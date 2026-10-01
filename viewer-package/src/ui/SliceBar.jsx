import React from 'react'
import { GPU_ACCELERATION_MODES, gpuAccelerationMode } from '../core/gpu_acceleration.js'

// The sidebar's fixed bottom bar: auto-slice toggle, the slice button (with the per-plate dropdown)
// and the G-code export link. While a slice runs the button cancels it.
export default function SliceBar({
  autoSlice, onAutoSlice, slicing, progress, sliceRate = 0, plateCount, selectedPlate, sliceMenuOpen, onSliceMenu,
  slicedPlateCount, canSlice, onSlice, onCancel, onExportAll, gcodeReady = false, onExportGcode, bedWarning,
  // Plate-parallel slicing: the run map (core/slice_pool.js) while an all-plates run is on, the worker-count knob
  //  and what Auto resolves to, and which kernel loaded — mt and st are a measured 9.8x apart, so it is said.
  plateRun = null, kernelKind = null, workers = 0, autoWorkers = 1, maxWorkers = 1, memoryWorkers = Infinity,
  slaResult = false, slaTech = false, onExportSl1 = null, exporting = null, sl1Ready = null, onExportGcode3mf = null, onExportPlateGcode3mf = null,
  // GPU acceleration of the polygon booleans (core/gpu_acceleration.js): the settings map's raw `gpu_acceleration` value.
  //  onSetting(key, value) writes a viewer knob (`slice_workers`, `gpu_acceleration`) into the host's settings map.
  gpuSetting = null, onSetting,
}) {
  const title = slicing ? 'Click to cancel the slice'
    : plateCount > 1 ? 'Choose what to slice (Ctrl+R = current plate)' : 'Slice the current plate (Ctrl+R)'
  const gpuMode = gpuAccelerationMode({ gpu_acceleration: gpuSetting })
  let workersValue = 0
  if (workers > 0) workersValue = Math.min(workers, maxWorkers, memoryWorkers)
  return (
    <div className="side-bottom">
      {/* The two slice options stack in one column so the bar keeps the export button on one line. */}
      <div className="slice-options">
        <label className="auto-slice" data-testid="auto-slice" title="Re-slice automatically 0.8s after a settings change (the first slice is manual; a running slice is canceled and restarted)">
          <input type="checkbox" checked={autoSlice} onChange={e => onAutoSlice(e.target.checked)} /> Auto slice
        </label>
        <label className="gpu-accel" data-testid="gpu-accel" title={GPU_TITLE[gpuMode]}>
          GPU
          <select value={gpuMode} onChange={e => onSetting('gpu_acceleration', e.target.value)}>
            {GPU_ACCELERATION_MODES.map(mode => <option key={mode} value={mode}>{GPU_LABEL[mode]}</option>)}
          </select>
        </label>
      </div>
      <div className="slice-dd">
        <button className="slice-btn" title={title}
          onClick={() => (slicing ? onCancel() : (plateCount > 1 ? onSliceMenu() : onSlice('current')))}
          disabled={!canSlice} data-testid="slice-btn">
          {slicing ? `Slicing… ${Math.round(progress * 100)}%` : (plateCount > 1 ? 'Slice ▾' : 'Slice')}
        </button>
        {sliceMenuOpen && plateCount > 1 && (
          <div className="slice-menu" data-testid="slice-menu">
            <button onClick={() => onSlice('current')} data-testid="slice-current" title="Slice only the selected plate (Ctrl+R)">Current plate (P{selectedPlate + 1})</button>
            <button onClick={() => onSlice('all')} data-testid="slice-all" title="Slice every plate, several at a time — switch tabs to inspect the results">All plates ({plateCount})</button>
            {/* How many plates slice at once. Auto is half the cores on the threaded kernel (most of the measured
                gain for half the memory) and one per core on the single-threaded one; each worker holds its own
                copy of the model, which is the only reason to go lower. Not a plain button row: this is a value. */}
            <label className="slice-workers" data-testid="slice-workers"
              title={`Plates sliced at the same time. Auto = ${autoWorkers} on this machine. Each worker keeps its own copy of the model in memory.`}>
              <span>Workers</span>
              <select value={workersValue} onChange={e => onSetting('slice_workers', Number(e.target.value))}>
                <option value={0}>Auto ({autoWorkers})</option>
                {/* Only what the memory budget allows for the loaded models is offered: past it the tab itself
                    dies (measured, five workers on a 143MB model), which nothing in the page can catch. */}
                {Array.from({ length: Math.max(1, Math.min(maxWorkers, memoryWorkers)) }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
                {memoryWorkers < maxWorkers && <option value="" disabled>more would exceed the memory budget for this model</option>}
              </select>
              {kernelKind && (
                <span className={'kernel-badge ' + kernelKind} data-testid="kernel-badge"
                  title={kernelKind === 'mt' ? 'Threaded kernel (the page is cross-origin isolated)'
                    : 'Single-threaded kernel — serve the page with COOP/COEP headers to enable threads (about 10x faster)'}>
                  {kernelKind}
                </span>
              )}
            </label>
            {slicedPlateCount > 0 && (
              <button onClick={onExportAll} data-testid="export-all" title="Save every sliced plate in one .gcode.3mf — reopenable here and in OrcaSlicer (a resin plate saves as its own .sl1)">Export all .gcode.3mf ({slicedPlateCount})</button>
            )}
          </div>
        )}
      </div>
      <ExportButton slaResult={slaResult} slaTech={slaTech} bedWarning={bedWarning} exporting={exporting} sl1Ready={sl1Ready}
        onExportSl1={onExportSl1} gcodeReady={gcodeReady} onExportGcode={onExportGcode} onExportGcode3mf={onExportGcode3mf}
        onExportPlateGcode3mf={onExportPlateGcode3mf} slicedPlateCount={slicedPlateCount} selectedPlate={selectedPlate} />
      {/* Throughput, on its own row (the bar wraps) rather than inside the button label: the button is flex-sized
          in a narrow sidebar, and "Slicing… 62% · 21 layers/s" does not fit it at any useful font size. Rendered
          only while a rate exists, so the bar keeps its idle height between slices. Tabular figures — without them
          the digits change width as the number moves and the line jitters several times a second. */}
      {/* An all-plates run shows every plate on one row — done, busy with its own percentage, queued, failed —
          because the button's one number is the mean over them and says nothing about which plate is where. */}
      {slicing && plateRun && (
        <div className="slice-plates" data-testid="slice-plates">
          {Object.entries(plateRun.plates).map(([i, p]) => (
            <span key={i} className={'slice-plate ' + p.state} title={`Plate ${Number(i) + 1} — ${p.state}${p.error ? ': ' + p.error : ''}`}>
              P{Number(i) + 1} {p.state === 'done' ? '✓' : p.state === 'failed' ? '✗' : p.state === 'busy' ? `${Math.round(p.progress * 100)}%` : '·'}
            </span>
          ))}
        </div>
      )}
      {slicing && (sliceRate > 0 || plateRun) && (
        <div className="slice-rate" data-testid="slice-rate"
          title="Layers finished per second, over the last 250ms. A resin slice reports it throughout; a filament slice reports it once the emission pass starts streaming layers, since the earlier passes publish no per-layer progress.">
          {sliceRate > 0 ? `${sliceRate >= 10 ? Math.round(sliceRate) : sliceRate.toFixed(1)} layers/s` : ''}
          {plateRun ? `${sliceRate > 0 ? ' · ' : ''}${plateRun.workers.active} of ${plateRun.workers.pool} worker${plateRun.workers.pool === 1 ? '' : 's'}` : ''}
        </div>
      )}
    </div>
  )
}

// Slicing something that hangs off the bed is fine — inspecting it is how you see the problem. Saving the file is not:
//  those coordinates drive a machine that cannot reach them, so export is where this stops. A resin slice exports an
//  .sl1 archive instead of G-code, and it is BUILT on click (a click handler, not a prefilled href) — rasterizing
//  hundreds of layer PNGs eagerly on every plate focus would freeze the tab for a file the user may never save.
function ExportButton({
  slaResult, slaTech, bedWarning, exporting, sl1Ready, onExportSl1, gcodeReady, onExportGcode, onExportGcode3mf,
  onExportPlateGcode3mf, slicedPlateCount, selectedPlate,
}) {
  const blockedTitle = `Export blocked — ${bedWarning}. Move or rescale the model to fit the bed.`
  if (slaResult) {
    let title = 'Save the SL1 archive (per-layer PNG masks + config) of the plate you are viewing'
    if (sl1Ready) title = `${sl1Ready} is built and waiting — click to save it`
    if (bedWarning) title = blockedTitle
    // Built-but-unsaved is its own state: the archive takes longer to rasterize than a browser keeps a click
    //  "recent", so the save needs a second one. Saying so beats a download that never appears.
    let label = 'Export SL1'
    if (sl1Ready) label = 'Save SL1'
    return (
      <button className="export-btn" disabled={!!bedWarning || !!exporting} onClick={onExportSl1} data-testid="sl1-dl" title={title}>
        {exporting || label}
      </button>
    )
  }
  if (gcodeReady && !bedWarning && onExportGcode3mf) {
    // The button saves EVERY sliced plate in one .gcode.3mf (upstream's "Export all sliced file"); the viewed plate
    //  alone, and the plain .gcode a non-Bambu printer needs, sit in its ▾ menu — a native <details>, so the menu
    //  needs no state of its own.
    let plates = 'the sliced plate'
    if (slicedPlateCount > 1) plates = `all ${slicedPlateCount} sliced plates`
    return (
      <div className="export-dd">
        <button className="export-btn" onClick={onExportGcode3mf} disabled={!!exporting} data-testid="gcode3mf-dl"
          title={`Save ${plates} as one .gcode.3mf — reopenable here and in OrcaSlicer/Bambu Studio`}>
          {exporting || 'Export G-code'}
        </button>
        <details className="export-more">
          <summary title="Other formats" data-testid="gcode-dl-more">▾</summary>
          <div className="slice-menu export-menu">
            {onExportPlateGcode3mf && slicedPlateCount > 1 && (
              <button onClick={onExportPlateGcode3mf} title="Save only the plate you are viewing as a .gcode.3mf" data-testid="gcode3mf-plate-dl">This plate only (P{selectedPlate + 1})</button>
            )}
            <button onClick={onExportGcode} title="Save the plain G-code of the plate you are viewing" data-testid="gcode-dl">Plain .gcode (P{selectedPlate + 1})</button>
          </div>
        </details>
      </div>
    )
  }
  if (gcodeReady && !bedWarning) {
    return <button className="export-btn" onClick={onExportGcode} title="Save the G-code of the plate you are viewing" data-testid="gcode-dl">Export G-code</button>
  }
  // The blocked button names what slicing WILL produce — under an SLA profile that is an SL1 archive, and a
  //  placeholder that says "G-code" there reads as the wrong export being offered.
  let format = 'G-code'
  if (slaTech) format = 'SL1'
  let title = `Export ${format} — enabled after slicing`
  if (bedWarning) title = blockedTitle
  return <button className="export-btn" disabled data-testid="gcode-dl-blocked" title={title}>Export {format}</button>
}

// The GPU select's option labels and tooltips, one per GPU_ACCELERATION_MODES entry. The stats line after a slice says
//  which engine that slice used.
const GPU_LABEL = { auto: 'Auto', on: 'On', off: 'Off' }
const GPU_TITLE = {
  auto: 'The layer contours are computed on the GPU when the single-threaded kernel is loaded and WebGPU gives a device. The G-code then differs slightly from a CPU slice.',
  on: 'The layer contours are computed on the GPU whenever WebGPU gives a device; without one the slice says so and uses the CPU. The G-code differs slightly from a CPU slice.',
  off: 'Everything is computed on the CPU.',
}
