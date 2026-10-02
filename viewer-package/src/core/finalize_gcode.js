// What upstream's GCodeProcessor writes into the G-code once the print's time is known (post_process,
// GCodeProcessor.cpp:1053-1340): the M73 progress lines and file_start_gcode's @PRINT_TIME_SEC@ /
// @USED_FILAMENT_LENGTH@. The kernel streams its text out before the estimate exists, so it leaves upstream's own
// placeholders and this fills them from the slice's stats. A G-code without them comes back unchanged.
//
// ponytail: upstream writes an M73 whenever the elapsed minute or percent changes within a layer's moves; this writes
//  one at each layer start, from the estimator's per-layer times (stats.layer_times), and the first and last lines
//  where upstream puts them. A per-move timeline would need the estimator to report move times back with the text.

const FIRST_LINE_M73 = ';_GP_FIRST_LINE_M73_PLACEHOLDER'
const LAST_LINE_M73 = ';_GP_LAST_LINE_M73_PLACEHOLDER'
const PRINT_TIME_SEC = '@PRINT_TIME_SEC@'
const USED_FILAMENT_LENGTH = '@USED_FILAMENT_LENGTH@'

// GCodeProcessor's time_in_minutes.
const minutesOf = (seconds) => Math.floor((Math.max(0, seconds) + 0.5) / 60)
// The Normal machine's mask (line_m73_main_mask, GCodeProcessor.cpp:2642).
const m73 = (percent, minutes) => `M73 P${percent} R${minutes}`

/**
 * @param gcode the slice's G-code text
 * @param stats the slice's stats: time_estimate (s), filament_mm, layer_times (s per "; LAYER" layer)
 * @returns the G-code with upstream's placeholders filled
 */
export function finalizeGcode(gcode, stats) {
  let text = String(gcode ?? '')
  const total = Number(stats?.time_estimate) || 0
  if (text.includes(PRINT_TIME_SEC)) text = text.split(PRINT_TIME_SEC).join(total.toFixed(2))
  if (text.includes(USED_FILAMENT_LENGTH)) text = text.split(USED_FILAMENT_LENGTH).join(((Number(stats?.filament_mm) || 0) / 1000).toFixed(2))
  if (!text.includes(FIRST_LINE_M73)) return text

  let layerTimes = []
  if (Array.isArray(stats?.layer_times)) layerTimes = stats.layer_times
  const lines = text.split('\n')
  const out = []
  let layer = 0, elapsed = 0, last = ''
  for (const line of lines) {
    if (line === FIRST_LINE_M73) { last = m73(0, minutesOf(total)); out.push(last); continue }
    if (line === LAST_LINE_M73) { out.push(m73(100, 0)); continue }
    out.push(line)
    if (!line.startsWith('; LAYER ')) continue
    // A layer's progress is what the layers before it took.
    let percent = 0
    if (total > 0) percent = Math.min(100, Math.floor((100 * elapsed) / total))
    const progress = m73(percent, minutesOf(total - elapsed))
    if (progress !== last) { out.push(progress); last = progress }
    elapsed += Number(layerTimes[layer]) || 0
    layer += 1
  }
  return out.join('\n')
}
