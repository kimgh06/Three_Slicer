// The application menu: File, Edit, Object, View, Slice, Help. Pure data, so the labels can be tested against the
//  real key handler (test_menu_items.mjs): a shortcut printed here is one makeKeyHandler answers.
// An item without `run` is left out rather than greyed: the host switched that feature off, or it does not exist.
// `disabled` is for what exists but cannot run right now.

const SELECTION_TOOLS = ['delete', 'duplicate', 'split']
const TOOL_SHORTCUTS = { delete: 'Del', duplicate: 'Ctrl+K' }

function objectMenuItems(tools, state) {
  return tools.filter(tool => tool.sep || tool.run).map((tool) => {
    if (tool.sep) return tool
    const needsSelection = SELECTION_TOOLS.includes(tool.id) && !state.hasSelection
    return {
      id: tool.id, label: tool.label, title: tool.tip, run: tool.run, shortcut: TOOL_SHORTCUTS[tool.id],
      disabled: !state.prepare || needsSelection || !!tool.disabled?.(),
    }
  })
}

function gizmoMenuItems(actions, state) {
  const items = actions.gizmos.map(tool => ({
    id: `gizmo-${tool.id}`, label: tool.label, title: tool.tip, shortcut: tool.shortcut, run: tool.run,
    checked: !state.painting && state.gizmoMode === tool.mode, disabled: !state.prepare,
  }))
  if (actions.paintSupport) {
    items.push({ id: 'gizmo-paint', label: actions.paintSupport.label, title: actions.paintSupport.tip, run: actions.paintSupport.run,
      checked: state.painting, disabled: !state.prepare })
  }
  return items
}

// Drops unavailable items, then the separators that leaves at an edge or next to each other.
function tidyItems(items, shortcuts) {
  const kept = []
  for (const item of items) {
    if (item.sep) {
      if (kept.length && !kept[kept.length - 1].sep) kept.push(item)
    } else if (item.run) {
      let shown = item
      if (!shortcuts) shown = { ...item, shortcut: undefined }
      kept.push(shown)
    }
  }
  if (kept[kept.length - 1]?.sep) kept.pop()
  return kept
}

export function menuBar(actions, state) {
  const editBlocked = !state.prepare
  const menus = [
    { id: 'file', label: 'File', items: [
      { id: 'open', label: 'Open model…', run: actions.open },
      { sep: true },
      { id: 'save-project', label: 'Save project as .3mf…', run: actions.saveProject, disabled: !state.canSave },
      { id: 'export-stl', label: 'Export as .stl…', run: actions.exportStl, disabled: !state.canSave },
      { id: 'export-result', label: state.exportLabel, run: actions.exportResult, disabled: !state.canExport },
    ] },
    { id: 'edit', label: 'Edit', items: [
      { id: 'undo', label: 'Undo', shortcut: 'Ctrl+Z', run: actions.undo, disabled: !state.canUndo },
      { id: 'redo', label: 'Redo', shortcut: 'Ctrl+Y', run: actions.redo, disabled: !state.canRedo },
      { sep: true },
      { id: 'cut', label: 'Cut', shortcut: 'Ctrl+X', run: actions.cut, disabled: editBlocked || !state.hasSelection },
      { id: 'copy', label: 'Copy', shortcut: 'Ctrl+C', run: actions.copy, disabled: editBlocked || !state.hasSelection },
      { id: 'paste', label: 'Paste', shortcut: 'Ctrl+V', run: actions.paste, disabled: editBlocked || !state.canPaste },
      { sep: true },
      { id: 'select-all', label: 'Select all', shortcut: 'Ctrl+A', run: actions.selectAll, disabled: editBlocked || !state.hasObjects },
    ] },
    { id: 'object', label: 'Object', items: [...gizmoMenuItems(actions, state), { sep: true }, ...objectMenuItems(actions.tools, state)] },
    { id: 'view', label: 'View', items: [
      { id: 'prepare', label: 'Prepare', run: actions.prepareMode, checked: state.prepare, disabled: !state.canPrepare },
      { id: 'preview', label: 'Preview', run: actions.previewMode, checked: !state.prepare, disabled: !state.canPreview },
      { sep: true },
      { id: 'zoom-all', label: 'Zoom all', shortcut: 'Z', run: actions.zoomAll },
      { id: 'zoom-bed', label: 'Zoom bed', shortcut: 'B', run: actions.zoomBed },
    ] },
    { id: 'slice', label: 'Slice', items: [
      { id: 'slice-current', label: 'Slice current plate', shortcut: 'Ctrl+R', run: actions.sliceCurrent, disabled: !state.canSlice },
      { id: 'slice-all', label: 'Slice all plates', run: actions.sliceAll, disabled: !state.canSlice },
      { sep: true },
      { id: 'slice-cancel', label: 'Cancel slice', run: actions.cancelSlice, disabled: !state.slicing },
    ] },
    { id: 'help', label: 'Help', items: [
      { id: 'shortcuts', label: 'Keyboard shortcuts', shortcut: '?', run: actions.shortcuts },
    ] },
  ]
  return menus
    .map(menu => ({ ...menu, items: tidyItems(menu.items, state.shortcuts) }))
    .filter(menu => menu.items.length > 0)
}
