// View-type coloring: kernel/derived per-vertex values -> the packed color texture the shader reads.
import { TYPE_COLOR, TOOL_COLOR, DEFAULT_RANGES_COLORS, packColor, rangeColorAt, hexToRgb } from './toolpath_palette.js'

// View type list (the highest-priority EViewType entries from the desktop app). value(i)=view value of vertex i, cont=continuous (heatmap) / false=fixed color.
export const VIEW_TYPES = [
  { key: 'feature',  label: 'Feature type', cont: false, unit: '' },
  { key: 'speed',    label: 'Speed',        cont: true,  unit: 'mm/s' },
  { key: 'height',   label: 'Layer Height', cont: true,  unit: 'mm' },
  { key: 'width',    label: 'Line Width',   cont: true,  unit: 'mm' },
  { key: 'fan',      label: 'Fan Speed',    cont: true,  unit: '%' },
  { key: 'temp',     label: 'Temperature',  cont: true,  unit: '°C' },
  // Last, like upstream's EViewType::Tool: it answers "did my painted regions come out on the extruder I assigned?",
  //  which is a check you run after slicing, not a property you scrub through. Discrete like the feature view — an
  //  extruder index is a label, and a heatmap over it would imply tool 2 sits "between" tools 1 and 3.
  { key: 'filament', label: 'Filament',     cont: false, unit: '' },
]
// Per-vertex view value. speed/fan/temp are absent from the kernel toolpath, so they are derived from settings (the cheap option, kernel unchanged).
//  ctx: { speedByType:{type:val}, firstLayerSpeed, fanByType or fanFirstLayers, tempNormal, tempFirst, closeFanLayers }
function viewValue(viewType, meta, i, ctx) {
  const t = meta.vType[i], layer = meta.vLayer[i], first = layer === 0
  switch (viewType) {
    case 'height': return meta.vHeight[i]
    case 'width':  return meta.vWidth[i]
    case 'speed':  return first ? ctx.firstLayerSpeed : (ctx.speedByType[t] ?? ctx.speedByType[1])
    case 'fan':    return (layer < ctx.closeFanLayers) ? 0 : (t === 9 ? 100 : ctx.fanNormal)   // bridge(9)=100%, first N layers=0
    case 'temp':   return first ? ctx.tempFirst : ctx.tempNormal
    default:       return 0
  }
}
// View type -> per-vertex colors, Float32Array(nV*4, .r=packed) + range min/max. feature uses fixed colors.
export function computeColors(data, viewType, ctx) {
  const { meta, nV } = data
  const color = new Float32Array(nV * 4)
  const vt = VIEW_TYPES.find(v => v.key === viewType) || VIEW_TYPES[0]
  if (!vt.cont) {   // Fixed color per vertex: by role (feature type) or by printing extruder (filament)
    //  vTool is read defensively because a segment stream built by an older viewer build has no tool channel at all;
    //  that data is single-extruder by definition, so falling back to tool 0 colors it as one material.
    //  The Filament view paints each tool in that filament's OWN colour when the host supplied one (ctx.toolColors,
    //  the same list the filament card and the stats legend read), falling back to the categorical palette per tool.
    //  Without this the preview contradicts every other place the filament appears.
    const toolRgb = (ctx?.toolColors ?? []).map(hexToRgb)
    const fixedColorAt = vt.key === 'filament'
      ? (i => { const t = meta.vTool ? meta.vTool[i] : 0; return toolRgb[t] || TOOL_COLOR[t % TOOL_COLOR.length] })
      : (i => TYPE_COLOR[meta.vType[i]] || TYPE_COLOR[1])
    for (let i = 0; i < nV; i++) color[i * 4] = packColor(fixedColorAt(i))
    return { color, min: 0, max: 0, viewType, label: vt.label, unit: vt.unit, cont: false }
  }
  // Continuous views: value range (extrusion vertices only) -> heatmap
  let lo = Infinity, hi = -Infinity
  const vals = new Float32Array(nV)
  // Every ctx field is optional, so a caller that omits one produces undefined here — and NaN compares false
  //  against both bounds, so it slipped past the range scan and reached rangeColorAt as a palette index.
  //  Measured: computeColors(data, 'fan', ctx) threw a TypeError for any caller following the published
  //  ColorContext, which declared fanByType/fanFirstLayers that nothing reads. Coerce once, here, rather
  //  than guarding each field: a view value that cannot be derived is not a colour, it is zero.
  for (let i = 0; i < nV; i++) {
    const raw = viewValue(viewType, meta, i, ctx)
    const v = Number.isFinite(raw) ? raw : 0
    vals[i] = v; if (v < lo) lo = v; if (v > hi) hi = v
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1 }
  for (let i = 0; i < nV; i++) { const c = rangeColorAt(vals[i], lo, hi, DEFAULT_RANGES_COLORS); color[i * 4] = packColor(c) }
  return { color, min: lo, max: hi, viewType, label: vt.label, unit: vt.unit, cont: true }
}
