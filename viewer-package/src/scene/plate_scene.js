import { bedGridLines } from '../core/bed_grid.js'
import { platePosition, plateIndexAtXZ } from '../core/plate_layout.js'
import { plateNumberLabel } from './plate_labels.js'
import { THEME } from '../core/theme.js'

// When the plate layout changes (a bed override, a bed edit, a plate added), objects keep their PLATE, not
// their world spot: membership is nearest-centre, and the centres just moved — without this, widening plate 1
// swallowed plate 2's objects (measured: its cube re-membered onto plate 1 and plate 2 sliced empty). Each
// object is translated by its OLD plate's origin delta; cached toolpath groups and the per-plate display
// offsets ride along, because both were placed from the origins that no longer exist.
// Returns whether anything moved — the caller re-registers the paint selector then, same as a drag commit.
export function followPlateLayout(THREE, { objects, count, prev, platePos, plateOffsets, plateTp }) {
  const oldPosOf = (i) => prev.het ? prev.het.layout.position(i) : platePosition(i, prev.n, prev.bw, prev.bd)
  const oldPlateAt = (x, z) => prev.het ? prev.het.layout.indexAt(x, z) : plateIndexAtXZ(x, z, prev.n, prev.bw, prev.bd)
  let moved = false
  for (const o of objects) {
    o.mesh.updateMatrixWorld(true)
    const wp = new THREE.Vector3().setFromMatrixPosition(o.mesh.matrixWorld)
    const p = Math.min(oldPlateAt(wp.x, wp.z), count - 1)
    const from = oldPosOf(Math.min(p, prev.n - 1)), to = platePos(p)
    const dx = to.x - from.x, dz = to.z - from.z
    if (dx || dz) { o.mesh.position.x += dx; o.mesh.position.z += dz; o.mesh.updateMatrixWorld(true); moved = true }
  }
  for (const key of Object.keys(plateOffsets ?? {})) {
    const i = Number(key); if (i >= count) continue
    const to = platePos(i)
    plateOffsets[i] = { offX: to.x, offZ: to.z }
    plateTp?.[i]?.group?.position.set(to.x, 0, to.z)
  }
  return moved
}

// Reframe the camera when the layout's overall footprint actually changes (a bed grew, a plate appeared) —
// without this, widening a plate left the user staring at the inside of the new grid with everything else
// off-screen. Keyed on the rounded union bbox: a selection switch or an object move changes nothing and so
// never touches the camera; the first layout keeps the mount framing. The current view DIRECTION is kept —
// only the target and distance move, so a deliberately chosen angle survives the refit.
export function refitCameraToPlates(THREE, t, { n, bw, bd, platePos, dims }) {
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9
  for (let i = 0; i < n; i++) {
    const { x, z } = platePos(i)
    const w = dims?.[i]?.w ?? bw, d = dims?.[i]?.d ?? bd
    minX = Math.min(minX, x - w / 2); maxX = Math.max(maxX, x + w / 2)
    minZ = Math.min(minZ, z - d / 2); maxZ = Math.max(maxZ, z + d / 2)
  }
  const key = `${Math.round(minX)},${Math.round(maxX)},${Math.round(minZ)},${Math.round(maxZ)}`
  const prev = t.plateBoundsKey; t.plateBoundsKey = key
  if (!prev || prev === key || !t.camera || !t.orbit) return
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
  const span = Math.max(maxX - minX, maxZ - minZ)
  const dist = Math.max(span * 1.15, 250)   // ~exact fit for the 50° fov plus margin; never closer than the mount framing
  const dir = t.camera.position.clone().sub(t.orbit.target)
  if (dir.lengthSq() < 1) dir.set(0, 1, 1)
  dir.normalize()
  t.orbit.target.set(cx, 0, cz)
  t.camera.position.set(cx, 0, cz).addScaledVector(dir, dist)
  t.orbit.update(); t.invalidate?.()
}

// Stage 29-2's plate rendering, extracted whole from use_three_scene setPlates: each plate = grid + border +
// number label, offset by its platePosition, the selected border highlighted. `dims` (heterogeneous beds)
// sizes each plate's OWN cell — an FFF bed override and an SLA plate's resin display alike, so every plate
// stands at its real printable size. (The mixed-tech stage briefly drew SLA areas as inset overlays on a
// shared cell; the per-plate cell replaced that once the cumulative grid existed to carry it.)
export function rebuildPlates(THREE, t, { n, bw, bd, sel, platePos, dims }) {
  for (const p of (t.plateBeds || [])) for (const m of [p.gridThin, p.gridBold, p.border, p.label, p.slaFill, p.slaEdge]) {
    if (!m) continue
    t.scene.remove(m); m.geometry.dispose(); m.material.map?.dispose(); m.material.dispose()
  }
  t.plateBeds = []
  const lineGeo = (a) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3)); return g }
  const gridCache = new Map()   // heterogeneous beds: one bedGridLines per distinct size, not per plate
  const gridFor = (w, d) => {
    const key = `${w}x${d}`
    if (!gridCache.has(key)) gridCache.set(key, bedGridLines(w, d))   // upstream Bed_2D's spacing rules — bed_grid.js
    return gridCache.get(key)
  }
  for (let i = 0; i < n; i++) {
    const { x: px, z: pz } = platePos(i)
    const pw = dims?.[i]?.w ?? bw, pd = dims?.[i]?.d ?? bd
    const { thin, bold } = gridFor(pw, pd)
    const gt = new THREE.LineSegments(lineGeo(thin), new THREE.LineBasicMaterial({ color: THEME.gridMinor }))
    const gb = new THREE.LineSegments(lineGeo(bold), new THREE.LineBasicMaterial({ color: THEME.gridMajor }))
    gt.position.set(px, 0, pz); gb.position.set(px, 0, pz); t.scene.add(gt); t.scene.add(gb)
    const sel_ = i === sel
    const border = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(pw, pd)),
      new THREE.LineBasicMaterial({ color: sel_ ? THEME.accent : THEME.plateBorder, linewidth: sel_ ? 2 : 1 }))
    border.rotation.x = -Math.PI / 2; border.position.set(px, 0, pz); t.scene.add(border)
    const label = plateNumberLabel(THREE, i, sel_, px, pz, pw, pd); t.scene.add(label)
    t.plateBeds.push({ gridThin: gt, gridBold: gb, border, label })
  }
}
