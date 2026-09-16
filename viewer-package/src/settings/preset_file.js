// OrcaSlicer preset files — the `.json` its "Config files (*.json;…)" import accepts, and that its
// "Export preset" writes. One file holds one preset of one type: machine, process or filament.
//
// The value encoding is the same one `project_settings.config` uses, and for the same reason: upstream writes
// every option through ConfigBase::save_to_json, which serializes each one to a string (a bool is "1"/"0", a point
// is "XxY", a vector becomes an array of strings). So normalize/serializeProjectSettings are reused verbatim
// rather than reimplemented — a second copy of that coercion table is exactly how the two would drift.
//
// Zero dependencies, so this lives in the engine and works headless. The zip bundle formats (.orca_printer) need
// a deflate and therefore live in the viewer, which already has one.
import { leanSchema as schema, presetKeys } from './data.js'   // .default is all it reads
import { normalizeProjectSettings, serializeProjectSettings } from './settings_core.js'   // not settings.js: that re-exports this file, and a cycle through it is avoidable

/** `machine` for printers, `process` for print settings, `filament` for materials — upstream's own `type` field. */
const KEY_LIST = { machine: 'printer', process: 'process', filament: 'filament' }

// Preset bookkeeping, not settings. Upstream writes six of these; `inherits` is read (it names the parent) and the
// rest are carried only so a round trip does not lose them.
const ENVELOPE = new Set(['type', 'name', 'from', 'version', 'setting_id', 'instantiation', 'inherits',
  'filament_id', 'is_custom_defined', 'filament_settings_id', 'print_settings_id', 'printer_settings_id'])

/** Every option key that belongs in a preset of this type. */
export function presetOptionKeys(type) {
  const list = presetKeys[KEY_LIST[type]]
  if (!list) throw new Error(`unknown preset type '${type}' (expected machine, process or filament)`)
  return list
}

/**
 * A settings map -> the object an OrcaSlicer preset `.json` holds.
 *
 * Written **flattened**: no `inherits`, every key present. That is the whole difference between a file another
 * program can read on its own and one that only means something next to the vendor database it was derived from —
 * upstream's own exports are diffs against a parent (`Preset::save`: "only save difference if it has parent"),
 * which is fine for OrcaSlicer reading its own files back and useless for anyone else.
 *
 * `complete: false` writes only the keys the settings map actually holds, for a diff-shaped file.
 */
export function writePresetFile(settings, { type = 'machine', name = 'Custom', complete = true, version = '1.0.0.0' } = {}) {
  const keys = presetOptionKeys(type)
  const picked = {}
  for (const key of keys) {
    // `inherits` is in upstream's printer_options list — it is an option to OrcaSlicer's config machinery, but it
    //  is bookkeeping here, and writing it would put an empty parent name in a file meant to stand alone. The same
    //  ENVELOPE set the reader strips is what the writer refuses to emit, so the two cannot disagree about it.
    if (ENVELOPE.has(key)) continue
    if (settings && key in settings && settings[key] != null) picked[key] = settings[key]
    // A key with no schema default cannot be filled — there is nothing to fill it with. `complete` means "every
    //  option that HAS a value", not "every option name", and inventing one would be worse than leaving it out.
    else if (complete && schema[key]?.default !== undefined) picked[key] = schema[key].default
  }
  return {
    type, name, from: 'User', version, instantiation: 'true',
    ...serializeProjectSettings(picked),
  }
}

/**
 * The inverse: a parsed preset `.json` -> a settings map this package accepts.
 *
 * `inherits` is the trap. Upstream stores a derived preset as the DIFF against its parent, so a vendor file on its
 * own carries a fraction of the preset — the Bambu X1C machine json inherits `fdm_bbl_3dp_001_common` and lists
 * about twenty keys. Resolution therefore needs a parent lookup, and this package has no full preset database:
 * `resolveParent(name)` is the hook, and `printerSettings` covers the machine case for the keys the kernel reads.
 *
 * When the parent cannot be resolved the file's own values are still applied and `missingParent` names it —
 * dropping a whole file because one name is unknown loses more than it protects, and the caller can decide.
 */
export function readPresetFile(raw, { resolveParent } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('not a preset object')
  const type = raw.type
  if (!KEY_LIST[type]) throw new Error(`not an OrcaSlicer preset: type is ${JSON.stringify(type)}`)

  const own = {}
  for (const [key, value] of Object.entries(raw)) if (!ENVELOPE.has(key)) own[key] = value
  const { settings, applied, skipped } = normalizeProjectSettings(own)

  // The parent goes UNDER the file's own values — the file is the diff, so it wins.
  let missingParent = null
  let merged = settings
  if (raw.inherits) {
    const parent = resolveParent?.(raw.inherits, type) ?? null
    if (parent) merged = { ...parent, ...settings }
    else missingParent = raw.inherits
  }

  return {
    settings: merged,
    type,
    name: typeof raw.name === 'string' ? raw.name : '',
    inherits: raw.inherits ?? null,
    missingParent,
    applied,
    skipped,
  }
}

/** Convenience: the JSON text an export writes. */
export const presetFileText = (settings, options) => JSON.stringify(writePresetFile(settings, options), null, 1)
