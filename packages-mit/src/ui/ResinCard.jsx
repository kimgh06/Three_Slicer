import React from 'react'
import { deriveSlaParams, settingRaw } from 'three-slicer-viewer/settings'
import { cardScope } from '../core/plate_settings.js'
import ScopeToggle from './ScopeToggle.jsx'
import { resolveCatalog } from '../core/catalog.js'

// Resin (SLA) card — shown in place of the filament card when the printer profile declares SLA: resin has no
//  extruders, colours or prime tower. The values shown are the ones the contour slicer and the SL1 export will
//  actually run with (deriveSlaParams), and edits land on the same settings map every other card writes, so a
//  project save carries them like any other option. Plate scope (the shared Global|Plate switch) binds the
//  whole card to the selected plate's effective map, so an SLA-override plate's exposure/supports/elevation
//  edit lands in ITS override — which is where its slice reads from.
export default function ResinCard({ catalog, settings: globalSettings, setSettings: setGlobalSettings, stats,
  plateSettings, setPlateSettings, plateCount = 1, selectedPlate = 0, settingsScope = 'global', setSettingsScope, onResetPlate = null }) {
  const scoped = cardScope({ settings: globalSettings, setSettings: setGlobalSettings, plateSettings, setPlateSettings, plateCount, selectedPlate, settingsScope })
  const plateScope = scoped.plateScope
  const settings = scoped.settings, setSettings = scoped.setSettings
  const p = deriveSlaParams(settings)
  const write = (key) => (e) => {
    const v = parseFloat(e.target.value)
    if (Number.isFinite(v) && v >= 0) setSettings(s => ({ ...s, [key]: v }))
  }
  const writeBool = (key) => (e) => { const on = !!e.target.checked; setSettings(s => ({ ...s, [key]: on })) }
  const blurOnEnter = (e) => { if (e.key === 'Enter') e.target.blur() }
  const row = (key, value, unit, label, step) => (
    <div className="sc-info"><span>{label}</span>
      <span className="sc-bed">
        <input type="number" min="0" step={step} key={`${key}${value}`} defaultValue={value}
          onBlur={write(key)} onKeyDown={blurOnEnter} data-testid={`resin-${key}`} />
        {unit}
      </span>
    </div>
  )
  // Material picker: the vendor catalog filtered to presets whose compatibility layer height matches the one
  //  in use (upstream's compatible_prints_condition, reduced to a number at extraction). Grouped by type the
  //  way the filament picker groups materials. Picking one applies the exposure family (upstream's layering:
  //  exposure lives in the sla_material preset) and remembers itself under the schema's own id key.
  const picked = String(settingRaw(settings, 'sla_material_settings_id') ?? '')
  const { resinCatalog, resinSettingsFor } = resolveCatalog(catalog)
  const compatible = resinCatalog.filter(r => r.layerHeight == null || Math.abs(r.layerHeight - p.layer_height) < 1e-6)
  const types = [...new Set(compatible.map(r => r.type || 'Other'))].sort()
  const pickMaterial = (name) => {
    const vals = resinSettingsFor(name)
    if (vals) setSettings(s => ({ ...s, ...vals }), plateScope ? Object.keys(vals) : undefined)   // a pick is written whole in plate scope
  }
  return (
    <section className="side-card" data-testid="resin-card">
      <div className="sc-head">🧪 Resin
        {plateCount > 1 && setSettingsScope && (
          <ScopeToggle plateScope={plateScope} selectedPlate={selectedPlate} onScope={setSettingsScope} onReset={onResetPlate}
            testid="resin-scope-toggle" plateTestid="resin-scope-plate" />
        )}
      </div>
      {compatible.length > 0 && (
        <div className="sc-info"><span>Material</span>
          <select className="sc-model" value={picked} onChange={e => pickMaterial(e.target.value)}
            data-testid="resin-material"
            title="Resin preset from the upstream vendor bundles — applies its exposure times">
            {!compatible.some(r => r.name === picked) && <option value="">Custom (current values)</option>}
            {types.map(t => (
              <optgroup key={t} label={t}>
                {compatible.filter(r => (r.type || 'Other') === t)
                  .map(r => <option key={r.name} value={r.name}>{r.name.replace(/\s*@.*$/, '')}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
      )}
      {row('layer_height', p.layer_height, 'mm', 'Layer height', 0.01)}
      {row('initial_layer_height', p.initial_layer_height, 'mm', 'First layer', 0.05)}
      {row('exposure_time', p.exposure_time, 's', 'Exposure', 0.5)}
      {row('initial_exposure_time', p.initial_exposure_time, 's', 'First exposure', 1)}
      {row('faded_layers', p.faded_layers, '', 'Fade layers', 1)}
      <div className="sc-info"><span>Display</span>
        {/* The mm figure is the PRINT AREA — without it on screen, a model judged over-bed against the display
            while a larger printable_area bed is drawn looks like it fits and fails for no visible reason. */}
        <b title="The resin printer's LCD — resolution and physical size, from the printer profile. The physical size is the print area; the pixel grid is what the SL1 export draws on.">
          {p.display_pixels_x}×{p.display_pixels_y} px · {p.display_width}×{p.display_height} mm
        </b>
      </div>
      <label className="sc-info" title="Generate grid-pillar supports under overhangs and floating islands (kernel slice_sla) — they render in the preview and rasterize into the SL1 masks">
        <span>Supports</span>
        <input type="checkbox" checked={p.supports_enable} onChange={writeBool('supports_enable')} data-testid="resin-supports" />
      </label>
      <label className="sc-info" title="A flat slab under everything that reaches the plate">
        <span>Pad</span>
        <input type="checkbox" checked={p.pad_enable} onChange={writeBool('pad_enable')} data-testid="resin-pad" />
      </label>
      {p.supports_enable && row('support_object_elevation', p.support_object_elevation, 'mm', 'Elevation', 0.5)}
      {stats?.sla && (
        <div className="sc-info" data-testid="resin-used"><span>Resin</span><b>{(stats.resinMl ?? 0).toFixed(1)} ml</b></div>
      )}
    </section>
  )
}
