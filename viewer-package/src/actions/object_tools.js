import * as THREE from 'three'
import { arrangeOnBed } from '../core/arrange.js'
import { bakeLocal, positionBounds } from '../core/bake_local.js'
import { convexHull } from '../core/convex_hull.js'
import { measureBetween } from '../core/measure.js'
import { boxSoup, halfSpaceBox, localFromModel, modelSoup, placeOnSurface, seatShift } from '../core/model_soup.js'
import { bestOrientation } from '../core/orient.js'
import { request } from '../core/worker_reply.js'
import { builtInFont, fontFromFile, textSoup } from '../scene/text_mesh.js'
import { fallbackFor, textRuns } from '../core/text_runs.js'

const ARRANGE_SPACING_MM = 3
const MIN_LAYER_BAND_MM = 0.01  // the kernel refuses less with INVALID_VARIABLE_LAYERS
const TEXT_SINK_MM = 0.3      // text sinks this far into the surface, so the two solids slice as one
const BUILT_IN_FONT = Object.freeze({ id: 'latin', label: 'Latin', covers: ['latin'] })
const UPLOADED_FONT_ID = 'uploaded'
async function fetchFont({ url, label }) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${label}: ${response.status}`)
  return fontFromFile(await response.arrayBuffer())
}
export const TEXT_DEFAULTS = Object.freeze({ text: 'Text', size: 10, depth: 2, engraved: false, fontId: BUILT_IN_FONT.id })
const ENGRAVE_RISE_MM = 1     // an engraving's cutter stands this far out of the surface, so the cut opens cleanly
export const BOOLEAN_OPERATIONS = Object.freeze({ union: 0, difference: 1, intersection: 2 })
export const CUT_AXES = Object.freeze(['X', 'Y', 'Z'])
const NEGATIVE_SIZE_MM = 10
const CUT_GAP_MM = 5

export function layerBandsOf(settings) {
  const flat = settings?.variable_layer_heights ?? []
  const bands = []
  for (let at = 0; at + 1 < flat.length; at += 2) bands.push({ from: flat[at], height: flat[at + 1] })
  return bands
}

// The object toolbar's tools that act on geometry; the kernel's half is mesh_boolean.cpp, seam_paint.cpp and plan_layers.
export function makeObjectTools(deps) {
  const {
    apiRef, objectsRef, selectedPlateRef, plateBed, overhangAngle, toolRef, textFonts, setToolPanel, recordHistory, refreshObjects,
    afterObjectsChanged, setError, setSliceNotice, clearError, setPaintMode, getWorker, removeObject, flushPaintRef, selectorGeomRef, setSettings,
  } = deps
  const tools = () => apiRef.current?.tools
  // A multi-selection holds its meshes on a pivot group, so their positions read relative to it until it lets go. An undo
  //  entry taken before that restored them that far off (measured: 10 mm under the bed).
  const releaseSelection = () => apiRef.current?.clearSelection()
  const refresh = () => { refreshObjects(); afterObjectsChanged() }
  const soupOf = (object) => {
    object.mesh.updateMatrixWorld(true)
    return modelSoup(object.localPos, object.mesh.matrixWorld)
  }
  const onThePlate = () => objectsRef.current.filter(object => object.visible !== false && apiRef.current?.plateOfObject(object) === selectedPlateRef.current)

  function closeTool() {
    tools()?.setPick(null)
    tools()?.clearMarks()
    setToolPanel(null)
  }
  function openTool(panel, onPick, pickOptions) {
    setPaintMode('off')
    clearError()
    tools()?.clearMarks()
    tools()?.setPick(onPick, pickOptions)
    setToolPanel(panel)
  }

  // A second point is previewed under the pointer once the first is down, with its distance in the panel.
  function openMeasure() {
    toolRef.current.picks = []
    const show = (picks, hover) => {
      tools()?.showMarks(picks.map(pick => pick.worldPoint), hover)
      let result = null, preview = false
      if (picks.length === 2) result = measureBetween(picks[0], picks[1])
      else if (picks.length === 1 && hover) { result = measureBetween(picks[0], hover); preview = true }
      setToolPanel({ kind: 'measure', picks: picks.length, result, preview, snapped: hover?.snapped ?? null })
    }
    const onPick = (surface) => {
      let picks = [...toolRef.current.picks, surface]
      if (picks.length > 2) picks = [surface]   // a third click starts the next measurement
      toolRef.current.picks = picks
      show(toolRef.current.picks, null)
    }
    openTool({ kind: 'measure', picks: 0 }, onPick, { hover: hover => show(toolRef.current.picks, hover), snap: true })
  }

  // Text on a model and a negative part in one move with what they sit on: pulled apart, the text hangs in the air and the
  //  hole is gone. A text alone on the bed is arranged like any object, and a negative part over nothing stays put.
  function arrange() {
    releaseSelection()   // positions read below are relative to the pivot while a selection holds them
    const onPlate = onThePlate()
    const plain = onPlate.filter(object => !object.negative && !object.keepHeight)
    const hostOf = (object) => plain.find(candidate => boxOf(candidate).intersectsBox(boxOf(object)))
    const attached = onPlate.filter(object => !plain.includes(object) && hostOf(object)).map(object => ({ object, host: hostOf(object) }))
    const objects = onPlate.filter(object => plain.includes(object) || (!object.negative && !hostOf(object)))
    if (!objects.length) { setError('There is nothing to arrange on this plate'); return }
    const { bedW, bedD } = plateBed()
    const items = objects.map((object) => {
      const soup = soupOf(object), corners = []
      const { x, z } = object.mesh.position
      for (let i = 0; i < soup.length; i += 3) corners.push([soup[i] - x, soup[i + 1] + z])
      return { id: object.id, hull: convexHull(corners) }
    })
    const { placed, unplaced } = arrangeOnBed(items, { width: bedW, depth: bedD, spacing: ARRANGE_SPACING_MM })
    if (!placed.length) { setError('No object fits this plate'); return }
    recordHistory()
    const before = new Map(attached.map(({ host }) => [host, host.mesh.position.clone()]))
    for (const { id, x, y } of placed) apiRef.current?.placeObjectOnPlate(id, selectedPlateRef.current, x, y)
    for (const { object, host } of attached) {
      object.mesh.position.x += host.mesh.position.x - before.get(host).x
      object.mesh.position.z += host.mesh.position.z - before.get(host).z
    }
    refresh()
    clearError()
    if (unplaced.length) setSliceNotice(`Arranged ${placed.length} object(s). ${unplaced.length} did not fit and stayed where they were`)
    else setSliceNotice(`Arranged ${placed.length} object(s)`)
  }

  function orient() {
    const ids = apiRef.current?.selectedObjectIds() ?? []
    if (!ids.length) { setError('Select an object to orient first'); return }
    const turns = []
    for (const id of ids) {
      const direction = bestOrientation(soupOf(objectsRef.current.find(object => object.id === id)), overhangAngle)
      if (direction) turns.push({ id, direction })
    }
    if (!turns.length) { clearError(); setSliceNotice('Already in the best orientation found'); return }
    releaseSelection()
    recordHistory()
    for (const { id, direction } of turns) tools()?.faceBed(id, direction)
    refresh()
    clearError()
    setSliceNotice(`Oriented ${turns.length} object(s)`)
  }

  // A new object from model-frame triangles, where those triangles already are.
  function spawnSoup(name, soup, { extruder = 1, keepHeight = false, negative = false, shiftX = 0, seated = false } = {}) {
    const { min, max } = positionBounds(soup)
    const { localPos } = bakeLocal(soup)
    let height = min[2]
    if (seated) height = 0
    if (keepHeight) height -= seatShift(height, { keepHeight, negative })
    const pos = new THREE.Vector3((min[0] + max[0]) / 2 + shiftX, height, -(min[1] + max[1]) / 2)
    return apiRef.current?.spawnSnapshot({ name, extruder, keepHeight, negative, localPos, rot: null, scale: null, pos }, true)
  }

  // ---- through the kernel (mesh_boolean.cpp) ----
  async function kernelBoolean(first, second, operation) {
    const reply = await request(getWorker(), { cmd: 'meshBoolean', first, second, operation }, { types: ['meshBoolean'] })
    if (reply.error) throw new Error(reply.error)
    return reply.positions
  }
  const objectById = (id) => objectsRef.current.find(object => object.id === id)
  const setBusy = (panel) => setToolPanel(panel)
  // Runs one kernel edit under an undo entry. Facet paint is keyed to the old facets, so a replaced object loses it.
  async function replaceObjects(sources, build, doneMessage) {
    await flushPaintRef?.current?.()
    const painted = sources.some(object => object.paint?.color?.size || object.paint?.supports?.size || object.paint?.seam?.size)
    let pieces
    try { pieces = await build() }
    catch (error) { setError(error?.message || String(error)); return false }
    releaseSelection()
    recordHistory()
    for (const object of sources) removeObject(object.id)
    pieces()
    refresh()
    clearError()
    if (painted) setSliceNotice(`${doneMessage}. The painting on the replaced objects was dropped`)
    else setSliceNotice(doneMessage)
    return true
  }

  function openBoolean() {
    const ids = apiRef.current?.selectedObjectIds() ?? []
    if (ids.length !== 2) { setError('Select exactly two objects for a boolean (Ctrl+click adds the second)'); return }
    toolRef.current.booleanIds = ids
    openTool({ kind: 'boolean', names: ids.map(id => objectById(id)?.name) }, null)
  }
  function swapBoolean() {
    toolRef.current.booleanIds = [...toolRef.current.booleanIds].reverse()
    setToolPanel({ kind: 'boolean', names: toolRef.current.booleanIds.map(id => objectById(id)?.name) })
  }
  async function runBoolean(operation) {
    const [first, second] = toolRef.current.booleanIds.map(objectById)
    if (!first || !second) { setError('Those objects are gone'); closeTool(); return }
    setBusy({ kind: 'boolean', names: [first.name, second.name], busy: true })
    const done = await replaceObjects([first, second], async () => {
      const positions = await kernelBoolean(soupOf(first), soupOf(second), BOOLEAN_OPERATIONS[operation])
      return () => spawnSoup(`${first.name} ${operation}`, positions, { extruder: first.extruder, seated: true })
    }, `Boolean ${operation} done`)
    if (done) closeTool()
    else setBusy({ kind: 'boolean', names: [first.name, second.name] })
  }

  const cutPanel = (extra = {}) => ({ kind: 'cut', ...toolRef.current.cut, ...extra })
  const showCutPlane = () => {
    const { axis, at, bounds } = toolRef.current.cut
    tools()?.showPlane(axis, at, bounds)
  }
  function openCut() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('Select an object to cut first'); return }
    const bounds = positionBounds(soupOf(objectById(id)))
    toolRef.current.cut = { id, axis: 2, at: (bounds.min[2] + bounds.max[2]) / 2, bounds, keep: 'both' }
    openTool(cutPanel(), null)
    showCutPlane()
  }
  function setCutOption(key, value) {
    const cut = { ...toolRef.current.cut, [key]: value }
    if (key === 'axis') cut.at = (cut.bounds.min[value] + cut.bounds.max[value]) / 2
    toolRef.current.cut = cut
    setToolPanel(cutPanel())
    showCutPlane()
  }
  async function runCut() {
    const { id, axis, at, bounds, keep } = toolRef.current.cut
    const object = objectById(id)
    if (!object) { setError('That object is gone'); closeTool(); return }
    setBusy(cutPanel({ busy: true }))
    const sides = { both: [true, false], upper: [true], lower: [false] }[keep]
    const done = await replaceObjects([object], async () => {
      const soup = soupOf(object), parts = []
      for (const upper of sides) parts.push({ upper, positions: await kernelBoolean(soup, halfSpaceBox(bounds, axis, at, upper), BOOLEAN_OPERATIONS.intersection) })
      return () => parts.forEach((part, index) => {
        // Two halves of a Z cut would both seat on the same spot, so the second stands beside the first.
        let shiftX = 0
        if (axis === 2 && index > 0) shiftX = bounds.max[0] - bounds.min[0] + CUT_GAP_MM
        spawnSoup(`${object.name} ${index + 1}`, part.positions, { extruder: object.extruder, shiftX, seated: true })
      })
    }, 'Cut done')
    if (done) closeTool()
    else setBusy(cutPanel())
  }

  function openNegative() {
    toolRef.current.negative = { shape: 'box', size: NEGATIVE_SIZE_MM }
    openTool({ kind: 'negative', ...toolRef.current.negative }, null)
  }
  function setNegativeOption(key, value) {
    toolRef.current.negative = { ...toolRef.current.negative, [key]: value }
    setToolPanel({ kind: 'negative', ...toolRef.current.negative })
  }
  function addNegative() {
    const { shape, size } = toolRef.current.negative
    const half = size / 2
    const shapes = {
      box: () => boxSoup([-half, -half, 0], [half, half, size]),
      cylinder: () => new THREE.CylinderGeometry(half, half, size, 48).rotateX(Math.PI / 2).translate(0, 0, half).toNonIndexed(),
      sphere: () => new THREE.SphereGeometry(half, 32, 24).translate(0, 0, half).toNonIndexed(),
    }
    const built = shapes[shape]()
    let soup = built
    if (built.getAttribute) soup = Float32Array.from(built.getAttribute('position').array)
    const origin = apiRef.current?.platePos(selectedPlateRef.current)
    const placed = new Float32Array(soup)
    for (let i = 0; i < placed.length; i += 3) { placed[i] += origin.x; placed[i + 1] -= origin.z }
    recordHistory()
    const added = spawnSoup(`Negative ${shape}`, placed, { keepHeight: true, negative: true })
    apiRef.current?.selectObject(added.id)
    refresh()
    clearError()
  }
  function toggleNegative() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('Select an object first'); return }
    recordHistory()
    tools()?.setNegative(id, !objectById(id).negative)
    refresh()
  }
  function setNegativeHeight(height) {
    const id = apiRef.current?.selectedObjectId()
    if (!id || !objectById(id)?.negative) { setError('Select a negative part first'); return }
    recordHistory('negative-height')
    tools()?.setHeight(id, height)
    refresh()
  }

  // What a slice or an export needs before it reads the geometry: each object cut by the negative parts over it. Done
  //  here because the kernel's boolean is asynchronous and buildMergedSTL is not. Cached on the transforms involved.
  const cutSignature = (object, cutters) => [object, ...cutters].map(item => { item.mesh.updateMatrixWorld(true); return `${item.id}:${item.mesh.matrixWorld.elements.join()}` }).join('|')
  const boxOf = (object) => new THREE.Box3().setFromObject(object.mesh, true)
  async function prepareGeometry() {
    if (selectorGeomRef?.current?.kind === 'seam') await flushPaintRef?.current?.()
    const negatives = objectsRef.current.filter(object => object.negative && object.visible !== false)
    for (const object of objectsRef.current) {
      if (!negatives.length) { object.cutPos = null; object.cutSignature = null; continue }
      if (object.negative) continue
      const box = boxOf(object)
      const cutters = negatives.filter(negative => boxOf(negative).intersectsBox(box))
      if (!cutters.length) { object.cutPos = null; object.cutSignature = null; continue }
      if (object.paint?.color?.size || object.paint?.supports?.size || object.paint?.seam?.size) {
        setError(`UNSUPPORTED_NEGATIVE_ON_PAINTED: ${object.name} is painted, and a negative part would renumber its facets. Clear the painting or move the part`)
        return false
      }
      const signature = cutSignature(object, cutters)
      if (object.cutSignature === signature) continue
      try {
        let soup = soupOf(object)
        for (const cutter of cutters) soup = await kernelBoolean(soup, soupOf(cutter), BOOLEAN_OPERATIONS.difference)
        object.cutPos = localFromModel(soup, object.mesh.matrixWorld)
        object.cutSignature = signature
      } catch (error) { setError(error?.message || String(error)); return false }
    }
    return true
  }

  const fontEntries = () => [BUILT_IN_FONT, ...(textFonts ?? []), toolRef.current.uploadedFont].filter(Boolean)
  const showTextPanel = (extra = {}) => setToolPanel({ kind: 'text', options: toolRef.current.text, fonts: fontEntries(), ...extra })
  // One parse per font: a CJK font is several MB. A failed fetch is forgotten so that the next attempt retries it.
  function loadTextFont(entry) {
    const cache = toolRef.current.loadedFonts ??= new Map()
    if (!cache.has(entry.id)) {
      let loading = builtInFont()
      if (entry.url) loading = fetchFont(entry)
      cache.set(entry.id, loading)
      loading.catch(() => cache.delete(entry.id))
    }
    return cache.get(entry.id)
  }
  // Each character's font: the chosen one, then the font its script falls back to.
  async function fontsForText(text) {
    const entries = fontEntries()
    const chosen = await loadTextFont(entries.find(entry => entry.id === toolRef.current.text.fontId) ?? BUILT_IN_FONT)
    const fontByCharacter = new Map()
    const missing = []
    for (const character of new Set(text.replace(/\s/g, ''))) {
      const fallback = !chosen.data.glyphs[character] && fallbackFor(character, entries)
      let font = chosen
      if (fallback) font = await loadTextFont(fallback)
      if (font.data.glyphs[character]) fontByCharacter.set(character, font)
      else missing.push(character)
    }
    return { chosen, fontByCharacter, missing }
  }
  async function placeText(point, normal, extruder, targetId = null) {
    const { text, size, depth, engraved } = toolRef.current.text
    if (!text.trim()) { showTextPanel({ problem: 'Type the text to place first' }); return }
    showTextPanel({ notice: 'Loading font…' })
    let fonts
    try { fonts = await fontsForText(text) } catch (error) { showTextPanel({ problem: `That font could not be loaded: ${error?.message || error}` }); return }
    if (fonts.missing.length) { showTextPanel({ problem: `No font here has ${fonts.missing.join(' ')}. Pick one that does, or load a font file.` }); return }
    showTextPanel()
    const runs = textRuns(text, character => fonts.fontByCharacter.get(character), fonts.chosen)
    const letters = textSoup(runs, { size, depth: depth + ENGRAVE_RISE_MM })
    if (engraved && targetId != null) {
      const target = objectById(targetId)
      const cutter = placeOnSurface(letters, point, normal, depth)
      await replaceObjects([target], async () => {
        const positions = await kernelBoolean(soupOf(target), cutter, BOOLEAN_OPERATIONS.difference)
        return () => spawnSoup(target.name, positions, { extruder: target.extruder, keepHeight: target.keepHeight, seated: !target.keepHeight })
      }, `Engraved "${text}"`)
      closeTool()
      return
    }
    recordHistory()
    const soup = placeOnSurface(textSoup(runs, { size, depth }), point, normal, TEXT_SINK_MM)
    const added = spawnSoup(`Text ${text}`, soup, { extruder, keepHeight: true })
    closeTool()   // one click, one text: the next click on a model selects it
    apiRef.current?.selectObject(added.id)
    refresh()
    clearError()
    setSliceNotice(`Placed "${text}"`)
  }
  function openText() {
    toolRef.current.text ??= { ...TEXT_DEFAULTS }
    const onPick = (surface) => {
      const object = objectsRef.current.find(candidate => candidate.id === surface.objectId)
      return placeText(surface.point, surface.normal, object?.extruder ?? 1, surface.objectId)
    }
    openTool({ kind: 'text', options: toolRef.current.text, fonts: fontEntries() }, onPick)
  }
  const setTextOption = (key, value) => {
    toolRef.current.text = { ...toolRef.current.text, [key]: value }
    showTextPanel()
  }
  async function loadFont(file) {
    try {
      const font = fontFromFile(await file.arrayBuffer())
      toolRef.current.uploadedFont = { id: UPLOADED_FONT_ID, label: file.name }
      toolRef.current.loadedFonts ??= new Map()
      toolRef.current.loadedFonts.set(UPLOADED_FONT_ID, Promise.resolve(font))
      setTextOption('fontId', UPLOADED_FONT_ID)
    } catch (error) { showTextPanel({ problem: `That font could not be read: ${error?.message || error}` }) }
  }
  const placeTextOnBed = () => {
    const origin = apiRef.current?.platePos(selectedPlateRef.current)
    return placeText([origin.x, -origin.z, 0], [0, 0, 1], 1)
  }

  const openSeam = () => { closeTool(); setPaintMode('seam-enforcer') }

  // Variable layer height: sorted flat [fromZ, height, ...] in the settings map, absent when there are no bands.
  function openLayers() {
    openTool({ kind: 'layers' }, null)
  }
  function setLayerBands(bands) {
    if (bands.some(band => !(band.height >= MIN_LAYER_BAND_MM))) { setError(`A layer height band must be at least ${MIN_LAYER_BAND_MM} mm`); return }
    clearError()
    const sorted = [...bands].sort((a, b) => a.from - b.from)
    setSettings?.((previous) => {
      const next = { ...previous }
      delete next.variable_layer_heights
      if (sorted.length) next.variable_layer_heights = sorted.flatMap(band => [band.from, band.height])
      return next
    })
  }

  return {
    closeTool, openMeasure, arrange, orient, openText, setTextOption, loadFont, placeTextOnBed, openBoolean, swapBoolean, runBoolean,
    openCut, setCutOption, runCut, openNegative, setNegativeOption, addNegative, toggleNegative, setNegativeHeight, prepareGeometry,
    openSeam, openLayers, setLayerBands,
  }
}
