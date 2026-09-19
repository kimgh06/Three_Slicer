import { log } from '../core/log.js'
import { objectRows } from '../core/object_rows.js'
import { normalizeProjectSettings, deriveKernelParams } from 'three-slicer-viewer/settings'
import { loadModel, SUPPORTED_EXT, fileExt } from '../scene/model_loaders.js'
import { plateCols, UPSTREAM_PLATE_GAP_RATIO, MAX_PLATES } from '../core/plate_layout.js'
import { PRESET_ACCEPT } from './preset_actions.js'
import { UNKNOWN_COLOR } from '../core/viewer_defaults.js'

// The preset picker's accept list, as bare extensions — loadFiles routes these to loadPresetFile, so dropping a
//  preset (or passing one through the `files` prop) behaves like picking it from the printer card.
const PRESET_EXTS = PRESET_ACCEPT.split(',').map(s => s.replace('.', ''))

// Stage 26: model loading (STL/OBJ/3MF/AMF/PLY, cumulative) — shared by the file picker and drag-and-drop.
// The component keeps owning the refs/state; this factory only receives what it uses and is rebuilt each
//  render so the values it closes over (dragOver) stay fresh.

// ---- 3mf project import ------------------------------------------------------------------------------------
// A 3mf written by a slicer (anything off MakerWorld, or any OrcaSlicer/BambuStudio "save project") carries the
//  preset it was sliced with, the per-object state and the plate layout next to the meshes. Importing only the
//  geometry silently drops the half of the file the author actually tuned, so it is all read — and whatever this
//  kernel has no equivalent for is REPORTED rather than dropped in silence.
// The per-object metadata keys that are applied rather than dropped; anything else in there is an override this
//  viewer has no per-object settings to hold.
const APPLIED_OBJECT_KEYS = new Set(['name', 'extruder'])

// Where an imported object goes. A slicer-written 3mf stores ABSOLUTE coordinates and lays its plates out in world
//  space, so an object's position already encodes both which plate it is on and where on it — but only under the
//  authoring slicer's grid rule, which is not this viewer's:
//     upstream (PartPlate.cpp compute_shape_position / plate_stride_x): origin = (col*W*1.2, -row*D*1.2),
//       LOGICAL_PART_PLATE_GAP = 1/5, plate origin at the plate's CORNER, rows growing along -y
//     here (plate_layout.js):      origin = (col*(W+40),  +row*(D+40)),  plate origin at the plate's CENTRE
//  So the coordinates are decoded with upstream's rule and re-emitted with ours. Verified against a real 6-plate
//  MakerWorld project: every one of its 17 objects decodes to inside 0..256mm of the plate it claims.
//  (The grid constant lives in plate_layout.js so the 3mf WRITER encodes with the same rule.)

function groupCentredPlacements(plates, byObjectId) {
  // Fallback: keep each plate's objects arranged relative to each other and centre the group on our plate. Used
  //  when the absolute decode does not check out — the arrangement survives even though the bed position does not.
  const out = []
  for (const plate of plates) {
    const group = plate.objectIds.map(id => byObjectId.get(id)).filter(e => e?.bbox)
    if (!group.length) continue
    const minX = Math.min(...group.map(e => e.bbox.minX)), maxX = Math.max(...group.map(e => e.bbox.maxX))
    const minY = Math.min(...group.map(e => e.bbox.minY)), maxY = Math.max(...group.map(e => e.bbox.maxY))
    for (const e of group)
      out.push([e.id, plate.index,
        (e.bbox.minX + e.bbox.maxX) / 2 - (minX + maxX) / 2,
        (e.bbox.minY + e.bbox.maxY) / 2 - (minY + maxY) / 2])
  }
  return out
}

/** Exported for the import test — the placement rule is the part with a wrong answer worth pinning. */
export function platePlacements(plates, loaded, bedWidth, bedDepth) {
  const byObjectId = new Map(loaded.map(e => [e.objectid, e]))
  if (!(bedWidth > 0 && bedDepth > 0)) return groupCentredPlacements(plates, byObjectId)
  const cols = plateCols(plates.length)
  const strideX = bedWidth * (1 + UPSTREAM_PLATE_GAP_RATIO)
  const strideY = bedDepth * (1 + UPSTREAM_PLATE_GAP_RATIO)
  const out = []
  let decoded = true
  for (const plate of plates) {
    const group = plate.objectIds.map(id => byObjectId.get(id)).filter(e => e?.bbox)
    if (!group.length) continue
    const originX = (plate.index % cols) * strideX
    const originY = -Math.floor(plate.index / cols) * strideY
    for (const e of group) {
      const localX = (e.bbox.minX + e.bbox.maxX) / 2 - originX
      const localY = (e.bbox.minY + e.bbox.maxY) / 2 - originY
      // The decode is only right if every object lands on the plate it says it is on. A project written under a
      //  different grid rule would put them somewhere else entirely, and scattering objects off the bed is worse
      //  than losing the absolute placement — so one bad object drops the whole file to the fallback.
      if (localX < 0 || localX > bedWidth || localY < 0 || localY > bedDepth) decoded = false
      out.push([e.id, plate.index, localX - bedWidth / 2, localY - bedDepth / 2])
    }
  }
  return decoded ? out : groupCentredPlacements(plates, byObjectId)
}

function droppedFeatures(project, loaded) {
  const dropped = []
  if (loaded.some(o => o.paint?.seam?.size)) dropped.push('seam painting')
  if (loaded.some(o => o.paint?.fuzzy?.size)) dropped.push('fuzzy-skin painting')
  if (project.hasLayerHeightProfile) dropped.push('variable layer height')
  if (project.hasCustomGcodePerLayer) dropped.push('per-layer custom G-code')
  // A per-object override only counts if it names something the config schema knows — the rest of that metadata is
  //  bookkeeping (ids, thumbnails, mesh statistics) with nothing to apply.
  for (const meta of project.objectMeta.values()) {
    const overrides = Object.keys(meta).filter(key => !APPLIED_OBJECT_KEYS.has(key))
    if (overrides.length && normalizeProjectSettings(Object.fromEntries(overrides.map(k => [k, meta[k]]))).applied) {
      dropped.push('per-object setting overrides'); break
    }
  }
  return dropped
}

export function makeModelLoad(deps) {
  const {
    apiRef, objectsRef, layersDataRef, segDataRef, plateResultsRef, plateOffsetsRef,
    clearToolpaths, refreshSlicedCount, dragOver, registerSelectorRef, applyProjectFilaments, setSettings, setPlateSettings, importSl1, loadPresetFile,
    selectedPlateRef, disposePlateToolpath, plateCountRef, setPlateCount, bedRef,
    setError, setTriWarn, setProgress, setStats, setOverBed, setLayerCount, setSegCount,
    setColorRange, setSliceNotice, setDowngradeOffer, setGcodeUrl, setCanvasMode, setObjects, setDragOver,
  } = deps

  // Grow the bed to the plate count an imported 3mf project needs, then let it place its objects. setPlates is
  //  called directly as well as through setPlateCount because it writes plateCountRef and plateBWRef/plateBDRef
  //  SYNCHRONOUSLY, and those are what the plate origins are computed from — going through React state alone would
  //  place every object against the OLD grid and let Viewport's plate-layout effect re-lay the plates underneath them.
  // The bed must come from the PROJECT, not from `kp`: kp is derived from the settings of the render this callback
  //  was created in, and setSettings has not landed yet. Getting that wrong is not a rounding error — the default
  //  bed is 200mm and a Bambu project is 256mm, so the grid step moved 240 -> 296 right after placement and every
  //  plate past the first drifted by 56mm per column (plate 2 by 112mm), which is exactly what it looked like.
  // A plate's cached slice, dropped when a load changes what sits on it. At factory scope because both the load and
  //  the project placement call it — it used to be local to loadFiles, so applyProject's call threw a ReferenceError
  //  and every multi-plate project import failed with "dropPlateResult is not defined".
  const dropPlateResult = (plate) => { delete plateResultsRef.current[plate]; delete plateOffsetsRef.current[plate]; disposePlateToolpath?.(plate) }

  const applyProjectPlates = (needed, bedWidth, bedDepth, place) => {
    const n = Math.min(MAX_PLATES, Math.max(plateCountRef.current, needed))
    const width = bedWidth > 0 ? bedWidth : bedRef.current.bedW
    const depth = bedDepth > 0 ? bedDepth : bedRef.current.bedD
    apiRef.current?.setPlates(n, width, depth, selectedPlateRef.current)
    setPlateCount(n)
    place(n)
  }

  // Everything a 3mf's Metadata/*.config asks for, applied once the meshes are in the scene. `loaded` pairs each
  //  3mf object id with the viewer object it became, which is what the per-object and per-plate state is keyed by.
  function applyProject(project, loaded) {
    const notices = []
    const imported = project.settings ? normalizeProjectSettings(project.settings) : null
    // The bed the project was authored on. Needed twice below and BOTH times before React has applied the new
    //  settings, so it is derived here from the incoming map rather than read back off the component.
    const bed = imported?.applied ? deriveKernelParams(imported.settings) : null
    if (imported?.applied) {
      // Replace rather than merge: this map is "what the project is", and merging would leave keys from whatever
      //  was loaded before silently overriding the author's preset in ways nothing on screen would explain.
      //  The per-plate overrides go with it, for the same reason: an upstream 3mf carries no per-plate printer state, so a
      //  previous session's "plate 2 is SLA / 330mm" surviving onto the imported project would resize its grid
      //  and reroute its slicer with nothing on screen explaining why.
      //  What does travel with it is this package's own member (write_3mf.js): the global viewer knobs the schema
      //  cannot type (wipe_tower_real...) layered over the map here, and the per-plate overrides once the plates
      //  exist (below).
      setSettings?.(project.viewerSettings ? { ...imported.settings, ...project.viewerSettings } : imported.settings)
      notices.push(`${imported.applied} settings`)
      // The filament list, before the per-object extruders below — those are coloured by looking the extruder up
      //  in it. `filament_colour` is the one key that always has one entry per loaded filament (the *_settings_id
      //  vector can carry blanks for a slot with no preset), so it is what the count comes from.
      const colors = imported.settings.filament_colour
      if (Array.isArray(colors) && colors.length) {
        applyProjectFilaments?.(colors.map(c => (typeof c === 'string' && c.trim()) || UNKNOWN_COLOR))
        notices.push(`${colors.length} filaments`)
      }
    }
    //  A save whose global map held no schema key writes no project_settings.config at all, but may still carry our
    //  member — its knobs then go over the settings already loaded rather than being dropped with the missing file.
    else if (project.viewerSettings) setSettings?.(settings => ({ ...settings, ...project.viewerSettings }))
    for (const entry of loaded) {
      const meta = project.objectMeta.get(entry.objectid)
      if (!meta) continue
      const extruder = Number(meta.extruder)
      if (Number.isInteger(extruder) && extruder >= 1) apiRef.current?.setObjectExtruder(entry.id, extruder)
      if (meta.name) { const o = objectsRef.current.find(x => x.id === entry.id); if (o) { o.name = meta.name; o.mesh.userData.name = meta.name } }
    }
    // Plates last: placing an object needs the FINAL plate count, because the plate origins are laid out against it.
    const assignments = platePlacements(project.plates, loaded, bed?.bed_width, bed?.bed_depth)
    let beyondLastPlate = 0, finalPlateCount = plateCountRef?.current ?? 1
    if (assignments.length && applyProjectPlates) {
      //  The saved plate count counts too (our member): the <plate> records name only plates holding objects, so an
      //  empty plate the author configured would otherwise not come back.
      const needed = Math.max(Math.max(...assignments.map(([, index]) => index)) + 1, project.plateCount ?? 0)
      applyProjectPlates(needed, bed?.bed_width, bed?.bed_depth, (plateCount) => {
        finalPlateCount = plateCount
        for (const [id, index, offsetX, offsetY] of assignments) {
          // The bed tops out at MAX_PLATES, so a project with more of them keeps those objects where they landed
          //  rather than piling them onto the last plate — and says so, because a silently merged plate prints wrong.
          if (index < plateCount) { apiRef.current?.placeObjectOnPlate(id, index, offsetX, offsetY); dropPlateResult(index) }
          else beyondLastPlate++
        }
      })
      notices.push(`${project.plates.length} plates`)
    }
    //  Per-plate overrides once the plate count is final, and only for plates that exist: MAX_PLATES can cut the
    //  project short, and an override on an index past the last plate would attach itself to the next plate added.
    //  A project with settings replaces the overrides even when it carries none (see "Replace rather than merge").
    if (imported?.applied || project.plateSettings) {
      const kept = Object.fromEntries(Object.entries(project.plateSettings ?? {}).filter(([plate]) => Number(plate) < finalPlateCount))
      setPlateSettings?.(() => kept)
      if (Object.keys(kept).length) notices.push(`${Object.keys(kept).length} plate override(s)`)
    }
    const dropped = droppedFeatures(project, loaded)
    if (beyondLastPlate) dropped.push(`${beyondLastPlate} object(s) on plates past this viewer's limit`)
    if (notices.length || dropped.length) {
      setSliceNotice?.(`Imported this project's ${notices.join(' and ') || 'geometry'}.`
        + (dropped.length ? ` Not supported by this slicer, so left out: ${dropped.join(', ')}.` : ''))
    }
  }

  async function loadFiles(fileList) {
    const all = Array.from(fileList || [])
    // .sl1 is not a mesh: it routes to the raster-preview import, and deliberately AFTER the mesh block below —
    //  loading meshes clears plateResultsRef, which is exactly where the import lands its result.
    const sl1Files = importSl1 ? all.filter(f => fileExt(f.name) === 'sl1') : []
    const presetFiles = loadPresetFile ? all.filter(f => PRESET_EXTS.includes(fileExt(f.name))) : []
    const files = all.filter(f => SUPPORTED_EXT.includes(fileExt(f.name)))
    const rejected = all.length - files.length - sl1Files.length - presetFiles.length
    if (!files.length && !sl1Files.length && !presetFiles.length) {
      if (rejected) setError('Supported formats: STL/OBJ/3MF/AMF/PLY' + (importSl1 ? '/SL1' : '') + (loadPresetFile ? ' + preset files' : ''))
      return
    }
    if (!files.length) {
      for (const f of presetFiles) await loadPresetFile(f)
      if (sl1Files.length) setError('')
      for (const f of sl1Files) await importSl1(f)
      return
    }
    setError(''); setTriWarn(''); setProgress(0)
    // Only the plate the meshes land on loses its result: another plate's slice still describes objects this load
    //  does not touch (the per-plate staleness rule, slice_staleness.js). It used to reset every plate, so adding a
    //  model to plate 2 silently threw plate 1's slice away. A project that places objects on other plates
    //  invalidates those below, once it knows which (dropPlateResult, above).
    layersDataRef.current = null; segDataRef.current = null
    dropPlateResult(selectedPlateRef?.current ?? 0)
    clearToolpaths(); refreshSlicedCount()
    setStats(null); setOverBed(false); setLayerCount(0); setSegCount(0); setColorRange(null); setSliceNotice(''); setDowngradeOffer(null)
    // Presets before the meshes they came with — those are the settings the model is meant to load under — but
    //  AFTER the state reset above, or the reset's setSliceNotice('') wipes the "Loaded machine: …" notice
    //  (measured: the notice never appeared when a preset and an STL arrived in one pass).
    for (const f of presetFiles) await loadPresetFile(f)
    setGcodeUrl(prev => { if (prev) URL.revokeObjectURL(prev); return '' })
    setCanvasMode('prepare')   // S2: a new model goes back to Prepare
    apiRef.current?.showObjects()
    let totalTri = 0
    let anyPaint = false
    for (const f of files) {
      try {
        const __tl0 = performance.now()   // [vp-prof] load timing (temporary)
        const buf = await f.arrayBuffer()
        const __tl1 = performance.now()
        const objs = await loadModel(f.name, buf)          // [{name, modelPos}] (3MF/AMF may return several)
        const __tl2 = performance.now()
        const loaded = []
        for (const ob of objs) {
          const added = apiRef.current?.addObject(ob.name, ob.modelPos, ob.paint)
          totalTri += ob.modelPos.length / 9
          if (ob.paint) anyPaint = true
          if (added && ob.objectid) loaded.push({ objectid: ob.objectid, id: added.id, paint: ob.paint, bbox: ob.bbox })
        }
        // Each file carries its own project; applying per file means dropping two 3mfs in at once behaves the way
        //  loading them one after the other does, rather than silently keeping only the last one's presets.
        if (objs[0]?.project) applyProject(objs[0].project, loaded)
        log.info(`[vp-prof] load ${f.name}: read ${(__tl1-__tl0).toFixed(0)}ms, parse ${(__tl2-__tl1).toFixed(0)}ms, scene ${(performance.now()-__tl2).toFixed(0)}ms`)
      } catch (err) { setError(`Failed to load ${f.name}: ${(err && err.message) || err}`) }
    }
    setObjects(objectRows(objectsRef.current, apiRef.current))
    if (totalTri > 100000) setTriWarn(`${Math.round(totalTri).toLocaleString()} triangles — slicing may take a while`)
    for (const f of sl1Files) await importSl1(f)
    // Imported painting sits on the objects (the per-object store, core/paint_store.js); registering the selector
    //  here loads the selected plate's share of it into the kernel and draws it, without waiting for a brush.
    if (anyPaint) registerSelectorRef?.current?.()
  }
  function onFiles(e) { loadFiles(e.target.files); e.target.value = '' }
  function removeObject(id) { apiRef.current?.removeObject(id); setObjects(objectRows(objectsRef.current, apiRef.current)) }
  // Stage 26 R4: the whole viewport is a drop zone
  function onDrop(e) { e.preventDefault(); setDragOver(false); loadFiles(e.dataTransfer?.files) }
  function onDragOver(e) { e.preventDefault(); e.dataTransfer && (e.dataTransfer.dropEffect = 'copy'); if (!dragOver) setDragOver(true) }
  function onDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }

  return { loadFiles, onFiles, removeObject, onDrop, onDragOver, onDragLeave }
}
