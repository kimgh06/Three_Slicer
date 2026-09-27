// A kernel refusal is typed: the error text starts with an upper-case code and a colon ("CUSTOM_GCODE_ERROR: …",
// "SLA_UNSUPPORTED_HOLLOWING: …"). It is decided by the input, not by memory or the wall generator, so the slice
// ladder (hooks/use_slicer.js) must not retry it with classic walls or economy mode: they would fail the same way,
// and a custom G-code typo used to cost two more slices before its message showed.
// Cancellation ("canceled") and a dead worker ("Worker terminated …") are not codes and keep their own handling.
export function isTypedRefusal(error) {
  return /^[A-Z][A-Z0-9_]+: /.test(String(error?.message || error))
}
