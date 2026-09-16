// The bed grid's line positions — upstream Bed_2D's rules, as plain numbers.
//  A rectangular grid that fits the bed rectangle exactly, cell spacing chosen from the SHORTER side, laid out
//  from the corner origin with a bold line every 5 cells (so the main grid is 50mm on a normal printer).
//  Kept apart from the scene because it is arithmetic, not rendering: setPlates rebuilds this on every bed
//  resize and plate add, and a wrong cell size is invisible in a screenshot but obvious in an assertion.

/** Upstream's spacing ladder, keyed on the shorter bed edge. */
export function gridCellSize(bedWidth, bedDepth) {
  const minEdge = Math.min(bedWidth, bedDepth)
  return minEdge >= 6000 ? 100 : minEdge >= 1200 ? 50 : minEdge >= 600 ? 20 : 10
}

/** Line-segment vertex arrays for one plate, centred on its own origin: {thin, bold}, each a flat
 *  [x,y,z, x,y,z, …] pair list ready for a BufferGeometry position attribute. */
export function bedGridLines(bedWidth, bedDepth) {
  const cell = gridCellSize(bedWidth, bedDepth)
  const thin = [], bold = []
  const x0 = -bedWidth / 2, z0 = -bedDepth / 2
  for (let i = 0, x = x0; x <= bedWidth / 2 + 1e-6; x = x0 + ++i * cell) (i % 5 ? thin : bold).push(x, 0, z0, x, 0, bedDepth / 2)
  for (let j = 0, z = z0; z <= bedDepth / 2 + 1e-6; z = z0 + ++j * cell) (j % 5 ? thin : bold).push(x0, 0, z, bedWidth / 2, 0, z)
  return { thin, bold }
}
