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

/** Uint8Array -> Map(name -> { method, compressedSize, size, dataStart }), or null when this reader cannot list it. */
export function zipEntries(bytes) {
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (u32(bytes, at) === 0x06054b50) { end = at; break }
  }
  if (end < 0) return null
  const count = u16(bytes, end + 10)
  let at = u32(bytes, end + 16)
  if (count === 0xffff || at === 0xffffffff) return null              // zip64
  const entries = new Map()
  for (let k = 0; k < count; k++) {
    if (u32(bytes, at) !== 0x02014b50) return null
    const flags = u16(bytes, at + 8), method = u16(bytes, at + 10)
    const compressedSize = u32(bytes, at + 20), size = u32(bytes, at + 24)
    const nameLength = u16(bytes, at + 28), extraLength = u16(bytes, at + 30), commentLength = u16(bytes, at + 32)
    const local = u32(bytes, at + 42)
    if (flags & 1) return null                                          // encrypted
    if (compressedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) return null
    if (method !== 0 && method !== 8) return null
    if (u32(bytes, local) !== 0x04034b50) return null
    const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    const dataStart = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28)
    entries.set(name, { method, compressedSize, size, dataStart })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** The compressed bytes of one member (a view into `bytes`). */
export function entryData(bytes, entry) {
  return bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize)
}

/** Inflates one member from its compressed bytes (entryData) -> Uint8Array. */
export async function inflateEntry(data, entry) {
  if (entry.method === 0) return data.slice()
  if (typeof DecompressionStream === 'function' && typeof Response === 'function') {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  return inflateSync(data, { out: new Uint8Array(entry.size) })
}
