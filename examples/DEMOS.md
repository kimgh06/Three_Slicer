# three-slicer example demo specs

This directory defines six ways to integrate `three-slicer` into a real product. Each demo is an
independent project deployed to a different site than this repository and installs the package from npm
(§2). Five of the six are implemented; the remaining one (marketplace) is still an **implementation
spec**.

The five implemented demos: [`instant-quote/`](./instant-quote/),
[`printer-showcase/`](./printer-showcase/), [`cad-embed/`](./cad-embed/),
[`farm-dashboard/`](./farm-dashboard/), [`octoprint/`](./octoprint/) — each `npm i && npm run dev`.
All five deploy as static hosting (no backend). The remaining one (marketplace) can only start once the
package publishes a project-codec export.

## Demo catalog

| Demo | Representative use case | Core package surface | Status | Detailed spec |
| --- | --- | --- | --- | --- |
| Instant Quote | automatic print-service quoting | `client`, `settings`, `viewer/loaders`, `viewer/toolpath` | **implemented** | [spec](./instant-quote.md) · [app](./instant-quote/) |
| Printer Showcase | manufacturer page embed | `viewer`, `settings` | **implemented** | [spec](./printer-showcase.md) · [app](./printer-showcase/) |
| CAD Embed | printability feedback while designing | `client`, `settings`, `toggle`, `viewer/toolpath` | **implemented** | [spec](./cad-embed.md) · [app](./cad-embed/) |
| Marketplace | 3MF project preservation and retargeting | project codec, `viewer`, `settings` | needs prerequisite API work | [marketplace.md](./marketplace.md) |
| Farm Dashboard | distributed browser slicing | `client`, `settings`, `viewer/gcode`, `viewer/toolpath`, `viewer/loaders` | **implemented** | [spec](./farm-dashboard.md) · [app](./farm-dashboard/) |
| Send to OctoPrint | upload G-code to a printer server | `viewer` (`onExport`), `components` | **implemented** | [README](./octoprint/README.md) · [app](./octoprint/) |

Each demo answers exactly one question.

- A print service: "can I take just the quote computation?"
- A printer manufacturer: "can I put a slicer inside our product page?"
- A CAD developer: "can I wire design changes straight to print time and material use?"
- A marketplace developer: "can I preserve the whole 3MF project, not just the mesh?"
- A print-farm developer: "can I prepare jobs for several printers without a slicing server?"
- An OctoPrint user: "can a sliced plate go straight to my printer instead of Downloads?"

## 1. Shared implementation principles

- Slicing runs in the browser's WASM worker. No demo has a backend.
- The original model is never sent to a server unless the demo explicitly says so.
- Every import uses `three-slicer`'s public exports. `../../packages/*` and `../../slicers/*` are
  forbidden.
- `slicers/` is a reference checkout — never modified, never a runtime dependency.
- Features that are not the demo's point — payment, accounts, real printer protocols — are mocked, and the
  UI says so.
- A first-time visitor must be able to see the core behaviour with a sample model within 30 seconds.
- When a package-private API is needed, improve the package's exports and types first — no copying, no
  workarounds.

## 2. Independent projects and installation

The demos deploy to **websites other than this repository.** Each demo is therefore an **independent
project installing the package from npm**, not a workspace bound into the monorepo. The source lives under
this repository's `examples/`, but is **not added** to the root `package.json` `workspaces` (currently
`packages`, `web/viewer`) — the moment it is, npm links the local source and what the demo verifies stops
being "the published package".

```text
examples/
├── DEMOS.md              # this document
├── fixtures/
├── instant-quote/        # each an independent project (own node_modules, own deployment)
├── printer-showcase/
├── cad-embed/
└── farm-dashboard/        # marketplace is spec-only (marketplace.md)
```

### Installation

The package comes from npm. `three-slicer` has no runtime dependencies; all it needs are the declared
peers `react >=18`, `react-dom >=18`, `three ^0.160.0`. Which peers are needed depends on the surface a
demo uses.

```bash
# demos using viewer/components (printer-showcase, marketplace, cad-embed)
npm i three-slicer three react react-dom

# demos not using the viewer — but three-slicer/viewer/loaders imports three
npm i three-slicer three          # instant-quote, farm-dashboard

# client + settings alone stand without any peer
npm i three-slicer
```

`package.json` carries a published version range. `workspace:*` and `file:../../packages` are forbidden —
they die the moment the demo lands on another site.

```json
{
  "private": true,
  "dependencies": {
    "three-slicer": "^0.2.4"
  }
}
```

Using the npm install also means the demo **verifies the published tarball**: if a new artifact goes
missing from `packages/package.json`'s `files`, the demo breaks first.

A demo that needs an unpublished API (marketplace's project codec) only stands from the **next** version
that publishes the export — one more reason the export work is a prerequisite in §10. To check ahead of a
release, install a tarball made with `npm pack` (`npm i ../../packages/three-slicer-0.2.5.tgz`).

Consumers use only the same paths the published package exposes.

```js
import { createSlicerClient } from 'three-slicer/client'
import { deriveKernelParams } from 'three-slicer/settings'
import Viewport from 'three-slicer/viewer'
```

### 2.1 Code structured by unit of copying

The unit of structure is not "the demo" but **"the copy"**. Cut everything to three sizes: a folder that
gets degit-ed whole, a file that gets copied whole into an adopter's app, and a code block that gets quoted
whole in a README. Separate, along file boundaries, the integration code an adopter takes from the code
that exists only because this is a demo.

```text
instant-quote/            # example — file names follow each demo's own concepts
├── package.json          # the published version range above
├── index.html
├── vite.config.js        # the COOP/COEP option explained in a comment
└── src/
    ├── quote.js          # ★ the integration file — all the code an adopter copies
    ├── stl_serialize.js  # a standalone utility — also copyable alone
    ├── App.jsx           # demo chrome — drop zone, selects, cards, as plain as possible
    └── mock/
        └── pricing.js    # the path itself says this is the thing to replace
```

- **The dependency direction is the boundary.** The integration file imports only `three-slicer/*` and the
  standard library; the demo chrome (App) imports the integration file. The import statements alone must
  say where the package integration ends.
- **Keep the integration file quotable in full in the README (±100 lines).** An adopter judges the cost of
  integrating from that one code block.
- **A demo folder is fully self-sufficient.** No shared root vite config, no path aliases, no common
  demo-utils package. Small utilities like the filament mm→g conversion are written per demo — the moment
  they are shared, no demo can be copied alone and no StackBlitz/CodeSandbox link can exist.
- **Do not wrap the package API.** Hiding `createSlicerClient()` behind a hook or a service layer hides
  the thing being sold. Keep the call sites raw and comment around them. No state libraries, CSS
  frameworks or custom hook systems in the demo chrome — the goal is code where only the package calls
  stand out.
- **File names match the demo document's concepts 1:1** (`compatibility.js`, `submit_job.js`). The
  "Powered by" surface note at the bottom of the screen links to that file.
- **Respect the complexity ladder.** instant-quote stays under 300 lines total to make the "integration is
  this cheap" first impression; marketplace is the top of the ladder. §10's implementation order is the
  entry order.

## 3. Shared fixtures

Redistributable, self-made models live in `examples/fixtures/`.

| File | Purpose | Suggested cap |
| --- | --- | --- |
| `calibration-cube.stl` | first load and quick smoke tests | 100 KB |
| `benchy-small.stl` | general slicing and quoting | 5 MB |
| `multi-object.3mf` | object transforms and merging | 10 MB |
| `multi-color.3mf` | material assignment and painting | 10 MB |
| `multi-plate.3mf` | plate layout and project round-trip | 15 MB |

Record each fixture's provenance, license and creation method in `examples/fixtures/README.md`. No storing
external marketplace models without permission.

## 4. The shared state and error contract

An app that slices has at least these states.

```ts
type SliceState =
  | { status: 'idle' }
  | { status: 'loading-model' }
  | { status: 'ready' }
  | { status: 'slicing'; progress: number }
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }
```

Account for `onProgress(done, total)`'s `total` possibly being 0, and never fabricate progress without a
real callback. Handle `result.error` separately from a successful result.

The shared errors and the user's next action:

| Error | User message / action |
| --- | --- |
| unsupported extension | show the supported formats and a re-pick button |
| corrupted STL/3MF | say the file could not be read, offer a replace button |
| build volume exceeded | show the exceeded axis and size, offer a printer change |
| missing profile | prompt re-picking printer/process/material |
| worker init / slice failure | offer retry or a model change |
| out of memory | suggest a smaller model; never silently lower quality |
| user cancel | switch to `cancelled` and allow slicing again |

Stack traces and raw exceptions go to the developer console only.

## 4.5 Coordinates handed to the kernel — plate-local

**Hand the model over centered on the origin (0, 0). Never pre-move it to the bed center.** The kernel
takes plate-local coordinates and seats the model on the bed itself, so pre-centering on the bed **adds
the offset twice**.

Measured (250 × 210 bed, 20mm cube, `Prusa MK4 0.4 nozzle`):

| Input | Resulting G-code X range | `stats.over_bed_model` |
| --- | --- | --- |
| moved to the bed center (125, 105) | 234.7 – 265.4 | **true** (off the bed) |
| origin-centered (0, 0) | 109.7 – 140.3 | false |

This is the silently-wrong kind of mistake. Time and material come out plausible (a 2% difference), no
error is raised, and nothing shows until the toolpath is actually **drawn** — in farm-dashboard it was
discovered only when the part appeared as a dot in a screen corner. So always check after a slice.

```js
if (result.stats.over_bed_model) throw new Error('slices outside the printable area')
```

All four demos ended up writing that same line, which is why 0.2.3 names it on the result itself. The flag
stays where it is; `warnings` is the version that does not require knowing it exists.

```js
if (result.warnings.length) throw new Error(result.warnings.join(', '))   // 0.2.3+
```

The bed size is still needed — as the up-front filter for whether the model fits the machine at all (§4's
build-volume-exceeded error).

## 4.6 The two ways to draw the sliced paths

`three-slicer/viewer/toolpath` is a **geometry builder**, not a UI component (the scene and camera are the
host's). What information is recoverable depends on where the input layers come from.

| Input | Where it comes from | Role information |
| --- | --- | --- |
| the kernel's layer stream | `client.slice()`'s `result.layers` (comes along when no onLayer callback is given) | **exact** |
| G-code re-parsing | `parseGcode(text).layers` | **approximate** — collapses into wall |

The reason: **this kernel's G-code output carries no `;TYPE:` / `;FEATURE:` comments.** `parseGcode`, as
documented, drops unknown roles to wall (1). The same 20mm cube measured:

```
from the kernel layers : Sparse 43% · Wall 38% · Solid 16% · Skirt 3%
from the G-code round-trip : Wall 94% · Skirt 6%
```

The geometry (layer count, segment positions, widths) is exact on both paths — only the roles are lost. So
where the slicing side can draw directly, use `result.layers`; where only G-code is at hand
(farm-dashboard), the screen states that the colors are approximate.

## 4.7 The st / mt kernels do not state the same time

The browser worker picks the multithreaded kernel when the page is cross-origin isolated and the
single-threaded one otherwise. **That choice changes `time_estimate`.** The same build, the same 20mm
cube:

| Page | Worker log | time_estimate | filament | layers / segments |
| --- | --- | --- | --- | --- |
| no headers (static hosting) | `core: st` | **12m** | 4.1 g (1.29 m) | 99 / 8,095 |
| COOP/COEP (web/viewer's `/demos`) | `core: mt (threads)` | **15m** | 4.1 g (1.29 m) | 99 / 8,095 |

Geometry and material identical, time 25% apart. A demo that puts a quote or a price on that value
(instant-quote) therefore prices differently per deployment headers — pick the reference kernel and pin
the headers.

## 5. The worker usage contract

**These demos create the worker themselves. Since 0.2.3 — the demos now pin ^0.2.4 — that is no longer
necessary** — `createSlicerClient()` with no argument builds its worker through the literal
`new Worker(new URL('./slicer.worker.js', import.meta.url), { type: 'module' })` that Vite and webpack
recognize as a worker entry, so it reaches dist with its kernel chunks.

Before that, the default went through `engineWorkerURL()`, and a function call does not match the pattern:
Vite treated the file **as an asset reference and copied it verbatim**. The copy still imported an unhashed
`./slicer_core.js`, so the production build 404'd, while the dev server served the sources and passed —
**a trap that only showed after `vite build`** (measured in instant-quote: dev fine, build fails the
worker's `/assets/slicer_core.js` fetch). The workaround, still correct and still needed on ≤0.2.2:

```js
import SlicerWorker from 'three-slicer/worker?worker'   // Vite
const client = createSlicerClient(new SlicerWorker())
```

How the worker is created is the bundler's concern, so the integration file **takes a worker factory as an
argument** and stays bundler-neutral (the same reason as §2.1's "the integration file imports only
`three-slicer/*`").

**The multithreaded kernel lands in dist twice** (+4.3 MB, confirmed in all four demos including
printer-showcase, which uses only `three-slicer/viewer`). This was originally attributed to the asset copy
above; it is not. It is emscripten's own pthread bootstrap: `allocateUnusedWorker()` inside the mt glue
creates its thread workers from the glue's own module URL, which the bundler emits a second time as a worker
entry. At runtime only one copy is fetched per context, so it is a deployment-size issue rather than user
bandwidth (19 MB per demo), and removing it means changing the emscripten build, not the JS surface.

The minimal browser slicing flow:

```js
import { createSlicerClient } from 'three-slicer/client'
import { deriveKernelParams } from 'three-slicer/settings'

let client = createSlicerClient()

async function slice(stlBytes, settings, onProgress) {
  const input = stlBytes.slice(0) // the ArrayBuffer detaches after worker transfer — clone inputs you reuse
  const result = await client.slice(input, deriveKernelParams(settings), { onProgress })
  if (result.error) throw new Error(result.error)
  return result
}

function cancelSlice() {
  if (client.cancel()) return
  client.terminate()
  client = createSlicerClient()
}
```

`cancel()` works only on the multithreaded kernel, where a SharedArrayBuffer is available. On static
hosting without COOP/COEP it returns `false`, so terminate the worker and recreate it.

## 6. The settings and preset application contract

The settings map is sparse. When swapping a profile, clear each catalog's `keys` first so no value the new
profile does not set survives from the old one.

```js
import {
  printerKeys,
  printerSettings,
  processPresets,
  filamentPresets,
} from 'three-slicer/settings'

const without = (source, keys) => {
  const next = { ...source }
  for (const key of keys) delete next[key]
  return next
}

const processApi = await processPresets()
const filamentApi = await filamentPresets()

settings = {
  ...without(settings, printerKeys),
  ...printerSettings(printerName),
}
settings = {
  ...without(settings, processApi.keys),
  ...processApi.settingsFor(processName),
}
settings = {
  ...without(settings, filamentApi.keys),
  ...filamentApi.settingsFor(filamentName),
}
```

`printerSettings()` and `settingsFor()` return `null` for an unknown name, so check in the UI first. Do
not fill empty values with schema defaults before handing to the kernel — `deriveKernelParams()` owns the
omission rules.

## 7. Measurement and the privacy proof

In development mode, at least these numbers must be visible.

```text
Model parse      120 ms
Kernel warmup    480 ms
Slicing         3.82 s
Total           4.42 s
```

The numbers come from `performance.now()` interval measurement and the real worker callbacks. A demo that
claims the model never goes to a server verifies zero model uploads during a slice, via a Playwright
request listener or the browser Network tab.

## 8. Accessibility and responsiveness bar

- The file drop zone offers a button/label that opens by keyboard too.
- Progress is conveyed by a progressbar with `aria-valuenow`, or by status text.
- Errors use `role="alert"`; completion is announced by an appropriate live region.
- Meaning is never carried by the canvas alone — the key statistics and states appear as text too.
- The core task must be completable at 360px width without horizontal scrolling.
- Decorative animation is reduced under `prefers-reduced-motion`.

## 9. The per-demo README format

The odds of being looked at are set by the README and the live link; the odds of adoption are set by the
copyable integration file. After implementation, the README shows the integration file's code block (in
full or as its core excerpt) **right after the title, before any description** — an adopter judges the
integration cost from that one block.

Once implementation starts, each document keeps this order.

1. The integration code block (quoting the integration file)
2. What this demonstrates
3. Current status / Try it — live URL, GIF or screenshot, the "file to copy" link
4. Package APIs used
5. Architecture
6. Run locally
7. Important files
8. The state/error contract
9. What is intentionally mocked
10. Verification and definition of done
11. Production considerations

`Run locally` and `Important files` never guess commands or paths before the real app exists.

The root README carries a demo gallery: one GIF per demo + live link + the file-to-copy link, within 3
lines each. The representative GIF is made from printer-showcase (listed in §10 order). No separate
gallery app.

## 10. Implementation order

1. `instant-quote`: verifies the minimal integration of loader, settings, worker, statistics.
2. `printer-showcase`: verifies the viewer/component embed and Shadow DOM isolation.
3. `cad-embed`: verifies host-controlled geometry and the automatic re-slice API.
4. `marketplace`: adds the project codec's public export, then verifies the 3MF semantic round-trip.
5. `farm-dashboard`: puts the queue and mock printers on top of the browser-slicing flow above.

## 11. Definition of Done

A demo is complete only when all of the below hold.

- `npm run dev`, `npm run build`, `npm test` succeed in the independent project.
- The demo folder, copied outside the repository, works on `npm i && npm run dev` alone — the criterion is
  that it runs on **`three-slicer` installed from npm**, not the repository's local source
  (`node_modules/three-slicer` must not be a symlink).
- It works from public `three-slicer/*` exports alone, referencing no local build output.
- The deployed URL stays alive without the repository (static hosting; farm-dashboard exempt).
- The integration file is quoted in the README, and its imports are only `three-slicer/*` and the standard
  library.
- A license-recorded sample fixture exists and loads straight from the first screen.
- loading, slicing, completed, cancelled and error are wired to real behaviour.
- The 360px viewport and the keyboard-only core flow are verified.
- The architecture, the real APIs, the mock boundary and the production differences are documented.
- At least the happy-path E2E and one demo-specific failure path exist.
- A manual QA record exists of loading the sample like a real user through to the result screen.
- No demo advertises another demo's representative feature.

## 12. Scope boundaries

| Demo | Proves at its core | Deliberately excluded |
| --- | --- | --- |
| instant-quote | headless WASM slicing and statistics | a 3D editor, payment |
| printer-showcase | a visual embed inside an existing page | printer management |
| cad-embed | the programmable feedback loop | a CAD kernel, the 3MF marketplace |
| marketplace | 3MF project preservation and printer retargeting | search/review/account CRUD |
| farm-dashboard | the client-compute queue architecture | real printer protocols |
