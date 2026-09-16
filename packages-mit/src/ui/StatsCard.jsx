import React from 'react'
import { UNKNOWN_COLOR } from '../core/viewer_defaults.js'

const hms = (seconds) => {
  const s = Math.round(seconds)
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`
}

const ENGINE_LABEL = { full: 'GCodeProcessor', transcribed: 'transcribed planner', fallback: 'fallback' }

// Slice result summary — rendered in the viewport card in Preview.
// Upstream labels each filament with its MATERIAL, not only its colour, and prefixes a support-only filament with
// "Sup." (GCodeViewer.cpp get_filament_display_type). Two filaments of the same colour are otherwise indistinguishable
// in the legend, and "which one is the ABS" is the question a multi-material print raises first.
function filamentLabel(types, ids, index) {
  const type = (types?.[index] ?? '').trim()
  const id = (ids?.[index] ?? '').trim()
  if (type) return type
  return id ? id.replace(/\s*@.*$/, '') : ''      // no type set — fall back to the preset name, minus its printer suffix
}

export default function StatsCard({ stats, overBed, overBedText, overBedModel = true, extruderColors, filamentTypes, filamentIds }) {
  if (!stats) return null
  // A per-tool split only says anything once a second tool actually extrudes: on a single-material print it would
  //  restate the total on its own line. So the breakdown appears only when two or more tools used filament, and
  //  the total line above stays exactly what it has always been in every other case.
  const perTool = Array.isArray(stats.filamentPerTool) ? stats.filamentPerTool : null
  const usedTools = perTool ? perTool.filter(millimetres => Number.isFinite(millimetres) && millimetres > 0).length : 0
  const showBreakdown = usedTools > 1
  // Purge is charged to the prime tower and to the tool-change wipes, so it belongs to no single extruder — a
  //  line of its own is what makes the per-tool figures add up to the total.
  const purge = Number.isFinite(stats.filamentPurge) ? stats.filamentPurge : 0
  // Upstream's legend splits each filament into Model / Support / Flushed / Tower / Total (GCodeViewer.cpp). This
  //  path emits no support and does not flush into the model, so the two columns that exist here are Model and
  //  Tower — shown only when the kernel reports the per-tool purge, because without it "model" would be a guess.
  const purgePerTool = Array.isArray(stats.filamentPurgePerTool) ? stats.filamentPurgePerTool : null
  const towerOf = (index) => (Number.isFinite(purgePerTool?.[index]) ? purgePerTool[index] : 0)
  const colors = Array.isArray(extruderColors) ? extruderColors : []
  return (
    <>
      <div><b>{stats.layers}</b> layers · <b>{stats.segments}</b> segments</div>
      {stats.sla
        ? <div data-testid="resin-total">Resin <b>{(stats.resinMl ?? 0).toFixed(1)}</b> ml</div>
        : <div>Filament <b>{stats.filament.toFixed(1)}</b> mm</div>}
      {showBreakdown && perTool.map((millimetres, index) => (
        Number.isFinite(millimetres) && millimetres > 0 ? (
          <div className="stat-tool" key={index} data-testid={`filament-tool-${index}`}>
            <span className="stat-swatch" style={{ background: colors[index] ?? UNKNOWN_COLOR }} />
            T{index + 1}
            {filamentLabel(filamentTypes, filamentIds, index) && (
              <span className="stat-type" data-testid={`filament-type-${index}`}>
                {filamentLabel(filamentTypes, filamentIds, index)}
              </span>
            )}
            {' '}<b>{millimetres.toFixed(1)}</b> mm
            {purgePerTool && towerOf(index) > 0 && (
              <span className="stat-split" data-testid={`filament-tool-split-${index}`}>
                {' '}(model {(millimetres - towerOf(index)).toFixed(1)} · tower {towerOf(index).toFixed(1)})
              </span>
            )}
          </div>
        ) : null
      ))}
      {showBreakdown && purge > 0 && (
        <div className="stat-tool" data-testid="filament-purge">
          <span className="stat-swatch stat-swatch-purge" />
          Prime tower / purge <b>{purge.toFixed(1)}</b> mm
        </div>
      )}
      {typeof stats.timeSec === 'number' && stats.timeSec > 0 && (<>
        <div data-testid="print-time">⏱ Estimated print <b>{hms(stats.timeSec)}</b></div>
        {stats.limits && (
          // What the estimator actually ran with, echoed back by the kernel — not re-derived from the settings,
          //  so an unwired limit shows up as a mismatch here instead of being silently reported as applied.
          <div className="sc-sub" data-testid="print-time-basis"
               title={Object.entries(stats.limits).map(([k, v]) => `${k}: ${v}`).join('\n')}>
            {ENGINE_LABEL[stats.engine] ?? stats.engine} · {stats.limits.max_speed_xy} mm/s
            · {stats.limits.accel_print} mm/s² · jerk {stats.limits.jerk_xy}
          </div>
        )}
      </>)}
      {/* How long the SLICE took, which is not the print time above and is easy to read as it if unlabelled —
          hence "Sliced in", in seconds, next to an estimate in hours. The visible line is the human one; the
          tooltip carries the two figures that only mean something to someone comparing runs: the kernel's own
          share of the wall time, and ms per million segments (the kernel is not deterministic in segment count,
          so raw milliseconds compare two different amounts of work). */}
      {stats.throughput && stats.throughput.ms > 0 && (
        <div className="sc-sub" data-testid="slice-speed"
             title={[`wall ${Math.round(stats.throughput.ms)} ms`,
                     stats.throughput.kernelMs != null ? `kernel ${Math.round(stats.throughput.kernelMs)} ms` : null,
                     stats.throughput.msPerMsegment != null ? `${Math.round(stats.throughput.msPerMsegment)} ms per million segments` : null]
                    .filter(Boolean).join('\n')}>
          Sliced in <b>{(stats.throughput.ms / 1000).toFixed(1)}s</b>
          {stats.throughput.layersPerSecond > 0 && ` · ${Math.round(stats.throughput.layersPerSecond)} layers/s`}
        </div>
      )}
      {/* "Beyond the bed" alone leaves the next two questions unanswered: by how much, and what is actually out
          there. Naming the toolpaths when the model itself fits is the difference between "shrink the model" and
          "it is the support/skirt/brim" — the second is fixed by moving inward a few mm, not by rescaling. */}
      {overBed && (
        <div className="slice-warn" data-testid="over-bed">
          {/* A resin print area is the display panel, and the file is an SL1 — "bed" and "G-code" are FFF words. */}
          ⚠ {overBedModel ? 'Model extends' : 'Support/skirt/brim extends'} beyond the {stats?.sla ? 'resin display' : 'bed'}
          {overBedText ? ` by ${overBedText}` : ''} — {stats?.sla ? 'SL1' : 'G-code'} export is blocked
        </div>
      )}
    </>
  )
}
