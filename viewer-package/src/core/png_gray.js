// Gray8 PNG encoder for SL1 masks. The canvas encoder this replaces emits RGBA, which upstream's
//  SL1 reader REJECTS (PNGReadWrite.cpp:100 requires PNG_COLOR_TYPE_GRAY at bit depth 8) — so this
//  is a format-parity fix first and an encoder second. Filter 0 on every scanline: a mask is long
//  runs of 0x00/0xff and measured 11KB either way, so smarter filters buy nothing here.
// Compression: CompressionStream('deflate') — the SAME native API in browsers and node (and 'deflate'
//  is the zlib wrapping IDAT requires), measured 5ms on a 3.7MB mask where fflate's JS deflate takes
//  20-28ms. fflate stays as the fallback for engines without CompressionStream, injected by the
//  caller (`deflate` option) so this module keeps zero imports and stays node-runnable under the
//  layer guard.

const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

const crc32 = (bytes) => {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** One PNG chunk: length + type + data + CRC(type+data). */
const chunk = (type, data) => {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  const body = out.subarray(4, 8 + data.length)
  dv.setUint32(8 + data.length, crc32(body))
  return out
}

const nativeDeflate = async (bytes) => {
  const cs = new CompressionStream('deflate')
  const chunks = []
  const reading = (async () => {
    const reader = cs.readable.getReader()
    for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value) }
  })()
  const writer = cs.writable.getWriter()
  await writer.write(bytes)
  await writer.close()
  await reading
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

/**
 * Gray8 pixels -> PNG bytes (color type 0, bit depth 8 — the one layout upstream's SL1 reader accepts).
 * @param {Uint8Array} gray  w*h luminance bytes, row-major
 * @param {number} width
 * @param {number} height
 * @param {{deflate?: (bytes: Uint8Array) => Uint8Array}} [opts] sync deflate fallback (e.g. fflate
 *   zlibSync) for engines without CompressionStream; must produce a ZLIB stream, not raw deflate.
 * @returns {Promise<Uint8Array>}
 */
export async function encodeGray8(gray, width, height, opts = {}) {
  if (gray.length !== width * height) throw new Error(`gray8: ${gray.length} bytes for ${width}x${height}`)
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width)
  dv.setUint32(4, height)
  ihdr[8] = 8    // bit depth
  ihdr[9] = 0    // color type: grayscale
  // scanlines with the filter-0 byte prefixed per row
  const raw = new Uint8Array(height * (1 + width))
  for (let y = 0; y < height; y++) raw.set(gray.subarray(y * width, (y + 1) * width), y * (1 + width) + 1)
  const idat = typeof CompressionStream !== 'undefined' ? await nativeDeflate(raw)
    : opts.deflate ? opts.deflate(raw)
      : (() => { throw new Error('gray8: no CompressionStream and no deflate fallback injected') })()
  const parts = [SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
