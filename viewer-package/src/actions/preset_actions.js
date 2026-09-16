// Load / save printer presets from the sidebar — the file side of the printer card.
//
// Save writes what upstream's importer accepts: a single flattened machine `.json`, or an `.orca_printer` bundle
// when the settings map also names a process or filament preset. It names them from `printer_settings_id` /
// `print_settings_id` / `filament_settings_id`, which the cards already write into the map, so nothing new has to
// be tracked to know what the presets are called.
//
// Load accepts both, plus the `.zip` / `.orca_bundle` / `.orca_filament` forms upstream's dialog lists. A machine
// preset in the file replaces the printer's keys; a process or filament preset in the same file is applied too,
// because a bundle exists precisely to carry the three together.
import { readPresetFile, writePresetFile,
         presetOptionKeys } from 'three-slicer-viewer/settings'
import { writePrinterBundle, readPresetArchive, isPresetArchive } from '../core/preset_bundle.js'
import { download } from './export_actions.js'
import { log } from '../core/log.js'
import { resolveCatalog } from '../core/catalog.js'

const nameOf = (settings, key, fallback) => {
  const value = settings?.[key]
  return (typeof value === 'string' && value.trim()) ? value : fallback
}

// A settings map holds every preset type's keys at once; a preset file holds one type's. Splitting by the
//  extracted key lists is what makes the three files carry the right values instead of all of them three times.
const sliceFor = (settings, type) => {
  const out = {}
  for (const key of presetOptionKeys(type)) if (settings && key in settings) out[key] = settings[key]
  return out
}

export function makePresetActions(deps) {
  // The vendor catalog is injected, not imported (core/catalog.js): a host with its own machines supplies
  //  its own, and the permissive package can run with none at all. Kept whole rather than picked apart here,
  //  because test_wiring.mjs treats the first destructuring after a factory declaration as its deps list.
  const catalog = resolveCatalog(deps.catalog)
  const { settingsRef, setSettings, setError, setSliceNotice, onExport, fileInputRef } = deps

  /** Save the printer. A bundle when a process/filament preset is named too, a bare machine .json otherwise. */
  function exportPrinterPreset({ bundle = 'auto' } = {}) {
    const settings = settingsRef.current ?? {}
    const machineName = nameOf(settings, 'printer_settings_id', 'Custom printer')
    const processName = nameOf(settings, 'print_settings_id', null)
    const filamentName = nameOf(settings, 'filament_settings_id', null)
    const wantBundle = bundle === true || (bundle === 'auto' && (processName || filamentName))

    try {
      if (!wantBundle) {
        const text = JSON.stringify(writePresetFile(sliceFor(settings, 'machine'),
          { type: 'machine', name: machineName }), null, 1)
        download(text, `${machineName}.json`, 'application/json', onExport)
        setSliceNotice?.(`Saved "${machineName}" as an OrcaSlicer machine preset`)
        return
      }
      const zip = writePrinterBundle({
        machine: { name: machineName, settings: sliceFor(settings, 'machine') },
        process: processName ? { name: processName, settings: sliceFor(settings, 'process') } : null,
        filament: filamentName ? { name: filamentName, settings: sliceFor(settings, 'filament') } : null,
      })
      download(zip, `${machineName}.orca_printer`, 'application/zip', onExport)
      setSliceNotice?.(`Saved "${machineName}" as a printer bundle`
        + (processName ? ` with ${processName}` : '') + (filamentName ? ` and ${filamentName}` : ''))
    } catch (error) {
      log.error('[preset] export failed', error)
      setError?.('Could not save the printer preset: ' + (error?.message ?? error))
    }
  }

  /** Apply one parsed preset onto the settings map, clearing that type's keys first. */
  const applyPreset = (preset) => setSettings?.(prev => {
    const next = { ...prev }
    for (const key of presetOptionKeys(preset.type)) delete next[key]
    // The printer keys are cleared by their own list too: presetOptionKeys('machine') and printerKeys overlap but
    //  neither contains the other, and a leftover from either side is a value from the previous printer.
    if (preset.type === 'machine') for (const key of catalog.printerKeys) delete next[key]
    const idKey = { machine: 'printer_settings_id', process: 'print_settings_id', filament: 'filament_settings_id' }[preset.type]
    return { ...next, ...preset.settings, ...(preset.name ? { [idKey]: preset.name } : {}) }
  })

  /** Read a preset file the user picked. Returns what was applied, for the caller's notice. */
  async function loadPresetFile(file) {
    const resolveParent = (name) => catalog.printerSettings(name)
    const applied = []
    const warnings = []
    try {
      if (isPresetArchive(file.name)) {
        const archive = readPresetArchive(await file.arrayBuffer(), { resolveParent })
        for (const type of ['machine', 'process', 'filament']) {
          for (const preset of archive[type]) {
            applyPreset(preset); applied.push(`${type}: ${preset.name || '(unnamed)'}`)
            if (preset.missingParent) warnings.push(`${preset.name}: parent "${preset.missingParent}" not found`)
          }
        }
        warnings.push(...archive.errors)
      } else {
        const preset = readPresetFile(JSON.parse(await file.text()), { resolveParent })
        applyPreset(preset); applied.push(`${preset.type}: ${preset.name || '(unnamed)'}`)
        if (preset.missingParent) warnings.push(`parent "${preset.missingParent}" not found`)
      }
    } catch (error) {
      log.error('[preset] import failed', error)
      setError?.('Could not read that preset file: ' + (error?.message ?? error))
      return
    }
    if (!applied.length) { setError?.('No presets found in that file'); return }
    setError?.('')
    // A missing parent is reported, never fatal: upstream stores a derived preset as the diff against its parent,
    //  so a vendor file without its parent still carries most of itself — dropping it entirely would lose more.
    setSliceNotice?.(`Loaded ${applied.join(', ')}`
      + (warnings.length ? ` — ${warnings.length} warning(s): ${warnings[0]}` : ''))
  }

  /** Opens the picker the printer card's Load button uses. Kept here so the accept list stays with the reader. */
  const openPresetPicker = () => fileInputRef?.current?.click()

  return { exportPrinterPreset, loadPresetFile, openPresetPicker }
}

/** File dialog filter — the same set upstream's "Config files" dialog offers. */
export const PRESET_ACCEPT = '.json,.orca_printer,.orca_bundle,.orca_filament,.zip'
