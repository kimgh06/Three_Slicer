# three-slicer-viewer

The 3D-printing viewer without the slicer: model loading (STL/OBJ/3MF/AMF/PLY), G-code parsing, GPU toolpath
rendering, the settings transforms, and the React `<Viewport/>` itself. **MIT licensed** — usable in closed-source
commercial products.

This is [`three-slicer`](https://www.npmjs.com/package/three-slicer) with the kernel taken out. It displays and
exports; it does not slice. Slicing is plugged in through two props — `slicer` (a hook driving a kernel) and
`catalog` (vendor presets) — which `three-slicer/viewer` supplies. Install `three-slicer` for that, and note that
doing so puts your application under AGPL.

Developed in the [`Three_Slicer`](https://github.com/kimgh06/Three_Slicer) monorepo (`viewer-package/`), where it
is built and tested beside the kernel; this repository is that folder's history, pushed on every release. Issues and
pull requests are welcome here — a change lands upstream and comes back with the next sync.

## The viewer

```jsx
import Viewport from 'three-slicer-viewer'

// A display-only viewer: opens models and G-code, no kernel, no presets. Pass `slicer` and `catalog` to add them.
<Viewport settings={settings} setSettings={setSettings} gcode={gcodeText} />
```

## Slicing, if you bring a kernel

```jsx
import Viewport, { useSlicer } from 'three-slicer-viewer'
import { makeSlicerWorker } from 'three-slicer/client'      // AGPL — the WASM kernel's worker; this is the step that changes your licence
import { bundledCatalog } from 'three-slicer/settings'      // AGPL — OrcaSlicer's vendor presets

const slicer = (deps) => useSlicer({ ...deps, makeWorker: makeSlicerWorker })   // module-level: it is a hook
<Viewport slicer={slicer} catalog={bundledCatalog} … />
```

`useSlicer` is this package's; it only needs a worker that speaks its protocol. `three-slicer` ships one.

## The settings form

```jsx
import SettingsPanel from 'three-slicer-viewer/components'

// Bare: fields labelled by key, nothing disabled. Pass `schema`, `uiTree` and `toggle` for labels, tabs and
// enable/disable rules — three-slicer/components does that with OrcaSlicer's data; a host may pass its own.
<SettingsPanel settings={settings} setSettings={setSettings} />
```

## Rendering without React

```js
import { parseGcode } from 'three-slicer-viewer/gcode'
import { buildSegmentData, makeToolpath, computeColors } from 'three-slicer-viewer/toolpath'
import * as THREE from 'three'

const { layers, stats } = parseGcode(gcodeText)          // any slicer's output
const data = buildSegmentData(layers, 0.4)               // -> GPU attribute buffers
const handle = makeToolpath(THREE, data)                 // -> { mesh, travLines, ... }
scene.add(handle.mesh, handle.travLines)

handle.setLayerRange(0, 90)                              // cut the print open
handle.setColors(computeColors(data, 'speed', ctx).color) // recolour without a rebuild
```

- Reads G-code from OrcaSlicer, PrusaSlicer, Cura and this kernel — roles, widths, tool changes, arcs.
- Draws one instanced call for the whole plate, with per-role, per-tool and heatmap colouring.
- `three`, `react` and `react-dom` are **optional peers**. The main entry is the React viewer; `/toolpath` and
  `/gcode` import neither React nor three (`makeToolpath` takes the THREE namespace as an argument), so a
  headless consumer pulls in no renderer at all.

## Licensing

MIT. It depends on nothing AGPL, which a check in this repository enforces rather than documents
(`packages/viewer/tests/test_license_boundary.mjs`).

The implementation was written from [`TOOLPATH_SPEC.md`](./TOOLPATH_SPEC.md), a functional contract, rather
than derived from any upstream slicer. The reasoning and evidence are in
[`PROVENANCE.md`](https://github.com/kimgh06/Three_Slicer/blob/main/packages/PROVENANCE.md); the plan it came from is
[`RELICENSE.md`](https://github.com/kimgh06/Three_Slicer/blob/main/packages/RELICENSE.md).

Published as a locked pair with `three-slicer`: both carry the same version, and `three-slicer` pins this
package exactly, so a combination that was never built together cannot be resolved.
