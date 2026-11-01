import React from 'react'
import { openIcon, saveIcon } from '../core/icons.js'

// The window's head, laid out like PowerPoint: a title row (logo, the application `menu`, open/save buttons, the
//  Prepare|Preview tabs, undo/redo) over a ribbon of labelled tools (`children`). `chrome` false is panels.topBar off:
//  only the ribbon the host kept stays. Preview has no tools, so the ribbon goes and the canvas takes its height.
// Saving mirrors upstream's File menu split: a .3mf is the PROJECT (geometry + settings + plates + painting), a
//  .stl is the geometry alone. Two buttons rather than a menu — there are exactly two formats, and a dropdown to
//  choose between two things is a click more than the thing itself.
// With a menu on a wide screen the open/save buttons are hidden while idle (styles.css): the File menu holds them and
//  the tools need the width. A narrow screen has no menu, so there they stay, as icons.
// `exporting` names the export in flight — 'project' | 'stl', null when idle. Writing a project is seconds of work
//  on a large model (mostly one deflate call), so the button that started it says so and both are locked for the
//  duration, the same way the slice button becomes "Slicing… 42%". No percentage here on purpose: the compression
//  reports no progress, and a bar that moves on a timer tells the user something the program does not know.
export default function TopBar({ chrome = true, menu = null, children, showTabs, canvasMode, onCanvasMode, previewEnabled, prepareEnabled = true, gcodeJob = null, onCloseGcode, onOpen, onSaveProject, onExportSTL, canSave,
                                 exporting = null, onUndo, onRedo, canUndo, canRedo }) {
  const exportBusy = !!exporting
  const exportClass = (which) => {
    if (exporting === which) return 'tb-btn tb-busy'
    return 'tb-btn'
  }
  const stlLabel = () => {
    if (exporting === 'stl') return 'Writing…'
    return 'STL'
  }
  const tabClass = (mode) => {
    if (canvasMode === mode) return 'on'
    return ''
  }
  const hasTools = React.Children.toArray(children).length > 0
  const rowClass = () => {
    if (menu) return 'topbar has-menu'
    return 'topbar'
  }
  return (
    <header className={rowClass()}>
      {chrome && <div className="tb-row">
      <div className="tb-left">
        <a href="/" className="tb-logo"><b>Three</b>Slicer <span className="tb-re">RE</span></a>
        {menu}
        <button className="tb-btn" onClick={onOpen} title="Open a model file — every existing object is cleared" aria-label="Open" data-testid="open-file"><img src={openIcon} alt="" /></button>
        {onSaveProject && (
          <button className={exportClass('project')} onClick={onSaveProject} aria-label="Save as 3mf"
            disabled={!canSave || exportBusy} data-testid="save-project"
            title="Save as a .3mf project — geometry, settings, plate layout and painting, reopenable here or in OrcaSlicer">
            <img src={saveIcon} alt="" />{exporting === 'project' && <span>Saving…</span>}
          </button>
        )}
        {onExportSTL && (
          <button className={exportClass('stl')} onClick={onExportSTL}
            disabled={!canSave || exportBusy} data-testid="export-stl"
            title="Export the geometry alone as a binary .stl — settings and painting are not part of an STL">
            <span>{stlLabel()}</span>
          </button>
        )}
      </div>
      {gcodeJob && (
        <div className="tb-gcode" data-testid="gcode-job">
          <span>G-code · {gcodeJob.name} · {Object.keys(gcodeJob.plates).length} plate(s)</span>
          <button onClick={onCloseGcode} title="Close the G-code and go back to preparing models" data-testid="gcode-close">✕</button>
        </div>
      )}
      <div className="tb-spacer" />
      {showTabs && (
        <div className="tb-tabs" role="tablist" aria-label="Canvas mode">
          <button role="tab" className={tabClass('prepare')} onClick={() => onCanvasMode('prepare')} disabled={!prepareEnabled} data-testid="mode-prepare" title="Arrange, transform and paint supports (close an opened G-code first)">Prepare</button>
          <button role="tab" className={tabClass('preview')} onClick={() => onCanvasMode('preview')} disabled={!previewEnabled} data-testid="mode-preview" title="Preview the sliced toolpaths (enabled after slicing)">Preview</button>
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
      </div>}
      {hasTools && <div className="tb-tools">{children}</div>}
    </header>
  )
}
