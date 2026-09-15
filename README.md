# Three Slicer

A 3D-printing slicer that runs entirely in the browser — reverse-engineered from [OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) into a WASM kernel + npm packages. STL/OBJ/3MF/AMF/PLY in (STEP via a pluggable loader), G-code out; no server, no install. A slicer-written `.3mf` project restores its plate layout, settings and support/material painting, and multi-material printing works through per-extruder filament presets and facet painting with a real ported prime tower.

Resin printing is a second technology in the same kernel, routed by `printer_technology`. The support-point generator, support tree and pad are PrusaSlicer 2.9.6's own chain ported verbatim; the result previews in the same viewer with the pad-lifted layer frame and writes out as an `.sl1` archive, which the viewer also reads back. What the port does not cover — hollowing, organic trees — fails with a typed capability error instead of an approximation.

![A sliced Benchy in the Preview tab — organic tree supports, per-feature toolpath colors, dual layer-range slider, filament and print-time estimates](web/viewer/public/usage.png)

## Links

- Demo: [slicer.kimgh06.com](https://slicer.kimgh06.com/)
- npm packages: [three-slicer](https://www.npmjs.com/package/three-slicer) (AGPL, slicing) · [three-slicer-viewer](https://www.npmjs.com/package/three-slicer-viewer) (MIT, viewer)
- Source: [kimgh06/Three_Slicer](https://github.com/kimgh06/Three_Slicer) · viewer mirror [kimgh06/three-slicer-viewer](https://github.com/kimgh06/three-slicer-viewer)
- Integration example specs: [examples/DEMOS.md](examples/DEMOS.md)
- Community: [questions, ideas, or a print you sliced with it](https://github.com/kimgh06/Three_Slicer/discussions) — bug reports go to [Issues](https://github.com/kimgh06/Three_Slicer/issues)

## Packages (npm workspace)

Two packages, released as a locked pair (same version; `three-slicer` pins `three-slicer-viewer` exactly).

| Package | License | What it is |
|---|---|---|
| `three-slicer` | AGPL | WASM slicing kernel SDK — FFF batch/streaming slice, SLA slice, worker protocol, settings mapping. Headless-capable (Node or browser), **no three.js dependency** |
| `three-slicer/data` | AGPL | Extracted OrcaSlicer metadata: config schema, UI tree, toggle rules, invalidation map, and the printer/process/filament/resin preset catalogs |
| `three-slicer/viewer`, `three-slicer/components` | AGPL | The viewer and settings panel below with the kernel and the vendor presets plugged in — thin wrappers over `three-slicer-viewer` |
| `three-slicer-viewer` | MIT | React `<Viewport/>` — three.js scene, model import, GPU volumetric toolpath preview, G-code parsing, SLA preview and `.sl1` import/export, Shadow DOM isolated. Displays and exports; slicing is a prop |
| `three-slicer-viewer/components` | MIT | React `<SettingsPanel/>` — schema-driven settings form, props-only, Shadow DOM isolated |

Quick taste (slicer included — AGPL):

```jsx
import { useState } from 'react'
import Viewport from 'three-slicer/viewer'
import SettingsPanel from 'three-slicer/components'

function App() {
  const [settings, setSettings] = useState({})       // OrcaSlicer schema keys, sparse
  return (<>
    <Viewport settings={settings} setSettings={setSettings} />
    <SettingsPanel settings={settings} setSettings={setSettings} />
  </>)
}
```

Viewer only (MIT — model and G-code preview, no slicing, no AGPL in the tree):

```jsx
import Viewport from 'three-slicer-viewer'
<Viewport files={files} settings={settings} setSettings={setSettings} />
```

Headless (no UI): `const s = await createSlicer(); s.slice(stl, params)`, or `s.sliceSla(stl, slaParams)` for resin — see [`packages/README.md`](packages/README.md).

## Repository layout

- **`packages/`** — the npm package `three-slicer` (AGPL): kernel SDK, extracted data, WASM kernel sources, and the wrappers that plug the kernel into the viewer. Self-contained: builds, tests, and runs without `slicers/`.
- **`packages-mit/`** — the npm package `three-slicer-viewer` (MIT): the viewer, the settings panel, G-code parsing and the toolpath renderer. Mirrored to its own repository on every release.
- **`web/`** — demo viewer app that consumes `three-slicer` through the workspace package name.
- **`slicers/`** — untracked reference clones (each its own git remote): upstream OrcaSlicer at `slicers/slicer` (the extraction/porting source) and PrusaSlicer at `slicers/PrusaSlicer` (comparison only).

```bash
# demo viewer (committed WASM — no emscripten needed)
cd web && make dev

# full gate: kernel invariants (FFF + SLA), the generated param table, the viewer's pure modules
npm test

# tarball independence gate (packs both packages, builds Node/Vite/Next consumers and a viewer-only one outside the repo)
bash packages/pack_check.sh

# release both packages in order (viewer first), sync the mirror, tag — DRY=1 to rehearse
make bump V=x.y.z && make publish
```

Development docs (demo app, stage-by-stage log, reverse-engineering guide, format specs): [`web/README.md`](web/README.md), [`web/HISTORY.md`](web/HISTORY.md), [`web/GUIDE.md`](web/GUIDE.md), [`web/SPECS.md`](web/SPECS.md).

## License

`three-slicer` is AGPL-3.0-or-later ([`LICENSE.txt`](LICENSE.txt)) — derived from OrcaSlicer. AGPL extends to network
use: a web service embedding it must offer its source to its users.

`three-slicer-viewer` ([`packages-mit/`](packages-mit/)) is MIT: the viewer, the settings form, G-code parsing and
toolpath rendering contain no upstream code ([`packages/PROVENANCE.md`](packages/PROVENANCE.md)) and can go into
closed-source products. Only slicing itself, and the vendor presets, are AGPL. Which files may carry which license,
and why, is [`packages/PROVENANCE.md`](packages/PROVENANCE.md); a license-boundary test enforces the split.
