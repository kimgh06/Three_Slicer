// A binary image's regions as closed rings along the pixel edges, simplified. The GPU draws a layer's support as a mask
//  (support_gpu.js); the kernel reads polygons, and this is the step between them. Pure: typed arrays in, arrays out.
//
// A ring walks the cracks between a solid pixel and an empty one with the solid on one side throughout, so an outer
//  boundary and a hole come out with opposite orientations. Two regions that touch only at a corner stay two rings
//  (4-connected solid): joining them would make a ring that touches itself.
// The image is mostly uniform (empty around the support, solid inside a trunk), so the pixels are read four at a time
//  and only a word that differs from the one above or below, or is mixed, is looked at pixel by pixel (measured on a
//  1173-layer plate, 315 MB of masks: 1.15 s reading every pixel, see AGENTS.md for the figure after).

// per side of a pixel (top, right, bottom, left): the direction the walk moves along it, and the way out of the solid
const FORWARD_X = [1, 0, -1, 0], FORWARD_Y = [0, 1, 0, -1], OUTWARD_X = [0, 1, 0, -1], OUTWARD_Y = [-1, 0, 1, 0]
// the corner a side starts at, relative to its pixel
const START_X = [0, 1, 1, 0], START_Y = [0, 0, 1, 1]
const SIDES = 4, WORD_PIXELS = 4, SOLID_BYTE = 255, SOLID_WORD = 0xFFFFFFFF

// The tracer works on a copy with at least one empty pixel all around (no neighbour test needs a bounds check), every
//  solid pixel 255, the image's first column at byte WORD_PIXELS of a row so that rows are whole words.
const paddedStride = (width) => WORD_PIXELS + Math.ceil((width + 1) / WORD_PIXELS) * WORD_PIXELS

/**
 * @param {Uint8Array} image    rows of `rowBytes` bytes, non-zero = solid
 * @param {number} rowBytes     bytes per row in `image` (at least `width`)
 * @param {number} width
 * @param {number} rows
 * @returns {{ rings: number[][], solidPixels: number }} each ring as [x, y, ...] corners in pixel units
 */
export function traceRings(image, rowBytes, width, rows) {
  const stride = paddedStride(width)
  const padded = new Uint8Array(stride * (rows + 2))
  for (let row = 0; row < rows; row++) {
    const to = (row + 1) * stride + WORD_PIXELS
    padded.set(image.subarray(row * rowBytes, row * rowBytes + width), to)
  }
  return tracePadded(padded, stride, rows)
}

// pixels one word of a packed mask holds, bit i the pixel i to the right of the word's first
export const PACKED_PIXELS = 32

// The same walk as tracePadded, on bits: the rectangle is copied into a bit image with one empty pixel around it, the
//  open sides of 32 pixels are found with a few word operations, and only boundary pixels are visited one by one.
//  Unpacking every rectangle to a byte per pixel first was most of the tracer's time (measured on the three largest
//  plates of a 28-plate project, node: 0.71 s of the pipeline's 3 s).
//  `openSides` is kept between calls: a walk clears every side it was given, so it is all zero again at the end.
let bitImage = new Int32Array(0), openSides = new Uint8Array(0)
const PAD = 1
const popcount = (word) => {
  word -= (word >>> 1) & 0x55555555
  word = (word & 0x33333333) + ((word >>> 2) & 0x33333333)
  return (Math.imul((word + (word >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24)
}
/**
 * The rings of one rectangle of a packed mask (support_gpu.js reads a batch's masks back as one bit per pixel).
 * @param {Uint32Array} packed   rows of `wordsPerRow` words, PACKED_PIXELS pixels each, a set bit = solid
 * @param {number} wordsPerRow
 * @param {number} left          the rectangle's first column and row in the mask
 * @param {number} top
 * @param {number} width
 * @param {number} rows
 * @returns {{ rings: number[][], solidPixels: number }} as traceRings, in the rectangle's own pixel units
 */
export function tracePackedRings(packed, wordsPerRow, left, top, width, rows) {
  const rowWords = Math.ceil((width + 2 * PAD) / PACKED_PIXELS), stride = rowWords * PACKED_PIXELS, wordCount = rowWords * (rows + 2 * PAD)
  if (bitImage.length < wordCount) bitImage = new Int32Array(wordCount)
  else bitImage.fill(0, 0, wordCount)
  if (openSides.length < stride * (rows + 2 * PAD)) openSides = new Uint8Array(stride * (rows + 2 * PAD))
  const bits = bitImage, open = openSides
  for (let row = 0; row < rows; row++) {
    const sourceRow = (top + row) * wordsPerRow, to = (row + PAD) * rowWords
    for (let word = 0; word < rowWords; word++) {
      // destination bit b of this word is the rectangle's column word * 32 + b - PAD
      const low = Math.max(0, PAD - word * PACKED_PIXELS), high = Math.min(PACKED_PIXELS, width + PAD - word * PACKED_PIXELS)
      if (high <= low) continue
      const sourceBit = left - PAD + word * PACKED_PIXELS
      const sourceWord = Math.floor(sourceBit / PACKED_PIXELS), shift = sourceBit - sourceWord * PACKED_PIXELS
      let value = 0
      if (sourceWord >= 0 && sourceWord < wordsPerRow) value = packed[sourceRow + sourceWord] >>> shift
      if (shift > 0 && sourceWord + 1 >= 0 && sourceWord + 1 < wordsPerRow) value |= packed[sourceRow + sourceWord + 1] << (PACKED_PIXELS - shift)
      let keep = -1
      if (high - low < PACKED_PIXELS) keep = ((1 << (high - low)) - 1) << low
      bits[to + word] = value & keep
    }
  }
  let boundary = new Int32Array(1024), boundaryCount = 0, solidPixels = 0
  for (let row = PAD; row < rows + PAD; row++) {
    for (let word = 0, index = row * rowWords; word < rowWords; word++, index++) {
      const here = bits[index]
      if (here === 0) continue
      solidPixels += popcount(here)
      let leftOf = here << 1, rightOf = here >>> 1
      if (word > 0) leftOf |= bits[index - 1] >>> 31
      if (word + 1 < rowWords) rightOf |= bits[index + 1] << 31
      const topOpen = here & ~bits[index - rowWords], rightOpen = here & ~rightOf, bottomOpen = here & ~bits[index + rowWords], leftOpen = here & ~leftOf
      let any = topOpen | rightOpen | bottomOpen | leftOpen
      while (any !== 0) {
        const bit = 31 - Math.clz32(any & -any)
        any &= any - 1
        const at = row * stride + word * PACKED_PIXELS + bit
        open[at] = ((topOpen >>> bit) & 1) | (((rightOpen >>> bit) & 1) << 1) | (((bottomOpen >>> bit) & 1) << 2) | (((leftOpen >>> bit) & 1) << 3)
        if (boundaryCount === boundary.length) { const grown = new Int32Array(boundary.length * 2); grown.set(boundary); boundary = grown }
        boundary[boundaryCount++] = at
      }
    }
  }
  const solidAt = (at) => (bits[at >>> 5] >>> (at & 31)) & 1
  const rings = []
  for (let index = 0; index < boundaryCount; index++) {
    const start = boundary[index]
    while (open[start] !== 0) {
      let side = 0
      while ((open[start] & (1 << side)) === 0) side++
      const ring = []
      let at = start, lastSide = -1
      while ((open[at] & (1 << side)) !== 0) {
        open[at] &= ~(1 << side)
        if (side !== lastSide) {
          const column = at % stride - PAD, row = (at - at % stride) / stride - PAD
          ring.push(column + START_X[side], row + START_Y[side])
          lastSide = side
        }
        const ahead = at + FORWARD_X[side] + FORWARD_Y[side] * stride
        const aheadOut = ahead + OUTWARD_X[side] + OUTWARD_Y[side] * stride
        if (solidAt(ahead) !== 0 && solidAt(aheadOut) !== 0) { at = aheadOut; side = (side + 3) % SIDES }
        else if (solidAt(ahead) !== 0) at = ahead
        else side = (side + 1) % SIDES
      }
      if (ring.length >= 8) rings.push(ring)
    }
  }
  return { rings, solidPixels }
}

function tracePadded(padded, stride, rows) {
  const wordsPerRow = stride / WORD_PIXELS, words = new Uint32Array(padded.buffer)
  // which sides of each solid pixel face an empty one; `boundary` lists the pixels that have any
  const open = new Uint8Array(padded.length), offsetOf = [-stride, 1, stride, -1]
  let boundary = new Int32Array(1024), boundaryCount = 0, solidPixels = 0
  for (let row = 1; row <= rows; row++) {
    for (let wordIndex = row * wordsPerRow + 1, end = (row + 1) * wordsPerRow; wordIndex < end; wordIndex++) {
      const word = words[wordIndex]
      if (word === 0) continue
      const first = wordIndex * WORD_PIXELS
      if (word === SOLID_WORD && words[wordIndex - wordsPerRow] === SOLID_WORD && words[wordIndex + wordsPerRow] === SOLID_WORD && padded[first - 1] !== 0 && padded[first + WORD_PIXELS] !== 0) {
        solidPixels += WORD_PIXELS
        continue
      }
      for (let at = first; at < first + WORD_PIXELS; at++) {
        if (padded[at] === 0) continue
        padded[at] = SOLID_BYTE
        solidPixels++
        let sides = 0
        for (let side = 0; side < SIDES; side++) if (padded[at + offsetOf[side]] === 0) sides |= 1 << side
        if (sides === 0) continue
        open[at] = sides
        if (boundaryCount === boundary.length) { const grown = new Int32Array(boundary.length * 2); grown.set(boundary); boundary = grown }
        boundary[boundaryCount++] = at
      }
    }
  }
  const rings = []
  for (let index = 0; index < boundaryCount; index++) {
    const start = boundary[index]
    while (open[start] !== 0) {
      let side = 0
      while ((open[start] & (1 << side)) === 0) side++
      const ring = []
      let at = start, lastSide = -1
      while ((open[at] & (1 << side)) !== 0) {
        open[at] &= ~(1 << side)
        if (side !== lastSide) {
          const column = at % stride - WORD_PIXELS, row = (at - at % stride) / stride - 1
          ring.push(column + START_X[side], row + START_Y[side])
          lastSide = side
        }
        const ahead = at + FORWARD_X[side] + FORWARD_Y[side] * stride
        const aheadOut = ahead + OUTWARD_X[side] + OUTWARD_Y[side] * stride
        if (padded[ahead] !== 0 && padded[aheadOut] !== 0) { at = aheadOut; side = (side + 3) % SIDES }
        else if (padded[ahead] !== 0) at = ahead
        else side = (side + 1) % SIDES
      }
      if (ring.length >= 8) rings.push(ring)
    }
  }
  return { rings, solidPixels }
}

/**
 * Ramer-Douglas-Peucker on a closed ring of [x, y, ...] corners.
 * @param {number[]} ring
 * @param {number} tolerance  the furthest a dropped corner may lie from the kept outline, in the ring's units
 */
export function simplifyRing(ring, tolerance) {
  const count = ring.length / 2
  if (count < 4) return ring
  // split the ring at its first corner and the corner furthest from it; each half is an open polyline
  let far = 0, farDistance = -1
  for (let index = 1; index < count; index++) {
    const distance = (ring[index * 2] - ring[0]) ** 2 + (ring[index * 2 + 1] - ring[1]) ** 2
    if (distance > farDistance) { farDistance = distance; far = index }
  }
  const keep = new Uint8Array(count + 1)
  keep[0] = 1; keep[far] = 1; keep[count] = 1
  const xOf = (index) => ring[(index % count) * 2], yOf = (index) => ring[(index % count) * 2 + 1]
  const stack = [0, far, far, count]
  while (stack.length) {
    const end = stack.pop(), begin = stack.pop()
    const ax = xOf(begin), ay = yOf(begin), ex = xOf(end) - ax, ey = yOf(end) - ay, lengthOf = Math.hypot(ex, ey) || 1
    let worst = tolerance, worstAt = -1
    for (let index = begin + 1; index < end; index++) {
      const distance = Math.abs((xOf(index) - ax) * ey - (yOf(index) - ay) * ex) / lengthOf
      if (distance > worst) { worst = distance; worstAt = index }
    }
    if (worstAt >= 0) { keep[worstAt] = 1; stack.push(begin, worstAt, worstAt, end) }
  }
  const out = []
  for (let index = 0; index < count; index++) if (keep[index]) out.push(ring[index * 2], ring[index * 2 + 1])
  return out
}
