import React, { useState } from 'react'
import { GPU_ACCELERATION_MODES, gpuAccelerationMode } from '../core/gpu_acceleration.js'

// The sidebar's fixed bottom bar: the slice button, split as upstream's is, so the current plate is one click and the
// ▾ holds the all-plates run; the export; and the slice options on a line of their own. While a slice runs the button
// cancels it.
export default function SliceBar({
  autoSlice, onAutoSlice, slicing, progress, sliceRate = 0, plateCount, selectedPlate, sliceMenuOpen, onSliceMenu,
  slicedPlateCount, canSlice, onSlice, onCancel, gcodeReady = false, onExportGcode, bedWarning,
  // Plate-parallel slicing: the run map (core/slice_pool.js) while an all-plates run is on, the worker-count knob
  //  and what Auto resolves to.
  plateRun = null, workers = 0, autoWorkers = 1, maxWorkers = 1, memoryWorkers = Infinity,
  slaResult = false, slaTech = false, onExportSl1 = null, exporting = null, sl1Ready = null, onExportGcode3mf = null, onExportPlateGcode3mf = null,
  // GPU acceleration of the polygon booleans (core/gpu_acceleration.js): the settings map's raw `gpu_acceleration` value.
  //  onSetting(key, value) writes a viewer knob (`slice_workers`, `gpu_acceleration`) into the host's settings map.
  gpuSetting = null, onSetting,
}) {
  const plates = plateCount > 1
  let sliceTitle = 'Slice the current plate (Ctrl+R)'
  let sliceLabel = 'Slice'
  if (plates) sliceLabel = `Slice plate ${selectedPlate + 1}`
  if (slicing) {
    sliceTitle = 'Click to cancel the slice'
    sliceLabel = `Slicing… ${Math.round(progress * 100)}%`
  }
  const runSlice = () => {
    if (slicing) onCancel()
    else onSlice('current')
  }
  // One menu at a time: `sliceMenuOpen` is Viewport's because a slice start closes it, the export one is this bar's.
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const closeMenus = () => {
    setExportMenuOpen(false)
    if (sliceMenuOpen) onSliceMenu()
  }
  const toggleSliceMenu = () => {
    setExportMenuOpen(false)
    onSliceMenu()
  }
  const toggleExportMenu = () => {
    if (sliceMenuOpen) onSliceMenu()
    setExportMenuOpen(open => !open)
  }
  const gpuMode = gpuAccelerationMode({ gpu_acceleration: gpuSetting })
  let workersValue = 0
  if (workers > 0) workersValue = Math.min(workers, maxWorkers, memoryWorkers)
  return (
    <div className="side-bottom" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); closeMenus() } }}>
      {(exportMenuOpen || sliceMenuOpen) && <div className="slice-scrim" onPointerDown={closeMenus} data-testid="slice-scrim" />}
      <div className="slice-dd">
        <button className="slice-btn" title={sliceTitle} onClick={runSlice} disabled={!canSlice} data-testid="slice-btn">{sliceLabel}</button>
        {plates && !slicing && (
          <button className="slice-more" onClick={toggleSliceMenu} disabled={!canSlice} aria-label="More slice options" aria-expanded={!!sliceMenuOpen}
            title="More ways to slice" data-testid="slice-more">▾</button>
        )}
        {sliceMenuOpen && plates && !slicing && (
          <div className="slice-menu" data-testid="slice-menu">
            <button onClick={() => onSlice('all')} data-testid="slice-all" title="Slice every plate, several at a time — switch tabs to inspect the results">Slice all plates ({plateCount})</button>
          </div>
        )}
      </div>
      <ExportButton menuOpen={exportMenuOpen} onToggleMenu={toggleExportMenu} onCloseMenu={closeMenus} plateCount={plateCount} slaResult={slaResult} slaTech={slaTech} bedWarning={bedWarning} exporting={exporting} sl1Ready={sl1Ready}
        onExportSl1={onExportSl1} gcodeReady={gcodeReady} onExportGcode={onExportGcode} onExportGcode3mf={onExportGcode3mf}
        onExportPlateGcode3mf={onExportPlateGcode3mf} slicedPlateCount={slicedPlateCount} selectedPlate={selectedPlate} />
      {/* Throughput, on its own row (the bar wraps) rather than inside the button label: the button is flex-sized
          in a narrow sidebar, and "Slicing… 62% · 21 layers/s" does not fit it at any useful font size. Rendered
          only while a rate exists, so the bar keeps its idle height between slices. Tabular figures — without them
          the digits change width as the number moves and the line jitters several times a second. */}
      {slicing && (sliceRate > 0 || plateRun) && (
        <div className="slice-rate" data-testid="slice-rate"
          title="Layers finished per second, over the last 250ms. A resin slice reports it throughout; a filament slice reports it once the emission pass starts streaming layers, since the earlier passes publish no per-layer progress.">
          {sliceRate > 0 ? `${sliceRate >= 10 ? Math.round(sliceRate) : sliceRate.toFixed(1)} layers/s` : ''}
          {plateRun ? `${sliceRate > 0 ? ' · ' : ''}${plateRun.workers.active} of ${plateRun.workers.pool} worker${plateRun.workers.pool === 1 ? '' : 's'}` : ''}
        </div>
      )}
      {/* The settings of the slice, on one line under the buttons they apply to. Workers only mean something with
          several plates. */}
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
        {plates && (
          <>
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
            </label>
          </>
        )}
      </div>
    </div>
  )
}

// Slicing something that hangs off the bed is fine — inspecting it is how you see the problem. Saving the file is not:
//  those coordinates drive a machine that cannot reach them, so export is where this stops. A resin slice exports an
//  .sl1 archive instead of G-code, and it is BUILT on click (a click handler, not a prefilled href) — rasterizing
//  hundreds of layer PNGs eagerly on every plate focus would freeze the tab for a file the user may never save.
function ExportButton({
  menuOpen, onToggleMenu, onCloseMenu, plateCount, slaResult, slaTech, bedWarning, exporting, sl1Ready, onExportSl1, gcodeReady, onExportGcode, onExportGcode3mf,
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
    // The button saves EVERY sliced plate in one .gcode.3mf (upstream's "Export all sliced file") and says how many; the
    //  viewed plate alone, and the plain .gcode a non-Bambu printer needs, sit in its ▾ menu. Entries read "what, format".
    const plateName = `Plate ${selectedPlate + 1}`
    const severalSliced = slicedPlateCount > 1
    let plates = 'the sliced plate'
    let exportLabel = 'Export G-code'
    if (plateCount > 1) exportLabel = `Export plate ${selectedPlate + 1}`
    if (severalSliced) {
      plates = `all ${slicedPlateCount} sliced plates`
      exportLabel = `Export ${slicedPlateCount} plates`
    }
    const pick = (run) => () => { onCloseMenu(); run() }
    return (
      <div className="export-dd">
        <button className="export-btn" onClick={onExportGcode3mf} disabled={!!exporting} data-testid="gcode3mf-dl"
          title={`Save ${plates} as one .gcode.3mf — reopenable here and in OrcaSlicer/Bambu Studio`}>
          {exporting || exportLabel}
        </button>
        <button className="export-more" onClick={onToggleMenu} aria-label="Other exports" aria-expanded={menuOpen} title="Other exports" data-testid="gcode-dl-more">▾</button>
        {menuOpen && (
          <div className="slice-menu export-menu" data-testid="export-menu">
            {severalSliced && (
              <button onClick={pick(onExportGcode3mf)} title="Save every sliced plate in one .gcode.3mf (a resin plate saves as its own .sl1)" data-testid="export-all">All plates, .gcode.3mf ({slicedPlateCount})</button>
            )}
            {onExportPlateGcode3mf && (
              <button onClick={pick(onExportPlateGcode3mf)} title="Save only the plate you are viewing as a .gcode.3mf" data-testid="gcode3mf-plate-dl">{plateName}, .gcode.3mf</button>
            )}
            <button onClick={pick(onExportGcode)} title="Save the plain G-code of the plate you are viewing" data-testid="gcode-dl">{plateName}, plain .gcode</button>
          </div>
        )}
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
