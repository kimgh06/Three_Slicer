// `.orca_printer` / `.orca_bundle` / `.orca_filament` — the zip forms of OrcaSlicer's preset files.
//
// Layout, from upstream's exporter (CreatePresetsDialog.cpp) and reader (PresetBundle::import_presets):
//
//   bundle_structure.json     the manifest — BUNDLE_STRUCTURE_JSON_NAME in PresetBundle.hpp
//   printer/<name>.json       one machine preset
//   process/<name>.json       zero or more
//   filament/<name>.json      zero or more
//
// The manifest lists the member paths per type rather than leaving the reader to guess from folder names, so it is
// written even though the folders already say it.
//
// This lives in the viewer and not the engine because a zip needs a deflate, and the only one in reach is the copy
// fflate ships inside three — which the engine deliberately does not depend on.
import { zipSync, unzipSync, strToU8, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js'
import { writePresetFile, readPresetFile } from 'three-slicer-viewer/settings'

const MANIFEST = 'bundle_structure.json'
const FOLDER = { machine: 'printer', process: 'process', filament: 'filament' }

// Upstream names the member after the preset, and a preset name is user text — a slash or a colon in it would
//  invent a folder or break a zip reader on Windows.
const safeName = (name) => String(name || 'Custom').replace(/[^\w.\- ]+/g, '_').trim() || 'Custom'

/**
 * Build a `.orca_printer`. `presets` is `{machine, process, filament}` where each entry is `{name, settings}` —
 * machine required, the other two optional and process/filament may be arrays.
 *
 * Every member is written flattened (see writePresetFile): a bundle that only resolves against the vendor
 * database it came from would defeat the point of handing someone a file.
 */
export function writePrinterBundle(presets, { timestamp = '' } = {}) {
  const machine = presets?.machine
  if (!machine?.settings) throw new Error('a printer bundle needs a machine preset')

  const files = {}
  const manifest = {
    version: '', bundle_id: `offline_${safeName(machine.name)}_${timestamp}`,
    bundle_type: 'printer config bundle', printer_preset_name: machine.name ?? '',
    printer_config: [], filament_config: [], process_config: [],
  }
  const listOf = { machine: 'printer_config', process: 'process_config', filament: 'filament_config' }

  for (const type of ['machine', 'process', 'filament']) {
    const entries = [].concat(presets[type] ?? []).filter(entry => entry?.settings)
    for (const entry of entries) {
      const path = `${FOLDER[type]}/${safeName(entry.name)}.json`
      files[path] = strToU8(JSON.stringify(writePresetFile(entry.settings, { type, name: entry.name }), null, 1))
      manifest[listOf[type]].push(path)
    }
  }
  files[MANIFEST] = strToU8(JSON.stringify(manifest, null, 1))
  // Level 3 for the same reason write_3mf uses it: on this kind of XML/JSON it is faster than 6 and no larger.
  return zipSync(files, { level: 3 })
}

/**
 * Read any of the zip forms. Returns the parsed presets grouped by type, plus the manifest when there is one.
 *
 * Members are found by their own `type` field rather than by folder, because `.zip` and `.orca_bundle` are also
 * accepted by upstream's importer and neither promises this layout — and a preset that says `"type": "machine"`
 * is a machine preset wherever it sits in the archive.
 */
export function readPresetArchive(buffer, { resolveParent } = {}) {
  const entries = unzipSync(new Uint8Array(buffer))
  let manifest = null
  const out = { machine: [], process: [], filament: [], errors: [] }

  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.toLowerCase().endsWith('.json') || path.endsWith('/')) continue
    let raw
    try { raw = JSON.parse(strFromU8(bytes)) } catch { out.errors.push(`${path}: not JSON`); continue }
    if (path === MANIFEST || raw.bundle_type) { manifest = raw; continue }
    try {
      const preset = readPresetFile(raw, { resolveParent })
      out[preset.type].push({ ...preset, path })
    } catch (error) { out.errors.push(`${path}: ${error.message}`) }
  }
  return { ...out, manifest }
}

/** True for the archive extensions upstream's import dialog accepts. */
export const isPresetArchive = (filename) =>
  /\.(orca_printer|orca_bundle|orca_filament|zip)$/i.test(String(filename))
