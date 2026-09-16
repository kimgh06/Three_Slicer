// SL1 (Prusa mSLA) archive reader — the reverse of sl1_write.js, to the extent the format allows: the zip
//  holds per-layer PNG masks + config.ini, so what comes back is raster layers and the job description. The
//  mesh those masks were rasterized from is gone, and config.ini records no millimetres — an imported archive
//  can only feed a raster PREVIEW, sized by the current printer's display parameters, never the mesh scene.
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js'
import { slaRasterTransform, SL1_ROLES_MEMBER, SL1_SCENE_MEMBER } from './sl1_write.js'

/** config.ini text -> object. `key = value` lines, numbers where the text is numeric — the exact shape
 *  sl1ConfigIni writes, tolerant of unknown keys so third-party archives read too. */
export function parseSl1Ini(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const raw = line.slice(eq + 1).trim()
    if (!key) continue
    out[key] = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw
  }
  return out
}

/**
 * What the `sl1` prop accepts -> what importSl1 reads: a `{name, arrayBuffer()}` pair. A File passes through;
 * raw bytes get a placeholder name, which is not cosmetic — the name is the import notice's subject and the
 * filename a re-export hands back.
 */
export function asSl1File(source) {
  if (source && typeof source.arrayBuffer === 'function') return source   // File / Blob
  const data = source?.data ?? source
  // A typed array may be a VIEW onto a larger buffer, and `.buffer` would hand back the whole thing — the caller
  //  wraps what it gets in `new Uint8Array(...)`, so the view's bounds have to be materialized here.
  const buffer = data instanceof ArrayBuffer ? data
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  return { name: source?.name || 'injected.sl1', arrayBuffer: async () => buffer }
}

/**
 * .sl1 bytes -> { config, layers: [{name, png}], layerHeight }. Layers are sorted by filename — the writer's
 * zero-padded names make lexicographic order the layer order (upstream names its masks the same way).
 * The PNGs stay encoded: decoding is a browser job (createImageBitmap), and keeping bytes is what lets a
 * re-export hand back the archive untouched.
 */
export function parseSl1(bytes) {
  const files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  const iniName = Object.keys(files).find(n => n.toLowerCase() === 'config.ini')
  if (!iniName) throw new Error('not an SL1 archive — config.ini missing')
  const config = parseSl1Ini(strFromU8(files[iniName]))
  const layers = Object.keys(files).filter(n => /\.png$/i.test(n)).sort()
    .map(name => ({ name, png: files[name] }))
  if (!layers.length) throw new Error('not an SL1 archive — no layer masks')
  const layerHeight = Number(config.layerHeight) > 0 ? Number(config.layerHeight) : 0.05
  return {
    config, layers, layerHeight,
    rolePaths: parseRolesSidecar(files[SL1_ROLES_MEMBER], layers.length),
    scene: parseSceneSidecar(files[SL1_SCENE_MEMBER]),
  }
}

/** The role sidecar back into per-layer stride-8 segment arrays (support/pad only — see sl1RolesSidecar).
 *  null when the archive carries none (a foreign SL1, or one of ours from before the sidecar existed) or when
 *  it does not check out — a colour hint is never worth failing an import over. */
export function parseRolesSidecar(bytes, layerCount) {
  if (!bytes || bytes.length < 8 || bytes[0] !== 0x54 || bytes[1] !== 0x53 || bytes[2] !== 0x52 || bytes[3] !== 0x31) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(4, true) !== layerCount) return null
  const out = []
  let at = 8
  for (let i = 0; i < layerCount; i++) {
    if (at + 4 > bytes.length) return null
    const count = dv.getUint32(at, true); at += 4
    if (count % 8 !== 0 || at + count * 4 > bytes.length) return null
    const seg = new Float32Array(count)
    for (let f = 0; f < count; f++) { seg[f] = dv.getFloat32(at, true); at += 4 }
    out.push(seg)
  }
  return out
}

/** The scene sidecar back into the meshes the SLA preview draws (see sl1SceneSidecar). null when the archive
 *  carries none or it does not check out — a missing scene just means reconstructing from the masks instead. */
export function parseSceneSidecar(bytes) {
  if (!bytes || bytes.length < 20 || bytes[0] !== 0x54 || bytes[1] !== 0x53 || bytes[2] !== 0x53 || bytes[3] !== 0x31) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const lift = dv.getFloat32(4, true)
  let at = 8
  const take = (elemBytes) => {
    if (at + 4 > bytes.length) return null
    const count = dv.getUint32(at, true); at += 4
    if (at + count * elemBytes > bytes.length) return null
    const out = elemBytes === 1 ? bytes.slice(at, at + count) : new Float32Array(count)
    if (elemBytes === 4) for (let i = 0; i < count; i++) out[i] = dv.getFloat32(at + i * 4, true)
    at += count * elemBytes
    return out
  }
  const modelSTL = take(1); if (!modelSTL) return null
  const supportMesh = take(4); if (!supportMesh) return null
  const padMesh = take(4); if (!padMesh) return null
  return { modelSTL, supportMesh, padMesh, lift }
}

/** A PNG's pixel dimensions, from the IHDR that always starts at byte 16 of the stream. null if it is not a PNG. */
export function pngSize(bytes) {
  if (!bytes || bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: dv.getUint32(16), height: dv.getUint32(20) }
}

/**
 * The settings an imported archive DICTATES, ready to merge — everything the file actually records, and nothing
 * it does not. config.ini carries the exposure family and the layer height; the mask's own header carries the
 * pixel grid (read back through the current orientation, since a raster cannot say which way its panel is
 * mounted). `printer_technology` leads the list: without it the session stays FFF and the whole SLA route —
 * the plate size, the resin card, the export — is drawn for the wrong machine.
 *
 * What is deliberately NOT here: the display's PHYSICAL size. Millimetres appear nowhere in an SL1 (upstream's
 * fill_iniconf writes pixels and seconds), so they stay whatever the current printer says, and the import
 * notice states it rather than inventing a panel. Nor `printer_settings_id`, which would drive the model picker
 * into applying a whole vendor profile the archive never named.
 */
export function sl1SettingsFrom(config, firstMask, orientation = 'portrait') {
  const out = { printer_technology: 'SLA' }
  const num = (key, into, min = 0) => { const v = Number(config[key]); if (Number.isFinite(v) && v >= min) out[into] = v }
  num('layerHeight', 'layer_height', 1e-4)
  num('expTime', 'exposure_time', 1e-4)
  num('expTimeFirst', 'initial_exposure_time', 1e-4)
  num('numFade', 'faded_layers')
  // expUserProfile is upstream's enum for the material's speed profile (slow=1, fast=0, user=2).
  if (config.expUserProfile != null) out.material_print_speed = config.expUserProfile === 1 ? 'slow' : config.expUserProfile === 0 ? 'fast' : 'user'
  for (const [key, into] of [['materialName', 'sla_material_settings_id'], ['printProfile', 'sla_print_settings_id'],
                             ['printerModel', 'printer_model'], ['printerVariant', 'printer_variant']])
    if (typeof config[key] === 'string' && config[key]) out[into] = config[key]
  // The mask is stored the way the raster was written: in portrait its columns run along the display's y axis,
  //  so its width is pixels_y and its height pixels_x. Landscape is the unswapped case.
  const size = pngSize(firstMask)
  if (size) {
    const portrait = orientation !== 'landscape'
    out.display_pixels_x = portrait ? size.height : size.width
    out.display_pixels_y = portrait ? size.width : size.height
  }
  return out
}

/**
 * The affine that puts an ARCHIVE mask back into the DISPLAY frame — a resX x resY canvas with +x right along
 * the display's x axis and +y down along its -y axis. It is the inverse of `slaRasterTransform` and is DERIVED
 * from it numerically (three mm points evaluated in both frames, then eliminated), so the two directions cannot
 * drift apart whichever way the orientation/mirror flags are set. Returns `matrix` as canvas setTransform()
 * arguments [a, b, c, d, e, f] and the display canvas size.
 */
export function sl1DisplayAffine(params) {
  const t = slaRasterTransform(params)
  const width = Number(params.display_width) > 0 ? Number(params.display_width) : 120.96
  const height = Number(params.display_height) > 0 ? Number(params.display_height) : 68.04
  const resX = t.portrait ? t.py : t.px
  const resY = t.portrait ? t.px : t.py
  const sx = resX / width, sy = resY / height
  const disp = (x, y) => [(x + width / 2) * sx, (height / 2 - y) * sy]
  const pts = [[0, 0], [1, 0], [0, 1]]
  const A = pts.map(([x, y]) => t.map(x, y))
  const D = pts.map(([x, y]) => disp(x, y))
  const a1 = [A[1][0] - A[0][0], A[1][1] - A[0][1]], a2 = [A[2][0] - A[0][0], A[2][1] - A[0][1]]
  const d1 = [D[1][0] - D[0][0], D[1][1] - D[0][1]], d2 = [D[2][0] - D[0][0], D[2][1] - D[0][1]]
  const det = a1[0] * a2[1] - a2[0] * a1[1]
  const m00 = (d1[0] * a2[1] - d2[0] * a1[1]) / det
  const m01 = (d2[0] * a1[0] - d1[0] * a2[0]) / det
  const m10 = (d1[1] * a2[1] - d2[1] * a1[1]) / det
  const m11 = (d2[1] * a1[0] - d1[1] * a2[0]) / det
  const e = D[0][0] - m00 * A[0][0] - m01 * A[0][1]
  const f = D[0][1] - m10 * A[0][0] - m11 * A[0][1]
  return { width: resX, height: resY, matrix: [m00, m10, m01, m11, e, f] }
}
