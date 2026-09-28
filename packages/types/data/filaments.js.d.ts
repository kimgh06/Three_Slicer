// filaments.js — filament (material) presets extracted from OrcaSlicer's resources/profiles/<Vendor>/filament/.
// Emitted as a JS module rather than JSON because it is loaded dynamically: see engine/src/data.js for why.
// Column layout, same as processes.js — `keys` names the columns once and each row in `sets` is positional.
// Prefer `filamentPresets()` from three-slicer/settings over decoding this by hand.

/** A positional row aligned to `keys`; `null` where the profile chain never set that option. */
export type FilamentRow = (unknown | null)[]

/** `[preset name, index into sets, filament_type, filament_vendor]`. The two labels are `''` when the
 *  profile chain declares neither — a picker groups those under its own "other" bucket. */
export type FilamentEntry = [string, number, string, string]

export interface FilamentData {
  /** Option keys, in column order — the kernel keys and custom-G-code keys that at least one filament profile sets */
  keys: string[]
  /** Deduplicated value rows */
  sets: FilamentRow[]
  /** Columns whose cells are indices into `text` rather than values: the multi-line options (custom G-code, notes),
   *  stored once because many rows share one. Absent when the table has none. */
  textKeys?: string[]
  /** The multi-line values the `textKeys` columns index */
  text?: unknown[]
  /** Preset entries, indexed by the numbers in `byPrinter` / `defaultsByModel` */
  presets: FilamentEntry[]
  /** Printer profile name (as keyed in printers.json) -> indices into `presets` — the compatible materials */
  byPrinter: Record<string, number[]>
  /** Printer *model* name -> indices into `presets` — the vendor's recommended materials, in their order */
  defaultsByModel: Record<string, number[]>
}

declare const filaments: FilamentData
export default filaments
