# marketplace — 3MF-native Model Marketplace

> The shared rules are in [DEMOS.md](./DEMOS.md). This document covers only what is specific to this demo.

> **Current status:** spec, pre-implementation. It does not start before the two public-API blockers below
> are resolved.

## What this demonstrates

A marketplace model detail page that publishes **the author's whole printer project** (plate layout ·
settings · multi-material painting), not a bare mesh, and lets a visitor **re-consume it against their own
printer**.

The reference is MakerWorld's Print Profile — geometry + print settings + orientation + arrangement +
coloring preserved in one 3MF. three-slicer shows this as the general 3MF-project consumption scenario.
**"A 3MF is a project, not a mesh"** is this demo's one-liner.

## Prerequisite work (required before implementation)

1. `parse3MFProject` / `write3MFProject` are currently **not public exports** — they live only inside the
viewer (`viewer-package/src/core/parse_3mf.js`, `viewer-package/src/core/write_3mf.js`). Per DEMOS.md's
public-export rule
("when a private API is needed, improve the package API first rather than working around it in a demo"),
**adding a subpath export (e.g. `three-slicer/viewer/project`) + type definitions is this demo's first
task.** The moment a relative-path import works around it, the demo's reason to exist is gone.

2. ~~`<Viewport/>` provides no prop for the host to inject a model/project~~ — the 0.2.2 `files` prop
resolved this blocker: models, 3MF projects, `.sl1` archives and preset files can be injected at mount
(`packages/types/viewer.d.ts`). Restoring the static fixture on the first screen is implemented with
`files`.

## Target

3D model marketplaces · creator platforms · shared teaching material · in-house printable-asset stores.

## Package APIs used

```
three-slicer/viewer/project (new)  parse3MFProject(buffer, baseName) /
                                   write3MFProject(objects, settings, options)
three-slicer/settings              normalizeProjectSettings / serializeProjectSettings —
                                   coercing the all-strings settings (already public API)
three-slicer/viewer                <Viewport/> — multi-plate/painting display, saves intercepted via onExport
three-slicer/settings              printerSettings(visitor) — the visitor's machine profile
three-slicer/client                re-slicing with the visitor's profile
```

## Install

This demo is an independent project deployed to a different site than the repository
([DEMOS.md §2](./DEMOS.md#2-independent-projects-and-installation)).

```bash
npm i three-slicer three react react-dom
```

**But `three-slicer/viewer/project` is not in the published package yet.** The current npm latest is
`0.2.2` and the project codec is not exported in it, so this demo only stands on a plain `npm i` after a
version carrying the prerequisite work is published. To start earlier, develop against a tarball made with
`npm pack` (`npm i ../../packages/three-slicer-<next>.tgz`) and postpone deployment until after the
publish. No relative-path imports of the local source — that would erase what this demo verifies.

## Fixture

The 3MF for this demo must include: **2 plates · 3+ objects · 2+ filament assignments · a painted
region · a printer profile · process settings · object transforms.**
No plain STL with its extension renamed. `fixtures/` does not hold this 3MF yet, so it has to be made — the
viewer itself can produce and save it (saving with painting already works).

## Screen

One model detail page is the whole thing: the project view (plate switching) + Objects/Filaments/Print
profile side info + Estimated. For the wireframe see [DEMOS.md](./DEMOS.md) §5.

### Author project mode (the initial state)

Opening the page restores the author's project as-is and shows what survived as a checklist:

```
Project data restored
✓ 2 plates  ✓ 3 objects  ✓ 2 filaments  ✓ painted regions  ✓ process settings
```

### Visitor printer change → compatibility check

On changing `[Bambu Lab P1S ▼]` → `[Prusa MK4 ▼]`, check `printerSettings(visitor machine)`'s
`printable_area`/`printable_height` against the project objects' bboxes:

```
⚠ Plate 2 exceeds MK4 build volume.   (naming the exceeding object and dimensions)
Compatible → [Reslice for MK4]
```

### Re-slice · download

Original (the author's profile) vs Your printer (the visitor's profile) statistics side by side.
Two downloads: `[Download G-code]`, `[Save modified 3MF]` — the latter must actually use
`write3MFProject()` (intercepted via Viewport `onExport` into the save flow).

## Implementation notes

- **Every project_settings value is a string** — including the trap where the bool `"0"` is truthy. It must
  go through `normalizeProjectSettings` (no raw use). Writing is the inverse via
  `serializeProjectSettings`.
- **The plate layout decodes under upstream's grid rule** (it coincides with this viewer's rule only on a
  200mm bed). The package handles the layout, so the demo does not touch it — touching it means something
  is wrong.
- **Where material paint and support paint overlap on one facet, material wins and the support is reported
  dropped** — the restore checklist shows the drop too.
- `parse3MFProject()`'s current internal return shape is `{objects, project}`. `project.settings` still
  holds raw string values, so it goes to `deriveKernelParams()` only after normalization.
- `write3MFProject()` is async. Make the UI busy during a save, but do not fabricate main-thread progress.
- With paint across several plates the selector cannot represent the whole project, so the package's
  existing preservation rule applies. The demo does not rebase facet indices by hand.

## Core verification (round-trip)

```js
const a = await parse3MFProject(input, 'fixture')
const settings = normalizeProjectSettings(a.project.settings).settings
const saved = await write3MFProject(a.objects, settings, {
  bedWidth,
  bedDepth,
  plateCount: a.project.plates?.length || 1,
})
const b = await parse3MFProject(saved, 'roundtrip')
expect(projectSemantics(b)).toEqual(projectSemantics(a))
```

Not byte equality but **preservation of the semantic data**: plates · object transforms · process
settings · filament assignments · painting · printer metadata.

## What is intentionally mocked

- Marketplace CRUD (search · reviews · payment · upload management) — one detail page is the entire demo.
- Author accounts — one fixture project served statically.

## Definition of done

- [ ] the `three-slicer/viewer/project` export + types (the prerequisite work)
- [ ] loading a real project 3MF — multi-plate · multi-object · filament/color · painting displayed
- [ ] original settings restored + the restore checklist
- [ ] visitor printer change → build-volume compatibility check
- [ ] browser reslicing → original vs visitor statistics
- [ ] G-code download + modified 3MF write
- [ ] the parse → write → parse round-trip test

## E2E scenario

```
load the fixture 3MF → every checklist item ✓ → switch to MK4 → compatibility warning or Compatible
→ Reslice → both statistics shown → Save modified 3MF → re-parse yields identical semantic data
```

The failure path:

```text
load a fixture with overlapping material/support paint → material kept + dropped-support warning
→ save, re-parse → the warning and the preserved result are identical
```

## To add to the docs after implementation

- the chosen programmatic project-load approach and the public-API link
- live URL, fixture provenance, screenshot
- the run/build/round-trip test commands
- the field list the semantic comparison includes and excludes

## Production considerations

A real service additionally needs project versioning, thumbnail generation (viewer screenshots), profile
trust signals (did the author actually print it), license display, and progressive loading of large 3MFs.
