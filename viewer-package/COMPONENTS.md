# three-slicer-viewer/components — the settings form

(Published as `three-slicer-viewer/components`, MIT. `three-slicer/components` is the same component with upstream's
schema, tab tree and toggle rules plugged in; everything below applies to both.)

Reusable React components for the browser slicer. Props-driven — no global state, no React context, no router coupling (proven standalone by the tarball consumer gate `packages/pack_check.sh`).

## `<SettingsPanel/>`

An OrcaSlicer-style settings form generated from `three-slicer/data` (schema + UI tree + toggle rules): tab/page/group navigation, mode filter (all/simple/advanced/expert/develop), search across 976 options, dirty markers with per-option reset, and enable/disable rules evaluation.

The tab set follows the printer profile's technology: a settings map whose `printer_technology` says SLA swaps the FFF tabs for the SLA ones (print/material/printer builders carry the technology in their upstream builder name, which is what the filter reads). No prop needed — change the profile in the shared settings map and the panel follows.

```bash
npm i three-slicer react react-dom     # react is an OPTIONAL peer — npm does not install it for you
```

```jsx
import { useState } from 'react'
import SettingsPanel from 'three-slicer/components'

function App() {
  const [settings, setSettings] = useState({})   // sparse map: edited keys only; missing = schema default
  return <SettingsPanel settings={settings} setSettings={setSettings} />
}
```

Props:

| Prop | Type | Description |
|---|---|---|
| `settings` | `{ [schemaKey]: value }` | Sparse settings map — the consumer's state is the single source of truth |
| `setSettings` | `(updater) => void` | React setState-style updater; the only way state leaves the component |
| `onOptionOpen` | `(key) => void` (optional) | Label click hook for deep links/detail views. Omit → plain labels |
| `embedded` | `boolean` (optional) | Compact layout for embedding inside another panel |
| `customWidgets` | `{ [schemaKey]: Component }` (optional) | Replace schema-driven widgets per key (e.g. `{ printable_area: MyBedEditor }`) |
| `only` | `{ builder, page? }` (optional) | Pins the panel to one builder/page and drops the search/page/mode chrome — how `<Viewport/>`'s `motionPanel` slot is meant to be filled |

The same `settings` object feeds `deriveKernelParams()` in `three-slicer` and the `<Viewport/>` in `three-slicer/viewer` — one state connects all three.

Ships transpiled ESM (`dist/`); react is an optional peer dependency. The panel arrives fully styled: its stylesheet is inlined into the bundle and injected into a Shadow DOM root, so host CSS neither styles it nor collides with it.

The 3D viewport lives in its own package: `three-slicer/viewer`.

## License

AGPL-3.0-or-later (derived from OrcaSlicer).
