// processes.js — print (process) presets extracted from OrcaSlicer's resources/profiles/<Vendor>/process/.
// Emitted as a JS module rather than JSON because it is loaded dynamically: see engine/src/data.js for why.
// Column layout, same as printers.json — `keys` names the columns once and each row in `sets` is positional.
// Prefer `processPresets()` from three-slicer/settings over decoding this by hand.

/** A positional row aligned to `keys`; `null` where the profile chain never set that option. */
export type ProcessRow = (unknown | null)[]

export interface ProcessData {
  /** Option keys, in column order — the keys the kernel consumes plus the ones its custom G-code reads (extract_all.py _preset_keys) */
  keys: string[]
  /** Deduplicated value rows */
  sets: ProcessRow[]
  /** Columns whose cells are indices into `text` rather than values: the multi-line options (custom G-code, notes),
   *  stored once because many rows share one. Absent when the table has none. */
  textKeys?: string[]
  /** The multi-line values the `textKeys` columns index */
  text?: unknown[]
  /** `[preset name, index into sets]`, indexed by the numbers in `byPrinter` */
  presets: [string, number][]
  /** Printer profile name -> indices into `presets` */
  byPrinter: Record<string, number[]>
}

declare const processes: ProcessData
export default processes
