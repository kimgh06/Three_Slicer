// SL1 writer invariants (core/sl1_write.js): the mm->px transform (incl. the display mirror), loop
//  reconstruction from the segment stream, the deterministic config.ini, and the archive layout — all under
//  plain node, with the canvas injected as a recorder stub (the PNG encode is the one browser-only piece).
import { strict as assert } from 'node:assert'
import { slaRasterTransform, drawLayer, sl1ConfigIni, sl1LayerName, makeSL1, sl1RolesSidecar } from './src/core/sl1_write.js'
import { parseSl1, parseSl1Ini, parseRolesSidecar, sl1DisplayAffine, sl1SettingsFrom, pngSize } from './src/core/sl1_read.js'
import { unzipSync, zipSync, strFromU8, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

const params = { display_width: 100, display_height: 50, display_pixels_x: 1000, display_pixels_y: 500 }

// [transform] centre-origin mm -> pixel. PORTRAIT is the default (the whole SL1 family is portrait): the
//  canvas is pixels_y wide by pixels_x tall, columns run along the display's y axis and rows along the
//  X-mirrored x axis (the display projects through the vat floor) — upstream SL1.cpp create_raster.
{
  const t = slaRasterTransform(params)
  assert.equal(t.portrait, true)
  assert.equal(t.px, 500); assert.equal(t.py, 1000)      // canvas dims swapped
  assert.deepEqual(t.map(0, 0), [250, 500])              // centre lands mid-canvas
  assert.deepEqual(t.map(10, 0), [250, 400])             // +x runs UP the image when mirrored
  assert.deepEqual(t.map(0, 10), [350, 500])             // +y runs right, no flip (mirror_y default off)
  const flipped = slaRasterTransform({ ...params, display_mirror_y: true })
  assert.deepEqual(flipped.map(0, 10), [150, 500])
  ok('transform portrait: swapped canvas, y->columns, mirrored x->rows')
}

// [transform] explicit landscape keeps the unswapped mapping
{
  const t = slaRasterTransform({ ...params, display_orientation: 'landscape' })
  assert.equal(t.portrait, false)
  assert.equal(t.px, 1000); assert.equal(t.py, 500)
  assert.deepEqual(t.map(0, 0), [500, 250])
  assert.deepEqual(t.map(10, 0), [400, 250])             // +x runs left when mirrored
  assert.deepEqual(t.map(0, 10), [500, 350])
  const plain = slaRasterTransform({ ...params, display_orientation: 'landscape', display_mirror_x: false })
  assert.deepEqual(plain.map(10, 0), [600, 250])
  ok('transform landscape: centre origin, scale, mirror')
}

// [transform] the SL1 reference panel with NO params at all — the shape a real 2.9.6 archive holds
//  (measured: masks are 1440x2560 portrait; a centred model sits at column 720, row 1280).
{
  const t = slaRasterTransform({})
  assert.equal(t.px, 1440); assert.equal(t.py, 2560)
  assert.deepEqual(t.map(0, 0), [720, 1280])
  ok('transform defaults: SL1 panel, portrait 1440x2560')
}

// [loops] a break in segment continuity starts a new subpath — that is how sla_core delimits loops
{
  const calls = []
  const ctx = {
    beginPath: () => calls.push(['begin']), moveTo: (x, y) => calls.push(['move', x, y]),
    lineTo: (x, y) => calls.push(['line', x, y]), fill: (rule) => calls.push(['fill', rule]),
  }
  // two loops: a 2-segment run (0,0 -> 10,0 -> 0,0) and a separate 1-segment degenerate run
  const paths = Float32Array.from([
    0, 0, 1, 1, 10, 0, 1, 1,
    10, 0, 1, 1, 0, 0, 1, 1,     // continues the first loop
    30, 30, 1, 1, 31, 30, 1, 1,  // discontinuity -> second loop
  ])
  const loops = drawLayer(ctx, paths, slaRasterTransform(params))
  assert.equal(loops, 2)
  assert.equal(calls.filter(c => c[0] === 'move').length, 2)
  assert.equal(calls.filter(c => c[0] === 'line').length, 3)
  assert.deepEqual(calls[calls.length - 1], ['fill', 'evenodd'])
  ok('loops: continuity breaks open subpaths, even-odd fill')
}

// [config] the exact upstream shape (fill_iniconf): field set, alphabetical order, 6-decimal floats.
//  Pinned as the WHOLE text — the byte layout is the contract, and it is deterministic by construction.
{
  const ini = sl1ConfigIni({
    params: { exposure_time: 7, initial_exposure_time: 35, layer_height: 0.05, faded_layers: 10 },
    stats: { layers: 42, time_estimate: 500, resin_ml: 1.23456 },
    jobName: 'plate_1', timestamp: '2026-01-01T00:00:00Z',
  })
  assert.equal(ini, [
    'action = print',
    'expTime = 7',
    'expTimeFirst = 35',
    'expUserProfile = 0',
    'fileCreationTimestamp = 2026-01-01T00:00:00Z',
    'hollow = 0',
    'jobDir = plate_1',
    'layerHeight = 0.05',
    'materialName = ',
    'numFade = 10',
    'numFast = 42',
    'numSlow = 0',
    'printProfile = ',
    'printTime = 500.000000',
    'printerModel = ',
    'printerProfile = ',
    'printerVariant = ',
    'prusaSlicerVersion = three-slicer',
    'usedMaterial = 1.234560',
  ].join('\n') + '\n')
  // Identity fields flow from the params; expUserProfile follows upstream's speed mapping (slow=1, user=2).
  const named = sl1ConfigIni({
    params: { printer_model: 'SL1S', printer_variant: 'default', sla_material_settings_id: 'resin A',
              material_print_speed: 'slow', hollowing_enable: true },
    stats: {}, jobName: 'x', timestamp: 't',
  })
  assert.ok(named.includes('printerModel = SL1S\n'))
  assert.ok(named.includes('materialName = resin A\n'))
  assert.ok(named.includes('expUserProfile = 1\n'))
  assert.ok(named.includes('hollow = 1\n'))
  assert.equal(sl1ConfigIni({ params: {}, stats: {}, jobName: 'x', timestamp: 't' }),
               sl1ConfigIni({ params: {}, stats: {}, jobName: 'x', timestamp: 't' }))
  ok('config.ini: fields present, deterministic')
}

// [archive] one PNG per layer named jobname%05d.png + config.ini, PNGs stored uncompressed
{
  const fakePng = Uint8Array.from([137, 80, 78, 71, 1, 2, 3])
  const makeCanvas = (w, h) => ({
    getContext: () => ({ beginPath() {}, moveTo() {}, lineTo() {}, fill() {}, fillRect() {}, set fillStyle(_) {}, get fillStyle() { return '' } }),
    convertToBlob: async () => new Blob([fakePng]),
    width: w, height: h,
  })
  const layers = [{ paths: new Float32Array(0) }, { paths: new Float32Array(0) }, { paths: new Float32Array(0) }]
  const bytes = await makeSL1({
    layers, params, stats: { layers: 3, time_estimate: 60, resin_ml: 0.5 },
    jobName: 'plate_2', timestamp: '2026-01-01T00:00:00Z', makeCanvas,
  })
  const files = unzipSync(bytes)
  const names = Object.keys(files).sort()
  assert.deepEqual(names, ['Metadata/threeslicer_roles.bin', 'config.ini', 'plate_200000.png', 'plate_200001.png', 'plate_200002.png'])
  assert.deepEqual(Array.from(files['plate_200001.png']), Array.from(fakePng))
  assert.ok(strFromU8(files['config.ini']).includes('jobDir = plate_2'))
  assert.equal(sl1LayerName('plate_2', 1), 'plate_200001.png')
  ok('archive: layer naming, config member, byte-exact PNG payload')
}

// ---- reader (core/sl1_read.js) ------------------------------------------------------------------------------

// [ini] numbers where numeric, strings otherwise; junk lines skipped — the writer's own format reads back
{
  const parsed = parseSl1Ini('expTime = 7.5\njobDir = plate_2\nempty =\nno equals sign here\nnumFast = 3\n')
  assert.equal(parsed.expTime, 7.5)
  assert.equal(parsed.jobDir, 'plate_2')
  assert.equal(parsed.empty, '')
  assert.equal(parsed.numFast, 3)
  assert.ok(!('no equals sign here' in parsed))
  ok('read ini: numeric coercion, junk tolerance')
}

// [round-trip] makeSL1 -> parseSl1: layer count/order/bytes and the config values survive
{
  const fakePng = (i) => Uint8Array.from([137, 80, 78, 71, i])
  let n = 0
  const makeCanvas = (w, h) => ({
    getContext: () => ({ beginPath() {}, moveTo() {}, lineTo() {}, fill() {}, fillRect() {}, set fillStyle(_) {}, get fillStyle() { return '' } }),
    convertToBlob: async () => new Blob([fakePng(n++)]),
    width: w, height: h,
  })
  const bytes = await makeSL1({
    layers: [{ paths: new Float32Array(0) }, { paths: new Float32Array(0) }, { paths: new Float32Array(0) }],
    params: { ...params, layer_height: 0.05, exposure_time: 7 },
    stats: { layers: 3, time_estimate: 60, resin_ml: 0.5 },
    jobName: 'plate_2', timestamp: '2026-01-01T00:00:00Z', makeCanvas,
  })
  const back = parseSl1(bytes)
  assert.equal(back.layerHeight, 0.05)
  assert.equal(back.config.expTime, 7)
  assert.equal(back.config.numFast, 3)
  assert.equal(back.config.jobDir, 'plate_2')
  assert.deepEqual(back.layers.map(l => l.name), ['plate_200000.png', 'plate_200001.png', 'plate_200002.png'])
  assert.deepEqual(Array.from(back.layers[1].png), Array.from(fakePng(1)))
  ok('read round-trip: layers in order, byte-exact masks, config values')
}

// [read errors] a zip that is not an SL1 refuses rather than returning an empty preview
{
  assert.throws(() => parseSl1(zipSync({ 'a.png': strToU8('x') })), /config\.ini/)
  assert.throws(() => parseSl1(zipSync({ 'config.ini': strToU8('layerHeight = 0.05\n') })), /no layer masks/)
  ok('read errors: missing config.ini / missing masks are typed refusals')
}

// [affine] the archive->display inverse of slaRasterTransform, checked by mapping real points both ways:
//  a point the forward transform lands at archive [cx, cy] must come back to its display-frame pixel.
{
  const apply = (m, u, v) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]
  // portrait + mirrored x (the defaults): W=100 H=50 resX=1000 resY=500
  const t = slaRasterTransform(params)
  const aff = sl1DisplayAffine(params)
  assert.equal(aff.width, 1000); assert.equal(aff.height, 500)     // display canvas is landscape again
  //  mm (10, 0): forward -> [250, 400]; display frame -> dx=(10+50)*10=600, dy=(25-0)*10=250
  assert.deepEqual(apply(aff.matrix, ...t.map(10, 0)), [600, 250])
  assert.deepEqual(apply(aff.matrix, ...t.map(0, 0)), [500, 250])  // centre stays centred
  // landscape, no mirror: y=10 flips vertically (canvas rows grow down, display +y is up)
  const p2 = { ...params, display_orientation: 'landscape', display_mirror_x: false }
  const aff2 = sl1DisplayAffine(p2)
  assert.deepEqual(apply(aff2.matrix, ...slaRasterTransform(p2).map(10, 10)), [600, 150])
  ok('affine: inverse of the raster transform in both orientations')
}

// [import settings] what the archive DICTATES — technology above all, plus the exposure family, and the pixel
//  grid read back off a mask header through the current orientation. Physical mm are NOT in an SL1 and must
//  not be invented.
{
  // a minimal PNG header: magic + IHDR width/height (1440 x 2560, the portrait mask an SL1 writes)
  const mask = new Uint8Array(24)
  mask.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  new DataView(mask.buffer).setUint32(16, 1440); new DataView(mask.buffer).setUint32(20, 2560)
  assert.deepEqual(pngSize(mask), { width: 1440, height: 2560 })
  assert.equal(pngSize(new Uint8Array([1, 2, 3])), null)

  const config = { layerHeight: 0.05, expTime: 7, expTimeFirst: 35, numFade: 10, expUserProfile: 0,
                   materialName: 'Prusa Orange Tough 0.05', printProfile: '0.05 Normal', printerModel: 'SL1', printerVariant: 'default' }
  const s = sl1SettingsFrom(config, mask)
  assert.equal(s.printer_technology, 'SLA')          // the one that makes the whole SLA route apply
  assert.equal(s.layer_height, 0.05)
  assert.equal(s.exposure_time, 7); assert.equal(s.initial_exposure_time, 35)
  assert.equal(s.faded_layers, 10)                   // 0 is legal and must survive
  assert.equal(sl1SettingsFrom({ ...config, numFade: 0 }, mask).faded_layers, 0)
  assert.equal(s.material_print_speed, 'fast')
  assert.equal(s.sla_material_settings_id, 'Prusa Orange Tough 0.05')
  assert.equal(s.printer_model, 'SL1')
  // portrait: the mask's width is pixels_y, its height pixels_x — the inverse of the writer's swap
  assert.equal(s.display_pixels_x, 2560); assert.equal(s.display_pixels_y, 1440)
  const land = sl1SettingsFrom(config, mask, 'landscape')
  assert.equal(land.display_pixels_x, 1440); assert.equal(land.display_pixels_y, 2560)
  // the physical panel is nowhere in an SL1 — inventing one would resize every imported preview
  assert.ok(!('display_width' in s) && !('display_height' in s))
  // nor the printer preset id, which would drive the model picker into applying a profile the file never named
  assert.ok(!('printer_settings_id' in s))
  // empty strings (what the writer emits with no named profile) are omitted rather than written as ''
  const bare = sl1SettingsFrom({ layerHeight: 0.05, materialName: '', printerModel: '' }, null)
  assert.ok(!('sla_material_settings_id' in bare) && !('printer_model' in bare))
  assert.equal(bare.printer_technology, 'SLA')
  ok('import settings: technology + exposure family + pixel grid, no invented millimetres')
}

// [import round-trip] the values an export wrote come back as the settings that produced them
{
  const params = { display_width: 100, display_height: 50, display_pixels_x: 1000, display_pixels_y: 500,
                   layer_height: 0.05, exposure_time: 9, initial_exposure_time: 30, faded_layers: 8,
                   material_print_speed: 'slow', sla_material_settings_id: 'Some Resin' }
  const ini = parseSl1Ini(sl1ConfigIni({ params, stats: { layers: 2 }, jobName: 'p', timestamp: 't' }))
  const back = sl1SettingsFrom(ini, null)
  assert.equal(back.layer_height, 0.05)
  assert.equal(back.exposure_time, 9); assert.equal(back.initial_exposure_time, 30)
  assert.equal(back.faded_layers, 8)
  assert.equal(back.material_print_speed, 'slow')     // expUserProfile 1 -> slow
  assert.equal(back.sla_material_settings_id, 'Some Resin')
  ok('import round-trip: config.ini values return as the settings that wrote them')
}

// [role sidecar] support/pad segments round-trip through the archive; model segments are omitted; a foreign
//  archive (no sidecar) and a corrupt one both read back as null rather than failing the import
{
  const seg = (x0, y0, x1, y1, role) => [x0, y0, 1, role, x1, y1, 1, role]
  const layers = [
    { paths: Float32Array.from([...seg(0, 0, 5, 0, 1), ...seg(0, 0, 3, 3, 5)]) },   // model + support
    { paths: Float32Array.from([...seg(1, 1, 2, 2, 6)]) },                          // pad only
    { paths: Float32Array.from([...seg(0, 0, 5, 0, 1)]) },                          // model only
  ]
  const back = parseRolesSidecar(sl1RolesSidecar(layers), 3)
  assert.equal(back.length, 3)
  assert.deepEqual(Array.from(back[0]), seg(0, 0, 3, 3, 5))     // support kept, model dropped
  assert.deepEqual(Array.from(back[1]), seg(1, 1, 2, 2, 6))
  assert.equal(back[2].length, 0)
  assert.equal(parseRolesSidecar(undefined, 3), null)
  assert.equal(parseRolesSidecar(sl1RolesSidecar(layers), 2), null)                 // layer-count mismatch
  assert.equal(parseRolesSidecar(sl1RolesSidecar(layers).slice(0, 20), 3), null)    // truncated
  ok('role sidecar: support/pad round-trip, model omitted, malformed -> null')
}

// [role sidecar in the archive] makeSL1 embeds it and parseSl1 hands it back per layer
{
  const fakePng = Uint8Array.from([137, 80, 78, 71, 9])
  const makeCanvas = (w, h) => ({
    getContext: () => ({ beginPath() {}, moveTo() {}, lineTo() {}, fill() {}, fillRect() {}, set fillStyle(_) {}, get fillStyle() { return '' } }),
    convertToBlob: async () => new Blob([fakePng]),
    width: w, height: h,
  })
  const seg = (x0, y0, x1, y1, role) => [x0, y0, 1, role, x1, y1, 1, role]
  const layers = [
    { paths: Float32Array.from([...seg(0, 0, 5, 0, 1), ...seg(-2, -2, 2, 2, 5)]) },
    { paths: Float32Array.from([...seg(0, 0, 4, 4, 6)]) },
  ]
  const bytes = await makeSL1({ layers, params, stats: { layers: 2 }, jobName: 'p', timestamp: 't', makeCanvas })
  const back = parseSl1(bytes)
  assert.ok(back.rolePaths, 'sidecar read back')
  assert.deepEqual(Array.from(back.rolePaths[0]), seg(-2, -2, 2, 2, 5))
  assert.deepEqual(Array.from(back.rolePaths[1]), seg(0, 0, 4, 4, 6))
  ok('role sidecar: rides the archive end to end')
}

console.log(`test_sl1: ${passed} checks passed`)
