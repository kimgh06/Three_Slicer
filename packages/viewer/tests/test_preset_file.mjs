// OrcaSlicer preset files: the single-preset .json codec (engine) and the .orca_printer bundle (viewer).
//
// The fixture is a REAL upstream vendor file, copied into the package rather than read out of `slicers/`. That
// checkout is untracked and optional — test_loaders.mjs reads its fixtures from there and is a permanent failure
// on any tree that does not have it, which is the mistake this file is written not to repeat.
//   run: node packages/viewer/test_preset_file.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writePresetFile, readPresetFile, presetOptionKeys,
         printerSettings, printerKeys, printerDefaultBedType, filamentPresets, printersByVendor } from '../../engine/src/settings.js'
// The bundle codec moved with the viewer into the permissive package; this test stays here because it also
//  exercises the vendor catalog (printerSettings/printerKeys), which is AGPL data.
import { writePrinterBundle, readPresetArchive, isPresetArchive } from '../../../viewer-package/src/core/preset_bundle.js'
import { schema } from '../../engine/src/data.js'

const schemaHasNoDefault = (key) => schema[key]?.default === undefined

const here = join(dirname(fileURLToPath(import.meta.url)), '..')   // the package root, one above tests/
let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}
const applyPreset = (base, preset, keys) => {
  const next = { ...base }
  for (const key of keys) delete next[key]
  return Object.assign(next, preset)
}

const PROFILE = 'Bambu Lab X1 Carbon 0.4 nozzle'
const machine = applyPreset({}, printerSettings(PROFILE), printerKeys)

console.log('\n[preset file: the key lists come from upstream, not from the catalog]')
// printers.json holds the 21 columns the kernel reads. A machine preset another slicer accepts needs upstream's
//  own list, which is an order of magnitude bigger — writing the catalog's 21 would produce a file missing
//  almost everything a printer preset is supposed to say.
check('machine keys are the upstream list, not the catalog columns',
  presetOptionKeys('machine').length > 100, String(presetOptionKeys('machine').length))
check('process and filament lists exist too',
  presetOptionKeys('process').length > 300 && presetOptionKeys('filament').length > 100)
check('an unknown type is rejected', (() => {
  try { presetOptionKeys('nope'); return false } catch { return true }
})())

console.log('\n[preset file: written flattened, in upstream encoding]')
const file = writePresetFile(machine, { type: 'machine', name: 'My X1C' })
check('carries the envelope upstream writes', file.type === 'machine' && file.from === 'User' && file.name === 'My X1C')
// No `inherits`: upstream saves a derived preset as the diff against its parent, which only means something next
//  to the vendor database it came from. A file handed to someone else has to stand alone.
// `inherits` is IN upstream's printer_options list, so a writer that just walks that list emits it — as an empty
//  string, pointing a reader at a parent named "". It has to be excluded by name.
check('no inherits — the file is self-contained', !('inherits' in file))
// "Complete" means every option that has a value to write. Two machine keys carry no schema default
//  (extruder_printable_area, thumbnails_format), and there is nothing to invent for them.
const absent = presetOptionKeys('machine').filter(key => !(key in file))
check('every option with a default is written',
  absent.every(key => key === 'inherits' || schemaHasNoDefault(key)), absent.join(' '))
// The same string encoding project_settings.config uses, because it is the same writer upstream (save_to_json).
check('points are written "XxY"', Array.isArray(file.printable_area) && file.printable_area[1] === '256x0',
  JSON.stringify(file.printable_area))
check('numbers are written as strings', file.printable_height === '250', JSON.stringify(file.printable_height))
check('per-extruder options stay arrays', Array.isArray(file.nozzle_diameter) && file.nozzle_diameter[0] === '0.4')

console.log('\n[preset file: round trip]')
const back = readPresetFile(file)
check('reads back as a machine preset', back.type === 'machine' && back.name === 'My X1C')
check('no unknown keys dropped', back.skipped.length === 0, back.skipped.join(' '))
const drift = Object.keys(machine).filter(k => JSON.stringify(machine[k]) !== JSON.stringify(back.settings[k]))
check('every value survives the round trip', drift.length === 0,
  drift.map(k => `${k}: ${JSON.stringify(machine[k])} -> ${JSON.stringify(back.settings[k])}`).join(' | '))

console.log('\n[preset file: a real upstream file is a DIFF against its parent]')
const upstream = JSON.parse(readFileSync(join(here, 'testing_files', 'upstream_machine_preset.json'), 'utf8'))
check('the fixture is a vendor machine preset', upstream.type === 'machine' && !!upstream.inherits)

const orphan = readPresetFile(upstream)
check('an unresolved parent is reported, not thrown', orphan.missingParent === upstream.inherits)
// The concrete cost of ignoring `inherits`: this file never states its own bed. Reading it standalone gives a
//  printer with no printable area at all, which is why the parent lookup exists.
check('...and without the parent the bed is missing',
  orphan.settings.printable_area === undefined && orphan.settings.printable_height === undefined)

const resolved = readPresetFile(upstream, { resolveParent: (name) => printerSettings(name) })
check('the parent resolves out of the shipped catalog', resolved.missingParent === null)
// The parent is an abstract preset (`instantiation: false`): resolvable by name, never offered for picking.
check('...but the picker does not list it',
  !Object.values(printersByVendor).some(models => upstream.inherits in models))
check('...and the bed comes back', Array.isArray(resolved.settings.printable_area) && resolved.settings.printable_height === 250,
  JSON.stringify(resolved.settings.printable_area))
// The file is the diff, so where both carry a key the file must win.
check('the file overrides the parent where both set a key',
  JSON.stringify(resolved.settings.nozzle_diameter) === JSON.stringify(orphan.settings.nozzle_diameter))

console.log('\n[preset bundle: .orca_printer]')
check('the archive extensions are recognised',
  ['a.orca_printer', 'b.orca_bundle', 'c.orca_filament', 'd.zip'].every(isPresetArchive) && !isPresetArchive('e.json'))
const zip = writePrinterBundle({
  machine: { name: PROFILE, settings: machine },
  process: { name: 'Fine', settings: { layer_height: 0.12, wall_loops: 3 } },
  filament: { name: 'My PLA', settings: { nozzle_temperature: [215] } },
}, { timestamp: 'test' })
check('produces a zip', zip.byteLength > 0)

const archive = readPresetArchive(zip, { resolveParent: (name) => printerSettings(name) })
check('the manifest is upstream-shaped',
  archive.manifest?.bundle_type === 'printer config bundle' && archive.manifest.printer_preset_name === PROFILE)
check('the manifest lists members per type',
  archive.manifest.printer_config.length === 1 && archive.manifest.process_config.length === 1
  && archive.manifest.filament_config.length === 1)
check('members are grouped by their own type field',
  archive.machine.length === 1 && archive.process.length === 1 && archive.filament.length === 1)
check('no read errors', archive.errors.length === 0, archive.errors.join(' | '))
const bundled = archive.machine[0]
const bundleDrift = Object.keys(machine).filter(k => JSON.stringify(machine[k]) !== JSON.stringify(bundled.settings[k]))
check('the machine preset survives the bundle', bundleDrift.length === 0, bundleDrift.join(' '))
check('the process preset survives too', archive.process[0].settings.layer_height === 0.12
  && archive.process[0].settings.wall_loops === 3)
// A name with a slash would invent a folder inside the zip.
const risky = writePrinterBundle({ machine: { name: 'a/b: c', settings: machine } })
const riskyNames = Object.keys(readPresetArchive(risky).manifest.printer_config)
check('preset names are made safe for zip paths',
  readPresetArchive(risky).manifest.printer_config[0] === 'printer/a_b_ c.json',
  readPresetArchive(risky).manifest.printer_config[0] + ' ' + riskyNames)

// Issue 63: the catalog carries the custom G-code (stored once in the artifact's text table, resolved by the
//  readers) and the model's default bed type, which the templates' bed temperature follows.
{
  const a1mini = printerSettings('Bambu Lab A1 mini 0.4 nozzle')
  check('a printer row carries its custom start G-code, resolved from the text table',
    typeof a1mini?.machine_start_gcode === 'string' && a1mini.machine_start_gcode.includes('[bed_temperature_initial_layer_single]'),
    typeof a1mini?.machine_start_gcode)
  check('the printer row carries printer_model (the Bambu Lab check reads it)', a1mini?.printer_model === 'Bambu Lab A1 mini', a1mini?.printer_model)
  check("the model's default bed type rides on the entry, not the preset row",
    printerDefaultBedType('Bambu Lab A1 mini 0.4 nozzle') === 'Textured PEI Plate' && !('curr_bed_type' in a1mini))
  const pla = (await filamentPresets()).settingsFor('Bambu PLA Basic @BBL A1M')
  check('a filament row carries its filament_end_gcode as text, not an index',
    Array.isArray(pla?.filament_end_gcode) && typeof pla.filament_end_gcode[0] === 'string', JSON.stringify(pla?.filament_end_gcode)?.slice(0, 40))
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nALL PRESET-FILE CHECKS PASSED\n')
process.exit(failures ? 1 : 0)
