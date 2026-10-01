// three-slicer/worker — the slice worker script. Not a module you import, but the target of
// `new Worker(new URL('three-slicer/worker', import.meta.url), { type: 'module' })`.
//
// The protocol below is the raw message contract. `createSlicerClient()` from `three-slicer/client` wraps it in
// promises and is the easier way in; these types are here for hosts driving the worker directly, and because the
// shape has traps that only a written-down contract makes visible — see the slice request and `erase`.
import type { SliceResult } from '../engine/index.d.ts'
import type { SlaErrorCode, SlaJob } from './sla.d.ts'

/** Brush geometry shared by paint and erase: the hit facet, the hit point, the camera, the radius. */
export interface BrushArgs {
  facet: number
  hx: number; hy: number; hz: number
  cx: number; cy: number; cz: number
  radius: number
  /**
   * The PREVIOUS sample of this stroke. Present, the kernel paints the capsule swept from there to `(hx,hy,hz)`
   * instead of a ball at the hit — which is what upstream does between two consecutive mouse positions
   * (`DoublePointCursor`, GLGizmoPainterBase.cpp:878). A pointer stream is sampled, not continuous, so without it
   * a fast drag lands as a row of separate blobs. Omit on the first sample of a stroke; a kernel built before the
   * capsule existed ignores it and paints the ball, so it is safe to always send.
   */
  px?: number; py?: number; pz?: number
}

/**
 * Painting state, following OrcaSlicer's own `EnforcerBlockerType`: one enum serving two jobs.
 * `1` is both the support ENFORCER and Extruder 1, `2` is both the BLOCKER and Extruder 2, `3..16` are
 * Extruders 3 to 16. `0` (NONE) is deliberately not a value here — see the `erase` command.
 */
export type PaintState = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16

/** Selection tools that are not the radius brush. All three take the mesh's own topology instead of a radius. */
export type PaintTool = 'smart' | 'bucket' | 'triangle'

export type SlicerRequest =
  /** Load the kernel (and spawn the mt thread pool) ahead of the first slice. Reply: `warm`. */
  | { cmd: 'warmup' }
  /**
   * Register a mesh for painting. `keepPaint` says this is the same model in a new place, so the marks carry
   * over — the reply reports whether they actually did. Reply: `prepared`.
   */
  | { cmd: 'prepare'; stl: ArrayBuffer; keepPaint?: boolean }
  /**
   * Paint. With `state` it addresses any extruder; with `enforcer` it stays on the original boolean pair, where
   * `false` means BLOCKER. `states` asks for those states' counts back. Reply: `painted`.
   */
  | (BrushArgs & { cmd: 'paint'; state?: PaintState; enforcer?: boolean; tool?: PaintTool
                   angle?: number; cursor?: 'sphere' | 'circle'; states?: PaintState[] })
  /**
   * Return the brushed facets to the default extruder. Its OWN command rather than `{cmd:'paint', state:0}`:
   * embind coerces a JS `false` to the int `0` == NONE, and the legacy blocker brush sends exactly that `false`,
   * so admitting `0` on the state path would let a stray boolean erase silently. Reply: `painted`.
   */
  | (BrushArgs & { cmd: 'erase'; tool?: PaintTool; angle?: number; states?: PaintState[] })
  /**
   * Load painting out of a 3mf. REPLACES every mark (the kernel's deserialize resets first), so it belongs
   * immediately after a `prepare` and nowhere else. Reply: `painted`, with `applied`.
   */
  | { cmd: 'importPaint'; facets: Int32Array | number[]; hex: string; states?: PaintState[] }
  /** Every marked facet's split tree, in the CURRENT selector's numbering. Reply: `paintExport`. */
  | { cmd: 'exportPaint' }
  /** Wipe every state at once. Reply: `painted`, all zero. */
  | { cmd: 'clear'; states?: PaintState[] }
  /** The painted overlay triangles. `enf`/`blk` always; `states` adds those states. Reply: `overlay`. */
  | { cmd: 'overlay'; states?: PaintState[] }

  /**
   * What a fill tool WOULD select under the cursor, without marking anything — upstream draws this on every mouse
   * move while a fill is active (GLGizmoPainterBase.cpp:929) so a click is aimed rather than tried. No state
   * argument at all: a preview marks nothing, so there is no NONE for a stray boolean to become.
   * `{clear:true}` drops the standing selection. Reply: `fillPreview`.
   */
  | { cmd: 'fillPreview'; facet?: number; hx?: number; hy?: number; hz?: number
      tool?: PaintTool; angle?: number; clear?: boolean }

  /**
   * Brush-wide options, set once and read by every stroke and fill — upstream keeps both on the gizmo.
   * `overhangDeg` restricts painting to facets overhanging by more than that angle (`0` = off, the default);
   * `clipPlane` is the section plane `[nx, ny, nz, offset]` in KERNEL coords that every cursor clips against
   * (`null` turns it off), which is the only way a brush reaches an interior surface. Reply: `paintMode`.
   */
  | { cmd: 'paintMode'; overhangDeg?: number; clipPlane?: [number, number, number, number] | null }
  /**
   * Legacy single-object SLA (resin) slice. `params` accepts a JSON string or an object (this path parses either). Same reply stream as
   * a slice: `progress` and `layer` while it runs, then `done` (stats only; layers arrived as `layer`) — or `error`.
   */
  | { cmd: 'sla'; stl: ArrayBuffer; params: string | object }
  /** Object-aware SLA protocol. The worker preserves the ordered objects; it never merges them for a fallback. */
  | { cmd: 'slaJob'; job: SlaJob }
  /**
   * Slice — and note it carries **no `cmd`**: slicing is the worker's default action, and leaving the field off
   * is what selects it. `params` accepts a JSON string or an object; the kernel parses JSON text, so an object is
   * stringified for you (it was string-only through 0.2.2, which made this the one call path with a different
   * contract from `createSlicer().slice()` and `createSlicerClient().slice()`).
   * Replies: `progress` and `layer` while it runs, then `done` — or `error`.
   * `gpu: true` asks the worker to compute the layer contours with WebGPU (src/contour_gpu.js). The worker uses it
   * when it has a device and the slice reaches the contour union; `done`'s `stats.contour_engine` says what ran
   * ('gpu', 'cpu' with `contour_engine_reason`, or 'reused' for layers from the stage cache).
   */
  | { stl: ArrayBuffer; params: string | object; gpu?: boolean }

export type SlicerResponse =
  /** `kernel` says which variant loaded: 'mt' under crossOriginIsolated, 'st' otherwise (or after an mt load failure). */
  | { type: 'warm'; kernel: 'mt' | 'st' | null }
  | { type: 'prepared'; facets: number; kept: boolean }
  /**
   * `enf`/`blk` are the counts for states 1 and 2 and are always present, so a listener predating the
   * state-addressed protocol keeps working. `counts` appears only when the request named `states`.
   */
  | { type: 'painted'; enf: number; blk: number; counts?: Record<number, number>; applied?: number }
  /** `supported: false` from a kernel built before the export binding existed — it does not throw. */
  | { type: 'paintExport'; supported: boolean; facets: number[]; hex: string }
  | { type: 'overlay'; enf: Float32Array; blk: Float32Array; overlays?: Record<number, Float32Array> }
  /** `supported` false on a kernel built before the preview existed; `tris` is flat x,y,z, 3 vertices per triangle. */
  | { type: 'fillPreview'; supported: boolean; tris: Float32Array }
  | { type: 'paintMode'; ok: boolean }
  /**
   * Sent once, unprompted, by the multithreaded kernel only: the address of the support-progress counter and of
   * the cancel flag, inside a SharedArrayBuffer. Writing 1 to the cancel flag stops a slice the worker is
   * currently blocked inside. A single-threaded kernel has no shared buffer and never sends this.
   */
  | { type: 'supsab'; buf: SharedArrayBuffer; ptr: number; cancelPtr: number }
  | { type: 'progress'; done: number; total: number }
  /** One sliced layer, its typed arrays transferred rather than copied. */
  | { type: 'layer'; z: number; idx: number; gcode: string; paths: Float32Array; widths: Float32Array }
  /** `result.stats.streamed` says whether the G-code came through `layer` messages or is on the result. */
  | { type: 'done'; result: SliceResult }
  | { type: 'error'; error: string; code?: SlaErrorCode }

export {}
