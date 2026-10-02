// The machine commands a printer profile decides (machine_writer.h, upstream GCodeWriter): temperatures, and the
// firmware flavor that formats them. Each is pinned by its own text in the G-code, and by its absence when the host
// sends nothing — the omission rule, which keeps every caller from before these keys byte-identical (golden.mjs).
//   Run: node packages/wasm-core/tests/test_machine_gcode.mjs
import createSlicer from '../../engine/src/slicer_core.js'
import createSlicerMt from '../../engine/src/slicer_core.mt.js'

let failures = 0
const ok = (condition, message) => {
  console.log(`  ${{ true: 'ok' }[condition] ?? 'FAIL'}: ${message}`)
  if (!condition) failures++
}

function boxTris(ox, oy, oz, sx, sy, sz) {
  const c = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v => [v[0]+ox, v[1]+oy, v[2]+oz])
  const q = (a,b,cc,d) => [[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]]
  return [...q(0,1,2,3), ...q(4,5,6,7), ...q(0,1,5,4), ...q(1,2,6,5), ...q(2,3,7,6), ...q(3,0,4,7)]
}
function trisToSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length*50); buf.writeUInt32LE(tris.length, 80); let off = 84
  for (const t of tris) { off += 12; for (const p of t) { buf.writeFloatLE(p[0],off); buf.writeFloatLE(p[1],off+4); buf.writeFloatLE(p[2],off+8); off += 12 } buf.writeUInt16LE(0,off); off += 2 }
  return new Uint8Array(buf)
}
const cube = trisToSTL(boxTris(-10, -10, 0, 20, 20, 2))
const A = boxTris(-13, -5, 0, 10, 10, 2), B = boxTris(3, -5, 0, 10, 10, 2)
const twoBoxes = trisToSTL([...A, ...B])

const base = { layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15,
               nozzle_temp: 210, bed_temp: 60, bed_width: 200, bed_depth: 200, skirt_loops: 1, skirt_distance: 2 }
const slicer = await createSlicer()
const slice = (p, stl = cube) => slicer.slice(stl, JSON.stringify(p), () => {})
// The text between a layer marker and the next one.
const layerText = (gcode, marker) => {
  const at = gcode.indexOf(marker)
  if (at < 0) return ''
  const next = gcode.indexOf('\n; LAYER', at + marker.length)
  if (next < 0) return gcode.slice(at)
  return gcode.slice(at, next)
}
const count = (text, pattern) => (text.match(pattern) ?? []).length

console.log('[temperatures: nothing sent, nothing switched]')
const plain = slice(base)
ok(!plain.error, `slices (${plain.error ?? 'no error'})`)
ok(!/set nozzle temperature|set bed temperature/.test(plain.gcode), 'no second-layer switch without first-layer temperatures')

console.log('[temperatures: the first layer runs at its own, the second switches]')
const firstLayer = { ...base, first_layer_nozzle_temp: 215, first_layer_bed_temp: 65 }
const switched = slice(firstLayer)
ok(/^M104 S215$/m.test(switched.gcode) && /^M190 S65$/m.test(switched.gcode), 'the preamble heats to the first-layer temperatures')
const layer1 = layerText(switched.gcode, '; LAYER 1 ')
ok(/^G1 Z[\d.]+ F\d+\nM104 S210 ; set nozzle temperature\nM140 S60 ; set bed temperature$/m.test(layer1),
   'the second layer sets the print temperatures right after its Z move')
ok(count(switched.gcode, /; set nozzle temperature$/gm) === 1 && count(switched.gcode, /; set bed temperature$/gm) === 1,
   'the switch is written once')
const sameTemps = slice({ ...base, first_layer_nozzle_temp: 210, first_layer_bed_temp: 60 })
ok(!/set nozzle temperature|set bed temperature/.test(sameTemps.gcode), 'equal temperatures write no switch')

console.log('[temperatures: with a raft the raft\'s second layer is the second layer]')
const rafted = slice({ ...firstLayer, raft_layers: 2 })
const raft1 = rafted.gcode.slice(rafted.gcode.indexOf('; raft 1 '), rafted.gcode.indexOf('; LAYER 0 '))
ok(raft1.includes('M104 S210 ; set nozzle temperature'), 'the switch is in the second raft layer')
ok(count(rafted.gcode, /; set nozzle temperature$/gm) === 1, 'and nowhere else')

console.log('[temperatures: the flavor formats the switch]')
const reprap = slice({ ...firstLayer, gcode_flavor: 'reprapfirmware' })
ok(layerText(reprap.gcode, '; LAYER 1 ').includes('G10 S210 ; set nozzle temperature'), 'RepRapFirmware sets the nozzle with G10')
const mach3 = slice({ ...firstLayer, gcode_flavor: 'mach3' })
ok(layerText(mach3.gcode, '; LAYER 1 ').includes('M104 P210 ; set nozzle temperature'), 'Mach3 takes the temperature as P')

console.log('[temperatures: multi-material]')
const mmParams = { ...base, extruder_count: 2, mm_group_split: A.length, extruder_nozzle_temp: [210, 230],
                   extruder_first_layer_temp: [215, 235], first_layer_nozzle_temp: 215 }
const semm = slice(mmParams, twoBoxes)
ok(!semm.error, `slices (${semm.error ?? 'no error'})`)
const semmLayer1 = layerText(semm.gcode, '; LAYER 1 ')
ok(/M104 S\d+ ; set nozzle temperature/.test(semmLayer1) && !/ ; set nozzle temperature[\s\S]* ; set nozzle temperature/.test(semmLayer1)
   && !/M104 S\d+ T\d/.test(semmLayer1), 'one nozzle: only the loaded tool switches, without a tool word')
const multi = slice({ ...mmParams, single_extruder_multi_material: false }, twoBoxes)
const multiLayer1 = layerText(multi.gcode, '; LAYER 1 ')
ok(multiLayer1.includes('M104 S210 T0 ; set nozzle temperature') && multiLayer1.includes('M104 S230 T1 ; set nozzle temperature'),
   'separate extruders: every used tool switches, named')
const layer0 = layerText(multi.gcode, '; LAYER 0 ')
ok(/^T1\n(?:G1 E[\d.]+ F\d+ ; PETG extra unretract\n)?M109 S235$/m.test(layer0) && !/^M109 S230$/m.test(layer0),
   'a first-layer tool change heats to the tool\'s first-layer temperature (235, not 230)')

console.log('[temperatures: with a printer\'s custom start G-code]')
// The settings as a project_settings.config holds them (strings), the way deriveKernelParams sends them.
const template = (extra) => ({ ...firstLayer, machine_start_gcode: '; start',
  placeholder_config: JSON.stringify({ machine_start_gcode: '; start', curr_bed_type: 'High Temp Plate',
    hot_plate_temp_initial_layer: ['65'], hot_plate_temp: ['60'], nozzle_temperature_initial_layer: ['215'], nozzle_temperature: ['210'],
    printable_area: ['0x0', '200x0', '200x200', '0x200'], ...extra }) })
const marlinStart = slice(template({}))
ok(!marlinStart.error, `slices (${marlinStart.error ?? 'no error'})`)
// Upstream's writer believes the bed is at 65 after the start block (it wrote M190 S65), so the second layer sets 60.
ok(layerText(marlinStart.gcode, '; LAYER 1 ').includes('M140 S60 ; set bed temperature'), 'the bed switches from the start block\'s 65 to 60')
const sameBed = slice(template({ hot_plate_temp_initial_layer: ['60'] }))
ok(!layerText(sameBed.gcode, '; LAYER 1 ').includes('M140'), 'a bed the start block already set to 60 is not set again')
ok(layerText(marlinStart.gcode, '; LAYER 1 ').includes('M104 S210 ; set nozzle temperature'), 'the nozzle switches after a template start')
const klipperStart = slice({ ...template({ gcode_flavor: 'klipper' }), gcode_flavor: 'klipper' })
ok(!/^M190 /m.test(klipperStart.gcode.slice(0, klipperStart.gcode.indexOf('; machine_start_gcode'))), 'Klipper: no bed temperature before the start block')
ok(layerText(klipperStart.gcode, '; LAYER 1 ').includes('M140 S60 ; set bed temperature'),
   'Klipper: the second layer always sets the bed (upstream never recorded one)')
const chamber = slice(template({ activate_chamber_temp_control: ['1'], chamber_temperature: ['45'] }))
const startAt = chamber.gcode.indexOf('; machine_start_gcode')
ok(/M191 S45 ;set chamber_temperature and wait for it to be reached\n; machine_start_gcode/.test(chamber.gcode.slice(startAt - 80, startAt + 25)),
   'a filament asking for chamber control heats the chamber right before the start block')

console.log('[flavor: the modes block]')
ok(/^G21 ; mm\nG90 ; absolute XYZ\nM83 ; relative E$/m.test(plain.gcode), 'no flavor: the kernel\'s own modes')
const marlin = slice({ ...base, gcode_flavor: 'marlin2' })
ok(/^G90\nG21\nM83 ; use relative distances for extrusion$/m.test(marlin.gcode), 'a flavor: upstream\'s preamble')
const machinekit = slice({ ...base, gcode_flavor: 'machinekit' })
ok(!/^M8[23] /m.test(machinekit.gcode), 'Machinekit has no E mode command')
ok(/^M2 ; end of program$/m.test(machinekit.gcode), 'Machinekit ends with M2')

console.log('[flavor: pressure advance]')
const pa = (flavor) => slice({ ...base, gcode_flavor: flavor, enable_pressure_advance: true, pressure_advance: 0.04 }).gcode
ok(pa('klipper').includes('SET_PRESSURE_ADVANCE ADVANCE=0.04; Override pressure advance value'), 'Klipper: SET_PRESSURE_ADVANCE')
ok(pa('reprapfirmware').includes('M572 D0 S0.04; Override pressure advance value'), 'RepRapFirmware: M572')
ok(pa('marlin2').includes('M900 K0.04; Override pressure advance value'), 'Marlin: M900')
ok(!pa('klipper').includes('M900'), 'Klipper gets no M900')

console.log('[flavor: absolute E]')
const absolute = slice({ ...base, gcode_flavor: 'marlin2', use_relative_e_distances: false, retract_length: 0.8 })
ok(/^M82 ; use absolute distances for extrusion\nG92 E0 ; reset extrusion distance$/m.test(absolute.gcode), 'M82 and a reset')
// Replay the E words: absolute mode must give the same extruded total as the relative slice.
const totalE = (gcode, absoluteMode) => {
  let position = 0, total = 0
  for (const line of gcode.split('\n')) {
    if (/^G92 E0/.test(line)) { position = 0; continue }
    const match = /^G[0123] .*E(-?[\d.]+)/.exec(line)
    if (!match) continue
    const word = Number(match[1])
    let delta = word
    if (absoluteMode) { delta = word - position; position = word }
    if (delta > 0) total += delta
  }
  return total
}
const relativeE = slice({ ...base, gcode_flavor: 'marlin2', retract_length: 0.8 })
const absTotal = totalE(absolute.gcode.slice(absolute.gcode.indexOf('; LAYER 0')), true)
const relTotal = totalE(relativeE.gcode.slice(relativeE.gcode.indexOf('; LAYER 0')), false)
ok(Math.abs(absTotal - relTotal) < 1e-3 * relTotal, `absolute E extrudes what relative E does (${absTotal.toFixed(3)} vs ${relTotal.toFixed(3)} mm)`)
const absoluteBody = absolute.gcode.slice(absolute.gcode.indexOf('; LAYER 0'))
ok(/^G1 E-?[\d.]+ F\d+\nG92 E0\n/m.test(absoluteBody) && !/^G1 E-0\.8000 F/m.test(absoluteBody),
   'a retraction writes the retracted position and resets E (no relative E-0.8 move)')
ok(Math.abs(absolute.stats.filament_mm - relativeE.stats.filament_mm) < 1e-6, 'the filament total is the same')

console.log('[flavor: firmware retraction]')
const firmware = slice({ ...base, gcode_flavor: 'klipper', use_firmware_retraction: true, retract_length: 0 })
ok(/^G10 ; retract$/m.test(firmware.gcode) && /^G11 ; unretract$/m.test(firmware.gcode), 'G10/G11, even with a zero length')
ok(!/^G1 E-/m.test(firmware.gcode), 'no E-move retraction')

console.log('[z_offset]')
const offset = slice({ ...base, z_offset: 0.15 })
ok(/^G1 Z0\.350 F\d+$/m.test(layerText(offset.gcode, '; LAYER 0 ')), 'the first layer moves to 0.2 + 0.15')
ok(/^; LAYER 0 Z0\.200$/m.test(offset.gcode), 'the layer marker keeps the print height')

console.log('[machine limits]')
const envelope = [1000, 1100, 200, 5000, 300, 310, 12, 25, 1500, 1200, 3000, 8, 9, 0.4, 2.5, 0.013]
const marlinLimits = slice({ ...base, gcode_flavor: 'marlin2', machine_envelope: envelope }).gcode
ok(marlinLimits.includes('M201 X1000 Y1100 Z200 E5000\nM203 X300 Y310 Z12 E25\nM204 P1500 R1200 T3000 ; sets acceleration (P, T) and retract acceleration (R), mm/sec^2\nM205 X8.00 Y9.00 Z0.40 E2.50 ; sets the jerk limits, mm/sec\nM205 J0.013 ; Junction Deviation'),
   'Marlin 2: M201/M203/M204 P R T/M205 and junction deviation')
const rrfLimits = slice({ ...base, gcode_flavor: 'reprapfirmware', machine_envelope: envelope }).gcode
ok(rrfLimits.includes('M203 X18000 Y18600 Z720 E1500') && rrfLimits.includes('M566 X480.00 Y540.00 Z24.00 E150.00'), 'RepRap: mm/min')
ok(!slice({ ...base, gcode_flavor: 'klipper', machine_envelope: envelope }).gcode.includes('M201'), 'Klipper: none')

console.log('[speeds: per role]')
// The feeds of each ;TYPE: section of one layer (role tags on): kernel type 1 is every wall, 2 sparse infill, 3 solid.
const feedsByType = (gcode, marker) => {
  const out = {}
  let type = ''
  let modal = 0   // F is modal: an extrusion line without it runs at the last one set (the cooling filter moves it to its own line)
  for (const line of layerText(gcode, marker).split('\n')) {
    if (line.startsWith(';TYPE:')) { type = line.slice(6); continue }
    const feedWord = / F(\d+)/.exec(line)
    if (/^G[0123] /.test(line) && feedWord) modal = Number(feedWord[1])
    if (/^G1 X.* E[\d.]+/.test(line)) (out[type] ??= new Set()).add(modal)
  }
  return out
}
const tall = trisToSTL(boxTris(-10, -10, 0, 20, 20, 6))
const roles = { ...base, gcode_role_tags: true, wall_loops: 2, print_speed: 50, first_layer_speed: 20, slow_down_layer_time: 0,
                inner_wall_speed: 100, sparse_infill_speed: 200, internal_solid_infill_speed: 150, initial_layer_infill_speed: 40 }
const roleSlice = slice(roles, tall)
const mid = feedsByType(roleSlice.gcode, '; LAYER 10 ')
ok(mid['Outer wall']?.has(3000) && mid['Outer wall']?.has(6000), `walls: outer 50 and inner 100 mm/s (${[...(mid['Outer wall'] ?? [])]})`)
ok(mid['Sparse infill']?.has(12000) && mid['Sparse infill'].size === 1, `sparse infill 200 mm/s (${[...(mid['Sparse infill'] ?? [])]})`)
const first = feedsByType(roleSlice.gcode, '; LAYER 0 ')
ok([...(first['Outer wall'] ?? [])].every(feed => feed === 1200), `first layer walls at initial_layer_speed (${[...(first['Outer wall'] ?? [])]})`)
ok([...(first['Internal solid infill'] ?? [])].every(feed => feed === 2400), `first layer solid at initial_layer_infill_speed (${[...(first['Internal solid infill'] ?? [])]})`)
const legacyFeeds = feedsByType(slice({ ...base, gcode_role_tags: true, print_speed: 50, slow_down_layer_time: 0 }, tall).gcode, '; LAYER 10 ')
ok(Object.values(legacyFeeds).every(set => [...set].every(feed => feed === 3000)), 'no per-role speed sent: every role at print_speed')
const ramp = slice({ ...roles, slow_down_layers: 4 }, tall)
const rampWalls = [...(feedsByType(ramp.gcode, '; LAYER 2 ')['Outer wall'] ?? [])].sort((a, b) => a - b)
// layer 2 of 4: halfway from 20 to 50 (outer) and from 20 to 100 (inner)
ok(rampWalls.includes(2100) && rampWalls.includes(3600), `slow_down_layers ramps the walls up (${rampWalls})`)

console.log('[speeds: small perimeters]')
// A 3mm column's wall loops (~12mm) are within 2*pi*4 = 25mm: they print at small_perimeter_speed (20 mm/s).
const column = trisToSTL(boxTris(-1.5, -1.5, 0, 3, 3, 3))
const small = slice({ ...roles, small_perimeter_speed: 20, small_perimeter_threshold: 4 }, column)
const smallWalls = feedsByType(small.gcode, '; LAYER 5 ')['Outer wall'] ?? new Set()
ok([...smallWalls].every(feed => feed === 1200) && smallWalls.size > 0, `small loops at 20 mm/s (${[...smallWalls]})`)
const bigWalls = feedsByType(slice({ ...roles, small_perimeter_speed: 20, small_perimeter_threshold: 4 }, tall).gcode, '; LAYER 10 ')['Outer wall'] ?? new Set()
ok(!bigWalls.has(1200), `a 20mm box's loops are not small (${[...bigWalls]})`)

console.log('[acceleration and jerk]')
const motion = { ...roles, default_acceleration: 2000, outer_wall_acceleration: 1000, inner_wall_acceleration: 3000,
                 travel_acceleration: 5000, initial_layer_acceleration: 500, default_jerk: 8, outer_wall_jerk: 5 }
const marlinMotion = slice({ ...motion, gcode_flavor: 'marlin2' }, tall).gcode
const mid2 = layerText(marlinMotion, '; LAYER 10 ')
ok(/^M204 P1000 ; adjust acceleration$/m.test(mid2) && /^M204 P3000 ; adjust acceleration$/m.test(mid2), 'Marlin 2: M204 P per wall role')
ok(/^M204 T5000 ; adjust acceleration$/m.test(marlinMotion), 'Marlin 2: travel acceleration with its own T word')
ok(/^M204 P500 ; adjust acceleration$/m.test(layerText(marlinMotion, '; LAYER 0 ')), 'the first layer at initial_layer_acceleration')
ok(/^M205 X5 Y5 ; adjust jerk$/m.test(mid2) && /^M205 X8 Y8 ; adjust jerk$/m.test(mid2), 'jerk per role (outer 5, default 8)')
ok(!/M204|M205/.test(slice(roles, tall).gcode), 'no default_acceleration / default_jerk: no command')
const klipperMotion = slice({ ...motion, gcode_flavor: 'klipper', accel_to_decel_enable: true, accel_to_decel_factor: 50 }, tall).gcode
ok(/^SET_VELOCITY_LIMIT ACCEL=1000 ACCEL_TO_DECEL=500 SQUARE_CORNER_VELOCITY=5 ; adjust VELOCITY_LIMIT\(accel\/jerk\)$/m.test(klipperMotion),
   'Klipper: one SET_VELOCITY_LIMIT for acceleration and jerk')
const clamped = slice({ ...motion, gcode_flavor: 'marlin2', machine_max_acceleration_extruding: 1500 }, tall).gcode
ok(!/^M204 P(2000|3000)/m.test(clamped) && /^M204 P1500 /m.test(clamped), 'print acceleration clamped to machine_max_acceleration_extruding')
const slicerMtMotion = await createSlicerMt()
ok(slicerMtMotion.slice(tall, JSON.stringify({ ...motion, gcode_flavor: 'marlin2' }), () => {}).gcode === marlinMotion,
   'st == mt with per-role speeds and motion (the dedupe state chains across the parallel writers)')

console.log('[cooling: upstream CoolingBuffer over the layers]')
// The filter runs with a printer's settings (placeholder_config): the fan by layer time, the slowdown of a short layer.
const coolingTemplate = (extra, overrides = {}) => ({ ...base, gcode_role_tags: true, print_speed: 50, machine_start_gcode: '; start', ...overrides,
  placeholder_config: JSON.stringify({ machine_start_gcode: '; start', printable_area: ['0x0', '200x0', '200x200', '0x200'],
    fan_min_speed: ['20'], fan_max_speed: ['100'], fan_cooling_layer_time: ['60'], slow_down_layer_time: ['8'],
    slow_down_min_speed: ['10'], close_fan_the_first_x_layers: ['1'], full_fan_speed_layer: ['0'], slow_down_for_layer_cooling: ['1'],
    ...extra }) })
const cooled = slice(coolingTemplate({}), tall)
ok(!cooled.error, `slices (${cooled.error ?? 'no error'})`)
ok(!/_EXTRUDE_SET_SPEED|_EXTRUDE_END|_EXTERNAL_PERIMETER|_FAN_START|_FAN_END/.test(cooled.gcode), 'the filter removes its markers')
// The filter writes a layer's fan command first in that layer's text, i.e. right before its marker.
const fanBefore = (gcode, marker) => {
  const fans = [...gcode.slice(0, gcode.indexOf(marker)).matchAll(/^M106 S(\d+)/gm)]
  return Number(fans.at(-1)?.[1] ?? -1)
}
ok(fanBefore(cooled.gcode, '; LAYER 0 ') === 0, 'the first layer runs without the fan (close_fan_the_first_x_layers)')
ok(fanBefore(cooled.gcode, '; LAYER 1 ') > 0, `the fan starts on the second layer (${fanBefore(cooled.gcode, '; LAYER 1 ')})`)
ok(fanBefore(cooled.gcode, '; LAYER 10 ') > 240, `a sparse layer shorter than slow_down_layer_time runs the fan at about full (${fanBefore(cooled.gcode, '; LAYER 10 ')})`)
const solidFan = fanBefore(cooled.gcode, '; LAYER 2 ')
ok(solidFan > 51 && solidFan < 255, `a longer layer interpolates between fan_min_speed and fan_max_speed (${solidFan})`)
const slowFeeds = [...(feedsByType(cooled.gcode, '; LAYER 10 ')['Outer wall'] ?? [])]
ok(slowFeeds.length > 0 && slowFeeds.every(feed => feed < 3000), `a short layer is slowed below print_speed (${slowFeeds})`)
// Two legs and a slab across them: the slab's underside is a bridge, which opens the overhang fan region. The
//  overhang fan only takes over when it is faster than the layer's own fan (CoolingBuffer: overhang_fan_speed >
//  fan_speed_new), so the layer fan is capped at 50% here.
const bridgeModel = trisToSTL([...boxTris(-12, -4, 0, 4, 8, 3), ...boxTris(8, -4, 0, 4, 8, 3), ...boxTris(-12, -4, 3, 24, 8, 1.2)])
const bridged = slice(coolingTemplate({ enable_overhang_bridge_fan: ['1'], overhang_fan_speed: ['77'], fan_max_speed: ['50'] }), bridgeModel)
ok(!bridged.error && /^M106 S196 ; enable fan$/m.test(bridged.gcode), 'the bridge prints under overhang_fan_speed (77% = S196)')
const noBridgeFan = slice(coolingTemplate({ enable_overhang_bridge_fan: ['0'], overhang_fan_speed: ['77'], fan_max_speed: ['50'] }), bridgeModel)
ok(!/^M106 S196 /m.test(noBridgeFan.gcode), 'not with enable_overhang_bridge_fan off')
const slicerMtCooling = await createSlicerMt()
ok(slicerMtCooling.slice(tall, JSON.stringify(coolingTemplate({})), () => {}).gcode === cooled.gcode, 'st == mt with the cooling filter')

console.log('[layer templates]')
// before_layer_change_gcode ahead of the layer's Z move, time_lapse_gcode and layer_change_gcode after it, the first
//  filament's filament_start_gcode on the first layer — upstream's GCode::process_layer order.
const layerTemplates = (extra) => ({ ...base, machine_start_gcode: '; start',
  placeholder_config: JSON.stringify({ machine_start_gcode: '; start', printable_area: ['0x0', '200x0', '200x200', '0x200'],
    before_layer_change_gcode: '; BEFORE [layer_num] {layer_z}', layer_change_gcode: '; AFTER [layer_num] {layer_z} mass {extruded_weight_total > 0}',
    time_lapse_gcode: '; TIMELAPSE [layer_num]', filament_start_gcode: ['; FILAMENT START [filament_extruder_id]'],
    filament_density: ['1.24'], ...extra }) })
const templated = slice(layerTemplates({}), tall)
ok(!templated.error, `slices (${templated.error ?? 'no error'})`)
ok(/^; BEFORE 3 0\.8\nG1 Z0\.800 F\d+\n; TIMELAPSE 3\n; AFTER 3 0\.8 mass true$/m.test(layerText(templated.gcode, '; LAYER 3 ')),
   'layer 3: before, the Z move, timelapse, layer change')
ok(/^; AFTER 0 0\.2 mass false\n; FILAMENT START 0$/m.test(layerText(templated.gcode, '; LAYER 0 ')), 'the first layer starts its filament after the layer change')
ok(!/_LAYER_CHANGE_SLOT/.test(templated.gcode), 'no slot line is left')
const broken = slice(layerTemplates({ layer_change_gcode: '; [no_such_variable]' }), tall)
ok(typeof broken.error === 'string' && broken.error.startsWith('CUSTOM_GCODE_ERROR: layer_change_gcode'), `a layer template error fails the slice (${String(broken.error).split('\n')[0]})`)
const slicerMtLayers = await createSlicerMt()
ok(slicerMtLayers.slice(tall, JSON.stringify(layerTemplates({})), () => {}).gcode === templated.gcode, 'st == mt with layer templates')

console.log('[progress placeholders]')
const withM73 = slice({ ...layerTemplates({ file_start_gcode: ';TIME:{print_time_sec}' }), disable_m73: false }, tall)
ok(withM73.gcode.startsWith(';TIME:@PRINT_TIME_SEC@\n'), 'file_start_gcode is the very first line, its totals left as upstream\'s tags')
ok(withM73.gcode.includes(';_GP_FIRST_LINE_M73_PLACEHOLDER\n') && withM73.gcode.includes(';_GP_LAST_LINE_M73_PLACEHOLDER\n'),
   'disable_m73 off: the first and last M73 placeholders')
ok(!slice(layerTemplates({}), tall).gcode.includes('_GP_FIRST_LINE_M73'), 'no disable_m73 sent: no placeholder')
ok(withM73.gcode.startsWith(';TIME:@PRINT_TIME_SEC@\n;_GP_THUMBNAILS_PLACEHOLDER\n'),
   'the thumbnails placeholder follows file_start_gcode (the viewer replaces it with the images on export)')
const slicerMtM73 = await createSlicerMt()
ok(slicerMtM73.slice(tall, JSON.stringify({ ...layerTemplates({ file_start_gcode: ';TIME:{print_time_sec}' }), disable_m73: false }), () => {}).gcode === withM73.gcode,
   'st == mt with the placeholders')

console.log('[tool changes: upstream\'s sequence with custom G-code]')
// GCode::set_extruder / append_tcr: the outgoing filament's filament_end_gcode, change_filament_gcode with the variables
//  it reads, the T command it does not write itself, the incoming filament's filament_start_gcode.
const toolchangeConfig = (extra) => JSON.stringify({ machine_start_gcode: '; start', curr_bed_type: 'High Temp Plate',
  hot_plate_temp_initial_layer: ['65', '65'], hot_plate_temp: ['60', '60'], nozzle_temperature_initial_layer: ['215', '235'],
  nozzle_temperature: ['210', '230'], filament_type: ['PLA', 'PETG'], filament_colour: ['#FFFFFF', '#000000'],
  filament_diameter: ['1.75', '1.75'], flush_volumes_matrix: ['0', '270', '270', '0'], enable_prime_tower: '1',
  filament_end_gcode: ['; END A [layer_num]', '; END B [layer_num]'], filament_start_gcode: ['; START A', '; START B'],
  change_filament_gcode: '; CHANGE [previous_extruder]->[next_extruder] count [toolchange_count] flush {flush_length_1} temp [new_filament_temp] old [old_filament_temp] z [toolchange_z]',
  printable_area: ['0x0', '200x0', '200x200', '0x200'], ...extra })
const toolchangeParams = (extra, params = {}) => ({ ...base, extruder_count: 2, mm_group_split: A.length, machine_start_gcode: '; start',
  flush_volumes_matrix: [0, 270, 270, 0], placeholder_config: toolchangeConfig(extra), ...params })
const changed = slice(toolchangeParams({}), twoBoxes)
ok(!changed.error, `slices (${changed.error ?? 'no error'})`)
const beforeLayer0 = changed.gcode.slice(0, changed.gcode.indexOf('; LAYER 0 '))
ok(/^; CHANGE -1->0 count 1 flush 0 temp 215 old 0 z 0\n;_FORCE_RESUME_FAN_SPEED\nT0\n/m.test(beforeLayer0),
   'the first selection after the start block runs the change sequence with no previous filament')
const layer1Change = layerText(changed.gcode, '; LAYER 1 ')
ok(/^; END B 1\n; CHANGE 1->0 count 3 flush [\d.]+ temp 210 old 230 z 0.4\n(?:M106[^\n]*\n)?T0\n; START A$/m.test(layer1Change),
   `a change in a layer: end, change with the pair's values, T, start (${/; CHANGE 1->0[^\n]*/.exec(layer1Change)?.[0]})`)
ok(Number(/; CHANGE 1->0 count 3 flush ([\d.]+)/.exec(layer1Change)?.[1]) > 0, 'the purge reaches flush_length_1')
ok(!/ ; PETG extra unretract| \(placeholder — not expanded\)/.test(changed.gcode), 'no kernel-only toolchange lines on the template path')
// No table from the host: the printer's 4x4 schema default resized to two filaments (upstream's resize keeps the pair's
//  280 mm³) times the default flush_multiplier 0.3 is 84 mm³, which a tower change raises to its 100 mm³ minimum:
//  41.6 mm of 1.75 mm filament, in one part.
const untabled = slice(toolchangeParams({ flush_volumes_matrix: undefined }, { flush_volumes_matrix: undefined }), twoBoxes)
ok(/; CHANGE 0->1 count 2 flush 41\.57\d* /.test(untabled.gcode), `without a purge table the default one is used (${/; CHANGE 0->1[^\n]*/.exec(untabled.gcode)?.[0]})`)
const towerChanged = slice(toolchangeParams({}, { wipe_tower_real: true }), twoBoxes)
ok(!towerChanged.error && !towerChanged.gcode.includes('placeholder — not expanded') && towerChanged.gcode.includes('; END A 0'),
   'with the real wipe tower its placeholder lines give way to the sequence')
const selfChanging = slice(toolchangeParams({ change_filament_gcode: '; swap\nT[next_extruder]' }), twoBoxes)
ok(count(selfChanging.gcode, /^T\d+$/gm) === count(selfChanging.gcode, /^; swap$/gm) && count(selfChanging.gcode, /^; swap$/gm) > 1,
   'a template that writes the T command gets no second one')
const bambu = slice(toolchangeParams({ printer_model: 'Bambu Lab A1 mini' }), twoBoxes)
ok(!/; CHANGE -1->/.test(bambu.gcode) && /^; CHANGE 0->1 count 1 [^\n]*\n(?:M106[^\n]*\n)?M1020 S1 H0$/m.test(bambu.gcode),
   'Bambu Lab: the first filament is loaded by the start block, and a change without a T in the template is M1020')
const noTower = slice(toolchangeParams({ enable_prime_tower: '0', change_filament_gcode: '' }, { enable_prime_tower: false }), twoBoxes)
ok(/^T1\nM104 S235 ; set nozzle temperature\n; START B$/m.test(noTower.gcode), 'one nozzle and no tower: the new filament\'s temperature after the T command')
const brokenChange = slice(toolchangeParams({ change_filament_gcode: '[no_such_variable]' }), twoBoxes)
ok(String(brokenChange.error).startsWith('CUSTOM_GCODE_ERROR: change_filament_gcode'), `a change template error fails the slice (${String(brokenChange.error).split('\n')[0]})`)
const slicerMtChanges = await createSlicerMt()
ok(slicerMtChanges.slice(twoBoxes, JSON.stringify(toolchangeParams({})), () => {}).gcode === changed.gcode, 'st == mt with tool changes')

console.log('[temperatures: st == mt]')
const slicerMt = await createSlicerMt()
const mt = slicerMt.slice(cube, JSON.stringify(firstLayer), () => {})
ok(mt.gcode === switched.gcode, 'the threaded kernel writes the same G-code')

if (failures) {
  console.log(`\n${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL MACHINE G-CODE CHECKS PASSED')
