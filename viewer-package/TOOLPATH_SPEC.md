# Toolpath renderer — functional specification

What the toolpath renderer must do, stated as a contract. Written so the four files listed in
[../PROVENANCE.md](../PROVENANCE.md) §2 can be reimplemented **without reference to the existing code or to
any upstream slicer** — see [../RELICENSE.md](../RELICENSE.md) for why that matters.

Everything here was derived from the published types (`types/viewer-toolpath.d.ts`), the consumers, and a
recorded run of the present implementation (`test_toolpath_contract.mjs`). No upstream source was consulted
in writing it, and none is needed to satisfy it.

## 1. The job

A slice result is a list of layers. Each layer holds a flat array of straight extrusion segments in
millimetres. The renderer turns that into something a GPU can draw as solid beads of plastic — one instanced
draw call for the whole plate — plus the queries the UI needs about it (per-layer counts, colour ranges,
material shares).

It draws two things: **extrusions** (solid, oriented, coloured) and **travels** (thin lines, hidden by
default).

## 2. Input

```js
buildSegmentData(layers, defaultLineWidth) -> SegmentData
```

`layers[i] = { z, paths, widths }`

- `paths` — a Float32Array, **stride 8**, one segment per 8 floats:
  `[x0, y0, z0, enc, x1, y1, z1, enc]`, coordinates in mm.
- `enc` — `role + tool * 16`. Read the role with `& 15` and the tool with `>>> 4`. **This encoding is this
  repository's own** (the segment stream is the largest array the viewer holds, and a ninth float per vertex
  would cost 12.5% of it for one small integer). Both endpoints of a segment carry the same `enc`.
- `widths` — one entry per segment, in mm. A non-positive entry means "unknown": fall back to
  `defaultLineWidth`.
- `role 0` is a **travel** move: no plastic, drawn as a line, excluded from every extrusion count and from
  length accounting.

Roles 1–11 are: 1 wall, 2 sparse infill, 3 solid infill, 4 skirt/brim, 5 support, 6 raft, 7 gap fill,
8 thin wall, 9 bridge, 10 ironing, 11 prime tower.

Layer height is not in the input. Derive it as the gap to the previous layer's `z`, falling back to a
sensible default for the first layer.

## 3. Output — `SegmentData`

Field names and types are fixed by `types/viewer-toolpath.d.ts` and by the two consumers that are **not**
being rewritten (`core/toolpath_views.js`, `use_move_scrub.js`). Everything else is an implementation choice.

| Field | Shape | Meaning |
| --- | --- | --- |
| `nSeg` | number | extrusion segments (travels excluded) |
| `nTrav` | number | travel segments |
| `nV` | number | vertices in the extrusion stream |
| `position` | Float32Array | per-vertex geometry input |
| `hwa` | Float32Array | per-vertex height / width / orientation |
| `segIndex` | Uint32Array | per-vertex segment identity |
| `layerSegPrefix` | Uint32Array, length `layerCount + 1` | non-decreasing; `[0] === 0`, `[layerCount] === nSeg` |
| `travelPos`, `travelPrefix`, `nTrav` | — | the same, for travels |
| `layerCount` | number | input layer count |
| `maxAbs` | number | bounds the coordinate magnitude |
| `hasNaN` | boolean | true if any non-finite value reached the stream |
| `bbox` | `{min:[x,y,z], max:[x,y,z]}` or `null` | null when there is not a single vertex |
| `typeLengths` | Float64Array(16) | total extruded length per role, mm |
| `meta` | see below | per-vertex channels |

`meta` — every array has length `nV`, and a shader reads past its attribute if any disagrees:

| Channel | Type | Contents |
| --- | --- | --- |
| `vType` | Uint8Array | the **decoded** role (`enc & 15`), never raw `enc` |
| `vTool` | Uint8Array | the decoded tool (`enc >>> 4`); untooled input decodes to 0 |
| `vWidth` | Float32Array | bead width, mm, always > 0 |
| `vHeight` | Float32Array | bead height, mm, always > 0 |
| `vLayer` | Int32Array | layer index, `0 .. layerCount-1` |

The present implementation uses two vertices per segment with `position` and `hwa` as vec4 attributes and
`segIndex` as 2 entries per vertex. **A reimplementation may choose differently**, provided `meta`, `nV` and
the fields above stay consistent with each other, because `computeColors` allocates `nV * 4` colours and
`makeToolpath` consumes what `buildSegmentData` produced.

Degenerate input must be survived, not crashed: no layers gives zero counts and `bbox === null`; a
zero-length segment must not produce NaN.

## 4. Geometry

Each extrusion segment is drawn as a solid bead: a cross-section swept along the segment, oriented to the
direction of travel, sized by that segment's width and height. One instanced draw call covers the plate.

Requirements:

- The bead is **centred on the extrusion path in z** — the toolpath's z is the nozzle position, and plastic
  sits below it. The recorded run shows a layer at `z = 0.2` producing a bbox z of `0.1 .. 0.3` for a
  0.2 mm layer: the bead spans half a layer height either side.
- Orientation follows the segment direction in the XY plane.
- Width and height come from `meta`, per vertex, so two segments in one draw call can differ.

`makeToolpath(THREE, data) -> ToolpathHandle` builds the scene objects. The `THREE` namespace is **passed
in, never imported** — that is what guarantees the consumer's own three.js instance is used, and it is why
this module has no dependency of its own.

```
mesh              the extrusions
travLines         the travels (THREE.LineSegments)
setLayerRange(lo, hi)   show only layers lo..hi inclusive
setVisibleLayers(n)     === setLayerRange(0, n - 1)
setTravelVisible(bool)  travels start hidden
setColors(Float32Array) swap the per-vertex colours in place, without rebuilding geometry
dispose()               release GPU resources
nSeg, layerCount        mirrored from the data
```

`setColors` must not rebuild the mesh: changing the view type is interactive and happens on every dropdown
change.

## 5. Colour

`computeColors` (in `core/toolpath_views.js`, **not** part of the rewrite) produces a `Float32Array(nV * 4)`
with the colour packed into the `.r` component of each vertex. The rewrite must supply the primitives it
uses:

| Export | Contract |
| --- | --- |
| `packColor([r,g,b])` | components 0..1 -> `r<<16 \| g<<8 \| b`; exact in float32 below 2^24, and the inverse of `hexToRgb` for any 6-digit hex |
| `hexToRgb('#rrggbb')` | -> `[r,g,b]` in 0..1 |
| `TYPE_COLOR` | role -> `[r,g,b]`; must cover every role in `TYPE_LABEL` |
| `TYPE_LABEL` | role -> display name (§2's list) |
| `TOOL_COLOR` | categorical per-extruder colours; non-empty, indexed **modulo its length** — a machine may have more extruders than entries |
| `DEFAULT_RANGES_COLORS` | an 11-stop heatmap for continuous views |
| `rangeColorAt(v, lo, hi, palette)` | value -> interpolated colour between adjacent stops |

**`rangeColorAt` must clamp both ends.** The present implementation clamps the high end and *extrapolates*
below the low end, returning negative components — out of gamut. It is latent today because `computeColors`
derives `lo`/`hi` from the data, so no value is ever below `lo`; `test_toolpath_contract.mjs` records it and
will report it as fixed once the rewrite lands.

The colour values themselves are a free choice. Pick a palette that reads well; there is no external
consumer that depends on a specific hue, only on the shape of these APIs.

## 6. Queries

`roleRatios(typeLengths)` — length share per role, as
`[{ type, label, pct, color }]`, **descending by `pct`**, summing to 100, one entry per role with non-zero
length. The kernel exposes no per-role time, so length stands in for it.

The move-scrub queries, consumed by `use_move_scrub.js` and pinned by `test_move_scrub.mjs`:

- `layerMoveCount(data, layer)` — moves in one layer
- `topMoveLayer(data, lo, hi)` — the topmost visible layer in a range
- `moveCursor(data, layer, at)` — where the nozzle is, `at` moves into `layer`, plus how much of each draw
  list that accounts for

## 7. Shaders

A vertex and a fragment shader, GLSL ES 3.0, used through a raw shader material. The vertex shader expands
each instance into the oriented bead from the per-vertex attributes; the fragment shader shades it.

Constraints:

- Attribute layout is the rewrite's own choice, provided the shaders and `makeToolpath` agree.
- Per-vertex colour arrives packed in one float (see §5) and is unpacked in the shader.
- Layer-range visibility must be a **uniform**, not a geometry rebuild — `setLayerRange` is dragged.

## 8. How to know it works

1. `node viewer-package/tests/test_toolpath_contract.mjs` — the contract, plus a printed snapshot to diff against
   the recorded run. Exact float equality is **not** expected; counts, strides, encodings, ranges and length
   accounting are.
2. `node viewer-package/tests/test_move_scrub.mjs` — the scrub queries.
3. `npm run test:viewer` — everything, including the license boundary check.
4. **Look at it.** Build the three demos that consume this API
   (`examples/{instant-quote,cad-embed,farm-dashboard}`) and open them. A static check cannot tell you a
   shader is wrong; a bead facing the wrong way, z-fighting, or a black plate will only show on screen.
