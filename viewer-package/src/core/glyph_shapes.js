import { Shape, ShapePath, ShapeUtils } from 'three'

// A glyph's outline as solids with holes. three.js' Font goes through ShapePath.toShapes, which takes contour order and
//  winding from TrueType: a CFF font (.otf) may list a hole before its solid and winds the other way, and measured on
//  Noto Sans KR that turned ㅁ into its own counter (area 25.6 -> -8.5). Here a contour is a hole when it winds against the
//  glyph's largest contour, and it belongs to the smallest solid around it, so neither order nor direction matters.
const CURVE_SEGMENTS = 6

function outlinePaths(outline, scale, offsetX) {
  const shapePath = new ShapePath()
  const tokens = (outline ?? '').split(' ')
  const x = (index) => tokens[index] * scale + offsetX
  const y = (index) => tokens[index] * scale
  for (let index = 0; index < tokens.length;) {
    const command = tokens[index]
    if (command === 'm') { shapePath.moveTo(x(index + 1), y(index + 2)); index += 3 }
    else if (command === 'l') { shapePath.lineTo(x(index + 1), y(index + 2)); index += 3 }
    else if (command === 'q') {
      shapePath.quadraticCurveTo(x(index + 3), y(index + 4), x(index + 1), y(index + 2))
      index += 5
    } else if (command === 'b') {
      shapePath.bezierCurveTo(x(index + 3), y(index + 4), x(index + 5), y(index + 6), x(index + 1), y(index + 2))
      index += 7
    } else index += 1
  }
  return shapePath.subPaths
}

function contains(points, { x, y }) {
  let inside = false
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const from = points[previous], to = points[index]
    if ((to.y > y) !== (from.y > y) && x < (from.x - to.x) * (y - to.y) / (from.y - to.y) + to.x) inside = !inside
  }
  return inside
}

export function glyphShapes(glyph, scale, offsetX) {
  const contours = outlinePaths(glyph.o, scale, offsetX).map((path) => {
    const points = path.getPoints(CURVE_SEGMENTS)
    return { path, points, area: ShapeUtils.area(points) }
  })
  if (!contours.length) return []
  const largest = contours.reduce((best, contour) => (Math.abs(contour.area) > Math.abs(best.area) ? contour : best))
  const solids = contours.filter(contour => Math.sign(contour.area) === Math.sign(largest.area))
    .sort((first, second) => Math.abs(first.area) - Math.abs(second.area))
    .map((contour) => {
      const shape = new Shape()
      shape.curves = contour.path.curves
      return { ...contour, shape }
    })
  for (const contour of contours) {
    if (Math.sign(contour.area) === Math.sign(largest.area)) continue
    solids.find(solid => contains(solid.points, contour.points[0]))?.shape.holes.push(contour.path)
  }
  return solids.map(solid => solid.shape)
}
