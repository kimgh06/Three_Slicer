# Provenance

Which parts of this package are derived from upstream (OrcaSlicer / PrusaSlicer) and which are not — and
therefore what could carry a license other than AGPL-3.0-or-later.

The whole package ships AGPL-3.0-or-later today (`LICENSE.txt`). That is not in question here. This file
exists for one recurring question: **can any part of the viewer be published under a permissive license so
that industrial users can adopt it without the AGPL network-use obligation?** Answering it means knowing,
per file, whether the code is our own or a derivative of upstream — and that answer is expensive to
re-derive from scratch each time it comes up.

**This is a provenance map, not legal advice.** Anything acted on here should be reviewed by counsel. A
license change is also irreversible: a permissive grant, once published, cannot be withdrawn from the
versions already distributed.

## 1. The ceiling: the kernel can never be relicensed

| Location | Size | Origin |
| --- | --- | --- |
| `wasm-core/arachne_port/` | 114,001 lines C++ | OrcaSlicer, verbatim |
| `wasm-core/treesupport_port/` | 112,535 lines C++ | OrcaSlicer, verbatim |
| `wasm-core/slasupport_port/` | 19,145 lines C++ | PrusaSlicer 2.9.6, verbatim |
| `wasm-core/third_party/` | 381,842 lines C++ | vendored deps, own licenses (`THIRD-PARTY-NOTICES.md`) |

Copyright in those ports belongs to SoftFever / Prusa Research / the Slic3r authors. We hold no right to
relicense them, so:

- **Dual licensing is impossible.** Selling a commercial license requires owning the copyright. The
  Artifex/Ghostscript, iText, MinIO and Grafana model does not transfer to this project.
- The compiled kernels (`engine/src/slicer_core.js`, `slicer_core.mt.js`) are combined works of those
  sources and are AGPL. CGAL headers (GPL-3.0-or-later) compile in as well.
- The kernel bridge written here — `wasm-core` root sources, 11,709 lines (`bindings.cpp`, `params.cpp`,
  `emit.cpp`, …) — is our own copyright, but it links the ports and does nothing without them. Separating
  it is legally possible and practically pointless. One root source is not ours: `classic_bridge.cpp` is
  OrcaSlicer's `PerimeterGenerator::process_classic`, `traverse_loops` and `VariableWidth.cpp`, adapted to
  plain types, so it carries OrcaSlicer's copyright like the ports.

Anything that calls the kernel is a combined work and is AGPL when distributed. That includes slicing in
any form, so **a permissive "viewer with slicing" cannot exist.** What can exist is a viewer without it.

## 2. `packages/viewer` — the derived files, and their replacement

Four files were ports of upstream's libvgcode toolpath renderer — 536 of the viewer's JS/JSX/CSS lines.
Each was flagged by its own header comment; the quoted text was from the file itself:

| File | Was |
| --- | --- |
| `src/core/toolpath_shaders.js` | "faithful port of the upstream `Segments_Vertex_Shader_ES`" |
| `src/core/toolpath_segments.js` | "faithful port of the upstream libvgcode toolpath renderer"; "the vertex shader is a straight port" |
| `src/scene/toolpath_mesh.js` | `SegmentTemplate.cpp:18` VERTEX_DATA, verbatim |
| `src/core/toolpath_palette.js` | `ColorRange.hpp:14` DEFAULT_RANGES_COLORS and `get_color_at` |

**All four have been replaced.** The replacements were written from
[`viewer/TOOLPATH_SPEC.md`](./viewer/TOOLPATH_SPEC.md) — a functional contract derived from the published
types (`types/viewer-toolpath.d.ts`), the consumers, and a recorded run of the old implementation
(`viewer/test_toolpath_contract.mjs`), with no upstream source consulted. The spec is also the artifact to
hand a third party if the work is ever redone under stricter clean-room conditions.

What the replacement does differently, in the open: it is instanced per segment from an eight-vertex
template whose 24 side indices are generated rather than transcribed, the layer range is a shader uniform,
and the colour palettes are its own. Two defects in the old code did not survive the rewrite —
`rangeColorAt` clamps both ends now (it used to extrapolate below the low end and return negative
components), and a non-finite view value can no longer index the palette out of bounds. The second was
reachable: `computeColors(data, 'fan', ctx)` threw a `TypeError` for any caller following the published
`ColorContext`, which declared `fanByType` / `fanFirstLayers` that nothing read while the code required
`fanNormal`. The type declaration now matches the implementation.

Grey areas that were noted while the files were still derived, recorded so they are not re-litigated: the
24-index prism skin is geometrically forced rather than authored, and an 11-stop heatmap is arguably a
creative selection. Both were replaced outright, so neither needs resolving.

`src/core/bed_grid.js` still carries upstream `Bed_2D`'s spacing ladder as bare numbers. Functional values,
trivially re-derivable, but taken from upstream — flagged rather than classified, and not part of any
closure that would ship permissively.

## 3. `packages/viewer` — `gcode_parse.js` is independently authored

`src/core/gcode_parse.js` (170 lines) was checked against upstream directly. It is not a port:

- **Structure.** Upstream `GCodeProcessor.cpp` is 7,561 lines plus a 1,530-line header: a state machine with
  per-axis acceleration/jerk time estimation, custom G-code blocks and an arc interpolation class. This file
  is a single line loop and deliberately derives no time estimate ("an estimate needs the machine's
  acceleration limits, which G-code does not carry"). The smaller `GCodeReader.cpp` (358 lines) is a
  callback-based parser class and is a different shape again.
- **The one formula.** `w = A/h + h·(1 − π/4)` is the algebraic inverse of upstream's rounded-rectangle bead
  cross-section (`Flow.cpp:225`, `m_height * (m_width - m_height * (1. - 0.25 * PI))`). A mathematical
  relation, written out here as its inverse.
- **The remaining upstream contact is file-format data**: the `;TYPE:` strings Orca/Prusa/Cura emit, and
  `GCodeExtrusionRole` enum numbers. Values needed to read someone else's output.
- **History.** Two commits, the first being `feat(viewer): parse G-code back into the renderer's layer
  stream`. Written here.

It has zero imports, so it is separable as-is. On its own it only parses; drawing the result needs §2.

## 4. `packages/viewer` — everything else

299 upstream references across 57 files were reviewed. Excluding §2 and §3 they fall into two groups,
neither of which is derivation:

**Interface and file-format facts.** Values required to read and write someone else's files:
`parse_3mf.js` / `write_3mf.js` (3mf member paths, the `paint_color` triangle attribute, 1-based
`plater_id`, `Slic3r_PE_sla_*.txt` record formats), `sl1_read.js` / `sl1_write.js` / `png_gray.js`
(`config.ini` field set, the `expUserProfile` enum, mask filename ordering, the gray8 PNG layout upstream's
reader requires), `preset_bundle.js` / `preset_actions.js` (the `.orca_printer` archive layout),
`support_paint.js` (`EnforcerBlockerType` stopping at Extruder16), `plate_layout.js`
(`UPSTREAM_PLATE_GAP_RATIO = 1/5`, without which an imported project decodes to the wrong coordinates).

**Behaviour citations.** Comments explaining what upstream does and why this code agrees or differs, with
implementations that share no expression: `use_three_scene.js` (25 references), `Viewport.jsx` (21),
`paint_input.js`, `box_select.js`, `brush_cursor.js`, `section_plane.js`, `nozzle_marker.js`,
`shortcut_keymap.js`, `model_loaders.js` and the `ui/*.jsx` components. `box_select.js` documents a
deliberate divergence — upstream uses a GPU picking pass, this projects world bounding boxes to screen.

## 5. `packages/data` — three parts, three different answers

This section originally read "cannot be relicensed" for all of `packages/data`. That was too coarse. The
artifacts (`web/extract_all.py`, sourced from `slicers/slicer`) hold three kinds of content, and only one of
them is upstream's authored expression. From `config-schema.json`, one of 976 entries:

```json
"layer_height": {
  "label": "Layer height",
  "tooltip": "This is the height for each layer. Smaller layer heights give greater accuracy but longer printing time.",
  "defined_in": "init_common_params", "line": 918
}
```

Every key carries upstream's label and tooltip prose, and records the upstream source location.
`ui-tree.json` likewise carries page and group names plus `Tab.cpp` line numbers. `printers.json`,
`processes.js` and `filaments.js` are extracted from the upstream vendor profile bundles.

Measured, the split is:

| Part | Size | Character | Disposition |
| --- | --- | --- | --- |
| `label` / `tooltip` / `full_label` | 157 KB — 45% of `config-schema.json` | upstream's authored prose | not relicensable; **no code reads it** |
| `type` / `default` / `enum_values` / `min` / `max` | 194 KB | interface facts about an option set | a reduced artifact is defensible — grey, needs counsel |
| vendor catalogs (`printers`, `processes`, `filaments`) | 2.0 MB | upstream's curated preset values | not relicensable; **inject from the host instead** |

The middle row is what makes a permissive `<Viewport/>` reachable at all, and it rests on one measured fact:
`engine/src/settings.js` (738 lines, no port claim of its own) reads exactly three schema fields —
`.type`, `.default` and `enum_values`. It never touches a label or a tooltip. So the prose can be dropped
from a generated artifact without changing a line of code.

The catalogs are a different answer on purpose. Injecting them is not a licensing workaround — it is the
right architecture regardless: an industrial adopter with its own machine fleet wants its own profiles, not
a vendor bundle, and does not want 2 MB of presets it will never show.

Two consumers still read the prose half and need substitutes:

| Consumer | Use | Substitute |
| --- | --- | --- |
| `viewer/src/core/support_settings.js` | `schema.support_style.enum_labels` for one dropdown | four literal strings |
| `viewer/src/ui/FilamentCard.jsx` | `uiTree[builder]` to pick which options to show | a reduced key list |

`packages/components`' `<SettingsPanel/>` is the heavy consumer of the prose — it exists to render labels
and tooltips — and stays AGPL. That is the correct home for it.

## 6. What a permissively licensed viewer would cost

Two boundaries are possible. They were chosen by computing the transitive import closure from candidate
entry points rather than by guessing, and the closures decide almost everything:

| Boundary | Files | Lines | External deps | Imports `three-slicer` |
| --- | --- | --- | --- | --- |
| **B** — G-code parsing, model loading, toolpath rendering | 12 | 1,692 | `three` | **none** |
| **C** — the whole `<Viewport/>` | 92 | 11,308 | react, react-dom, three, `three-slicer/settings`, `/data` | 13 files |

B is already free of AGPL imports today. Its only blocker is the four derived files of §2, which are 536 of
its 1,692 lines. Nothing has to be inverted; the boundary already exists.

C additionally needs the §5 work. It is smaller than the "13 files" column suggests, because
`three-slicer/settings` is our own code and therefore **moves rather than inverts**: 73 viewer call sites
(`settingRaw` 20, `deriveKernelParams` 15, `deriveSlaParams` 12, the preset and project codecs, …) travel
with it untouched. Only the catalog lookups need injection — 11 sites in four files
(`actions/preset_actions.js`, `ui/ResinCard.jsx`, `ui/FilamentCard.jsx`, `core/printer_pick.js`).

| Work | B | C |
| --- | --- | --- |
| Rewrite the toolpath renderer without reference to upstream (§2) | 536 lines, 4 files | same |
| Move `engine/src/settings.js` (738 lines, unchanged) | — | yes |
| Generate a reduced schema (`type` / `default` / `enum_values` only, §5) | — | one more `extract_all.py` output |
| Inject the vendor catalogs instead of bundling them | — | 11 sites, 4 files |
| Replace the two prose readers (§5) | — | 2 sites |
| Package split, per-package `LICENSE`, boundary + lockstep tests | small | small |

**C shipped** (RELICENSE.md §5). B was shipped first as `three-slicer-viewer`'s initial surface and then grown to
C in place, which is what made the ordering free. B is a strict subset of C, so shipping B first wastes nothing: it pays the one genuinely new cost (the 536
lines) and produces something publishable, while the grey question in §5's middle row goes to counsel.

Direction matters: the permissive package must not import the AGPL one. The AGPL package depending on the
permissive one is fine, and is how `three-slicer/viewer/toolpath` and `/viewer/gcode` keep working for
existing consumers — the AGPL package re-exports them.

Two facts make this viable rather than cosmetic. The toolpath and G-code surfaces already form a closed
import island — closure B reaches nothing in the kernel, and closure A (rendering alone, 7 files, 783
lines) has no external dependency at all, not even `three`. And `viewer/src/use_injection.js` already
renders `gcode` and `sl1` artifacts on a plate **without running the kernel**, so a viewer without slicing
has a real use case rather than being a shell built to route around a license.

### Release: the two packages version as a pair

The AGPL package re-exports the permissive one, so a version of the pair that was never built together must
never be resolvable. Both packages therefore carry the **same version**, and the dependency is an **exact
pin**, not a range:

```json
// the permissive package            // the AGPL package
{ "version": "0.3.0" }               { "version": "0.3.0",
                                       "dependencies": { "<permissive>": "0.3.0" } }
```

A caret would let `three-slicer@0.3.0` resolve a later `0.3.7` of the permissive package, so the first
place that combination is ever assembled would be a user's `node_modules`. The cost of lockstep is that a
kernel-only release still bumps the permissive package — cosmetic churn, traded against a correctness
failure, which is the right way round.

Enforced, not documented: a `test_version_lockstep.mjs` beside the other gates asserts the two versions are
equal, that the dependency is that exact version with no range operator, and that every subpath the AGPL
package re-exports exists in the permissive one. `pack_check.sh` packs **both** and installs the two
tarballs together, so the AGPL consumer resolves the local permissive build rather than whatever the
registry holds; a fifth consumer case installs the permissive package **alone**, which is the industrial
adopter's actual path and is where "no AGPL in the dependency tree" is verified.

Publish order is the dependency order — the permissive package first. npm has no atomic multi-package
publish; if the second publish fails, an unreferenced version of the first is harmless, whereas the reverse
order leaves `npm i three-slicer` pointing at a dependency that does not exist yet. npm also refuses to
reuse a version number and forbids unpublishing after 72 hours, which is why these are gates rather than
conventions.

## 7. Method and limits

Classification is based on each file's own header comments, its import graph, and — for `gcode_parse.js` —
a structural comparison against upstream. A line-by-line diff against upstream's 7,561-line
`GCodeProcessor.cpp`, or against libvgcode, was **not** performed. This codebase's comments are unusually
explicit about what was ported, which is what made the audit tractable; a comment reading "upstream does the
same" could still sit above copied code.

Before any file is actually published under a different license, that specific file should be diffed
against upstream, and authorship of `packages/viewer` should be confirmed across all contributors — a
relicense needs every copyright holder's agreement.

## 8. Precedent

Consumer 3D printing runs almost entirely on this lineage: PrusaSlicer → BambuStudio → OrcaSlicer →
ElegooSlicer / Creality Print / Snapmaker Orca / Anycubic. Anycubic, Bambu Lab, Creality, Elegoo,
Flashforge, Snapmaker and Sovol all ship AGPL-derived slicers alongside commercial hardware and publish the
source; the revenue sits in the hardware and the ecosystem, not in the software license.

The cautionary case is the one attempt to keep a piece closed: BambuStudio's proprietary networking plugin,
loaded at runtime from a CDN, drew a public AGPL-violation accusation from Josef Prusa. Partial closure is
the pattern that draws challenge; full compliance is the pattern that does not.

For internal industrial deployment specifically, AGPL costs nothing: obligations attach to distribution, and
software used by employees of one legal entity is not conveyed to third parties. Note that this viewer ships
its code to every browser that loads the page, so "we only run it on our own server" is not the relevant
test — who opens the page is.
