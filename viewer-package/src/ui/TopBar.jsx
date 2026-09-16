import React from 'react'
import { openIcon, saveIcon } from '../core/icons.js'

// S1 top bar: logo + open/save buttons, the Prepare|Preview tabs, and the undo/redo placeholders.
// Saving mirrors upstream's File menu split: a .3mf is the PROJECT (geometry + settings + plates + painting), a
//  .stl is the geometry alone. Two buttons rather than a menu — there are exactly two formats, and a dropdown to
//  choose between two things is a click more than the thing itself.
// `exporting` names the export in flight — 'project' | 'stl', null when idle. Writing a project is seconds of work
//  on a large model (mostly one deflate call), so the button that started it says so and both are locked for the
//  duration, the same way the slice button becomes "Slicing… 42%". No percentage here on purpose: the compression
//  reports no progress, and a bar that moves on a timer tells the user something the program does not know.
export default function TopBar({ showTabs, canvasMode, onCanvasMode, previewEnabled, onOpen, onSaveProject, onExportSTL, canSave,
                                 exporting = null, onUndo, onRedo, canUndo, canRedo }) {
  const exportBusy = !!exporting
  const exportLabel = (which, idle, busy) => (exporting === which ? busy : idle)
  return (
    <header className="topbar">
      <div className="tb-left">
        <a href="/" className="tb-logo"><b>Three</b>Slicer <span className="tb-re">RE</span></a>
        <button className="tb-btn" onClick={onOpen} title="Open a model file — every existing object is cleared" data-testid="open-file"><img src={openIcon} alt="" /><span>Open</span></button>
        {onSaveProject && (
          <button className={exporting === 'project' ? 'tb-btn tb-busy' : 'tb-btn'} onClick={onSaveProject}
            disabled={!canSave || exportBusy} data-testid="save-project"
            title="Save as a .3mf project — geometry, settings, plate layout and painting, reopenable here or in OrcaSlicer">
            <img src={saveIcon} alt="" /><span>{exportLabel('project', 'Save as 3mf', 'Saving…')}</span>
          </button>
        )}
        {onExportSTL && (
          <button className={exporting === 'stl' ? 'tb-btn tb-busy' : 'tb-btn'} onClick={onExportSTL}
            disabled={!canSave || exportBusy} data-testid="export-stl"
            title="Export the geometry alone as a binary .stl — settings and painting are not part of an STL">
            <span>{exportLabel('stl', 'STL', 'Writing…')}</span>
          </button>
        )}
      </div>
      {showTabs && (
        <div className="tb-tabs" role="tablist" aria-label="Canvas mode">
          <button role="tab" className={canvasMode === 'prepare' ? 'on' : ''} onClick={() => onCanvasMode('prepare')} data-testid="mode-prepare" title="Arrange, transform and paint supports">Prepare</button>
          <button role="tab" className={canvasMode === 'preview' ? 'on' : ''} onClick={() => onCanvasMode('preview')} disabled={!previewEnabled} data-testid="mode-preview" title="Preview the sliced toolpaths (enabled after slicing)">Preview</button>
        </div>
      )}
      <div className="tb-right">
        {/* Scene actions only — moving, adding, deleting, and the per-object extruder/visibility. Print settings
            belong to the host application (they arrive as props), so they are not on this stack. */}
        <button className="tb-icon" onClick={onUndo} disabled={!canUndo} data-testid="undo"
          title="Undo the last object change — move, add, delete, extruder or visibility (Ctrl+Z). Print settings and painting are not included">↶</button>
        <button className="tb-icon" onClick={onRedo} disabled={!canRedo} data-testid="redo"
          title="Redo (Ctrl+Shift+Z / Ctrl+Y)">↷</button>
      </div>
    </header>
  )
}
