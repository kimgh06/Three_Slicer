import React, { useMemo, useState, useEffect } from 'react'
import { machineLimitKeys, printerTechnology } from 'three-slicer-viewer/settings'
import { resolveCatalog } from '../core/catalog.js'
import { cardScope } from '../core/plate_settings.js'
import { applyPrinterPick, applyProcessPreset } from '../core/printer_pick.js'
import { bedRectangle } from '../core/bed_bounds.js'
import ScopeToggle from './ScopeToggle.jsx'

// Printer card: the printer profile picker, bed width x depth (rectangular, edited inline) and the nozzle diameter.
// Origin, circular and custom shapes belong to the process panel's printable_area editor.
//
// Plate scope (the same Global|Plate switch the Process card carries, bound to the same state): a model picked
// here lands in the selected plate's override, so plates can run different machines' values — nozzle,
// retraction, temperatures, motion limits, FFF/SLA (the mixed-technology stage), and since the
// heterogeneous-bed stage even the bed itself: a bed edit or a model pick in plate scope resizes that plate's
// own grid cell. One known asymmetry, accepted: apply() clears the outgoing model's keys, and in plate
// scope a clear can only drop OVERRIDE keys — a global value the new model's preset does not set shows through.
export default function PrinterCard({ catalog, bedWidth, bedDepth, nozzleDia, plateFrame, onBedSize,
  settings: globalSettings, setSettings: setGlobalSettings, motionPanel, onExportPreset, onImportPreset,
  plateSettings, setPlateSettings, plateCount = 1, selectedPlate = 0, settingsScope = 'global', setSettingsScope, onResetPlate = null }) {
  // The vendor catalog is injected (core/catalog.js): this package ships none, three-slicer/viewer hands its
  //  bundled one in, and a host with its own fleet passes its own. Every lookup below reads from it.
  const { printerKeys, printersByVendor, printerSettings, printerDefaultPreset, printerDefaultBedType, printerTechByVendor, processPresets } = resolveCatalog(catalog)
  const scoped = cardScope({ settings: globalSettings, setSettings: setGlobalSettings, plateSettings, setPlateSettings, plateCount, selectedPlate, settingsScope })
  const plateScope = scoped.plateScope
  const settings = scoped.settings, setSettings = setGlobalSettings ? scoped.setSettings : null
  // Picking a printer merges its profile straight into the settings map — printers.json stores the values under the
  //  same option keys the panel edits, so there is nothing to translate. The pick is remembered in printer_settings_id
  //  (an upstream schema key). Model and nozzle are separate controls because the profiles differ only by nozzle in
  //  most cases, and 1,000+ entries in one list is unusable.
  const vendors = useMemo(() => Object.entries(printersByVendor).sort(([a], [b]) => a.localeCompare(b)), [printersByVendor])
  const picked = settings?.printer_settings_id ?? ''
  // The picker offers only the machines of the declared technology: the FFF vendor catalog under FFF, the resin
  //  bundles under SLA. Picking a resin machine also APPLIES its technology (the profile row carries the key),
  //  so choosing "Original Prusa SL1" from an FFF session is impossible by construction, not by warning.
  const tech = printerTechnology(settings)
  const vendorTech = (vendor) => printerTechByVendor[vendor] ?? 'FFF'
  const shownVendors = vendors.filter(([vendor]) => vendorTech(vendor) === tech)
  // model -> [{ name, nozzle }], so choosing a model can keep the current nozzle when that variant exists
  const models = useMemo(() => {
    const out = new Map()
    for (const [vendor, profiles] of vendors)
      for (const [name, [nozzle, , model]] of Object.entries(profiles)) {
        const key = `${vendor}\u0000${model}`
        if (!out.has(key)) out.set(key, { vendor, model, variants: [] })
        out.get(key).variants.push({ name, nozzle })
      }
    for (const m of out.values()) m.variants.sort((a, b) => parseFloat(a.nozzle) - parseFloat(b.nozzle))
    return out
  }, [vendors])
  const currentModel = [...models.entries()].find(([, m]) => m.variants.some(v => v.name === picked))
  // The pick can belong to the OTHER technology (a global FFF machine leaking into an SLA plate's effective
  //  map): its nozzle variants must not render there, and the Model select should say what is inherited
  //  rather than a bare "Custom (defaults)".
  const pickMatchesTech = currentModel ? vendorTech(currentModel[1].vendor) === tech : true
  const variants = (pickMatchesTech ? currentModel?.[1].variants : null) ?? []

  // Process presets are printer-specific and live in a lazily loaded artifact, so they arrive after the pick.
  const [processes, setProcesses] = useState(null)

  // A printer pick. In GLOBAL scope it is the row alone, and the [picked] effect below adds the vendor's recommended
  //  print preset once the (lazy) artifact is in. In PLATE scope the pick is written as ONE COMPLETE SET — the machine
  //  row, its technology, its recommended preset and both ids — and written whole (forceKeys), so the plate describes
  //  its own machine instead of a diff against the global one: a diff left every shared key on the global machine
  //  and the technology key off an FFF row (vendor rows carry it only for resin), so a global printer or technology
  //  change dragged the plate along. The preset rides in the same write because the effect cannot add it here: it
  //  reads print_settings_id off the EFFECTIVE map, where the global preset shows through as "already set".
  const apply = async (profileName) => {
    const vals = profileName ? printerSettings(profileName) : null
    const bedType = profileName && printerDefaultBedType(profileName)
    if (!plateScope) return setSettings?.(prev => applyPrinterPick(prev, vals, profileName, { printerKeys, processKeys: processes?.keys ?? [], bedType }))
    const api = tech === 'SLA' ? null : await processPresets()
    const recommended = api && profileName ? printerDefaultPreset(profileName) : null
    const presetVals = recommended && api.listFor(profileName).includes(recommended) ? api.settingsFor(recommended) : null
    const forceKeys = [...Object.keys(vals ?? {}), ...Object.keys(presetVals ?? {}), 'printer_technology', 'printer_settings_id', 'print_settings_id']
    if (bedType) forceKeys.push('curr_bed_type')
    setSettings?.(prev => {
      const withPrinter = { ...applyPrinterPick(prev, vals, profileName, { printerKeys, processKeys: api?.keys ?? [], bedType }), printer_technology: vals?.printer_technology ?? tech }
      if (!presetVals) return withPrinter
      return applyProcessPreset(withPrinter, presetVals, recommended, { processKeys: api.keys, printerOwnedKeys: Object.keys(vals ?? {}) })
    }, forceKeys)
  }
  useEffect(() => {
    if (!picked || tech === 'SLA') return   // an SLA plate must not auto-apply the (FFF) process preset of a leaked global pick
    let live = true
    processPresets().then(api => {
      if (!live) return
      setProcesses(api)
      // Start on the vendor's own recommended preset rather than leaving the print settings at schema defaults,
      //  which is what made picking a printer look like it changed nothing.
      const recommended = printerDefaultPreset(picked)
      setSettings?.(prev => {
        if (prev.printer_settings_id !== picked || prev.print_settings_id) return prev
        const vals = recommended && api.listFor(picked).includes(recommended) ? api.settingsFor(recommended) : null
        if (!vals) return prev
        return applyProcessPreset(prev, vals, recommended, { processKeys: api.keys, printerOwnedKeys: Object.keys(printerSettings(picked) ?? {}) })
      })
    })
    return () => { live = false }
  }, [picked])   // eslint-disable-line react-hooks/exhaustive-deps
  const presetNames = processes && picked ? processes.listFor(picked) : []
  // The picked machine's own row keeps its keys over the preset (core/printer_pick.js applyProcessPreset).
  const applyPreset = (name) => setSettings?.(prev => applyProcessPreset(prev, name ? processes.settingsFor(name) : null, name,
    { processKeys: processes.keys, printerOwnedKeys: Object.keys(printerSettings(picked) ?? {}) }))

  // Switching model keeps the nozzle if that variant exists, so changing printer does not silently change nozzle size
  const pickModel = (key) => {
    const m = models.get(key)
    if (!m) return apply('')
    const keep = m.variants.find(v => v.nozzle === variants.find(v2 => v2.name === picked)?.nozzle)
    apply((keep ?? m.variants[Math.min(1, m.variants.length - 1)]).name)
  }

  // Motion ability: which of the printer's kinematic limits the estimate is running on. The key list comes from the
  //  settings mapping (not spelled out here), and the settings map is sparse, so a present key means the user edited it.
  //  The values themselves are reported by StatsCard from what the kernel echoed back — deliberately not duplicated here.
  const edited = machineLimitKeys.filter(k => settings && k in settings)
  // Two decimals, not whole mm: an SLA display is a real panel (the SL1's is 120.96 x 68.04) and rounding the
  //  shown value would make a blur re-write 121 over a profile's exact size.
  // In plate scope the size and nozzle rows show THIS plate's frame — `plateFrame`, the selected plate's
  //  plateContext handed down by Viewport, the same frame the grid cell and the bed check use — and an edit
  //  writes the override (an FFF bed as a printable_area rectangle, an SLA print area as display_width/height).
  //  In global scope they show the global frame (`bedWidth`/`bedDepth`/`nozzleDia`), which is what the edit writes.
  const scopedBed = plateScope && plateFrame?.w > 0 && plateFrame?.d > 0 ? { w: plateFrame.w, d: plateFrame.d } : null
  const applyBed = (nw, nd) => {
    if (!(nw > 0) || !(nd > 0)) return
    if (!plateScope) return onBedSize(nw, nd)
    setSettings(s => tech === 'SLA'
      ? { ...s, display_width: nw, display_height: nd }
      : { ...s, printable_area: bedRectangle(s.printable_area, nw, nd) })
  }
  const w = Math.round((scopedBed?.w ?? bedWidth) * 100) / 100, d = Math.round((scopedBed?.d ?? bedDepth) * 100) / 100
  const blurOnEnter = (e) => { if (e.key === 'Enter') e.target.blur() }
  return (
    <section className="side-card">
      <div className="sc-head">
        🖨 Printer
        {plateCount > 1 && setSettings && setSettingsScope && (
          <ScopeToggle plateScope={plateScope} selectedPlate={selectedPlate} onScope={setSettingsScope} onReset={onResetPlate}
            testid="printer-scope-toggle" plateTestid="printer-scope-plate" />
        )}
        {/* Preset files read/write the GLOBAL map (preset_actions settingsRef) — offering them under a
            "Plate N" heading would save the wrong thing, so they step back until the scope does. */}
        {!plateScope && (onExportPreset || onImportPreset) && (
          <span className="sc-head-actions">
            {onImportPreset && (
              <button className="sc-mini" onClick={onImportPreset} data-testid="printer-import"
                title="Load a printer profile from a .json preset or an .orca_printer bundle">Load</button>
            )}
            {onExportPreset && (
              <button className="sc-mini" onClick={onExportPreset} data-testid="printer-export"
                title="Save this printer's settings as an OrcaSlicer preset file">Save</button>
            )}
          </span>
        )}
      </div>
      {setSettings && (<>
        {/* The FFF/SLA switch — one settings key, and everything routes off it: which sidebar cards render,
            which slicer runs, what the export button writes. The vendor catalog below is FFF-only (it comes from
            Orca's profiles), so a resin setup starts from this switch rather than from a model pick. */}
        <div className="sc-info"><span>Technology</span>
          <select className="sc-model" value={printerTechnology(settings)}
            onChange={e => setSettings(s => ({ ...s, printer_technology: e.target.value }))}
            data-testid="printer-tech"
            title={'FFF extrudes filament and exports G-code; SLA cures resin layer by layer and exports an SL1 archive of per-layer masks'
              + (plateScope ? ' — in plate scope this routes THIS plate only' : '')}>
            <option value="FFF">FFF (filament)</option>
            <option value="SLA">SLA (resin)</option>
          </select>
        </div>
        <div className="sc-info"><span>Model</span>
          <select className="sc-model" value={currentModel?.[0] ?? ''} onChange={e => pickModel(e.target.value)}
            data-testid="printer-model" title="Loads this printer's profile (motion limits, bed, nozzle) from the upstream vendor data">
            <option value="">{!pickMatchesTech && currentModel ? `Inherited: ${currentModel[1].model} (${vendorTech(currentModel[1].vendor)})` : 'Custom (defaults)'}</option>
            {shownVendors.map(([vendor]) => (
              <optgroup key={vendor} label={vendor}>
                {[...models.entries()].filter(([, m]) => m.vendor === vendor)
                  .map(([key, m]) => <option key={key} value={key}>{m.model}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        {variants.length > 1 && (
          <div className="sc-info"><span>Nozzle</span>
            <select className="sc-model" value={picked} onChange={e => apply(e.target.value)} data-testid="printer-nozzle">
              {variants.map(v => <option key={v.name} value={v.name}>{v.nozzle} mm</option>)}
            </select>
          </div>
        )}
        {/* FFF only: the process-preset artifact is FFF machinery, and on an SLA plate `picked` can still be
            the GLOBAL map's FFF printer leaking through the effective merge — offering its speed presets on a
            resin plate was the visible symptom. Resin quality lives on the Resin card (material presets). */}
        {tech !== 'SLA' && presetNames.length > 0 && (
          <div className="sc-info"><span>Quality</span>
            <select className="sc-model" value={settings?.print_settings_id ?? ''} onChange={e => applyPreset(e.target.value)}
              data-testid="process-preset" title="Print preset from the vendor profile — the speeds and accelerations the printer is actually driven at">
              <option value="">Custom (defaults)</option>
              {presetNames.map(n => <option key={n} value={n}>{n.replace(/\s*@.*$/, '')}</option>)}
            </select>
          </div>
        )}
      </>)}
      {/* One editable size row for both technologies, but the value it EDITS differs: under SLA the print area
          is the resin display's physical size, so onBedSize (Viewport) writes display_width/display_height —
          the keys slice_sla and the SL1 raster actually read — while printable_area (which never reaches the
          SLA kernel) is what it writes under FFF. */}
      <div className="sc-info"><span>{tech === 'SLA' ? 'Print area' : 'Bed'}</span>
        <span className="sc-bed" title={tech === 'SLA'
          ? "The resin display's physical size (display_width / display_height) — the area the SLA kernel prints in and the mm the SL1 masks map onto. Applied on Enter or blur."
          : 'Plate size — applied on Enter or blur. Circular/custom shapes come from the printable_area option'}>
          <input type="number" min="1" step="any" key={`w${w}`} defaultValue={w}
            onBlur={e => applyBed(+e.target.value, d)}
            onKeyDown={blurOnEnter} data-testid="bed-w-card" />
          ×
          <input type="number" min="1" step="any" key={`d${d}`} defaultValue={d}
            onBlur={e => applyBed(w, +e.target.value)}
            onKeyDown={blurOnEnter} data-testid="bed-d-card" />
          mm
        </span>
      </div>
      {tech !== 'SLA' && <div className="sc-info"><span>Nozzle Ø</span><b>{(plateScope && plateFrame?.nozzle) || nozzleDia} mm</b></div>}
      {/* The editor itself is injected by the host (same slot pattern as processPanel) so the viewer keeps no
          second copy of the settings form. Without it the card still reports which limits are in play.
          FFF only, like the nozzle row: kinematic limits drive the G-code estimate, and a resin plate showing
          the global FFF map's edits as "Custom (12)" was reporting another machine's state.
          The EDITOR also steps back in plate scope: the host bound it to the GLOBAL pair, so editing it there
          wrote global values under a "Plate N" heading (measured: machine_max_speed_x 123 leaked). The info
          row remains — `edited` reads the scoped map, so it reports THIS plate's truth. */}
      {tech === 'SLA' ? null : (motionPanel && !plateScope) ? (
        <details className="sc-fold" data-testid="motion-fold">
          <summary><span className="sc-fold-lbl">Motion</span><b data-testid="motion-source">{edited.length ? `Custom (${edited.length})` : 'Default'}</b></summary>
          {/* Own wrapper: ShadowHost's own element is display:contents, so it cannot carry the scroll box */}
          <div className="sc-fold-body">{motionPanel}</div>
        </details>
      ) : (
        <div className="sc-info"><span>Motion</span>
          <b data-testid="motion-source"
             title={edited.length ? `Edited: ${edited.join(', ')}` : 'Machine limits are at their defaults'}>
            {edited.length ? `Custom (${edited.length})` : 'Default'}
          </b>
        </div>
      )}
    </section>
  )
}
