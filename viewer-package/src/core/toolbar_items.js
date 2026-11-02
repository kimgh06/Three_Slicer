import {
  addIcon, deleteIcon, deleteallIcon, duplicateIcon, splitIcon, onbedIcon, arrangeIcon, orientIcon,
  cutIcon, booleanIcon, negativeIcon, seamIcon, mmuIcon, textmarkIcon, measureIcon, varlayerIcon,
  moveIcon, rotateIcon, scaleIcon, paintIcon,
} from './icons.js'

// The gizmo group of the ribbon, which the Object menu lists too. `mode` is the scene's gizmo mode.
export const GIZMO_TOOLS = [
  { id: 'move', mode: 'translate', icon: moveIcon, label: 'Move', shortcut: 'M', tip: 'Move the object across the bed — drag a gizmo axis or use arrow keys for 10mm (Shift 1mm). A part prints off the bed, so there is no up/down axis (M/G)' },
  { id: 'rotate', mode: 'rotate', icon: rotateIcon, label: 'Rotate', shortcut: 'R', tip: 'Rotate the object — PageUp/PageDown rotates in 45° steps (R)' },
  { id: 'scale', mode: 'scale', icon: scaleIcon, label: 'Scale', shortcut: 'S', tip: 'Scale the object — drag a corner of the bounding box to resize X, Y and Z together, or a gizmo axis for one axis (S)' },
]
export const SUPPORT_PAINT_TOOL = { id: 'paint', icon: paintIcon, label: 'Support painting', tip: 'Brush facets to enforce or block support — Ctrl+wheel changes the brush size' }

// Object toolbar definition, following the upstream toolbar (GLToolbar) layout.
// An entry without `run` is not implemented: the ribbon and the menu leave it out, and its tip records what it needs.
// A `sep` opens a ribbon group and names it; the menu draws it as a divider.
// When adding buttons, edit this array instead of duplicating JSX.
export function ribbonGroups(tools) {
  const groups = []
  for (const tool of tools) {
    if (tool.sep) groups.push({ caption: tool.group, tools: [] })
    else if (tool.run) groups[groups.length - 1].tools.push(tool)
  }
  return groups.filter(group => group.tools.length > 0)
}

export function objectTools(actions) {
  return [
    { sep: true, group: 'Objects' },
    { id: 'add', icon: addIcon, label: 'Add', tip: 'Add a model file to the current plate (existing objects are kept)', run: actions.add },
    { id: 'delete', icon: deleteIcon, label: 'Delete', tip: 'Delete the selected object (Del)', run: actions.remove },
    { id: 'delete-all', icon: deleteallIcon, label: 'Delete all', tip: 'Delete every object on the plate', run: actions.removeAll, disabled: () => actions.objectCount() === 0 },
    { sep: true, group: 'Edit' },
    { id: 'duplicate', icon: duplicateIcon, label: 'Duplicate', tip: 'Duplicate the selected object (Ctrl+K)', run: actions.duplicate },
    { id: 'split', icon: splitIcon, label: 'Split', tip: 'Split to objects — every disconnected part (connected component) becomes its own object. Split to parts is not implemented (no part concept)', run: actions.split },
    { id: 'onbed', icon: onbedIcon, label: 'Place on bed', tip: 'Drop every object onto the bed (Z=0). Text stays on its model unless it is selected', run: actions.placeOnBed },
    { sep: true, group: 'Layout' },
    { id: 'arrange', icon: arrangeIcon, label: 'Arrange', tip: 'Auto arrange — lay the plate\'s objects out on the bed without overlap', run: actions.arrange },
    { id: 'orient', icon: orientIcon, label: 'Orient', tip: 'Auto orient — rotate the selected object to the orientation needing the least support', run: actions.orient },
    { sep: true, group: 'Modify' },
    { id: 'cut', icon: cutIcon, label: 'Cut', tip: 'Cut — slice the selected object with a plane into two solid pieces', run: actions.cut, active: actions.toolActive?.('cut') },
    { id: 'boolean', icon: booleanIcon, label: 'Boolean', tip: 'Mesh boolean — union, difference or intersection of two selected objects', run: actions.boolean, active: actions.toolActive?.('boolean') },
    { id: 'negative', icon: negativeIcon, label: 'Negative part', tip: 'Negative part — a shape that cuts away what it overlaps when you slice', run: actions.negative, active: actions.toolActive?.('negative') },
    { sep: true, group: 'Surface' },
    { id: 'seam', icon: seamIcon, label: 'Seam painting', tip: 'Seam painting — brush where the layer seam goes, or where it must not', run: actions.seam, active: actions.seamActive },
    { id: 'mmu', icon: mmuIcon, label: 'Color painting', tip: 'Color painting — brush a region so it prints with another filament (opens on T1; the panel picks the rest)', run: actions.paintMaterial },
    { id: 'text', icon: textmarkIcon, label: 'Text', tip: 'Text — raise letters from a model surface or stand them on the bed', run: actions.text, active: actions.toolActive?.('text') },
    { id: 'measure', icon: measureIcon, label: 'Measure', tip: 'Measure — distance and angle between two points or faces', run: actions.measure, active: actions.toolActive?.('measure') },
    { id: 'varlayer', icon: varlayerIcon, label: 'Variable layers', tip: 'Variable layer height — different layer heights per Z band', run: actions.layers, active: actions.toolActive?.('layers') },
  ]
}
