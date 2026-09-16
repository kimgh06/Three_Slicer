// SL1 (Prusa mSLA) archive writer: SLA slice layers -> a zip of per-layer PNG masks + config.ini.
//  The layer input is the same stride-8 segment stream every preview consumer reads; each layer's closed loops are
//  reconstructed from segment continuity (a loop is a run of segments whose start is the previous end) and filled
//  even-odd, so hole orientation cannot matter here even though sla_core orients it correctly anyway.
//
// Split the way write_3mf.js is: everything mm->px and text is pure and node-tested; only the actual PNG encode
//  needs a canvas, which the caller INJECTS (`makeCanvas`) — the browser passes OffscreenCanvas, a test passes a
//  recorder stub. Nothing here touches the DOM at import time, which is what keeps core/ under the layer guard.
import { zipSync, strToU8, zlibSync } from 'three/examples/jsm/libs/fflate.module.js'
import { log } from './log.js'
import { rasterizeMask } from './raster_mask.js'
import { encodeGray8 } from './png_gray.js'
import { STRIDE, ROLE, roleOf } from './toolpath_encoding.js'

/** mm -> px mapping of the resin display. Model coordinates are plate-local (origin at the plate centre); the
 *  display's origin is its own centre, so the transform is scale + half-display offset. `mirrorX` is the default
 *  because an mSLA display projects through the vat floor — upstream mirrors X for the SL1 family.
 *  `display_orientation` defaults to PORTRAIT — the whole SL1 family (SL1 and SL1S SPEED vendor profiles) is
 *  portrait, and upstream's SL1 writer then swaps the image axes (SL1.cpp create_raster: swap(w,h)+swap(pw,ph)
 *  with the rotation in the raster trafo). Measured on a real 2.9.6 archive: image is pixels_y WIDE by
 *  pixels_x TALL, columns run along the display's y axis, rows along the (mirrored) x axis. `px`/`py` on the
 *  returned object are CANVAS dimensions (already swapped in portrait); toX/toY produce canvas coordinates. */
export function slaRasterTransform(params) {
  const width = Number(params.display_width) > 0 ? Number(params.display_width) : 120.96
  const height = Number(params.display_height) > 0 ? Number(params.display_height) : 68.04
  const resX = Number(params.display_pixels_x) > 0 ? Math.round(Number(params.display_pixels_x)) : 2560
  const resY = Number(params.display_pixels_y) > 0 ? Math.round(Number(params.display_pixels_y)) : 1440
  const mirrorX = params.display_mirror_x !== false
  const mirrorY = params.display_mirror_y === true
  const portrait = (params.display_orientation ?? 'portrait') !== 'landscape'
  const sx = resX / width, sy = resY / height
  const mmX = (x) => (mirrorX ? (width / 2 - x) : (x + width / 2)) * sx   // along the display x axis, in px
  const mmY = (y) => (mirrorY ? (height / 2 - y) : (y + height / 2)) * sy // along the display y axis, in px
  return portrait ? {
    px: resY, py: resX, mirrorX, portrait,
    // canvas columns run along the display's y axis, rows along the (mirrored) x axis
    map: (x, y) => [mmY(y), mmX(x)],
  } : {
    px: resX, py: resY, mirrorX, portrait,
    map: (x, y) => [mmX(x), mmY(y)],
  }
}

/** One layer's segment stream -> the canvas ctx, as even-odd-filled white loops on the black already there.
 *  A new subpath starts wherever the stream breaks continuity — that break is how sla_core delimits loops. */
export function drawLayer(ctx, paths, transform) {
  const segCount = paths.length / 8
  if (!segCount) return 0
  let loops = 0
  ctx.beginPath()
  let lastX = NaN, lastY = NaN
  for (let s = 0; s < segCount; s++) {
    const x0 = paths[s * STRIDE], y0 = paths[s * STRIDE + 1], x1 = paths[s * STRIDE + 4], y1 = paths[s * STRIDE + 5]
    if (x0 !== lastX || y0 !== lastY) { ctx.moveTo(...transform.map(x0, y0)); loops++ }
    ctx.lineTo(...transform.map(x1, y1))
    lastX = x1; lastY = y1
  }
  // even-odd, and NOT nonzero: measured on a self-intersecting mesh (two boxes fused at a corner) the two give
  //  the SAME picture, because the slicer emits the overlap boundary with a hole's winding — so nonzero buys
  //  nothing there while giving up even-odd's indifference to loop orientation. Clean meshes round-trip either
  //  way: a 30x20 slab with a 10x6 hole rasterizes to 0.899 of its bbox against a theoretical 0.9.
  ctx.fill('evenodd')
  return loops
}

const iniEscape = (v) => String(v ?? '')

/** The SL1 job description (config.ini), upstream SL1.cpp fill_iniconf: the same field set, ALPHABETICAL
 *  order (upstream's ConfMap is a std::map — the sort is part of the bytes), and std::to_string's fixed
 *  6-decimal format for the two floats. Identity fields (printerModel, profiles) come from the params and
 *  default to empty — exactly what upstream produces without named profiles. Deterministic: the timestamp
 *  comes in as data, never from the clock. */
export function sl1ConfigIni({ params, stats, jobName, timestamp }) {
  // material_print_speed -> expUserProfile (upstream: slow=1, fast=0, user=2). Every Prusa vendor SL1
  //  material is "fast", so absent defaults to fast rather than upstream's unknown->2.
  const speed = String(params.material_print_speed ?? 'fast')
  const entries = {
    action: 'print',
    jobDir: jobName,
    expTime: params.exposure_time,
    expTimeFirst: params.initial_exposure_time,
    expUserProfile: speed === 'slow' ? 1 : speed === 'fast' ? 0 : 2,
    fileCreationTimestamp: timestamp ?? '',
    hollow: params.hollowing_enable ? 1 : 0,
    layerHeight: params.layer_height,
    materialName: params.sla_material_settings_id ?? '',
    numFade: params.faded_layers,
    numFast: stats.layers,
    numSlow: 0,
    printProfile: params.sla_print_settings_id ?? '',
    printTime: Number(stats.time_estimate ?? 0).toFixed(6),
    printerModel: params.printer_model ?? '',
    printerProfile: params.printer_settings_id ?? '',
    printerVariant: params.printer_variant ?? '',
    prusaSlicerVersion: 'three-slicer',
    usedMaterial: Number(stats.resin_ml ?? 0).toFixed(6),
  }
  return Object.keys(entries).sort().map(k => `${k} = ${iniEscape(entries[k])}`).join('\n') + '\n'
}

export const sl1LayerName = (jobName, index) => `${jobName}${String(index).padStart(5, '0')}.png`

// The role sidecar. An SL1 mask is only "cure this pixel" — which pixels were SUPPORT (role 5) or PAD (role 6)
//  is gone the moment it is rasterized, and that is why a reimported archive could only render one colour. Our
//  own writer can carry it: an extra zip member holding the support/pad segments of each layer, which every
//  other consumer (PrusaSlicer, printers) ignores as an unknown file. Model segments are NOT stored — model is
//  simply "cured and not support/pad" — so the sidecar stays a fraction of the mask data.
export const SL1_ROLES_MEMBER = 'Metadata/threeslicer_roles.bin'

// The scene sidecar. The role sidecar answers "which pixels were support"; this one answers the bigger
//  question the masks cannot: what the SURFACE was. Reconstructing a mesh from a voxelized mask grid is
//  faithful but never smooth — the original triangles are analytic, the reconstruction is a 0.12mm sample of
//  them. So our own writer stores the meshes the preview was showing (model STL, support tree, pad) and a
//  reimport shows exactly the scene that was exported, with no reconstruction at all. Every other consumer
//  ignores the unknown member; a foreign SL1 has none and still reconstructs from the masks.
export const SL1_SCENE_MEMBER = 'Metadata/threeslicer_scene.bin'

/** { modelSTL: Uint8Array, supportMesh/padMesh: Float32Array soups, lift: mm } -> the sidecar bytes:
 *  'TSS1', f32 lift, then three u32-length sections (STL bytes, support floats, pad floats). Little-endian. */
export function sl1SceneSidecar({ modelSTL, supportMesh, padMesh, lift = 0 }) {
  const stl = modelSTL instanceof Uint8Array ? modelSTL : new Uint8Array(modelSTL ?? 0)
  const sup = supportMesh instanceof Float32Array ? supportMesh : new Float32Array(supportMesh ?? 0)
  const pad = padMesh instanceof Float32Array ? padMesh : new Float32Array(padMesh ?? 0)
  const bytes = new Uint8Array(8 + 4 + stl.length + 4 + sup.length * 4 + 4 + pad.length * 4)
  const dv = new DataView(bytes.buffer)
  bytes.set([0x54, 0x53, 0x53, 0x31], 0)          // 'TSS1'
  dv.setFloat32(4, lift, true)
  let at = 8
  dv.setUint32(at, stl.length, true); at += 4
  bytes.set(stl, at); at += stl.length
  for (const arr of [sup, pad]) {
    dv.setUint32(at, arr.length, true); at += 4
    for (let i = 0; i < arr.length; i++) { dv.setFloat32(at, arr[i], true); at += 4 }
  }
  return bytes
}

/** Layers -> the sidecar bytes: 'TSR1', u32 layer count, then per layer u32 float count + the stride-8
 *  segments whose role is SUPPORT or RAFT (the pad), in stream order (drawLayer's loop-continuity rule
 *  survives filtering because loops close on themselves). Little-endian throughout, deterministic. */
export function sl1RolesSidecar(layers) {
  const kept = layers.map(({ paths }) => {
    const out = []
    for (let k = 0; k + STRIDE - 1 < paths.length; k += STRIDE) {
      const role = roleOf(paths[k + 3])
      if (role === ROLE.SUPPORT || role === ROLE.RAFT) for (let f = 0; f < STRIDE; f++) out.push(paths[k + f])
    }
    return out
  })
  const total = 8 + kept.reduce((s, seg) => s + 4 + seg.length * 4, 0)
  const bytes = new Uint8Array(total)
  const dv = new DataView(bytes.buffer)
  bytes.set([0x54, 0x53, 0x52, 0x31], 0)   // 'TSR1'
  dv.setUint32(4, kept.length, true)
  let at = 8
  for (const seg of kept) {
    dv.setUint32(at, seg.length, true); at += 4
    for (const v of seg) { dv.setFloat32(at, v, true); at += 4 }
  }
  return bytes
}

/**
 * Build the .sl1 bytes. `layers` is the slice result's layer list ({paths} per layer), `makeCanvas(px, py)`
 * returns an OffscreenCanvas-compatible object (2d ctx + convertToBlob). Returns a Uint8Array of the archive.
 */
/** The parallel encoder: N workers, worker k taking layers k, k+N, 2N+k… (the stride keeps progress even and
 *  the reassembly a plain index write). Layer paths are structured-clone COPIES — the main thread's arrays
 *  stay untouched for the sidecars below. Any worker error kills the whole pool and rejects: a partial
 *  archive is not an archive. */
function encodeParallel({ layers, params, makeWorker, workerCount, onProgress, aa = 1 }) {
  return new Promise((resolve, reject) => {
    const pngs = new Array(layers.length)
    const progress = new Array(workerCount).fill(0)
    let finished = 0, dead = false
    const workers = []
    const bail = (err) => { dead = true; workers.forEach(w => w.terminate()); reject(err) }
    for (let w = 0; w < workerCount; w++) {
      const indices = [], paths = []
      for (let i = w; i < layers.length; i += workerCount) { indices.push(i); paths.push(layers[i].paths) }
      const worker = makeWorker()
      workers.push(worker)
      worker.onerror = (event) => bail(new Error('SL1 encode worker: ' + (event?.message || 'failed')))
      worker.onmessage = ({ data }) => {
        if (dead) return
        if (data.progress != null) {
          progress[w] = data.progress
          onProgress?.(progress.reduce((a, b) => a + b, 0), layers.length)
          return
        }
        data.indices.forEach((layerIndex, k) => { pngs[layerIndex] = data.pngs[k] })
        worker.terminate()
        if (++finished === workerCount) resolve(pngs)
      }
      worker.postMessage({ indices, paths, params, aa })
    }
  })
}

export async function makeSL1({ layers, params, stats, jobName = 'plate', timestamp, makeCanvas, onProgress, scene = null, makeWorker = null, workerCount = 0, aa = 1, gpuRaster = null }) {
  // An EXPLICITLY injected canvas keeps the legacy path (that injection is a published contract, and
  //  the node tests' recorder stubs ride on it). Without one the default is now the own rasterizer +
  //  gray8 encoder — which is what upstream's SL1 reader requires (PNG_COLOR_TYPE_GRAY, depth 8; the
  //  canvas encoder emits RGBA and gets rejected), and what lets an export run under plain node.
  const canvasFactory = makeCanvas ?? null
  const transform = slaRasterTransform(params)
  const files = {}
  // The worker pool is the fast path; the sequential loop below stays for callers without one (node tests
  //  inject makeCanvas and never a worker). A pool that dies mid-build rejects rather than restarting
  //  sequentially — the caller already reports export errors, and a silent 8x slowdown would read as a hang.
  // The count is the CALLER's judgment (core/ cannot read navigator.hardwareConcurrency under the layer
  //  guard); 4 is the floor a caller that passes a factory but no count gets.
  const pool = makeWorker && typeof Worker !== 'undefined' && layers.length > 1 ? {
    makeWorker,
    workerCount: Math.max(1, Math.min(workerCount > 0 ? workerCount : 4, layers.length)),
  } : null
  // No throw without a canvas any more: the rasterizer path needs nothing injected.
  // Per-stage cost, on the [vp-prof] channel the 3mf export and the sl1 import already use. One total says
  //  nothing about which stage to attack, and the candidates have completely different fixes (a canvas pool,
  //  a smaller mask, a worker pool, a different encoder). Caveat when reading it: a 2d context may defer its
  //  raster work, in which case some of `draw` is charged to `encode` instead — treat the two as one budget
  //  unless one of them is near zero.
  const now = () => performance.now()
  const spent = { canvas: 0, clear: 0, draw: 0, encode: 0, read: 0 }
  const mark = (key, from) => { const t = now(); spent[key] += t - from; return t }
  let pngBytes = 0, loops = 0
  const encodeOne = async (i) => {
    let t = now()
    if (!canvasFactory) {   // default: own rasterizer -> gray8 PNG. gpuRaster (injected, may be null)
      //  carries the MSAA path for high-res AA; the CPU AET fill is the reference and the fallback.
      //  The layer object and index ride along for raster backends that do not consume the contour
      //  stream at all — the parity renderer (sl1_parity_gpu.js) slices the MESH at layers[i].z instead.
      const mask = gpuRaster
        ? await gpuRaster(layers[i].paths, transform, aa, layers[i], i)
        : rasterizeMask(layers[i].paths, transform, aa)
      t = mark('draw', t)
      const bytes = await encodeGray8(mask, transform.px, transform.py, { deflate: zlibSync })
      mark('encode', t)
      pngBytes += bytes.length
      return bytes
    }
    const canvas = canvasFactory(transform.px, transform.py)
    const ctx = canvas.getContext('2d')
    t = mark('canvas', t)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, transform.px, transform.py)
    t = mark('clear', t)
    ctx.fillStyle = '#fff'
    loops += drawLayer(ctx, layers[i].paths, transform)
    t = mark('draw', t)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    t = mark('encode', t)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    mark('read', t)
    pngBytes += bytes.length
    return bytes
  }
  // The pool is where the time goes and the sequential loop is the contract: one at a time, deliberately —
  //  encoding in same-thread batches of 8 was measured at 12% (convertToBlob never leaves the thread), so the
  //  only real lever is other threads, and that is what `makeWorker` provides (8 workers: 9.3x on the raster
  //  stage of a 960-layer Benchy). PNGs are already deflate-compressed — storing them beats re-deflating
  //  (write_3mf's level-3 reasoning).
  const tRaster = now()
  if (pool) {
    const pngs = await encodeParallel({ layers, params, onProgress, aa, ...pool })
    for (let i = 0; i < layers.length; i++) {
      files[sl1LayerName(jobName, i)] = [pngs[i], { level: 0 }]
      pngBytes += pngs[i].length
    }
  } else {
    for (let i = 0; i < layers.length; i++) {
      files[sl1LayerName(jobName, i)] = [await encodeOne(i), { level: 0 }]
      if ((i & 31) === 0) onProgress?.(i, layers.length)
    }
  }
  const tSidecar = now()
  files['config.ini'] = strToU8(sl1ConfigIni({ params, stats, jobName, timestamp }))
  files[SL1_ROLES_MEMBER] = [sl1RolesSidecar(layers), { level: 6 }]   // floats deflate well, unlike the PNGs
  if (scene) files[SL1_SCENE_MEMBER] = [sl1SceneSidecar(scene), { level: 6 }]
  const tZip = now()
  const bytes = zipSync(files)
  const ms = (v) => v.toFixed(0)
  log.info(`[vp-prof] sl1 build: ${layers.length} layers ${transform.px}x${transform.py},`
    + (pool ? ` raster ${ms(tSidecar - tRaster)}ms (${pool.workerCount} workers),`
      : ` ${loops} loops, raster ${ms(tSidecar - tRaster)}ms (canvas ${ms(spent.canvas)} + clear ${ms(spent.clear)}`
        + ` + draw ${ms(spent.draw)} + encode ${ms(spent.encode)} + read ${ms(spent.read)}),`)
    + ` sidecar ${ms(tZip - tSidecar)}ms, zip ${ms(now() - tZip)}ms`
    + ` -> ${(bytes.byteLength / 1e6).toFixed(1)}MB (png ${(pngBytes / 1e6).toFixed(1)}MB)`)
  return bytes
}
