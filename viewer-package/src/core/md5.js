// MD5 of a byte array, as UPPERCASE hex — the spelling upstream writes into a .gcode.3mf's
//  Metadata/plate_N.gcode.md5 (bbs_3mf.cpp: `sprintf("%02X")` over the digest), which a Bambu printer checks the
//  plate's G-code against. Hand-written because the browser's crypto.subtle deliberately has no MD5, and a
//  dependency for ~50 lines of RFC 1321 is not worth its install. Not used for anything that needs to be secure.

const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
const CONSTANTS = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0)

export function md5Hex(bytes) {
  const length = bytes.length
  // Padding: 0x80, zeros to 56 mod 64, then the bit length as a little-endian 64-bit number.
  const paddedLength = (((length + 8) >> 6) + 1) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, (length * 8) >>> 0, true)
  view.setUint32(paddedLength - 4, Math.floor(length / 0x20000000), true)

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  const words = new Uint32Array(16)
  for (let block = 0; block < paddedLength; block += 64) {
    for (let word = 0; word < 16; word++) words[word] = view.getUint32(block + word * 4, true)
    let a = a0, b = b0, c = c0, d = d0
    for (let step = 0; step < 64; step++) {
      let mixed, wordIndex
      const round = step >> 4
      if (round === 0) { mixed = (b & c) | (~b & d); wordIndex = step }
      else if (round === 1) { mixed = (d & b) | (~d & c); wordIndex = (5 * step + 1) & 15 }
      else if (round === 2) { mixed = b ^ c ^ d; wordIndex = (3 * step + 5) & 15 }
      else { mixed = c ^ (b | ~d); wordIndex = (7 * step) & 15 }
      const sum = (a + mixed + CONSTANTS[step] + words[wordIndex]) >>> 0
      const shift = SHIFTS[round * 4 + (step & 3)]
      a = d; d = c; c = b
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0
  }
  let hex = ''
  for (const value of [a0, b0, c0, d0])
    for (let byte = 0; byte < 4; byte++) hex += ((value >>> (byte * 8)) & 0xff).toString(16).padStart(2, '0')
  return hex.toUpperCase()
}
