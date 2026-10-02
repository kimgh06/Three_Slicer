// G-code thumbnails (core/thumbnails.js): the `thumbnails` list, the PNG and QOI encodings, upstream's block text.
//   Run: node viewer-package/tests/test_thumbnails.mjs
import assert from 'node:assert'
import { inflateSync } from 'node:zlib'
import { zlibSync } from 'three/examples/jsm/libs/fflate.module.js'
import { thumbnailList, encodeQoi, thumbnailBlock, thumbnailsText, withThumbnails, THUMBNAILS_PLACEHOLDER } from '../src/core/thumbnails.js'

// ---- the list (make_and_check_thumbnail_list)
assert.deepStrictEqual(thumbnailList('96x96/PNG, 300x300/qoi,48x48'), [
  { width: 96, height: 96, format: 'PNG' }, { width: 300, height: 300, format: 'QOI' }, { width: 48, height: 48, format: 'PNG' }])
assert.deepStrictEqual(thumbnailList('junk, 10x/PNG, 5x5/GIF'), [], 'malformed entries and unknown formats are skipped')
assert.deepStrictEqual(thumbnailList(undefined), [])
// Most vendor profiles store the coString as a JSON list (the older coPoints shape); upstream's JSON loader joins a
//  list for a scalar option with ','.
assert.deepStrictEqual(thumbnailList(['16x16/QOI', '640x480/PNG', '380x380/COLPIC']).map(entry => entry.format), ['QOI', 'PNG', 'COLPIC'])

// ---- a test image: a gradient with a transparent corner and runs, so every QOI op is exercised
const W = 13, H = 7
const image = new Uint8Array(W * H * 4)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4
  image[i] = (x * 19) & 255; image[i + 1] = (y * 37) & 255; image[i + 2] = (x * y * 11) & 255; image[i + 3] = 255
  if (x < 4) image[i + 2] = 200        // a run of one colour
  if (x + y < 3) image[i + 3] = 0      // a transparent corner
}

// An independent QOI decoder (the spec's ops), so the encoder is checked against the format, not against itself.
function decodeQoi(bytes) {
  const width = (bytes[4] << 24 | bytes[5] << 16 | bytes[6] << 8 | bytes[7]) >>> 0
  const height = (bytes[8] << 24 | bytes[9] << 16 | bytes[10] << 8 | bytes[11]) >>> 0
  const out = new Uint8Array(width * height * 4), index = new Uint8Array(256)
  let r = 0, g = 0, b = 0, a = 255, p = 14, run = 0
  for (let px = 0; px < width * height; px++) {
    if (run > 0) run--
    else {
      const b1 = bytes[p++]
      if (b1 === 0xfe) { r = bytes[p++]; g = bytes[p++]; b = bytes[p++] }
      else if (b1 === 0xff) { r = bytes[p++]; g = bytes[p++]; b = bytes[p++]; a = bytes[p++] }
      else if ((b1 & 0xc0) === 0x00) { r = index[b1 * 4]; g = index[b1 * 4 + 1]; b = index[b1 * 4 + 2]; a = index[b1 * 4 + 3] }
      else if ((b1 & 0xc0) === 0x40) { r = (r + ((b1 >> 4) & 3) - 2) & 255; g = (g + ((b1 >> 2) & 3) - 2) & 255; b = (b + (b1 & 3) - 2) & 255 }
      else if ((b1 & 0xc0) === 0x80) { const b2 = bytes[p++], dg = (b1 & 63) - 32; r = (r + dg - 8 + ((b2 >> 4) & 15)) & 255; g = (g + dg) & 255; b = (b + dg - 8 + (b2 & 15)) & 255 }
      else run = b1 & 63
      const slot = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4
      index[slot] = r; index[slot + 1] = g; index[slot + 2] = b; index[slot + 3] = a
    }
    out[px * 4] = r; out[px * 4 + 1] = g; out[px * 4 + 2] = b; out[px * 4 + 3] = a
  }
  return { width, height, out }
}
const qoi = encodeQoi(image, W, H)
const decoded = decodeQoi(qoi)
assert.strictEqual(decoded.width, W); assert.strictEqual(decoded.height, H)
assert.deepStrictEqual(Array.from(decoded.out), Array.from(image), 'QOI decodes back to the same pixels')

// ---- the G-code text: PNG decodes back through zlib, the block is upstream's shape
const text = await thumbnailsText(thumbnailList(`${W}x${H}/PNG, ${W}x${H}/QOI`), () => image, { deflate: zlibSync })
const pngBlock = /; thumbnail begin 13x7 (\d+)\n((?:; .*\n)+?); thumbnail end\n/.exec(text)
assert.ok(pngBlock, 'a PNG block: "; thumbnail begin WxH <length>" ... "; thumbnail end"')
const pngBase64 = pngBlock[2].split('\n').filter(Boolean).map(line => line.slice(2)).join('')
assert.strictEqual(pngBase64.length, Number(pngBlock[1]), 'the length is the base64 length')
assert.ok(pngBlock[2].split('\n').filter(Boolean).every(line => line.length <= 80), 'rows of at most 78 characters')
const png = Buffer.from(pngBase64, 'base64')
assert.strictEqual(png.readUInt32BE(16), W); assert.strictEqual(png.readUInt32BE(20), H); assert.strictEqual(png[25], 6, 'RGBA')
const idatAt = png.indexOf('IDAT'), idatLength = png.readUInt32BE(idatAt - 4)
const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + idatLength))
const rows = []
for (let y = 0; y < H; y++) rows.push(...raw.subarray(y * (W * 4 + 1) + 1, (y + 1) * (W * 4 + 1)))
assert.deepStrictEqual(rows, Array.from(image), 'PNG scanlines are the pixels')
assert.ok(text.includes('; thumbnail_QOI begin 13x7 '), 'a QOI block is tagged thumbnail_QOI')
assert.ok(thumbnailBlock('PNG', 1, 1, new Uint8Array([1, 2, 3])).startsWith('; THUMBNAIL_BLOCK_START\n\n;\n; thumbnail begin 1x1 4\n; AQID\n'))

// ---- the placeholder
assert.strictEqual(withThumbnails(`a\n${THUMBNAILS_PLACEHOLDER}\nb\n`, 'T\n'), 'a\nT\nb\n')
assert.strictEqual(withThumbnails(`a\n${THUMBNAILS_PLACEHOLDER}\nb\n`, ''), 'a\nb\n', 'no image: the line goes')
assert.strictEqual(await thumbnailsText(thumbnailList('10x10/PNG'), () => null), '', 'no scene: nothing')
console.log('thumbnails: all assertions passed')
