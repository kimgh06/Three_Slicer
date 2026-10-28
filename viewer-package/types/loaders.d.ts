// three-slicer-viewer/loaders — pure loaders, independent of the kernel.

/** The 5 built-ins plus any extension registered via `registerLoader()`, which pushes onto this array. */
export const SUPPORTED_EXT: string[]

/** G-code extensions: print jobs, opened as a preview instead of a mesh. */
export const GCODE_EXTS: string[]

/** The resin archive extension (`sl1`). */
export const SL1_EXT: string

/** Every extension the viewport opens: `SUPPORTED_EXT`, `SL1_EXT` and `GCODE_EXTS`, read at call time. */
export function openableExtensions(): string[]

/** Lowercased extension. Empty string when there is no dot. */
export function fileExt(name: string): string

export interface LoadedObject {
  name: string
  /** Triangle vertex coordinates (N*9, model z-up) */
  modelPos: Float32Array
}

/** A single file may contain several objects (3mf/amf/step) -> always an array. */
/** Parses one model file. `source` may be the File (or Blob) itself; a 3mf is then read by its worker, not this thread. */
export function loadModel(name: string, source: ArrayBuffer | Blob): Promise<LoadedObject[]>

/** Starts the workers that will read a file of this name (a 3mf's parse worker and helpers) before it arrives. */
export function warmLoaderFor(name: string): void

/**
 * Uses `worker` (from three-slicer-viewer/workers makeParse3mfWorker) as the 3mf parse worker, so a host can start it
 *  before this module has loaded. Ignored, and the worker terminated, when one is already in use.
 */
export function adoptParseWorker(worker: Worker): void

/** Starts parsing `source` now; the viewport's own load of that same File then takes the result instead of parsing. */
export function preloadModel(name: string, source: ArrayBuffer | Blob): void

/**
 * Registers an extra format. Formats needing heavy dependencies (STEP=OCCT WASM, etc.) are not bundled here,
 * so the app wires them up itself. The `<Viewport/>` file dialog and drag-and-drop filters pick them up automatically.
 *
 * ```js
 * import { registerLoader } from 'three-slicer-viewer/loaders'
 * registerLoader('step,stp', async (buffer, name) => [{ name, modelPos }])
 * ```
 */
export function registerLoader(
  exts: string | string[],
  fn: (buffer: ArrayBuffer, name: string) => LoadedObject[] | Promise<LoadedObject[]>,
): void

/** Connected-component split. Returns `null` when there is only one component (cannot split) — not an empty array. */
export function splitConnectedComponents(localPos: Float32Array): Float32Array[] | null
