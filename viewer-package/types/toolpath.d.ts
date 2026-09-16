// three-slicer-viewer — kernel layers -> GPU-instanced toolpath.
// Also published as three-slicer/viewer/toolpath, which re-exports this package.
// Does not import three: makeToolpath takes the THREE namespace as an argument (guaranteeing a single instance).

/** The 24 triangle indices of the 8-vertex diamond cross-section (from SegmentTemplate.cpp:18) */
export const VERTEX_DATA: number[]

/** Toolpath type -> color. 0=travel, 1=wall … 11=prime */
export const TYPE_COLOR: Record<number, number[]>
export const TYPE_LABEL: Record<number, string>

/**
 * Per-extruder colors for the Filament view. Categorical, not semantic — the toolpath stream carries a tool index and
 * nothing about the material, and a machine may have more extruders than entries, so index it modulo its length.
 */
export const TOOL_COLOR: number[][]

/** Blue-to-red 11-color heatmap (libvgcode ColorRange.hpp:14) */
export const DEFAULT_RANGES_COLORS: number[][]

export interface ViewTypeDef {
  key: 'feature' | 'speed' | 'height' | 'width' | 'fan' | 'temp' | 'filament'
  label: string
  /** Whether values are continuous (heatmap). False means a fixed color. */
  cont: boolean
  unit: string
}
export const VIEW_TYPES: ViewTypeDef[]

/** Per-vertex extra data */
export interface SegmentMeta {
  vType: Uint8Array
  /** Printing extruder, decoded out of the role field's high bits. Untooled output decodes to 0, i.e. single material. */
  vTool: Uint8Array
  vWidth: Float32Array
  vHeight: Float32Array
  vLayer: Int32Array
}

export interface SegmentData {
  position: Float32Array
  hwa: Float32Array
  segIndex: Uint32Array
  nV: number
  nSeg: number
  layerSegPrefix: Uint32Array
  travelPos: Float32Array
  travelPrefix: Uint32Array
  nTrav: number
  layerCount: number
  maxAbs: number
  hasNaN: boolean
  meta: SegmentMeta
  /** Total extruded length per type (index = toolpath type, length 16) */
  typeLengths: Float64Array
  /** Null when there is not a single vertex */
  bbox: { min: [number, number, number]; max: [number, number, number] } | null
}

/** Kernel layers[{z, paths(stride8), widths[]}] -> GPU stream. */
export function buildSegmentData(layers: unknown[], defaultLineWidth: number): SegmentData

/** Length share per type (%), descending by pct. The kernel does not expose time per role, so length is used as an approximation. */
export function roleRatios(typeLengths: Float64Array | number[]): Array<{
  type: number
  label: string
  pct: number
  color: number[]
}>

/**
 * speed/fan/temp are absent from the kernel toolpath and derived from settings — these are the values used for that.
 */
export interface ColorContext {
  /** Print speed per toolpath type, mm/s. Falls back to the wall entry for a type not listed. */
  speedByType?: Record<number, number>
  firstLayerSpeed?: number
  /** Part-cooling fan %, used for every layer at or above `closeFanLayers`. Bridges are always 100. */
  fanNormal?: number
  /** Layers below this index are drawn at 0% fan. */
  closeFanLayers?: number
  tempNormal?: number
  tempFirst?: number
  /** Filament colours (hex, per extruder) for the Filament view, so the preview agrees with the filament
   *  card and the stats legend. Falls back to the categorical TOOL_COLOR palette per tool. */
  toolColors?: string[]
}

export interface ColorResult {
  /** Per-vertex RGBA (nV*4). The color is packed into `.r`. */
  color: Float32Array
  min: number
  max: number
  viewType: ViewTypeDef['key']
  label: string
  unit: string
  /** False means fixed colors — min/max are 0 and no legend should be drawn. */
  cont: boolean
}

export function computeColors(data: SegmentData, viewType: ViewTypeDef['key'], ctx: ColorContext): ColorResult

export interface ToolpathHandle {
  /** THREE.Mesh — typed by the THREE namespace passed in */
  mesh: any
  /** THREE.LineSegments (travel) */
  travLines: any
  setLayerRange(lo: number, hi: number): void
  /** Backwards compatible — same as setLayerRange(0, n-1). */
  setVisibleLayers(n: number): void
  setTravelVisible(visible: boolean): void
  setColors(color: Float32Array): void
  dispose(): void
  nSeg: number
  layerCount: number
}

/** @param THREE - the `import * as THREE from 'three'` namespace. The consumer's instance is used as-is. */
export function makeToolpath(THREE: any, data: SegmentData): ToolpathHandle

/** [r,g,b] in 0..1 -> r<<16 | g<<8 | b, the form the shader unpacks. */
export function packColor(rgb: number[]): number
/** '#rrggbb' -> [r,g,b] in 0..1. Unparseable input returns mid-grey rather than NaN. */
export function hexToRgb(hex: string): number[]
/** Value -> colour interpolated between adjacent stops. Clamps BOTH ends; non-finite input returns stop 0. */
export function rangeColorAt(v: number, lo: number, hi: number, palette?: number[][]): number[]

/** Moves in one layer — extrusions and travels together, which is what a scrub bar walks. */
export function layerMoveCount(data: SegmentData, layer: number): number
/** The topmost layer in [lo, hi] that has moves, or `lo` when none does. */
export function topMoveLayer(data: SegmentData, lo: number, hi: number): number
/** Where the nozzle is after `at` moves into `layer`. `segCount + travCount === at`, clamped to the layer. */
export function moveCursor(data: SegmentData, layer: number, at: number): {
  point: [number, number, number] | null
  segCount: number
  travCount: number
  onTravel: boolean
}
