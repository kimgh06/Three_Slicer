// three-slicer-viewer/loaders — pure loaders, independent of the kernel.

/** The 5 built-ins plus any extension registered via `registerLoader()`, which pushes onto this array. */
export const SUPPORTED_EXT: string[]

/** Lowercased extension. Empty string when there is no dot. */
export function fileExt(name: string): string

export interface LoadedObject {
  name: string
  /** Triangle vertex coordinates (N*9, model z-up) */
  modelPos: Float32Array
}

/** A single file may contain several objects (3mf/amf/step) -> always an array. */
export function loadModel(name: string, buffer: ArrayBuffer): Promise<LoadedObject[]>

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
