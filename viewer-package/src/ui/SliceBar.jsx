import React from 'react'

// The sidebar's fixed bottom bar: auto-slice toggle, the slice button (with the per-plate dropdown)
// and the G-code export link. While a slice runs the button cancels it.
export default function SliceBar({
  autoSlice, onAutoSlice, slicing, progress, sliceRate = 0, plateCount, selectedPlate, sliceMenuOpen, onSliceMenu,
  slicedPlateCount, canSlice, onSlice, onCancel, onExportAll, gcodeUrl, bedWarning,
  // Plate-parallel slicing: the run map (core/slice_pool.js) while an all-plates run is on, the worker-count knob
  //  and what Auto resolves to, and which kernel loaded — mt and st are a measured 9.8x apart, so it is said.
  plateRun = null, kernelKind = null, workers = 0, autoWorkers = 1, maxWorkers = 1, memoryWorkers = Infinity, onWorkers = null,
  slaResult = false, slaTech = false, onExportSl1 = null, exporting = null, sl1Ready = null,
}) {
  const title = slicing ? 'Click to cancel the slice'
    : plateCount > 1 ? 'Choose what to slice (Ctrl+R = current plate)' : 'Slice the current plate (Ctrl+R)'
  return (
    <div className="side-bottom">
      <label className="auto-slice" data-testid="auto-slice" title="Re-slice automatically 0.8s after a settings change (the first slice is manual; a running slice is canceled and restarted)">
        <input type="checkbox" checked={autoSlice} onChange={e => onAutoSlice(e.target.checked)} /> Auto slice
      </label>
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
              <select value={workers > 0 ? Math.min(workers, maxWorkers, memoryWorkers) : 0} onChange={e => onWorkers?.(Number(e.target.value))}>
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
              <button onClick={onExportAll} data-testid="export-all" title="Save the G-code of every sliced plate as its own file">Export all G-code ({slicedPlateCount})</button>
            )}
          </div>
        )}
      </div>
      {/* Slicing something that hangs off the bed is fine — inspecting it is how you see the problem. Saving the
          file is not: those coordinates drive a machine that cannot reach them, so export is where this stops.
          A resin slice exports an .sl1 archive instead of G-code, and it is BUILT on click (a click handler, not
          a prefilled href) — rasterizing hundreds of layer PNGs eagerly on every plate focus would freeze the tab
          for a file the user may never save. */}
      {slaResult
        ? <button className="export-btn" disabled={!!bedWarning || !!exporting} onClick={onExportSl1} data-testid="sl1-dl"
            title={bedWarning ? `Export blocked — ${bedWarning}. Move or rescale the model to fit the bed.`
              : sl1Ready ? `${sl1Ready} is built and waiting — click to save it`
              : 'Save the SL1 archive (per-layer PNG masks + config) of the plate you are viewing'}>
            {/* Built-but-unsaved is its own state: the archive takes longer to rasterize than a browser keeps a
                click "recent", so the save needs a second one. Saying so beats a download that never appears. */}
            {exporting || (sl1Ready ? 'Save SL1' : 'Export SL1')}
          </button>
        : gcodeUrl && !bedWarning
        ? <a className="export-btn" href={gcodeUrl} download={`plate_${selectedPlate + 1}.gcode`} title="Save the G-code of the plate you are viewing" data-testid="gcode-dl">Export G-code</a>
        : <button className="export-btn" disabled data-testid="gcode-dl-blocked"
            title={bedWarning ? `Export blocked — ${bedWarning}. Move or rescale the model to fit the bed.`
              : `Export ${slaTech ? 'SL1' : 'G-code'} — enabled after slicing`}>
            {/* The blocked button names what slicing WILL produce — under an SLA profile that is an SL1 archive,
                and a placeholder that says "G-code" there reads as the wrong export being offered. */}
            Export {slaTech ? 'SL1' : 'G-code'}
          </button>}
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
