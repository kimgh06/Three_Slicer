// A zip's members, listed from its central directory and inflated one at a time. A 3mf's mesh parts are the bulk of
//  the archive (haaland.3mf: 52MB -> 316MB, 64 members), and listing them without inflating them is what lets each
//  part be inflated where it is parsed. Inflation is the platform's own (DecompressionStream, ~1.1GB/s measured in
//  node's zlib) with fflate's JS inflate as the fallback.
// ponytail: no zip64 and no encryption — zipEntries() returns null for either, and the caller reads the archive with
//  fflate as before. A 3mf over 4GB, or an encrypted one, is the case that would justify reading zip64 records here.
import { inflateSync } from 'three/examples/jsm/libs/fflate.module.js'

const utf8 = new TextDecoder()
const u16 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8)
const u32 = (bytes, at) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0

// The end-of-central-directory record is in the archive's last 65557 bytes (its comment is at most 65535).
const TAIL_BYTES = 65557
const LOCAL_HEADER_BYTES = 30

// The central directory's records, read from `bytes` at `at`: [{ name, method, compressedSize, size, local }], or null
//  for what this reader does not do (zip64, encryption, a method other than stored/deflated).
function centralDirectory(bytes, at, count) {
  const records = []
  for (let k = 0; k < count; k++) {
    if (u32(bytes, at) !== 0x02014b50) return null
    const flags = u16(bytes, at + 8), method = u16(bytes, at + 10)
    const compressedSize = u32(bytes, at + 20), size = u32(bytes, at + 24)
    const nameLength = u16(bytes, at + 28), extraLength = u16(bytes, at + 30), commentLength = u16(bytes, at + 32)
    const local = u32(bytes, at + 42)
    if (flags & 1) return null                                          // encrypted
    if (compressedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) return null
    if (method !== 0 && method !== 8) return null
    records.push({ name: utf8.decode(bytes.subarray(at + 46, at + 46 + nameLength)), method, compressedSize, size, local })
    at += 46 + nameLength + extraLength + commentLength
  }
  return records
}

// Where the end record sits in `tail` (the archive's last bytes), with the directory's count and offset, or null.
function endRecord(tail) {
  for (let at = tail.length - 22; at >= 0; at--) {
    if (u32(tail, at) !== 0x06054b50) continue
    const count = u16(tail, at + 10), directoryStart = u32(tail, at + 16)
    if (count === 0xffff || directoryStart === 0xffffffff) return null  // zip64
    return { at, count, directoryStart }
  }
  return null
}

// A member's data starts after its local header, whose name and extra lengths only the header itself holds.
function dataStartOf(header, local) {
  if (u32(header, 0) !== 0x04034b50) return null
  return local + LOCAL_HEADER_BYTES + u16(header, 26) + u16(header, 28)
}

/** Uint8Array -> Map(name -> { method, compressedSize, size, dataStart }), or null when this reader cannot list it. */
export function zipEntries(bytes) {
  const end = endRecord(bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)))
  if (!end) return null
  const records = centralDirectory(bytes, end.directoryStart, end.count)
  if (!records) return null
  const entries = new Map()
  for (const record of records) {
    const dataStart = dataStartOf(bytes.subarray(record.local, record.local + LOCAL_HEADER_BYTES), record.local)
    if (dataStart === null) return null
    entries.set(record.name, { method: record.method, compressedSize: record.compressedSize, size: record.size, dataStart })
  }
  return entries
}

/**
 * zipEntries over a Blob that is not read whole: the directory from the archive's tail, each member's data offset from
 *  its own header, a few small reads in all. The members are then read as slices, and a big one can be streamed into
 *  its inflater while the rest of the archive is never loaded.
 */
export async function zipEntriesFromBlob(blob) {
  const readRange = async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer())
  const tailStart = Math.max(0, blob.size - TAIL_BYTES)
  const tail = await readRange(tailStart, blob.size)
  const end = endRecord(tail)
  if (!end) return null
  let directory = tail, directoryAt = end.directoryStart - tailStart
  if (directoryAt < 0) { directory = await readRange(end.directoryStart, tailStart + end.at); directoryAt = 0 }
  const records = centralDirectory(directory, directoryAt, end.count)
  if (!records) return null
  // One small read per member, all at once: in sequence they sat on the critical path, one disk round trip each.
  const headers = await Promise.all(records.map((record) => readRange(record.local, record.local + LOCAL_HEADER_BYTES)))
  const entries = new Map()
  records.forEach((record, k) => {
    const dataStart = dataStartOf(headers[k], record.local)
    if (dataStart === null) return
    entries.set(record.name, { method: record.method, compressedSize: record.compressedSize, size: record.size, dataStart })
  })
  if (entries.size !== records.length) return null
  return entries
}

// The compressed bytes of a member as a stream: `data` is the Uint8Array of them, or a Blob slice holding them (then
//  the bytes are read as the inflater consumes them, never all at once).
const compressedStream = (data) => {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.stream()
  return new Blob([data]).stream()
}
const compressedBytes = async (data) => {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  return data
}

/** The compressed bytes of one member (a view into `bytes`). */
export function entryData(bytes, entry) {
  return bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize)
}

/** Inflates one member from its compressed bytes (entryData, or a Blob slice of them) -> Uint8Array. */
export async function inflateEntry(data, entry) {
  if (entry.method === 0) return (await compressedBytes(data)).slice()
  if (typeof DecompressionStream === 'function' && typeof Response === 'function') {
    const stream = compressedStream(data).pipeThrough(new DecompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  return inflateSync(await compressedBytes(data), { out: new Uint8Array(entry.size) })
}

/**
 * The receiving half of an inflate done elsewhere: a sink for the batches the inflater posts, filling a buffer of the
 *  member's size and calling onBytes(buffer, received) after each, as inflateEntryProgressively does. finish()
 *  resolves to the buffer. DecompressionStream inflates on the thread that reads it (measured: a 303MB member's
 *  219ms of inflation were the reader's own time, whatever queue sat between), so the only way to overlap inflation
 *  with reading the output is another worker.
 */
export function inflateSink(entry, onBytes) {
  let buffer = new Uint8Array(entry.size)
  let received = 0
  return {
    push(batch) {
      if (received + batch.length > buffer.length) {
        const grown = new Uint8Array(Math.max(buffer.length * 2, received + batch.length))
        grown.set(buffer.subarray(0, received))
        buffer = grown
      }
      buffer.set(batch, received)
      received += batch.length
      onBytes(buffer, received)
    },
    finish() {
      if (received !== buffer.length) return buffer.slice(0, received)
      return buffer
    },
  }
}

/**
 * Inflates one member and hands the output on in batches of about `batchBytes` (the stream's own chunks are 64KB;
 *  posting each one is message overhead for nothing). For an inflater worker: each batch is a fresh buffer it can
 *  transfer.
 */
export async function inflateEntryInBatches(data, entry, onBatch, batchBytes = 1 << 20) {
  if (entry.method === 0 || typeof DecompressionStream !== 'function') {
    onBatch(await inflateEntry(data, entry))
    return
  }
  const reader = compressedStream(data).pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  let batch = new Uint8Array(batchBytes)
  let filled = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    let from = 0
    while (from < value.length) {
      const take = Math.min(value.length - from, batch.length - filled)
      batch.set(value.subarray(from, from + take), filled)
      filled += take
      from += take
      if (filled === batch.length) {
        onBatch(batch)
        batch = new Uint8Array(batchBytes)
        filled = 0
      }
    }
  }
  if (filled) onBatch(batch.subarray(0, filled))
}

/**
 * Inflates one member into a buffer of its size, calling onBytes(buffer, received) as the bytes arrive, so a reader
 *  can start on the front of a member while the rest is still being inflated. Resolves to the full buffer: the two
 *  halves above on one thread. Reading the stream's chunks into the buffer measured 240ms for a 303MB member against
 *  280ms for Response.arrayBuffer() on the same stream (Chromium).
 */
export async function inflateEntryProgressively(data, entry, onBytes) {
  const sink = inflateSink(entry, onBytes)
  await inflateEntryInBatches(data, entry, (batch) => sink.push(batch))
  return sink.finish()
}
