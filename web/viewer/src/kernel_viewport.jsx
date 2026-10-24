import Viewport, { useSlicer } from 'three-slicer-viewer'   // the viewer and the slicing hook (MIT)
import { makeSlicerWorker } from 'three-slicer/client'       // the WASM kernel's worker (AGPL)
import { bundledCatalog } from 'three-slicer/settings'       // OrcaSlicer's vendor presets (AGPL)

// The permissive viewer with the kernel and the vendor presets plugged in — the one place the pages bind them,
//  so /slice, /test and the landing embed slice the same way. Kept apart from settings_panel.jsx so the
//  landing embed's lazy chunk does not carry the full schema.
// The slicing hook bound to the kernel worker. Module-level on purpose: it is called as a hook, so its identity
//  must not change between renders.
const slicer = (deps) => useSlicer({ ...deps, makeWorker: makeSlicerWorker })

export default function KernelViewport(props) {
  return <Viewport slicer={slicer} catalog={bundledCatalog} {...props} />
}
