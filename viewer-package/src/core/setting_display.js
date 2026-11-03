// How the settings form shows a value. Writing stays verbatim: these only change what is displayed.

// Every per-feature line width whose schema default is 0 falls back to `line_width`, and `line_width` 0 to the
//  nozzle. Keys such as `bridge_line_width` default to a percentage and read 0 literally, so the default decides.
export function zeroMeansAuto(key, def, value) {
  if (!key.endsWith('line_width') || def?.type !== 'coFloatOrPercent') return false
  return parseFloat(def.default) === 0 && parseFloat(value) === 0
}

// A composite upstream row (Nozzle: First layer, Other layers) is one row per option here, so the row names both.
export function rowLabel(def, key, lineTitle) {
  const ownLabel = def?.label || def?.full_label
  if (!lineTitle) return ownLabel || key
  if (!ownLabel || ownLabel === lineTitle) return lineTitle
  return `${lineTitle} · ${ownLabel}`
}

// Upstream prints float defaults with a bare trailing point ("0.", "100.%"). Only a default goes through this: an
//  edited value is what the user is typing, and "0." is on the way to "0.4".
export function cleanDefaultText(text) {
  if (typeof text !== 'string') return text
  return text.replace(/\.(?=%?$)/, '')
}
