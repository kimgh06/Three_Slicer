// three-slicer/viewer/gcode — G-code text -> kernel-shaped layer stream (renderable without slicing).
// Feed the returned layers straight into buildSegmentData (three-slicer/viewer/toolpath).

export interface GcodeLayer {
  z: number
  /** Stride 8: [x0,y0,z0,enc, x1,y1,z1,enc] per segment, enc = role + tool*16 (role 0 = travel). */
  paths: Float32Array
  /** One entry per segment; 0 means "use the default line width". */
  widths: Float32Array
}

export interface ParseGcodeResult {
  layers: GcodeLayer[]
  stats: { layers: number; path_segments: number; travel_segments: number; tools: number[] }
}

export interface ParseGcodeOptions {
  /** Used to derive bead width from E when the file has no ;WIDTH: comments. Default 1.75. */
  filamentDiameter?: number
  /** Bead-height fallback when a layer's height cannot be inferred from z steps. Default 0.2. */
  defaultLayerHeight?: number
}

/**
 * Parses G0/G1/G2/G3 (I/J arcs), G90/G91, M82/M83, G92, T<n>, and the layer/role comment conventions of
 * OrcaSlicer/PrusaSlicer (;TYPE: ;WIDTH: ;LAYER_CHANGE ;Z:), Cura (;TYPE: ;LAYER:) and this kernel's own output.
 * Recovery is lossy where G-code carries no data: unknown roles become wall(1), widths are derived from E.
 */
export function parseGcode(text: string, opts?: ParseGcodeOptions): ParseGcodeResult
