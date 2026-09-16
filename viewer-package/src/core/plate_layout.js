// Plate spacing — fixed mm. (Upstream uses 1/5 of the width, but we keep a constant gap regardless of bed size.)
export const PLATE_GAP = 40
export const plateStep = (edge) => edge + PLATE_GAP
// Square plate layout — upstream PartPlate.hpp compute_colum_count: cols ≈ ceil(sqrt(n)).
//  Plate i = (col=i%cols)*stepX, (row=i/cols)*stepZ (upstream grows along -Y -> +z in three).
export const MAX_PLATES = 9
export const plateCols = (count) => { const v = Math.sqrt(count), r = Math.round(v); return v > r ? r + 1 : r }
// Where plate `index` sits in three world coordinates, as an {x, z} offset from plate 0. The scene, the toolpath
//  display offset and the G-code injection all have to agree on this, so it lives here rather than in the closure
//  that happens to need it first — three call sites used to spell the same two multiplications out by hand.
export function platePosition(index, plateCount, bedWidth, bedDepth) {
  const cols = plateCols(plateCount)
  return { x: (index % cols) * plateStep(bedWidth), z: Math.floor(index / cols) * plateStep(bedDepth) }
}
// The inverse: which plate a world (x, z) belongs to = nearest plate centre, clamped into the grid. Used to decide
//  an object's membership from its position alone, which is what makes dragging a model between plates work.
export function plateIndexAtXZ(worldX, worldZ, plateCount, bedWidth, bedDepth) {
  const cols = plateCols(plateCount)
  const col = Math.max(0, Math.min(cols - 1, Math.round(worldX / plateStep(bedWidth))))
  const row = Math.max(0, Math.round(worldZ / plateStep(bedDepth)))
  return Math.max(0, Math.min(plateCount - 1, row * cols + col))
}
// Heterogeneous beds (per-plate printer stage): the same 3-column grid, but each COLUMN is as wide as its
// widest plate and each ROW as deep as its deepest, with centre-to-centre steps built from adjacent halves +
// the same PLATE_GAP. With every plate equal this reduces EXACTLY to platePosition/plateIndexAtXZ above —
// test_plate_layout.mjs pins that equivalence, which is what lets the uniform paths keep their closed form.
// `dims` is [{w, d}] per plate; membership walks the ≤9 centres instead of a closed form.
export function plateLayoutHetero(dims, gap = PLATE_GAP) {
  const count = dims.length, cols = plateCols(count)
  const colW = [], rowD = []
  for (let i = 0; i < count; i++) {
    const c = i % cols, r = Math.floor(i / cols)
    colW[c] = Math.max(colW[c] ?? 0, dims[i].w); rowD[r] = Math.max(rowD[r] ?? 0, dims[i].d)
  }
  const xs = [0], zs = [0]
  for (let c = 1; c < colW.length; c++) xs[c] = xs[c - 1] + colW[c - 1] / 2 + gap + colW[c] / 2
  for (let r = 1; r < rowD.length; r++) zs[r] = zs[r - 1] + rowD[r - 1] / 2 + gap + rowD[r] / 2
  // Nearest centre per axis; a tie goes to the LATER cell, matching Math.round in plateIndexAtXZ.
  const nearest = (v, centres) => {
    let best = 0
    for (let k = 1; k < centres.length; k++) if (Math.abs(v - centres[k]) <= Math.abs(v - centres[best])) best = k
    return best
  }
  return {
    position: (i) => ({ x: xs[i % cols], z: zs[Math.floor(i / cols)] }),
    indexAt: (wx, wz) => Math.max(0, Math.min(count - 1, nearest(wz, zs) * cols + nearest(wx, xs))),
    dims: (i) => dims[i],
  }
}

// Upstream's OWN grid (PartPlate.cpp compute_shape_position / plate_stride_x): origin at the plate's CORNER,
//  gap = bed/5, rows growing along -y. The 3mf importer decodes positions under this rule and the 3mf writer
//  re-encodes them under it — one constant, or the two silently disagree at every bed size but 200mm.
export const UPSTREAM_PLATE_GAP_RATIO = 1 / 5

// Where a newly loaded object goes on the plate the user is looking at. The first object of a row lands on the
//  plate CENTRE (`platePosition` returns the centre, and a baked mesh's position IS its XZ centre — the old
//  `plateX + cursor + w/2` put the model's LEFT FACE on the centre instead), further ones queue to its right
//  with a fixed gap. `cursor` is the row's running extent to the right of the centre; 0 means an empty row, and
//  the returned one is what the next call takes.
export const PLACE_GAP = 8
export function nextPlacement(cursor, plateX, width, gap = PLACE_GAP) {
  const first = cursor === 0
  return { x: first ? plateX : plateX + cursor + width / 2, cursor: (first ? width / 2 : cursor + width) + gap }
}
