// G-code thumbnails, upstream's GCodeThumbnails (GCode/Thumbnails.hpp/.cpp): the `thumbnails` option lists the images a
// printer shows ("96x96/PNG, 300x300/PNG"), each is compressed in its format and written as a base64 block where
// the kernel left ;_GP_THUMBNAILS_PLACEHOLDER (right after file_start_gcode, as upstream writes them at the top).
// The pixels come from the viewer's scene (renderThumbnail), the rest is here so it runs under node.
//
// ponytail: PNG and QOI, the formats 706 of the bundled machine profiles use. JPG (none bundled), BTT_TFT and
//  ColPic (6) are listed but skipped; add their encoders (Thumbnails.cpp compress_thumbnail_btt_tft/_colpic) when a
//  printer that needs them is in use.
import { encodeRgba8 } from './png_gray.js'

export const THUMBNAILS_PLACEHOLDER = ';_GP_THUMBNAILS_PLACEHOLDER'

// make_and_check_thumbnail_list (Thumbnails.cpp): "WxH/FORMAT" entries split by ',', the format PNG when left out.
const FORMATS = { PNG: 'PNG', JPG: 'JPG', QOI: 'QOI', BTT_TFT: 'BTT_TFT', COLPIC: 'COLPIC' }
export function thumbnailList(value) {
  const out = []
  for (const entry of String(value ?? '').split(',')) {
    const [size, formatName = 'PNG'] = entry.trim().split('/')
    const match = /^(\d+)x(\d+)$/i.exec(size ?? '')
    const format = FORMATS[formatName.trim().toUpperCase()]
    if (!match || !format) continue
    out.push({ width: Number(match[1]), height: Number(match[2]), format })
  }
  return out
}

// The QOI image format (qoiformat.org), what upstream's QOI thumbnails are (Thumbnails.cpp compress_thumbnail_qoi).
export function encodeQoi(rgba, width, height) {
  const out = []
  const push32 = (v) => out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)
  out.push(0x71, 0x6f, 0x69, 0x66)   // "qoif"
  push32(width); push32(height); out.push(4, 0)   // 4 channels, sRGB with linear alpha
  const index = new Uint8Array(64 * 4)
  let pr = 0, pg = 0, pb = 0, pa = 255, run = 0
  const total = width * height
  for (let i = 0; i < total; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3]
    if (r === pr && g === pg && b === pb && a === pa) {
      run++
      if (run === 62 || i === total - 1) { out.push(0xc0 | (run - 1)); run = 0 }
      continue
    }
    if (run > 0) { out.push(0xc0 | (run - 1)); run = 0 }
    const slot = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4
    if (index[slot] === r && index[slot + 1] === g && index[slot + 2] === b && index[slot + 3] === a) {
      out.push(slot / 4)
    } else {
      index[slot] = r; index[slot + 1] = g; index[slot + 2] = b; index[slot + 3] = a
      if (a === pa) {
        const dr = ((r - pr + 384) % 256) - 128, dg = ((g - pg + 384) % 256) - 128, db = ((b - pb + 384) % 256) - 128
        const drg = dr - dg, dbg = db - dg
        if (dr > -3 && dr < 2 && dg > -3 && dg < 2 && db > -3 && db < 2) out.push(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2))
        else if (drg > -9 && drg < 8 && dg > -33 && dg < 32 && dbg > -9 && dbg < 8) out.push(0x80 | (dg + 32), ((drg + 8) << 4) | (dbg + 8))
        else out.push(0xfe, r, g, b)
      } else {
        out.push(0xff, r, g, b, a)
      }
    }
    pr = r; pg = g; pb = b; pa = a
  }
  out.push(0, 0, 0, 0, 0, 0, 0, 1)   // end marker
  return Uint8Array.from(out)
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function base64(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63]
    if (i + 1 < bytes.length) out += BASE64[(n >> 6) & 63]
    else out += '='
    if (i + 2 < bytes.length) out += BASE64[n & 63]
    else out += '='
  }
  return out
}

// The tag upstream's compressed buffer names its block with (CompressedPNG/QOI/JPG::tag).
const TAGS = { PNG: 'thumbnail', QOI: 'thumbnail_QOI', JPG: 'thumbnail_JPG' }
const MAX_ROW_LENGTH = 78

/** One image's block, export_thumbnails_to_file's text for PNG/QOI/JPG. `bytes` is the compressed image. */
export function thumbnailBlock(format, width, height, bytes) {
  const encoded = base64(bytes)
  let text = '; THUMBNAIL_BLOCK_START\n'
  text += `\n;\n; ${TAGS[format]} begin ${width}x${height} ${encoded.length}\n`
  for (let at = 0; at < encoded.length; at += MAX_ROW_LENGTH) text += `; ${encoded.slice(at, at + MAX_ROW_LENGTH)}\n`
  text += `; ${TAGS[format]} end\n`
  text += '; THUMBNAIL_BLOCK_END\n\n'
  return text
}

/**
 * Every listed thumbnail as G-code text. `render(width, height)` gives a size's RGBA pixels (top row first), or
 * null when there is no scene to render. `opts` is encodeRgba8's (a deflate fallback for engines without
 * CompressionStream).
 */
export async function thumbnailsText(list, render, opts = {}) {
  let text = ''
  for (const { width, height, format } of list) {
    if (!TAGS[format] || format === 'JPG') continue   // see the ponytail note above
    const rgba = await render(width, height)
    if (!rgba) continue
    let bytes
    if (format === 'QOI') bytes = encodeQoi(rgba, width, height)
    else bytes = await encodeRgba8(rgba, width, height, opts)
    text += thumbnailBlock(format, width, height, bytes)
  }
  return text
}

/** The G-code with its thumbnail placeholder replaced by `text` (the line is removed when `text` is empty). */
export function withThumbnails(gcode, text) {
  const line = THUMBNAILS_PLACEHOLDER + '\n'
  const at = String(gcode).indexOf(line)
  if (at < 0) return gcode
  return gcode.slice(0, at) + text + gcode.slice(at + line.length)
}
