import Viewport, { useSlicer } from 'three-slicer-viewer'   // the viewer and the slicing hook (MIT)
import { makeSlicerWorker } from 'three-slicer/client'       // the WASM kernel's worker (AGPL)
import { bundledCatalog } from 'three-slicer/settings'       // OrcaSlicer's vendor presets (AGPL)

// The permissive viewer with the kernel and the vendor presets plugged in — the one place the pages bind them,
//  so /slice, /test and the landing embed slice the same way. Kept apart from settings_panel.jsx so the
//  landing embed's lazy chunk does not carry the full schema.
// The slicing hook bound to the kernel worker. Module-level on purpose: it is called as a hook, so its identity
//  must not change between renders.
const slicer = (deps) => useSlicer({ ...deps, makeWorker: makeSlicerWorker })

// One default font per script for the Text tool (Noto Sans CJK Regular, SIL OFL: fonts/OFL.txt). Each is its own
//  asset, fetched only when a text needs it.
const TEXT_FONTS = [
  { id: 'ko', label: '한국어', url: new URL('./fonts/NotoSansKR-Regular.otf', import.meta.url).href, covers: ['hangul'] },
  { id: 'ja', label: '日本語', url: new URL('./fonts/NotoSansJP-Regular.otf', import.meta.url).href, covers: ['kana'] },
  { id: 'zh-hans', label: '简体中文', url: new URL('./fonts/NotoSansSC-Regular.otf', import.meta.url).href },
  { id: 'zh-hant', label: '繁體中文', url: new URL('./fonts/NotoSansTC-Regular.otf', import.meta.url).href },
]

export default function KernelViewport(props) {
  return <Viewport slicer={slicer} catalog={bundledCatalog} textFonts={TEXT_FONTS} {...props} />
}
