import { ExtrudeGeometry } from 'three'
import { Font } from 'three/examples/jsm/loaders/FontLoader.js'
import { TTFLoader } from 'three/examples/jsm/loaders/TTFLoader.js'
import { glyphShapes } from '../core/glyph_shapes.js'

// Text as a solid: glyph outlines extruded along +z from z = 0, centred on the origin, as a triangle soup.
export async function builtInFont() {
  const { default: data } = await import('three/examples/fonts/helvetiker_regular.typeface.json')
  return new Font(data)
}

export const fontFromFile = (buffer) => new Font(new TTFLoader().parse(buffer))

// The runs sit side by side at their fonts' own advances, and the whole text is centred on the origin.
export function textSoup(runs, { size, depth }) {
  const parts = []
  let cursor = 0
  for (const { font, text } of runs) {
    const scale = size / font.data.resolution
    const shapes = []
    for (const character of text.replace(/\s/g, ' ')) {
      const glyph = font.data.glyphs[character] ?? font.data.glyphs['?']
      shapes.push(...glyphShapes(glyph, scale, cursor))
      cursor += glyph.ha * scale
    }
    const solid = new ExtrudeGeometry(shapes, { depth, bevelEnabled: false, curveSegments: 6 })
    const flat = solid.index ? solid.toNonIndexed() : solid
    parts.push(flat.getAttribute('position').array)
  }
  const soup = new Float32Array(parts.reduce((total, part) => total + part.length, 0))
  let filled = 0
  for (const part of parts) { soup.set(part, filled); filled += part.length }
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  for (let index = 0; index < soup.length; index += 3) {
    bounds.minX = Math.min(bounds.minX, soup[index]); bounds.maxX = Math.max(bounds.maxX, soup[index])
    bounds.minY = Math.min(bounds.minY, soup[index + 1]); bounds.maxY = Math.max(bounds.maxY, soup[index + 1])
  }
  for (let index = 0; index < soup.length; index += 3) {
    soup[index] -= (bounds.minX + bounds.maxX) / 2
    soup[index + 1] -= (bounds.minY + bounds.maxY) / 2
  }
  return soup
}
