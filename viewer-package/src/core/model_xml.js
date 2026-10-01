// A 3mf .model part, read straight from its inflated bytes. The regex reader this replaces decoded the whole part to a
//  string first and then ran a capture per vertex and triangle: on haaland.3mf (316MB of XML, 3.79M triangles) that
//  was 840-1000ms of a 1.34s parse, where one pass over the bytes is enough.
// It reads the shape parse_3mf.js always read — every vertex/triangle/component tag is self-closing and
//  attribute-only, objects do not nest, items live in the first <build> — and returns the same structure:
//  { objects: Map(id -> { components } | { mesh: { verts, tris, paint } | null }), items: [{ objectid, path, transform }] }.
// Numbers are the values `+text` gives, so the triangles that come out are byte-identical to the regex reader's.

const POW10 = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17,
  1e18, 1e19, 1e20, 1e21, 1e22]
const utf8 = new TextDecoder()
const text = (bytes, start, end) => utf8.decode(bytes.subarray(start, end))

/**
 * `+text` for an attribute value, without making the string. A plain decimal whose digits fit in 2^53 with at most 22
 *  fraction digits is an exact integer divided by an exact power of ten: IEEE division rounds that correctly, which is
 *  what Number() does, so both give the same double. Anything else (exponents, hex, spaces, long digit strings) goes
 *  through Number() itself.
 */
export function numberAt(bytes, start, end) {
  let index = start, negative = false
  if (index < end && (bytes[index] === 45 || bytes[index] === 43)) { negative = bytes[index] === 45; index++ }
  let mantissa = 0, fraction = -1, digits = 0
  for (; index < end; index++) {
    const code = bytes[index]
    if (code >= 48 && code <= 57) {
      mantissa = mantissa * 10 + (code - 48); digits++
      if (fraction >= 0) fraction++
    } else if (code === 46 && fraction < 0) fraction = 0
    else return Number(text(bytes, start, end))
  }
  if (!digits || mantissa > 9007199254740991 || fraction > 22) return Number(text(bytes, start, end))
  let value = mantissa
  if (fraction > 0) value = mantissa / POW10[fraction]
  if (negative) return -value
  return value
}

// The fast paths below read the exact tag shape slicers write — `<vertex x="…" y="…" z="…"/>` and
//  `<triangle v1="…" v2="…" v3="…" …/>` — without the per-attribute callbacks of readAttributes. A tag in any other
//  shape (other spacing, other attribute order) is read again by the general path, so the shape only decides speed.
let cursor = 0   // set by quotedNumber: the index just past the closing quote
function quotedNumber(bytes, start) {
  let index = start, negative = false, code = bytes[index]
  if (code === 45 || code === 43) { negative = code === 45; code = bytes[++index] }
  let mantissa = 0, fraction = -1, digits = 0
  for (;; code = bytes[++index]) {
    if (code >= 48 && code <= 57) {
      mantissa = mantissa * 10 + (code - 48); digits++
      if (fraction >= 0) fraction++
    } else if (code === 46 && fraction < 0) fraction = 0
    else break
  }
  if (code !== 34) {
    const end = bytes.indexOf(34, index)
    cursor = end + 1
    return Number(text(bytes, start, end))
  }
  cursor = index + 1
  if (!digits || mantissa > 9007199254740991 || fraction > 22) return Number(text(bytes, start, index))
  let value = mantissa
  if (fraction > 0) value = mantissa / POW10[fraction]
  if (negative) return -value
  return value
}
// ` <letter>="` at `at` (one space, as slicers write it) — then the value starts at at + 4.
const attrStart = (bytes, at, letter) => bytes[at] === 32 && bytes[at + 1] === letter && bytes[at + 2] === 61 && bytes[at + 3] === 34
// ` v<digit>="` at `at` — then the value starts at at + 5.
const indexStart = (bytes, at, digit) => bytes[at] === 32 && bytes[at + 1] === 118 && bytes[at + 2] === digit && bytes[at + 3] === 61 && bytes[at + 4] === 34

const isSpace = (code) => code === 32 || code === 10 || code === 13 || code === 9
const nameIs = (bytes, start, end, name) => {
  if (end - start !== name.length) return false
  for (let k = 0; k < name.length; k++) if (bytes[start + k] !== name.charCodeAt(k)) return false
  return true
}

// Walks the attributes of the tag whose name ends at `index`, calling visit(nameStart, nameEnd, valueStart, valueEnd)
//  for every double-quoted one (the regex reader matched only those). Returns the index just past the tag's '>'.
function readAttributes(bytes, index, visit) {
  const length = bytes.length
  while (index < length) {
    let code = bytes[index]
    while (isSpace(code)) code = bytes[++index]
    if (code === 62) return index + 1                                   // '>'
    if (code === 47) { index++; continue }                              // the '/' of '/>'
    const nameStart = index
    while (index < length && bytes[index] !== 61 && bytes[index] !== 62 && !isSpace(bytes[index])) index++
    const nameEnd = index
    while (isSpace(bytes[index])) index++
    if (bytes[index] !== 61) continue                                   // an attribute without a value
    index++
    while (isSpace(bytes[index])) index++
    const quote = bytes[index]
    if (quote !== 34 && quote !== 39) continue
    const valueStart = index + 1
    const valueEnd = bytes.indexOf(quote, valueStart)
    if (valueEnd < 0) return length
    if (quote === 34) visit(nameStart, nameEnd, valueStart, valueEnd)
    index = valueEnd + 1
  }
  return length
}

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
export function parseTransform(value) {
  if (!value) return IDENT
  const t = value.trim().split(/\s+/).map(Number)
  if (t.length === 12 && t.every(Number.isFinite)) return t
  return IDENT
}

// Painting is stored ON the <triangle> tag, not in Metadata/model_settings.config as the rest of the per-object
//  state is (slicer/src/libslic3r/Format/bbs_3mf.cpp:329-332). Each value is upstream's split-tree bitstream
//  rendered as hex by FacetsAnnotation::get_triangle_as_string — opaque here, decoded by the kernel's selector.
// paint_seam / paint_fuzzy_skin are read too so a project that carries them can be REPORTED as dropped rather
//  than silently losing them; the kernel has no seam or fuzzy-skin painting to apply them to.
export const PAINT_ATTRS = [
  ['paint_color', 'color'],        // multi-material: state 1..16 == Extruder1..16
  ['paint_supports', 'supports'],  // support enforcer/blocker: states 1 and 2
  ['paint_seam', 'seam'],          // unsupported by the kernel — collected for the warning only
  ['paint_fuzzy_skin', 'fuzzy'],   // ditto
]
const PAINT_SLOT = Object.fromEntries(PAINT_ATTRS)
export function emptyPaint() { return { color: new Map(), supports: new Map(), seam: new Map(), fuzzy: new Map() } }
export function paintIsEmpty(paint) { return !paint || PAINT_ATTRS.every(([, slot]) => paint[slot].size === 0) }

// A growable Float64Array: the vertex and index values stay doubles, as the regex reader's arrays held them, so the
//  build transform is applied at the same precision.
class Values {
  constructor() { this.data = new Float64Array(1024); this.length = 0 }
  push3(a, b, c) {
    if (this.length + 3 > this.data.length) { const grown = new Float64Array(this.data.length * 2); grown.set(this.data); this.data = grown }
    this.data[this.length] = a; this.data[this.length + 1] = b; this.data[this.length + 2] = c; this.length += 3
  }
  view() { return this.data.subarray(0, this.length) }
}

/** One .model part's bytes -> { objects, items } (see the file header). */
export function scanModelXml(bytes) {
  const objects = new Map(), items = []
  let object = null              // the <object> being read: { id, components, verts, tris, paint }
  let buildState = 0             // 0 before the first <build>, 1 inside it, 2 after it
  let x = 0, y = 0, z = 0, v1 = 0, v2 = 0, v3 = 0, attrObjectId = null, attrPath = null, attrLocalPath = null, attrTransform = null
  let paintValues = null

  const finishObject = () => {
    if (object.id) {
      if (object.components.length) objects.set(object.id, { components: object.components })
      else {
        let mesh = null
        if (object.verts.length >= 9 && object.tris.length) mesh = { verts: object.verts.view(), tris: object.tris.view(), paint: object.paint }
        objects.set(object.id, { mesh })
      }
    }
    object = null
  }
  const reference = () => ({ objectid: attrObjectId, path: attrPath || attrLocalPath, transform: parseTransform(attrTransform) })
  const readReference = (nameStart, nameEnd, valueStart, valueEnd) => {
    if (nameIs(bytes, nameStart, nameEnd, 'objectid')) attrObjectId = text(bytes, valueStart, valueEnd)
    else if (nameIs(bytes, nameStart, nameEnd, 'p:path')) attrPath = text(bytes, valueStart, valueEnd)
    else if (nameIs(bytes, nameStart, nameEnd, 'path')) attrLocalPath = text(bytes, valueStart, valueEnd)
    else if (nameIs(bytes, nameStart, nameEnd, 'transform')) attrTransform = text(bytes, valueStart, valueEnd)
  }
  const readVertex = (nameStart, nameEnd, valueStart, valueEnd) => {
    if (nameEnd - nameStart !== 1) return
    const axis = bytes[nameStart]
    if (axis === 120) x = numberAt(bytes, valueStart, valueEnd)
    else if (axis === 121) y = numberAt(bytes, valueStart, valueEnd)
    else if (axis === 122) z = numberAt(bytes, valueStart, valueEnd)
  }
  const readTriangle = (nameStart, nameEnd, valueStart, valueEnd) => {
    if (nameEnd - nameStart === 2 && bytes[nameStart] === 118) {     // v1 / v2 / v3
      const which = bytes[nameStart + 1]
      if (which === 49) v1 = numberAt(bytes, valueStart, valueEnd)
      else if (which === 50) v2 = numberAt(bytes, valueStart, valueEnd)
      else if (which === 51) v3 = numberAt(bytes, valueStart, valueEnd)
    } else if (bytes[nameStart] === 112 && nameEnd - nameStart > 6) {  // paint_*
      const slot = PAINT_SLOT[text(bytes, nameStart, nameEnd)]
      if (slot && valueEnd > valueStart) (paintValues ??= []).push(slot, text(bytes, valueStart, valueEnd))
    }
  }
  let objectId = null
  const readObject = (nameStart, nameEnd, valueStart, valueEnd) => {
    if (nameIs(bytes, nameStart, nameEnd, 'id')) objectId = text(bytes, valueStart, valueEnd)
  }

  const length = bytes.length
  let index = 0
  for (;;) {
    index = bytes.indexOf(60, index)                                    // '<'
    if (index < 0) break
    let nameStart = index + 1
    const closing = bytes[nameStart] === 47
    if (closing) nameStart++
    const first = bytes[nameStart]
    if (first === 33 || first === 63) {                                 // <!-- … -->, <?…?>, <![CDATA[…]]>
      if (bytes[nameStart + 1] === 45 && bytes[nameStart + 2] === 45) {
        let end = nameStart + 3
        while ((end = bytes.indexOf(45, end)) >= 0 && !(bytes[end + 1] === 45 && bytes[end + 2] === 62)) end++
        index = length
        if (end >= 0) index = end + 3
      } else index = bytes.indexOf(62, nameStart) + 1 || length
      continue
    }
    let nameEnd = nameStart
    while (nameEnd < length && !isSpace(bytes[nameEnd]) && bytes[nameEnd] !== 62 && bytes[nameEnd] !== 47) nameEnd++
    if (closing) {
      if (object && nameIs(bytes, nameStart, nameEnd, 'object')) finishObject()
      else if (buildState === 1 && nameIs(bytes, nameStart, nameEnd, 'build')) buildState = 2
      index = bytes.indexOf(62, nameEnd) + 1 || length
      continue
    }
    if (object) {
      if (nameIs(bytes, nameStart, nameEnd, 'vertex')) {
        if (attrStart(bytes, nameEnd, 120)) {
          x = quotedNumber(bytes, nameEnd + 4)
          if (attrStart(bytes, cursor, 121)) {
            y = quotedNumber(bytes, cursor + 4)
            if (attrStart(bytes, cursor, 122)) {
              z = quotedNumber(bytes, cursor + 4)
              if (bytes[cursor] === 47 && bytes[cursor + 1] === 62) {
                index = cursor + 2
                if (object.id) object.verts.push3(x, y, z)
                continue
              }
            }
          }
        }
        x = 0; y = 0; z = 0                                             // a missing coordinate read as +null, i.e. 0
        index = readAttributes(bytes, nameEnd, readVertex)
        if (object.id) object.verts.push3(x, y, z)
        continue
      }
      if (nameIs(bytes, nameStart, nameEnd, 'triangle')) {
        v1 = 0; v2 = 0; v3 = 0; paintValues = null
        let rest = nameEnd
        if (indexStart(bytes, nameEnd, 49)) {
          const first = quotedNumber(bytes, nameEnd + 5)
          if (indexStart(bytes, cursor, 50)) {
            const second = quotedNumber(bytes, cursor + 5)
            if (indexStart(bytes, cursor, 51)) {
              const third = quotedNumber(bytes, cursor + 5)
              v1 = first; v2 = second; v3 = third; rest = cursor
            }
          }
        }
        if (rest !== nameEnd && bytes[rest] === 47 && bytes[rest + 1] === 62) index = rest + 2
        else index = readAttributes(bytes, rest, readTriangle)
        if (!object.id) continue
        const triIndex = object.tris.length / 3
        object.tris.push3(v1, v2, v3)
        if (paintValues) for (let k = 0; k < paintValues.length; k += 2) object.paint[paintValues[k]].set(triIndex, paintValues[k + 1])
        continue
      }
      if (nameIs(bytes, nameStart, nameEnd, 'component')) {
        attrObjectId = null; attrPath = null; attrLocalPath = null; attrTransform = null
        index = readAttributes(bytes, nameEnd, readReference)
        if (attrObjectId) object.components.push(reference())
        continue
      }
    } else if (nameIs(bytes, nameStart, nameEnd, 'object')) {
      objectId = null
      index = readAttributes(bytes, nameEnd, readObject)
      object = { id: objectId, components: [], verts: new Values(), tris: new Values(), paint: emptyPaint() }
      if (bytes[index - 2] === 47) finishObject()                       // <object … /> carries nothing
      continue
    } else if (buildState === 0 && nameIs(bytes, nameStart, nameEnd, 'build')) {
      index = readAttributes(bytes, nameEnd, () => {})
      buildState = 1
      if (bytes[index - 2] === 47) buildState = 2
      continue
    } else if (buildState === 1 && nameIs(bytes, nameStart, nameEnd, 'item')) {
      attrObjectId = null; attrPath = null; attrLocalPath = null; attrTransform = null
      index = readAttributes(bytes, nameEnd, readReference)
      if (attrObjectId) items.push(reference())
      continue
    }
    index = bytes.indexOf(62, nameEnd) + 1 || length
  }
  return { objects, items }
}
