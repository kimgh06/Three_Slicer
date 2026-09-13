// The plate's number, painted flat on the bed at its front-left corner — upstream PartPlate's convention.
// Without it two identical grids give no way to tell WHICH plate the tabs/panels are talking about; the
// selected plate's number takes the same green its border does, so the two cues always agree.
// Lives beside use_three_scene (not core/): CanvasTexture needs a DOM canvas and a renderer to mean anything.
import { THEME } from '../core/theme.js'

export function plateNumberLabel(THREE, index, selected, px, pz, bw, bd) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 96
  const g = canvas.getContext('2d')
  g.font = '700 64px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillStyle = selected ? THEME.accent : THEME.plateLabel
  g.fillText(String(index + 1), 48, 52)
  const tex = new THREE.CanvasTexture(canvas); tex.anisotropy = 4
  const label = new THREE.Mesh(new THREE.PlaneGeometry(14, 14),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }))
  label.rotation.x = -Math.PI / 2
  label.position.set(px - bw / 2 + 11, 0.05, pz + bd / 2 - 11)   // front-left corner, just above the grid
  return label
}
