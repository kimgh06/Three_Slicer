#!/usr/bin/env bash
# Standalone tarball verification: npm pack three-slicer, then scaffold consumers in a temp directory outside the repo
# to confirm the tarball alone builds and runs. This script must live inside packages/ —
# a standalone-verification tool sitting outside packages/ would not itself be standalone.
#
# Cases: (1) Node consumer (no peers) (2) type check with tsc --noEmit (3) Vite (4) Next
# (runtime E2E slicing is separate — this is a build/resolution gate only, no browser needed)
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"
MIT="$(cd "$PKG/../viewer-package" && pwd)"
TMP="$(mktemp -d /tmp/three-slicer-packcheck.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
echo "== pack -> $TMP"
mkdir -p "$TMP/tarballs"
# BOTH packages, and installed together below. three-slicer depends on three-slicer-viewer at an exact
#  pin, so packing only three-slicer would send npm to the REGISTRY for its other half — which either fails
#  (the version is not published yet) or, worse, succeeds against an older build and passes a check that was
#  supposed to be about these two tarballs.
npm pack "$MIT" --pack-destination "$TMP/tarballs" >/dev/null
npm pack "$PKG" --pack-destination "$TMP/tarballs" >/dev/null
T=("$TMP"/tarballs/*.tgz)

echo "== no dot-paths in either tarball"
# Tooling drops state directories (.omc/, ...) inside the published folders, and `files` only keeps them out when
#  every folder remembers its own negation — `types` did not, and three-slicer 0.3.0 shipped one.
#  Neither package publishes a dotfile on purpose, so any path component starting with a dot is a leak.
for tgz in "${T[@]}"; do
  if leaked="$(tar -tzf "$tgz" | grep '/\.')"; then
    echo "FAIL: $(basename "$tgz") contains dot-paths:"; echo "$leaked"; exit 1
  fi
done

echo "== permissive consumer (three-slicer-viewer alone)"
# The whole point of the split: this package installs and works with NO AGPL anywhere in the tree. If that
#  ever stops holding, the MIT grant on it is one nobody had the right to give.
MIT_TGZ=("$TMP"/tarballs/three-slicer-viewer-*.tgz)
mkdir -p "$TMP/permissive" && cd "$TMP/permissive"
cat > package.json <<'EOF'
{ "name": "packcheck-permissive", "private": true, "type": "module" }
EOF
npm i --no-audit --no-fund "${MIT_TGZ[@]}" >/dev/null
cat > run.mjs <<'EOF'
import { parseGcode } from 'three-slicer-viewer/gcode'
// The toolpath SUBPATH, not the main entry: '.' is the whole viewer and imports react, which a headless
//  consumer does not have (react is an optional peer). The rendering-only surface must stay react-free.
import { buildSegmentData, roleRatios, computeColors, TYPE_LABEL } from 'three-slicer-viewer/toolpath'
const gcode = [';LAYER_CHANGE', ';Z:0.2', ';TYPE:Outer wall', ';WIDTH:0.42',
  'G1 X0 Y0 Z0.2 E0', 'G1 X10 Y0 E0.5', 'G1 X10 Y10 E1.0'].join('\n')
const { layers, stats } = parseGcode(gcode)
if (!layers.length) throw new Error('parsed no layers')
const data = buildSegmentData(layers, 0.4)
if (data.nSeg < 2) throw new Error('built no segments: ' + data.nSeg)
if (!roleRatios(data.typeLengths).length) throw new Error('no role ratios')
const colours = computeColors(data, 'speed', { speedByType: { 1: 60 }, firstLayerSpeed: 20 })
if (colours.color.length !== data.nV * 4) throw new Error('colour buffer is the wrong size')
if (!TYPE_LABEL[1]) throw new Error('no labels')
console.log(`   permissive alone: ${stats.layers} layer(s), ${data.nSeg} segments, ${colours.viewType} coloured`)
EOF
node run.mjs
# No AGPL in the tree, and no renderer either — three is an OPTIONAL peer and this consumer never asked for one.
for forbidden in three-slicer three react react-dom; do
  if [ -d "node_modules/$forbidden" ]; then echo "FAIL: $forbidden was installed for a permissive-only consumer"; exit 1; fi
done
echo "   dependency tree is clean: no three-slicer, no renderer"

echo "== node consumer (no peers)"
# Engine/settings/toggle must run under Node without react or three. Guards against JSON import attribute regressions.
mkdir -p "$TMP/node" && cd "$TMP/node"
cat > package.json <<'EOF'
{ "name": "packcheck-node", "private": true, "type": "module" }
EOF
npm i --no-audit --no-fund "${T[@]}" >/dev/null
cat > run.mjs <<'EOF'
import { createSlicer, engineWorkerURL } from 'three-slicer'
import { deriveKernelParams, schemaDefault, printerSettings, printersByVendor, processPresets, filamentPresets } from 'three-slicer/settings'
import { makeCfg, disabledKeys } from 'three-slicer/toggle'
import { schema, uiTree, toggleRules, invalidationMap } from 'three-slicer/data'
import rawSchema from 'three-slicer/data/config-schema.json' with { type: 'json' }
if (Object.keys(rawSchema).length !== Object.keys(schema).length) throw new Error('raw JSON path mismatch')
for (const [n, v] of [['uiTree', uiTree], ['toggleRules', toggleRules], ['invalidationMap', invalidationMap]])
  if (!Object.keys(v).length) throw new Error(n + ' is empty')
if (typeof createSlicer !== 'function') throw new Error('createSlicer missing')
if (!engineWorkerURL().href.endsWith('slicer.worker.js')) throw new Error('bad worker URL')
if (schemaDefault('layer_height') == null) throw new Error('schemaDefault failed')
if (!Object.keys(schema).length) throw new Error('schema is empty')
const p = deriveKernelParams({ layer_height: 0.15 })
if (p.layer_height !== 0.15) throw new Error('deriveKernelParams failed: ' + p.layer_height)
if (typeof disabledKeys(makeCfg({})) !== 'object') throw new Error('disabledKeys failed')
// Printer profiles ship as data/printers.json, print presets as the lazily imported data/processes.js —
//  both are easy to leave out of package.json "files", which only shows up at install time.
const anyPrinter = Object.values(printersByVendor).flatMap(m => Object.keys(m))[0]
if (!anyPrinter) throw new Error('printersByVendor is empty')
if (!printerSettings(anyPrinter)) throw new Error('printerSettings failed for ' + anyPrinter)
const proc = await processPresets()
if (!proc.keys.length) throw new Error('processPresets carries no keys')
const fil = await filamentPresets()
if (!fil.keys.length) throw new Error('filamentPresets carries no keys')
// The recommendation list is declared on the machine model and so is nozzle-agnostic — filamentPresets narrows
//  it to the compatible set. A regression here would offer a material upstream marks incompatible.
const withMaterials = Object.values(printersByVendor).flatMap(m => Object.keys(m)).find(n => fil.listFor(n).length)
if (!withMaterials) throw new Error('no printer has a compatible material list')
const compatible = new Set(fil.listFor(withMaterials).map(f => f.name))
if (fil.recommendedFor(withMaterials).some(f => !compatible.has(f.name)))
  throw new Error('recommendedFor is not a subset of listFor for ' + withMaterials)
console.log('  node OK —', Object.keys(schema).length, 'keys,',
  Object.values(printersByVendor).reduce((n, m) => n + Object.keys(m).length, 0), 'printers loaded')
EOF
node run.mjs
# The peers are declared optional, so npm must NOT pull them in for a headless consumer — and run.mjs above
#  having just sliced proves the engine half needs neither. The previous assertion here was the opposite (that npm
#  auto-installed them), which is what a non-optional peer does: it made every Node consumer of the engine download
#  react, react-dom and three to import a function that returns G-code.
for peer in three react react-dom; do
  if [ -d "node_modules/$peer" ]; then echo "FAIL: $peer was installed for a headless consumer"; exit 1; fi
done
echo "OK: node consumption with no react/three installed"

echo "== types (tsc --noEmit)"
mkdir -p "$TMP/ts/src" && cd "$TMP/ts"
cat > package.json <<'EOF'
{ "name": "packcheck-ts", "private": true, "type": "module" }
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "es2022", "module": "esnext", "moduleResolution": "bundler",
    "jsx": "react-jsx", "strict": true, "noEmit": true,
    "resolveJsonModule": false, "skipLibCheck": false
  },
  "include": ["src"]
}
EOF
cat > src/check.ts <<'EOF'
import { createSlicer, type SlicerSettings } from 'three-slicer'
import { deriveKernelParams, settingScalar, filamentPresets, type FilamentPreset } from 'three-slicer/settings'
import { makeCfg, disabledKeys } from 'three-slicer/toggle'
import { buildSegmentData, computeColors, VIEW_TYPES } from 'three-slicer/viewer/toolpath'
import { loadModel, SUPPORTED_EXT, splitConnectedComponents } from 'three-slicer/viewer/loaders'
import { schema, uiTree } from 'three-slicer/data'
import rawSchema from 'three-slicer/data/config-schema.json'
// Everything below this line is here because it is USED IN THE DOCUMENTATION. A README that shows an API the
//  declarations do not carry compiles for nobody, and that is exactly how `only` (documented in viewer.d.ts as the
//  way to build the motion panel) and the five printer helpers reached a release undeclared: the type gate never
//  imported them. Adding a documented example here is cheaper than discovering it from a consumer's bug report.
import type { SettingsPanelProps } from 'three-slicer/components'
import {
  printerSettings, printersByVendor, printerKeys, printerDefaultPreset, machineLimitKeys,
  normalizeProjectSettings, serializeProjectSettings, processPresets,
  writePresetFile, readPresetFile, presetFileText, presetOptionKeys,
  type PresetType, type ReadPresetResult,
} from 'three-slicer/settings'
import { presetKeys } from 'three-slicer/data'
import { createSlicerClient, type SlicerClient } from 'three-slicer/client'
import type { SlicerRequest, SlicerResponse } from 'three-slicer/worker'

// Do the generated key types actually narrow
const s: SlicerSettings = { layer_height: 0.2, sparse_infill_pattern: 'gyroid', spiral_mode: false }
// @ts-expect-error — an unknown enum value must be rejected
const bad: SlicerSettings = { sparse_infill_pattern: 'not-a-pattern' }
// @ts-expect-error — a type mismatch must be rejected
const bad2: SlicerSettings = { layer_height: 'thick' }

export async function main(buf: ArrayBuffer) {
  const slicer = await createSlicer()
  const r = slicer.slice(buf, deriveKernelParams(s))
  const n: number = r.stats.layers
  settingScalar(s, 'layer_height')
  const dis: Record<string, string> = disabledKeys(makeCfg(s))
  const objs = await loadModel('a.stl', buf)
  const name: string = objs[0].name
  splitConnectedComponents(objs[0].modelPos)?.length
  const data = buildSegmentData([], 0.42)
  const c = computeColors(data, VIEW_TYPES[0].key, { firstLayerSpeed: 20 })
  const pages = uiTree[Object.keys(uiTree)[0]][0].groups[0].options.length
  const materials: FilamentPreset[] = (await filamentPresets()).listFor('Bambu Lab X1 Carbon 0.4 nozzle')
  const material: string = materials[0].type

  // --- the documented examples, type-checked ---------------------------------
  // The motion-limits panel exactly as types/viewer.d.ts tells a host to build it.
  const motionPanel: SettingsPanelProps = {
    settings: s, setSettings: () => {}, embedded: true,
    only: { builder: 'TabPrinter::build_kinematics_page' },
  }
  // Picking a printer, then applying a preset the way the README says to: clear the keys the previous one set
  //  before merging the next, or the old preset's leftovers survive the switch.
  const profile: string = Object.keys(Object.values(printersByVendor)[0])[0]
  const machine: SlicerSettings | null = printerSettings(profile)
  const recommended: string = printerDefaultPreset(profile)
  const processes = await processPresets()
  const applyPreset = (base: SlicerSettings, preset: SlicerSettings | null, keys: string[]): SlicerSettings => {
    const next: SlicerSettings = { ...base }
    for (const key of keys) delete next[key as keyof SlicerSettings]
    return Object.assign(next, preset)
  }
  const withPreset = applyPreset(applyPreset(s, machine, printerKeys),
                                 processes.settingsFor(recommended), processes.keys)
  // A 3mf project's all-strings config, in and back out again.
  const project = normalizeProjectSettings({ layer_height: '0.2', spiral_mode: '0', printable_area: '0x0' })
  const roundTrip: Record<string, string | string[]> = serializeProjectSettings(project.settings)

  // The worker client, as the README shows it. A slice request is the one message with no `cmd` and a string
  //  `params`; the union has to keep admitting exactly that.
  const client: SlicerClient = createSlicerClient(undefined as unknown as Worker)
  const sliceRequest: SlicerRequest = { stl: buf, params: JSON.stringify(deriveKernelParams(s)) }
  const paintRequest: SlicerRequest = { cmd: 'paint', facet: 0, hx: 0, hy: 0, hz: 0, cx: 0, cy: 0, cz: 1, radius: 2, state: 3 }
  const doneReply: SlicerResponse = { type: 'done', result: { stats: { layers: 1 } as never } }
  const canCancel: boolean = client.cancel()

  // Preset files, as the README shows them: write a machine preset, read it back, follow `inherits` through the
  //  shipped catalog. The 4 exports and `presetKeys` reached a release undeclared once already because nothing
  //  here imported them.
  const machineType: PresetType = 'machine'
  const keys: string[] = presetOptionKeys(machineType)
  const preset: Record<string, unknown> = writePresetFile(machine, { type: machineType, name: 'My printer' })
  const text: string = presetFileText(machine, { type: machineType, name: 'My printer', complete: false })
  const loaded: ReadPresetResult = readPresetFile(preset, { resolveParent: (name) => printerSettings(name) })
  const parentMissing: string | null = loaded.missingParent
  const keyLists: number = presetKeys.printer.length + presetKeys.process.length + presetKeys.filament.length

  return { n, dis, name, ext: SUPPORTED_EXT[0], cont: c.cont, pages, keys: Object.keys(schema).length,
           raw: Object.keys(rawSchema).length, material, motionPanel, withPreset,
           applied: project.applied, roundTrip, limits: machineLimitKeys.length,
           sliceRequest, paintRequest, doneReply, canCancel,
           presetOptions: keys.length, presetName: preset.name, presetText: text.length, parentMissing, keyLists }
}
EOF
npm i --no-audit --no-fund "${T[@]}" >/dev/null
npm i --no-audit --no-fund -D typescript@5 @types/react@18 >/dev/null
npx tsc --noEmit -p tsconfig.json
echo "OK: types (strict, including 2 @ts-expect-error cases)"

echo "== vite consumer"
mkdir -p "$TMP/vite/src" && cd "$TMP/vite"
cat > package.json <<'EOF'
{ "name": "packcheck-vite", "private": true, "type": "module", "scripts": { "build": "vite build" } }
EOF
cat > vite.config.js <<'EOF'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// The 2 Vite requirements from the README: dynamic st/mt worker selection (es worker) + top-level await in the mt glue (es2022)
export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
})
EOF
cat > index.html <<'EOF'
<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>
EOF
cat > src/main.jsx <<'EOF'
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import Viewport from 'three-slicer/viewer'
import SettingsPanel from 'three-slicer/components'
// The no-argument client, which is the path a first-time consumer takes: it must reach dist as a real worker
//  chunk whose kernel imports were emitted too (see the dist integrity check below).
import { createSlicerClient } from 'three-slicer/client'
function App() {
  const [settings, setSettings] = useState({})
  return (<><button onClick={() => createSlicerClient().warmup()}>warm</button>
    <Viewport settings={settings} setSettings={setSettings} />
    <SettingsPanel settings={settings} setSettings={setSettings} /></>)
}
createRoot(document.getElementById('root')).render(<App />)
EOF
npm i --no-audit --no-fund react@18 react-dom@18 three@0.160.1 "${T[@]}" >/dev/null
npm i --no-audit --no-fund -D vite@5 @vitejs/plugin-react@4 >/dev/null
npm run build >/dev/null
ls dist/assets/ | grep -q "slicer.worker" || { echo "FAIL: no worker chunk in the vite consumer's dist"; exit 1; }
# The worker chunk EXISTING is not the same as the worker WORKING, and that gap shipped once: with the URL split
#  across a function call, Vite matched its plain-asset rule and copied slicer.worker.js in verbatim — a hashed
#  filename holding the untouched source, still importing `./slicer_core.js`, `./slicer_core.mt.js` and
#  `./sla_request.js` while dist contained none of them. Measured: a 21KB copy in a 40KB dist, i.e. no kernel at
#  all, and it 404s on the first message. The dev server serves the sources, so this is invisible until `vite build`.
#  So: every relative import the worker chunk makes must name a file that was actually emitted.
node - <<'EOF'
const { readdirSync, readFileSync } = require('node:fs')
const assets = readdirSync('dist/assets')
const workers = assets.filter(f => /slicer\.worker.*\.js$/.test(f))
if (!workers.length) { console.log('FAIL: no worker chunk'); process.exit(1) }
let missing = []
for (const w of workers) {
  const source = readFileSync(`dist/assets/${w}`, 'utf8')
  for (const [, spec] of source.matchAll(/(?:from\s*|import\(\s*)["'](\.\/[^"']+)["']/g)) {
    const name = spec.replace(/^\.\//, '')
    if (!assets.includes(name)) missing.push(`${w} -> ${spec}`)
  }
}
if (missing.length) { console.log('FAIL: the worker chunk imports files dist does not contain:\n  ' + missing.join('\n  ')); process.exit(1) }
console.log(`  worker chunk ${workers[0]} resolves every import it makes`)
EOF
echo "OK: vite build + worker chunk"

echo "== next consumer"
mkdir -p "$TMP/next/pages" && cd "$TMP/next"
cat > package.json <<'EOF'
{ "name": "packcheck-next", "private": true, "scripts": { "build": "next build" } }
EOF
cat > next.config.js <<'EOF'
/** The Next recipe from the README: map the emscripten glue's Node guard paths (node:*) to an empty module */
module.exports = { webpack: (config) => {
  for (const m of ['node:module','node:fs','node:path','node:url','node:crypto','node:worker_threads']) config.resolve.alias[m] = false
  return config
} }
EOF
cat > pages/_app.jsx <<'EOF'
export default function App({ Component, pageProps }) { return <Component {...pageProps} /> }
EOF
cat > pages/index.jsx <<'EOF'
import dynamic from 'next/dynamic'
import React, { useState } from 'react'
const Viewport = dynamic(() => import('three-slicer/viewer'), { ssr: false })
const SettingsPanel = dynamic(() => import('three-slicer/components'), { ssr: false })
export default function Home() {
  const [settings, setSettings] = useState({})
  return (<><Viewport settings={settings} setSettings={setSettings} />
    <SettingsPanel settings={settings} setSettings={setSettings} /></>)
}
EOF
npm i --no-audit --no-fund next@14 react@18 react-dom@18 three@0.160.1 "${T[@]}" >/dev/null
npx next build >/dev/null
echo "OK: next build"
echo "ALL PACK CHECKS PASSED"
