import React from 'react'

// Right-click menu of an object. `menu` is {x, y}; every entry closes the menu first. Empty space opens none: its
//  entries were all in the menu bar, and on macOS it opened at the press of every right-drag pan.
// `selectedCount` only shapes the wording — upstream's object menu carries the same Export entries whether one or
//  several objects are selected (GUI_Factories.cpp:972), and saying "3 objects" is the difference between trusting
//  the menu and re-counting the scene.
export default function ContextMenu({ menu, onClose, actions, selectedCount = 0 }) {
  const run = (fn) => () => { onClose(); fn?.() }
  let subject = 'selection'
  if (selectedCount > 1) subject = `${selectedCount} objects`
  return (
    <>
      <div className="ctx-scrim" onPointerDown={onClose} onContextMenu={e => { e.preventDefault(); onClose() }} />
      <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} data-testid="ctx-menu">
        <button onClick={run(actions.duplicate)} data-testid="ctx-duplicate" title="Duplicate the selected object at the same scale and rotation, placed beside it">Duplicate <span className="ctx-key">Ctrl+K</span></button>
        <button onClick={run(actions.copy)} data-testid="ctx-copy" title="Copy the selected object to the buffer (paste to add it)">Copy <span className="ctx-key">Ctrl+C</span></button>
        <button onClick={run(actions.split)} data-testid="ctx-split" title="Split to objects — every disconnected part (connected component) becomes its own object. Split to parts is not implemented (no part concept)">Split</button>
        <button onClick={run(actions.placeOnBed)} data-testid="ctx-seat" title="Drop every object onto the bed (Z=0)">Place on bed</button>
        <hr />
        <button onClick={run(actions.exportSelectedSTL)} data-testid="ctx-export-stl"
          title="Export just the selected object(s) as one binary STL — geometry only">Export {subject} as STL…</button>
        <button onClick={run(actions.exportSelectedProject)} data-testid="ctx-export-3mf"
          title="Save just the selected object(s) as a 3mf project — keeps settings, plate and painting">Export {subject} as 3MF…</button>
        <hr />
        <button className="danger" onClick={run(actions.remove)} data-testid="ctx-delete" title="Remove the selected object from the scene">Delete <span className="ctx-key">Del</span></button>
      </div>
    </>
  )
}
