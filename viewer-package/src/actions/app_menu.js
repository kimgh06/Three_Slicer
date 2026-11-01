import { menuBar } from '../core/menu_items.js'
import { GIZMO_TOOLS, SUPPORT_PAINT_TOOL, objectTools } from '../core/toolbar_items.js'

// Binds the object toolbar and the application menu to the viewport's handlers. `deps` is rebuilt on every render.

export function boundObjectTools(deps) {
  return objectTools({
    add: deps.openFilePicker,
    remove: deps.deleteSelected,
    removeAll: deps.deleteAllObjects,
    duplicate: deps.duplicateSelected,
    split: deps.splitSelected,
    placeOnBed: () => { deps.recordHistory(); deps.apiRef.current?.placeOnBed() },
    // The toolbar is upstream's entry point for the MMU brush; the filament rows' brush buttons are this viewer's
    //  addition on top, not a replacement. Opening it on T1 is what upstream does — the gizmo starts at
    //  m_selected_extruder_idx 0 — and the panel's chips are one click from any other filament.
    paintMaterial: () => deps.startMaterialPaint(0),
    objectCount: () => deps.objects.length,
  })
}

// The export the plate's technology produces, as the slice bar's button offers it.
function resultExport(deps) {
  if (deps.tech === 'SLA') {
    return { label: 'Export SL1…', run: deps.exportPlateSl1, ready: !!deps.plateResultsRef.current[deps.selectedPlate]?.stats?.sla }
  }
  return { label: 'Export G-code…', run: deps.exportAllGcode, ready: !!deps.gcodeResult }
}

export function appMenus(deps, tools) {
  const prepare = deps.canvasMode === 'prepare'
  const hasObjects = deps.objects.length > 0
  const exportTarget = resultExport(deps)
  const api = () => deps.apiRef.current
  const actions = {
    saveProject: deps.exportProject, exportStl: deps.exportSTL,
    undo: () => deps.travelHistory('undo'), redo: () => deps.travelHistory('redo'),
    cut: () => { deps.copySelected(); deps.deleteSelected() }, copy: deps.copySelected, paste: deps.pasteClipboard,
    selectAll: () => api()?.selectAllObjects(),
    prepareMode: () => deps.enterCanvasMode('prepare'), previewMode: () => deps.enterCanvasMode('preview'),
    zoomAll: () => api()?.frame(), zoomBed: () => api()?.frameBed(),
    tools: [], gizmos: [],
  }
  if (deps.showPanel('objectToolbar')) actions.tools = tools.filter(tool => deps.tech !== 'SLA' || tool.id !== 'mmu')
  if (deps.showPanel('gizmoRail')) {
    actions.gizmos = GIZMO_TOOLS.map(tool => ({ ...tool, run: () => deps.setGizmo(tool.mode) }))
    if (deps.tech !== 'SLA') actions.paintSupport = { ...SUPPORT_PAINT_TOOL, run: deps.togglePaintGizmo }
  }
  if (deps.feature('filePicker')) actions.open = deps.openFilePicker
  if (deps.feature('shortcuts')) actions.shortcuts = () => deps.setShowHelp(true)
  if (deps.showPanel('sliceBar')) {
    actions.sliceCurrent = () => deps.onSlice('current')
    actions.cancelSlice = deps.cancelSlice
    actions.exportResult = () => exportTarget.run()
    if (deps.plateCount > 1) actions.sliceAll = () => deps.onSlice('all')
  }
  return menuBar(actions, {
    prepare, gizmoMode: deps.gmode, painting: deps.supportPainting, hasObjects, hasSelection: deps.selectedIds.length > 0, canPaste: !!deps.clipboardRef.current,
    canSave: hasObjects && !deps.exporting, exportLabel: exportTarget.label,
    canExport: exportTarget.ready && !deps.bedOver && !deps.overBed && !deps.exporting,
    canUndo: deps.historyDepth.undo > 0 && prepare, canRedo: deps.historyDepth.redo > 0 && prepare,
    canPrepare: !deps.gcodeOnly, canPreview: deps.layerCount > 0, canSlice: deps.canSlice && !deps.slicing, slicing: deps.slicing,
    shortcuts: deps.feature('shortcuts'),
  })
}
