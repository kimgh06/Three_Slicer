// A printer pick as a settings-map transform — pure, so the plate-scope trap below stays under a test.
//
// Picking a machine replaces the outgoing machine's values (every printer key), its print preset (whose speeds
// would otherwise survive onto a different machine), and both preset ids. `printer_technology` is the one
// printer key that must NOT go with them: the vendor rows carry it only for resin machines (an FFF row omits it,
// the schema default being FFF), so a plain delete-then-merge leaves an FFF pick without the key. In the GLOBAL
// map that reads as the default and changes nothing; in a PLATE override it reads as "follow the global
// technology" — which is how picking a filament machine on the one FFF plate of a resin project flipped that
// plate straight back to resin (measured: the card showed SLA again within a render). The key is therefore
// carried across from `prev` whenever it was there and the profile does not set it.
export function applyPrinterPick(prev, vals, profileName, { printerKeys, processKeys = [] }) {
  const next = { ...prev }
  for (const key of printerKeys) delete next[key]
  for (const key of processKeys) delete next[key]
  delete next.printer_settings_id
  delete next.print_settings_id
  if ('printer_technology' in prev && !(vals && 'printer_technology' in vals)) next.printer_technology = prev.printer_technology
  return vals ? { ...next, ...vals, printer_settings_id: profileName } : next   // no profile -> schema defaults
}

/**
 * A print (quality) preset as a settings-map transform. The preset replaces the outgoing preset's keys and its
 * id; the keys the PICKED MACHINE's own row sets stay the machine's (`printerOwnedKeys`), because the row is
 * the more specific source for them (nozzle, bed, retraction). That set must be the machine's OWN keys and not
 * the union of every row in the artifact: the union holds `layer_height` / `initial_layer_height` because a
 * handful of resin rows set them, and guarding those blanketly meant no FFF quality preset could ever change
 * the layer height (measured: "0.16mm High Quality" left the panel at 0.2).
 */
export function applyProcessPreset(prev, vals, presetName, { processKeys, printerOwnedKeys = [] }) {
  const owned = new Set(printerOwnedKeys)
  const next = { ...prev }
  for (const key of processKeys) if (!owned.has(key)) delete next[key]
  delete next.print_settings_id
  if (!vals) return next
  const incoming = { ...vals }
  for (const key of owned) delete incoming[key]
  return { ...next, ...incoming, print_settings_id: presetName }
}
