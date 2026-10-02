// printers.json — per-printer settings extracted from OrcaSlicer's resources/profiles/<Vendor>/machine/.
// Column layout: `keys` names the columns once and each entry in `sets` is a positional row, because
// repeating the key names per printer costs more than all the values together. Rows are deduplicated —
// a printer's nozzle variants usually share one row — so a printer holds an index rather than its own copy.
// Prefer `printerSettings()` from three-slicer/settings over decoding this by hand.

/** A positional row aligned to `keys`; `null` where the profile chain never set that option. */
export type PrinterRow = (unknown | null)[]

/** `[nozzle diameter, index into sets, model name without the nozzle suffix, default process preset,
 *  the model's default bed type ('' when none)]` — SLA entries carry the first four */
export type PrinterEntry = [string, number, string, string, string?]

export interface PrinterData {
  /** Option keys, in column order — the same keys the settings panel edits, including the custom G-code and the
   *  options it reads (issue 63) */
  keys: string[]
  /** Deduplicated value rows */
  sets: PrinterRow[]
  /** Columns whose cells are indices into `text` rather than values: the multi-line options (custom G-code, notes),
   *  stored once because many rows share one. Absent when the table has none. */
  textKeys?: string[]
  /** The multi-line values the `textKeys` columns index */
  text?: unknown[]
  /** Vendor -> printer profile name -> entry */
  byVendor: Record<string, Record<string, PrinterEntry>>
  /** The abstract machine presets (`instantiation: false`) by name: not offered for picking, but resolvable as
   *  the parent a user preset file `inherits` */
  parents?: Record<string, PrinterEntry>
}

declare const printers: PrinterData
export default printers
