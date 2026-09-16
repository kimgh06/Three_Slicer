# Relicensing the viewer

A plan for publishing the viewer under a permissive license (MIT) so industrial users can adopt it
commercially, while slicing stays AGPL-3.0-or-later.

Every number here was measured against the tree at 0.2.5 — file counts, import closures and call-site counts
are reproducible with the commands noted. **Why** each part is or is not relicensable is
[PROVENANCE.md](./PROVENANCE.md); this file is only **what to do**.

## 1. What this achieves, and what it does not

Achieves: an industrial adopter can display G-code, toolpaths and models inside a closed-source commercial
product, or serve them from a SaaS, without the AGPL network-use obligation. The one duty is keeping the
copyright notice.

Does not achieve: free commercial use of *slicing*. The kernel is a combined work of ~245k lines of
verbatim OrcaSlicer and PrusaSlicer C++ that we hold no right to relicense, so anything that calls it is
AGPL when distributed. An adopter who adds slicing to the permissive viewer is back under AGPL for their
whole app.

The audience this actually serves is therefore the one that already has G-code — print-farm consoles, MES
dashboards, machine-vendor job previews — plus anyone who only needs to display models.

## 2. The two boundaries

Chosen by computing the transitive import closure from candidate entry points, not by guessing:

| Boundary | Files | Lines | External deps | Imports `three-slicer` |
| --- | --- | --- | --- | --- |
| **A** — toolpath rendering + G-code parsing | 7 | 783 | **none** | none |
| **B** — A + model loading (`stl/obj/3mf/amf/ply`) | 12 | 1,692 | `three` | **none** |
| **C** — the whole `<Viewport/>` | 92 | 11,308 | react, react-dom, three, `three-slicer/settings`, `/data` | 13 files |

B is already free of AGPL imports. Its only blocker is the four derived files, which are 536 of its 1,692
lines. **B is a strict subset of C**, so shipping B first wastes nothing.

Closure B, in full:

```
core/gcode_parse.js      171     core/toolpath_palette.js    59  [DERIVED]
core/model_geometry.js   152     core/toolpath_segments.js  206  [DERIVED]
core/parse_3mf.js        409     core/toolpath_shaders.js   138  [DERIVED]
core/plate_layout.js      66     scene/toolpath_mesh.js     145  [DERIVED]
core/toolpath_views.js    56     scene/model_loaders.js     250
make_worker.js            32     scene/toolpath_gpu.js        8
```

## 3. Work items

### G001 — Rewrite the toolpath renderer (536 lines, 4 files)

The only genuinely new code in the whole plan, and the shared cost of both B and C.

| File | Lines | What it must produce |
| --- | --- | --- |
| `core/toolpath_segments.js` | 206 | layer stream -> GPU instance attributes (position, orientation, height, width, colour) + the four move-scrub queries |
| `scene/toolpath_mesh.js` | 145 | the instanced cross-section geometry and `InstancedMesh` assembly |
| `core/toolpath_shaders.js` | 138 | vertex/fragment GLSL turning instance attributes into an oriented extrusion bead |
| `core/toolpath_palette.js` | 59 | per-role and per-tool colours, the value-range heatmap, colour packing |

(544 lines on disk; 536 excluding the two-line provenance header each carries.)

`core/toolpath_views.js` (56) and `scene/toolpath_gpu.js` (8) are **not** in scope — neither is derived;
they only consume the four above.

**Contract that must survive.** Published as `three-slicer/viewer/toolpath`
(`types/viewer-toolpath.d.ts`): `buildSegmentData`, `makeToolpath`, `computeColors`, `roleRatios`,
`TYPE_LABEL`, `TYPE_COLOR`, `TOOL_COLOR`, `DEFAULT_RANGES_COLORS`, `VERTEX_DATA`.

External consumers — three demos share one identical import line
(`examples/{instant-quote,cad-embed,farm-dashboard}/src/toolpath_view.js`), which makes them a regression
detector as well as a contract.

Internal consumers — `actions/toolpath_view.js`, `actions/plate_actions.js` (`roleRatios`),
`use_move_scrub.js` (`layerMoveCount` / `moveCursor` / `topMoveLayer`), `ui/PreviewControls.jsx`
(`VIEW_TYPES` / `DEFAULT_RANGES_COLORS` / `TOOL_COLOR`).

Data contract — ours, not upstream's, and must not change: `paths` stride 8 as `[x,y,z,enc] x2` with
`enc = role + tool*16` (role `& 15`, tool `>>> 4`); one `widths` entry per segment.

**Order matters here.** Toolpath behaviour is currently pinned by exactly one test
(`test_move_scrub.mjs`), covering only the three scrub queries — nothing covers geometry generation,
colouring or the shaders. Rewriting first and testing after would be a gamble:

1. **Characterization tests first.** Freeze the *current* output for known input: instance count, positions,
   angles and widths from `buildSegmentData`; `computeColors` per view type; `roleRatios` sums. This records
   present behaviour, not upstream, so it carries no clean-room concern.
2. **Write a functional spec** — the contract in prose, with no upstream reference.
3. **Rewrite from the spec**, without opening the four existing files.
4. **Check against the characterization tests.** Byte-identical output is *not* the goal — a different
   implementation legitimately differs. What must match is the contract: instance counts, width ranges, role
   encoding, colour ranges.
5. **Observe it rendering.** Build the three demos and look at them in a browser. A static check cannot tell
   you a shader is right.

Clean-room note: whoever rewrites should work from the spec produced in step 2, not from the existing files.
Steps 1 and 2 are safe to do regardless and are the artifact to hand to a third party if the rewrite is
delegated.

### G002 — Split the permissive package (boundary B)

New sibling workspace (`packages-mit/`, added to the root `workspaces` array) holding closure B: its own
`package.json` (`"license": "MIT"`, peer `three`), `LICENSE`, vite config, and types.

`packages/` is itself a single package root with no sub-`package.json`, and the workspace glob is the bare
string `"packages"` — hence a sibling directory rather than a child.

The AGPL package **re-exports** `viewer/toolpath` and `viewer/gcode` from it, so existing consumers
(including the four demos) keep working unchanged.

### G003 — Version pairing

The AGPL package re-exports the permissive one, so a combination that was never built together must never be
resolvable. Both packages carry the **same version**, and the dependency is an **exact pin**:

```json
// permissive                    // AGPL
{ "version": "0.3.0" }           { "version": "0.3.0",
                                   "dependencies": { "<permissive>": "0.3.0" } }
```

A caret would let `three-slicer@0.3.0` resolve a later `0.3.7`, so the first place that pair is ever
assembled would be a user's `node_modules`. The cost is that a kernel-only release still bumps the
permissive package — cosmetic churn traded against a correctness failure, which is the right way round.

Enforced rather than documented:

- `test_version_lockstep.mjs` — versions equal; the dependency is that exact version with no range operator;
  every subpath the AGPL package re-exports exists in the permissive one.
- `pack_check.sh` packs **both** and installs the two tarballs together, so the AGPL consumer resolves the
  local build rather than whatever the registry holds.
- A fifth consumer case installs the permissive package **alone** — the industrial adopter's real path, and
  where "no AGPL in the dependency tree" is verified.

Publish order is dependency order: **permissive first**. npm has no atomic multi-package publish; if the
second publish fails, an unreferenced version of the first is harmless, whereas the reverse order leaves
`npm i three-slicer` pointing at a dependency that does not exist yet. npm also refuses to reuse a version
number and forbids unpublishing after 72 hours, which is why these are gates and not conventions.

No changesets or lerna: two packages in lockstep need a mismatch check, not release tooling.

### G004 — Reduced schema (boundary C, part 1)

`config-schema.json` is 351 KB over 976 keys, of which **45% (157 KB) is `label` / `tooltip` prose** —
upstream's authored text, and the part that cannot be relicensed. The remaining 194 KB is `type`, `default`,
`enum_values`, `min`, `max`: facts about an option set.

The unlock is that `engine/src/settings.js` (738 lines, no port claim of its own) reads exactly three schema
fields — `.type`, `.default`, `enum_values`. It never touches a label or a tooltip, so the prose can be
dropped from a generated artifact without changing a line of code.

Work: one more `web/extract_all.py` output, a consumption switch in `engine/src/data.js`, and substitutes for
the two consumers that do read the prose half:

| Consumer | Use | Substitute |
| --- | --- | --- |
| `core/support_settings.js` | `schema.support_style.enum_labels` | four literal strings |
| `ui/FilamentCard.jsx` | `uiTree[builder]` to choose which options to show | a reduced key list |

### G005 — Inject the vendor catalogs (boundary C, part 2)

`printers.json` (0.4 MB), `processes.js` (0.8 MB) and `filaments.js` (0.8 MB) are upstream's curated preset
values and stay AGPL. The permissive viewer takes them as a prop instead of bundling them.

This is the right architecture regardless of licensing: an industrial adopter with its own machine fleet
wants its own profiles, not a vendor bundle, and does not want 2 MB of presets it will never show.

Scope is far smaller than boundary C's "13 files" column suggests, because `three-slicer/settings` is our own
code and therefore **moves rather than inverts** — 73 viewer call sites travel with it untouched:

| API | Call sites | Disposition |
| --- | --- | --- |
| `settingRaw` | 20 | moves |
| `deriveKernelParams` | 15 | moves |
| `deriveSlaParams` | 12 | moves |
| `writePresetFile` / `readPresetFile` | 9 | moves |
| `normalize` / `serializeProjectSettings` | 6 | moves |
| `presetOptionKeys` | 4 | moves |
| `printerTechnology` | 4 | moves |
| `applyPreset` | 3 | moves |
| **catalog lookups** | **11** | **injected** |

The 11 injection sites live in four files: `actions/preset_actions.js` (4), `ui/ResinCard.jsx` (3),
`ui/FilamentCard.jsx` (2), `core/printer_pick.js` (2).

## 4. Sequence

```
G001 rewrite toolpath  ──┬── G002 split package (B) ── G003 version pairing ──> B publishable
                         └── G004 reduced schema ───── G005 inject catalogs ──> C publishable
```

Ship B first. It pays the one new cost (G001), produces something publishable, and leaves the open legal
question below to be answered in parallel rather than blocking.

## 5. Already done

### G001 — the toolpath rewrite (shipped)

All four derived files were replaced, written from [`../packages-mit/TOOLPATH_SPEC.md`](../packages-mit/TOOLPATH_SPEC.md).
Characterization first (`packages-mit/tests/test_toolpath_contract.mjs`), because only `test_move_scrub.mjs` had
covered any of this — geometry, colouring and the shaders had nothing. Two shipped defects surfaced and did
not survive: `viewer-toolpath.d.ts` declared `fanByType` / `fanFirstLayers` that nothing read while the code
required `fanNormal` / `toolColors`, so `computeColors(data, 'fan', ctx)` threw for any typed consumer; and
`rangeColorAt` extrapolated below the low end, returning negative components. Verified by rendering a
239-layer Benchy in a browser, cutting it open with the layer slider and switching view types.

### G002 — the permissive package (shipped, narrowed)

`packages-mit/` is `three-slicer-viewer@0.2.5`, MIT, 7 files, `three` an optional peer, building to
19 KB. `three-slicer/viewer/toolpath` and `/viewer/gcode` re-export it, so the four demos and every other
existing consumer are untouched.

**Scope was narrowed from closure B to closure A + G-code**, and the reason is worth keeping: model loading
pulls in `parse_3mf`'s worker entry, which the viewer build resolves by path and `test_layers.mjs` pins at
the root of `src/`. Closure A needs none of that, maps 1:1 onto two subpaths that were already published,
and is exactly what the demos consume. Two findings for whoever finishes closure B:

- `make_worker.js` is half kernel. `makeSlicerWorker()` points at `engine/src/slicer.worker.js`; only
  `makeParse3mfWorker()` is wanted on the permissive side. The file has to split. The 3MF worker is already
  optional with a main-thread fallback (`model_loaders.js`), so injecting the factory is the clean shape.
- `test_gcode_parse.mjs` slices with the AGPL kernel and reads the result back with the permissive parser.
  It is a round trip ACROSS the boundary and belongs on the AGPL side, importing the parser as a package.

### G003–G005 and the move to boundary C (shipped)

`three-slicer-viewer` is now the whole viewer, not the toolpath island: `<Viewport/>`, the 20 UI cards, the
actions, the scene, the four pure workers, the catalog-free settings transforms (`settings_core.js`,
`preset_file.js`, the generated `kernel_setting_keys.js`) and the three prose-free data artifacts. What stayed
in the AGPL package is exactly what touches the kernel or upstream's data: `use_slicer.js`, the slicer worker
factory, the bundled vendor catalog, the full schema, and `three-slicer/viewer` itself — now a wrapper that
passes `useSlicer` and `bundledCatalog` into the permissive `<Viewport/>` through two props, `slicer` and
`catalog`. Without those props the viewer runs on a no-op slicer and an empty catalog: it loads, displays and
exports, and never starts a kernel.

Findings that only surfaced by doing it, for the record:

- The injection is a **hook, not values**. `useSlicer` needs Viewport's own refs and callbacks as input, so
  eight values could not be passed; the hook itself is the prop, called under the name `useSlicer` so the
  wiring guard's call-site check keeps holding. It must be stable for the mount.
- `settings.js` split cleanly — the two halves never referenced each other in code — but the reduced schema had
  to keep `defined_in` and `line`: `SLA_SETTING_CONTRACT` selects the resin keys by `defined_in`. Function
  names and line numbers are facts, not text; G004's "pointers back into upstream" rationale was too coarse.
- `make_worker.js` split five ways, not two: one kernel factory stays, four pure worker factories move, each
  package keeping its own `make_worker.js` so the verbatim-copy build rule applies unchanged.
- JSON import attributes force a shape: inside the permissive package the viewer imports its own `settings`
  and `data` by package name, externalised in its build, so the attribute survives — the same funnel rule
  `engine/src/data.js` documents.
- Two generators now write into both packages (`kernel_setting_keys.js`, `settings-keys.d.ts`): their only
  or shared consumers moved. A key list may carry either licence.
- `PrinterCard.jsx` contains a NUL byte (a vendor/model separator, present since 0.2.5) and every text tool
  silently skipped it — including the audit that missed its catalog imports. `git grep` says "Binary file".
- `useSlicer` itself turned out to have no upstream in it — the worker protocol, progress, the pool and the
  downgrade ladder are ours; its one tie to a kernel was importing `makeSlicerWorker`. With the factory as
  `deps.makeWorker`, the hook is permissive too, and the AGPL residue of the viewer is exactly two files:
  the WASM worker factory and the bundled catalog, plus a ten-line wrapper that binds them.
- `web/viewer`'s `/slice` page now imports `Viewport` and `useSlicer` from `three-slicer-viewer`, and takes
  the two AGPL pieces from where they live: `makeSlicerWorker` from `three-slicer/client` (beside the kernel,
  the same literal `new Worker(new URL(…))` createSlicerClient uses) and `bundledCatalog` from
  `three-slicer/settings` (beside the nine lookups it bundles). `three-slicer/viewer` is left with a ten-line
  binding and three re-export shims. The composition is one screen.
- `<SettingsPanel/>` went the same way: the component is permissive and takes `schema`, `uiTree` and `toggle`
  as props; `three-slicer/components` is the wrapper that passes upstream's full schema, the real tab tree and
  the rule-bound evaluator. The reduced schema grew the form's layout flags and units (`mode`, `gui_type`,
  `is_code`, `multiline`, `sidetext`) — facts, not text — and still carries no label, tooltip or enum label, so the
  bare panel names every field by its key. `three-slicer/toggle` became `makeToggle(rules, schema)` in the
  permissive package, bound on the AGPL side; unbound, it disables nothing.

## 5.1 Foundations

- `PROVENANCE.md` — the per-file verdict: which code is derived, which is ours, and the evidence for each.
- `viewer/test_license_boundary.mjs` — the verdict as a check, wired into `npm run test:viewer`. It asserts
  the four derived files exist and carry their `LICENSE-PROVENANCE:` header, that no unlisted file declares
  itself a port, and that the verified-clean files import neither `three-slicer` nor anything derived.
  Both drift modes were negative-tested. It has already earned its place once: the eighteen new source files
  in 0.2.5 added no new derived file, and the check is what says so.

## 6. Open questions — these need a person, not code

1. **Legal review.** The verdicts here are a provenance map, not legal advice, and a permissive grant cannot
   be withdrawn from versions already published.
2. **Contributor copyright.** Relicensing `packages/viewer` needs agreement from every copyright holder in it.
3. **The grey row in G004.** A 976-key type map is a compilation of interface facts and is defensible with
   the prose dropped, but "defensible" is a lawyer's call. **This one question can block C entirely — and B
   does not depend on it**, which is the strongest argument for shipping B first.
4. **Who performs the rewrite.** Working from the step-2 spec rather than the existing files is a mitigation,
   not a guarantee; a third party who has never read the derived files is the stronger position.
