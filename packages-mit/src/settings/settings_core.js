// Settings-map transforms that need no vendor catalog: schema-typed coercion, the 3mf project codecs,
// kernel/SLA parameter derivation, preset application, and the preset-file codecs re-exported at the end.
//
// Split out of settings.js so it can ship in the permissive viewer package (packages/RELICENSE.md): nothing
// in here reads upstream's authored text or the vendor catalogs, both of which stay with the AGPL package.
// settings.js re-exports all of this, so `three-slicer/settings` is unchanged for every consumer.

// Maps the actual values of the (editable) right-hand settings panel -> kernel slice parameters.
//  - Settings state is a sparse map (key->value): only edited keys are stored, otherwise the config-schema default.
//  - For vector types (coFloats/coInts, …) only the first element is used/edited (simplification).
// The REDUCED schema is enough here: this file reads .type, .default, enum_values and, for the SLA
//  contract, defined_in/line — never a label or a tooltip. Aliased so the call sites read as before.
import { leanSchema as schema } from './data.js'
import { FFF_FALLBACKS, AUTO_LINE_WIDTH, SLA_FALLBACKS, MACHINE_LIMITS, BED_FALLBACK } from './kernel_defaults.js'

export function schemaDefault(key) { return schema[key]?.default }
export function settingRaw(settings, key) { return (settings && key in settings) ? settings[key] : schemaDefault(key) }
// Normalize to a scalar ([0] for vectors)
// A per-extruder column reduced to the single value the kernel's scalar reader wants. The FIRST SET entry, not
//  literally index 0: the filament card writes one column per extruder and leaves a null wherever that extruder has
//  no preset, so an assignment that starts at T2 puts a null at index 0. Taking that null made filament_diameter 0,
//  which divides into the extrusion maths and turned the whole slice into NaN — measured as
//  "; filament used [mm] = nan, nan" from a print whose T1 had no material picked.
export function settingScalar(settings, key) {
  const v = settingRaw(settings, key)
  if (!Array.isArray(v)) return v
  return v.find(entry => entry != null && entry !== '') ?? v[0]
}

// Stage 8: real ported Fill patterns (gyroid TPMS/honeycomb/3dhoneycomb/crosshatch/concentric) + the older approximations
const KERNEL_PATTERNS = ['rectilinear', 'grid', 'triangles', 'zigzag', 'gyroid', 'gyroid_approx',
  'honeycomb', '3dhoneycomb', 'crosshatch', 'concentric']
const KERNEL_SEAMS = ['nearest', 'aligned', 'back', 'random']

// ---- Pass-through kernel parameters -----------------------------------------------------------------------
// The kernel reads 159 parameters (see the reference table in engine/PARAMS.md, generated from its own reader).
//  These are the ones whose schema key carries the SAME name, so the mapping is the identity and the only real
//  decision is WHEN to send them. They are sent only when the settings map actually holds the key — never filled
//  in from the schema default — because the two defaults disagree for several of them:
//  independent_support_layer_height is true in the schema and false in the kernel, printable_height is 100 there
//  and 250 here. Filling one in would silently reslice every existing caller's model. This is the same omission
//  rule the per-feature widths, the support tools and the prime tower keys already follow, and it is what keeps
//  deriveKernelParams({}) producing exactly the parameter set it produced before these keys were mapped.
const PASSTHROUGH_NUM = [
  // Real (organic) tree support shape. Upstream keeps an _organic spelling and a suffix-less one for most of
  //  these, and the kernel accepts both — preferring _organic — so both are passed as written rather than
  //  reconciled here. Before this, none of the organic tree support could be tuned from a settings map at all.
  'tree_support_branch_angle', 'tree_support_branch_angle_organic',
  'tree_support_branch_diameter', 'tree_support_branch_diameter_organic',
  'tree_support_branch_distance', 'tree_support_branch_distance_organic',
  'tree_support_branch_diameter_angle', 'tree_support_angle_slow', 'tree_support_tip_diameter',
  'tree_support_top_rate', 'tree_support_wall_count',
  'support_object_first_layer_gap',
  // The tree support's build-volume ceiling. Distinct from bed_height above — that one is the kernel's own
  //  off-the-bed check — but both come from this single schema key, because upstream has one option for both jobs.
  'printable_height',
  // Upstream's *_filament_id family: a 1-based filament index per feature, 0 meaning "whatever tool the region
  //  already prints with". slice_mm.cpp honours the wall and sparse-infill ids and reports the rest in the G-code
  //  rather than silently dropping them.
  'outer_wall_filament_id', 'inner_wall_filament_id', 'sparse_infill_filament_id',
  'top_surface_filament_id', 'bottom_surface_filament_id', 'internal_solid_filament_id',
]
const PASSTHROUGH_BOOL = ['independent_support_layer_height']
// Per-filament vectors, one entry per filament, passed positionally like every other per-extruder array.
//  filament_map is which physical extruder each filament sits in; density and cost turn extruded millimetres into
//  the grams and currency the G-code footer reports.
const PASSTHROUGH_NUM_VECTOR = ['filament_map', 'filament_density', 'filament_cost']
// Material identity. The kernel needs the type for the two decisions upstream makes by material name (PETG's
//  extra unretract, TPU on the first layer) and the settings id for the footer.
const PASSTHROUGH_STR_VECTOR = ['filament_type', 'filament_settings_id']

// The schema keys the machine limits are read from — for UI that has to show "which printer characteristics are in play"
// without hardcoding key strings of its own.
export const machineLimitKeys = Object.values(MACHINE_LIMITS).map(([key]) => key)

// ---- Printer profiles -------------------------------------------------------

// ---- Imported project settings (a slicer-written 3mf's Metadata/project_settings.config) --------------------
// Upstream serializes every option as a STRING (or an array of them, one per extruder) — a bool is "0"/"1" and a
//  float is "0.2". This settings map holds real JS types, and the difference is not cosmetic: `bool()` below reads
//  a value with `!!v`, and `!!"0"` is TRUE — importing raw would turn every disabled option on. So each value is
//  coerced by its schema type, and anything the schema does not know (inherits_group, *_settings_id, version, the
//  whole preset-bookkeeping half of that file) is dropped rather than carried into a map keyed by schema keys.
// The `inherits` / `different_settings_to_system` machinery upstream applies on top of this (Preset.cpp:2577) is
//  deliberately NOT reproduced: it exists to reconcile a stored preset against a LOCAL vendor preset database of a
//  possibly different version. project_settings.config is already flattened, so taking its values as written is
//  both simpler and closer to what the project author actually sliced.
const FALSE_STRINGS = new Set(['0', 'false', 'no', 'off', ''])

function coerceScalar(type, value) {
  if (typeof value !== 'string') return value
  switch (type) {
    case 'coBool': case 'coBools':
      return !FALSE_STRINGS.has(value.trim().toLowerCase())
    case 'coFloat': case 'coFloats': case 'coInt': case 'coInts':
      return asNumber(value)
    case 'coPercent': case 'coPercents':
      // A percent option's value is the bare number (the schema default of sparse_infill_density is 20, not "20%")
      //  and upstream serializes it that way — but the '%' does show up in hand-edited configs, so strip it.
      return asNumber(value.trim().replace(/%$/, ''))
    case 'coFloatOrPercent': case 'coFloatsOrPercents':
      // "50%" must stay a string — the percent IS the value, and Number('50%') is NaN anyway.
      return value.trim().endsWith('%') ? value : asNumber(value)
    case 'coPoint': case 'coPoints':
      return parsePoint(value) ?? value
    case 'coPointsGroups':
      return parsePointGroup(value) ?? value
    default:
      return value   // strings and enums — the kernel and the panel both read these as written
  }
}

// Points are the other shape trap, and a quiet one: upstream writes a point as the STRING "XxY", while every
//  consumer here indexes it as a [x, y] pair — so `printable_area[1][0]` on a raw import is the CHARACTER '2' of
//  "256x0", and the bed comes out 2mm wide (measured on a real MakerWorld project: 2 x NaN).
// Two separators exist in the wild: ConfigOptionPoint::serialize writes 'x', while some Orca options
//  (best_object_pos) write "X,Y". A points GROUP is one string holding a comma-separated LIST of "XxY" points,
//  so there the comma cannot also separate a point's own coordinates — hence two parsers rather than one regex.
function parsePoint(text) {
  const split = String(text).split('x')
  const pair = split.length === 2 ? split : String(text).split(',')
  if (pair.length !== 2) return null
  const x = Number(pair[0]), y = Number(pair[1])
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
}
function parsePointGroup(text) {
  const points = String(text).split(',').map(entry => {
    const [a, b] = entry.split('x')
    const x = Number(a), y = Number(b)
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  })
  return points.length && points.every(Boolean) ? points : null
}
// Number('') is 0 and Number('  ') is 0, neither of which means "the option was set to zero" — an unparsable
//  value is handed back untouched so the schema default keeps applying instead of a fabricated 0.
function asNumber(value) {
  if (value.trim() === '') return value
  const n = Number(value)
  return Number.isFinite(n) ? n : value
}

/**
 * A 3mf project's raw `project_settings.config` object -> a settings map this package's own API accepts.
 * Keys the config schema does not define are dropped. Returns `{settings, applied, skipped}`.
 */
export function normalizeProjectSettings(raw) {
  const settings = {}
  let applied = 0
  const skipped = []
  for (const [key, value] of Object.entries(raw || {})) {
    const type = schema[key]?.type
    if (!type) { skipped.push(key); continue }
    settings[key] = Array.isArray(value) ? value.map(entry => coerceScalar(type, entry)) : coerceScalar(type, value)
    applied++
  }
  return { settings, applied, skipped }
}

// The exact inverse, for WRITING a project_settings.config: every value back to the string shape upstream
//  serializes (bool -> "1"/"0", point -> "XxY", a points group -> "X1xY1,X2xY2"), because that is what every other
//  slicer's reader — and normalizeProjectSettings above — expects to coerce FROM. Writing the JS types raw would
//  hand OrcaSlicer a bool it reads with its own string parser and this package a round-trip that only works here.
//  Keys the schema does not define are dropped for the same reason normalize drops them: they could not be typed.
const pointToText = (point) => (Array.isArray(point) ? `${point[0]}x${point[1]}` : String(point))

function serializeScalar(type, value) {
  if (value == null) return ''
  switch (type) {
    case 'coBool': case 'coBools':
      return value ? '1' : '0'
    case 'coPoint': case 'coPoints':
      return pointToText(value)
    case 'coPointsGroups':
      return Array.isArray(value) ? value.map(pointToText).join(',') : String(value)
    default:
      return String(value)   // numbers, percents, strings, enums — String() is upstream's own spelling for all of them
  }
}

/** A settings map (real JS types) -> the all-strings object a 3mf's `project_settings.config` stores. */
export function serializeProjectSettings(settings) {
  const out = {}
  for (const [key, value] of Object.entries(settings || {})) {
    const type = schema[key]?.type
    if (!type) continue
    // A coPoint's value IS an array ([x, y]) — the generic array path would serialize its two numbers separately.
    out[key] = (type !== 'coPoint' && Array.isArray(value))
      ? value.map(entry => serializeScalar(type, entry))
      : serializeScalar(type, value)
  }
  return out
}


// Right-panel settings values -> kernel parameters (derived from schema keys)
//  opts.plate: which plate's entry to take from per-plate array options (wipe_tower_x/y — upstream coFloats,
//  one entry per plate). Defaults to 0, so every existing caller reads exactly what it always did.
export function deriveKernelParams(settings, opts) {
  const plate = opts?.plate ?? 0
  const S = k => settingScalar(settings, k)
  const str = k => String(S(k) ?? FFF_FALLBACKS[k])
  const num = (k, d = FFF_FALLBACKS[k]) => { const v = Number(S(k)); return Number.isFinite(v) ? v : d }
  const bool = (k, d = FFF_FALLBACKS[k]) => { const v = settingRaw(settings, k); return typeof v === 'boolean' ? v : (Array.isArray(v) ? !!v[0] : (v == null ? d : !!v)) }
  // Filament retraction overrides: upstream lets a material override the machine's retraction (TPU wants a
  //  different pull-back than PLA on the same printer). These schema keys are nullable and carry no default of
  //  their own — "unset" means keep the machine value — so this reads the settings map directly rather than
  //  through settingScalar, whose schema fallback would not distinguish the two.
  const override = (filamentKey, machineKey, fallback = FFF_FALLBACKS[machineKey]) => {
    const raw = settings?.[filamentKey]
    const value = Number(Array.isArray(raw) ? raw[0] : raw)
    return Number.isFinite(value) ? value : num(machineKey, fallback)
  }

  let line_width = num('line_width'); if (!line_width) line_width = AUTO_LINE_WIDTH   // 0 = auto

  let pat = str('sparse_infill_pattern')
  if (!KERNEL_PATTERNS.includes(pat)) pat = 'rectilinear'                     // pattern unsupported by the kernel -> rectilinear

  let seam = str('seam_position')
  if (seam === 'aligned_back') seam = 'back'
  if (!KERNEL_SEAMS.includes(seam)) seam = 'back'

  // Support style: schema enum (default/grid/snug/organic/tree_slim/tree_strong/tree_hybrid)
  //  -> kernel grid|tree|tree_lite. Since stage 18 the tree/organic family maps to the real organic TreeSupport ('tree',
  //  generate_tree_support_3D -> real type5 branch toolpaths); everything else maps to grid.
  //  support_type participates too, as upstream's UI does: a tree(auto)/tree(manual) TYPE whose style is
  //  still 'default' is a tree request — before this, an imported Orca project saved with tree(auto) and
  //  the default style silently sliced grid. An explicit non-tree style keeps winning over the type.
  const styleRaw = str('support_style')
  const typeRaw = str('support_type')
  const support_style =
    /tree|organic/i.test(styleRaw) || (/tree/i.test(typeRaw) && styleRaw === 'default') ? 'tree' : 'grid'

  // Bed: bounding box of the first rectangle in printable_area
  const pa = settingRaw(settings, 'printable_area')
  let bed_width = BED_FALLBACK.width, bed_depth = BED_FALLBACK.depth
  if (Array.isArray(pa) && pa.length) {
    const xs = pa.map(p => p[0]), ys = pa.map(p => p[1])
    bed_width = Math.max(...xs) - Math.min(...xs); bed_depth = Math.max(...ys) - Math.min(...ys)
  }

  // Stage 21: per-feature widths — passed to the kernel verbatim (including strings like "120%"). Unedited keys are omitted -> the kernel derives auto(=line_width).
  //  The 0=auto semantics are handled by the kernel's resolve_lw (upstream Flow formula). Defaults unchanged (no feature set -> line_width).
  const widths = {}
  for (const k of ['outer_wall_line_width','inner_wall_line_width','top_surface_line_width',
                   'sparse_infill_line_width','internal_solid_infill_line_width','initial_layer_line_width']) {
    const v = S(k); if (v != null && v !== '') widths[k] = v
  }
  const machine = {}
  for (const [param, [key, fallback]] of Object.entries(MACHINE_LIMITS)) machine[param] = num(key, fallback)

  // Support filament mapping: which extruder prints the support base/raft, and which prints the support interface.
  //  Upstream's "Default" is the value 0 = keep whatever tool is current, and an absent key means the same thing to
  //  the kernel (its JSON reader falls back to its own 0 default). Unmapped supports are therefore omitted rather
  //  than sent as 0, so a settings map that maps neither produces byte-for-byte the parameters it produced before
  //  these keys existed — same reason the per-feature widths above are omitted when unedited.
  const supportTools = {}
  for (const key of ['support_filament', 'support_interface_filament']) {
    const extruderIndex = num(key, 0)
    if (extruderIndex > 0) supportTools[key] = extruderIndex
  }

  // Multi-material: upstream stores every filament option as one entry per extruder (coFloats), and the material
  //  picker writes each extruder's material at its own index. Only a second entry makes these arrays appear, so a
  //  single-material slice sends exactly the keys it always did — the kernel then reads its scalars as before.
  //  A hole (a material that overrides nothing) is filled with the value tool 0 resolved to, because the kernel
  //  reads the array positionally and cannot tell "absent" from "0".
  // Prime tower keys, omitted when unset so the kernel/viewer defaults stay in charge (same rule as supportTools).
  //  wipe_tower_x/y are coFloats upstream — one entry per plate — indexed by opts.plate. A hole (null entry) means
  //  nobody chose a position for THAT plate, so the automatic placement stands there; a scalar applies to every
  //  plate (the pre-array form, kept readable so old saved settings keep meaning what they meant).
  const towerSettings = {}
  {
    const width = num('prime_tower_width')
    if (width > 0) towerSettings.prime_tower_width = width
    // Read the map itself, NOT settingRaw: wipe_tower_x/y carry an upstream schema default of (15, 220), which is
    //  a coordinate off the front of a 200mm bed. Taking it as "the user chose a position" put the tower outside
    //  the plate and disabled the automatic placement entirely — measured as a tower at z=-127.5 on a 200mm bed.
    //  Absent from the map means nobody chose one, and the placement beside the model stands.
    const chosen = (key) => { const raw = settings?.[key]
      const v = Array.isArray(raw) ? raw[plate] : raw
      const n = Number(v)
      return (v != null && v !== '' && Number.isFinite(n)) ? n : null }
    const towerX = chosen('wipe_tower_x'), towerY = chosen('wipe_tower_y')
    if (towerX != null) towerSettings.prime_tower_x = towerX
    if (towerY != null) towerSettings.prime_tower_y = towerY
    // The purging volumes table (flat N×N, mm³) and its scalars. Sent verbatim — the kernel indexes it [from*N+to].
    const matrix = settingRaw(settings, 'flush_volumes_matrix')
    if (Array.isArray(matrix) && matrix.length >= 4) towerSettings.flush_volumes_matrix = matrix.map(Number)
    // Upstream defaults enable_prime_tower to false and relies on flushing into the model; the kernel defaults it
    //  to true because that was the only destination it had. Both are sent only when the map carries them, so an
    //  untouched project keeps whatever the kernel decides.
    if ('enable_prime_tower' in (settings ?? {})) towerSettings.enable_prime_tower = !!settings.enable_prime_tower
    if ('flush_into_infill' in (settings ?? {})) towerSettings.flush_into_infill = !!settings.flush_into_infill
    const multiplier = num('flush_multiplier')
    if (multiplier > 0) towerSettings.flush_multiplier = multiplier
    const prime = num('prime_volume')
    if (prime > 0) towerSettings.prime_volume = prime
  }

  // Pass-through parameters (see PASSTHROUGH_* above). `present` reads the settings MAP, not settingRaw, because
  //  settingRaw's schema fallback is exactly what must not happen here — an unedited key has to stay absent.
  const passthrough = {}
  {
    const present = (key) => settings != null && key in settings && settings[key] != null && settings[key] !== ''
    for (const key of PASSTHROUGH_NUM) {
      if (!present(key)) continue
      const value = Number(S(key))
      if (Number.isFinite(value)) passthrough[key] = value
    }
    for (const key of PASSTHROUGH_BOOL) if (present(key)) passthrough[key] = bool(key, false)
    for (const key of PASSTHROUGH_NUM_VECTOR) {
      if (!present(key)) continue
      const raw = settings[key]
      passthrough[key] = (Array.isArray(raw) ? raw : [raw]).map(entry => { const n = Number(entry); return Number.isFinite(n) ? n : 0 })
    }
    for (const key of PASSTHROUGH_STR_VECTOR) {
      if (!present(key)) continue
      const raw = settings[key]
      passthrough[key] = (Array.isArray(raw) ? raw : [raw]).map(entry => String(entry ?? ''))
    }
    // support_line_width is coFloatOrPercent, but the kernel reads it with the plain number reader rather than the
    //  percent-aware jwidth_raw the per-feature widths get. A "120%" would reach strtod as a quoted string and
    //  parse to 0 == auto — the setting silently ignored. Resolved here against the nozzle, which is the same
    //  thing jwidth_raw does for the widths that do get the percent-aware reader.
    if (present('support_line_width')) {
      const text = String(settingScalar(settings, 'support_line_width')).trim()
      const width = text.endsWith('%') ? (parseFloat(text) / 100) * num('nozzle_diameter') : Number(text)
      if (Number.isFinite(width) && width > 0) passthrough.support_line_width = width
    }
  }

  const perExtruder = {}
  for (const [param, key, scalar] of [
    ['extruder_nozzle_temp', 'nozzle_temperature', num('nozzle_temperature')],
    ['extruder_filament_diameter', 'filament_diameter', num('filament_diameter')],
    ['extruder_flow_ratio', 'filament_flow_ratio', num('filament_flow_ratio')],
    ['extruder_retract_length', 'filament_retraction_length', override('filament_retraction_length', 'retraction_length')],
    ['extruder_retract_speed', 'filament_retraction_speed', override('filament_retraction_speed', 'retraction_speed')],
    ['extruder_z_hop', 'filament_z_hop', override('filament_z_hop', 'z_hop')],
  ]) {
    const raw = settings?.[key]
    if (!Array.isArray(raw) || raw.length < 2) continue
    perExtruder[param] = raw.map(v => {
      if (v == null || v === '') return scalar        // null survives a JSON round-trip; Number(null) would be 0
      const n = Number(Array.isArray(v) ? v[0] : v)
      return Number.isFinite(n) ? n : scalar
    })
  }

  return {
    ...widths,
    ...machine,
    ...passthrough,     // present only for keys the settings map actually holds (see PASSTHROUGH_* above)
    layer_height: num('layer_height'),
    first_layer_height: num('initial_layer_print_height'),
    line_width,
    wall_loops: num('wall_loops'),
    infill_density: num('sparse_infill_density') / 100,      // % → 0~1
    sparse_infill_pattern: pat,
    infill_angle: num('infill_direction'),
    top_shell_layers: num('top_shell_layers'),
    bottom_shell_layers: num('bottom_shell_layers'),
    seam_position: seam,
    skirt_loops: num('skirt_loops'),
    skirt_distance: num('skirt_distance'),
    skirt_height: num('skirt_height'),                       // stage 33: the kernel used to hardcode the first layer
    brim_width: num('brim_width'),
    brim_object_gap: num('brim_object_gap'),                 // stage 33: the kernel used to hardcode w*0.5
    ...perExtruder,
    // Prime tower. These were the one part of multi-material the settings map could not reach: the kernel read its
    //  own prime_tower_* parameters and nothing mapped the upstream keys onto them, so the tower's size and place
    //  were whatever the viewer decided. Only sent when the user actually set them — an unset width keeps the
    //  kernel's own default, and an unset position lets the viewer's auto-placement stand.
    ...towerSettings,
    retract_length: override('filament_retraction_length', 'retraction_length'),   // vector[0]
    retraction_minimum_travel: override('filament_retraction_minimum_travel', 'retraction_minimum_travel'),  // stage 33: used to be the kernel constant 2.0
    gcode_resolution: num('resolution'),                  // stage 33: tree-support path simplification tolerance
    retract_speed: override('filament_retraction_speed', 'retraction_speed'),
    z_hop: override('filament_z_hop', 'z_hop'),
    travel_speed: num('travel_speed'),
    first_layer_speed: num('initial_layer_speed'),
    print_speed: num('outer_wall_speed'),
    nozzle_diameter: num('nozzle_diameter'),
    filament_diameter: num('filament_diameter'),
    flow_ratio: num('filament_flow_ratio'),
    nozzle_temp: num('nozzle_temperature'),
    bed_temp: num('hot_plate_temp'),                        // no bed_temperature key -> hot_plate_temp
    bed_width, bed_depth,
    bed_height: num('printable_height'),                    // 0 = profile states no ceiling -> kernel skips the check
    // Explicitly-set only: the schema default here is upstream's generic "G28 / G1 Z5" preamble, and falling back
    //  to it would rewrite the emitted G-code for every caller. The kernel keeps its own preamble when these are empty.
    machine_start_gcode: String(settings?.machine_start_gcode ?? ''),
    machine_end_gcode: String(settings?.machine_end_gcode ?? ''),
    enable_support: bool('enable_support'),
    support_threshold_angle: num('support_threshold_angle'),
    support_top_z_distance: num('support_top_z_distance'),
    support_bottom_z_distance: num('support_bottom_z_distance'),   // stage 32: support bottom z-gap (default 0.2 = equivalent to current behavior)
    support_xy_distance: num('support_object_xy_distance'),
    support_interface_top_layers: num('support_interface_top_layers'),
    // Stage 33: support keys added when the kernel hardcoding was removed (upstream schema key names kept)
    support_angle: num('support_angle'),
    support_base_pattern: str('support_base_pattern'),
    support_interface_pattern: str('support_interface_pattern'),
    support_interface_spacing: num('support_interface_spacing'),
    support_base_pattern_spacing: num('support_base_pattern_spacing'),
    support_remove_small_overhang: bool('support_remove_small_overhang'),
    bridge_no_support: bool('bridge_no_support'),
    support_expansion: num('support_expansion'),
    support_threshold_overlap: (() => { const v = settingRaw(settings, 'support_threshold_overlap')
      if (typeof v === 'string' && v.trim().endsWith('%')) return parseFloat(v) / 100
      const n = Number(v); return Number.isFinite(n) ? n : 0.5 })(),   // "50%" -> 0.5 (ratio of extrusion width)
    support_on_build_plate_only: bool('support_on_build_plate_only'),
    support_interface_bottom_layers: num('support_interface_bottom_layers'),
    ...supportTools,                                            // present only when a support extruder is mapped (see above)
    raft_layers: num('raft_layers'),
    raft_expansion: num('raft_expansion'),                 // stage 33: the kernel used to hardcode +3.0
    raft_contact_distance: num('raft_contact_distance'),   // stage 33: previously ignored by the kernel
    fan_speed: num('fan_max_speed'),                       // no fan_speed key -> fan_max_speed
    close_fan_the_first_x_layers: num('close_fan_the_first_x_layers'),
    full_fan_speed_layer: num('full_fan_speed_layer'),
    slow_down_layer_time: num('slow_down_layer_time'),
    enable_arc_fitting: bool('enable_arc_fitting'),
    spiral_mode: bool('spiral_mode'),
    // New in stage 5 (derived from the matching schema keys)
    seam_slope_type: str('seam_slope_type'),      // none|external|all -> scarf seam
    enable_pressure_advance: bool('enable_pressure_advance'),
    pressure_advance: num('pressure_advance'),
    support_style,                                                 // grid|tree_lite (mapped above)
    bridge_speed: num('bridge_speed'),
    // New in stage 6 (derived from the matching schema keys). The MM parameters (extruder_count/mm_group_split) are
    //  injected at onSlice time from the viewer's per-object extruder assignment (not included here).
    ironing_type: str('ironing_type'),       // no ironing|top|topmost|solid (the top family = on)
    ironing_spacing: num('ironing_spacing'),
    ironing_flow: num('ironing_flow'),
    ironing_speed: num('ironing_speed'),
    reduce_crossing_wall: bool('reduce_crossing_wall'),
    max_volumetric_extrusion_rate_slope: num('max_volumetric_extrusion_rate_slope'),
    // Stage 7: wall generator classic|arachne (arachne = the real ported OrcaSlicer WallToolPaths, variable width)
    wall_generator: (str('wall_generator') === 'arachne') ? 'arachne' : 'classic',
    // support_density has no matching schema key, so the kernel default (0.15) is used; scarf_length likewise uses the kernel default (10mm)
  }
}

// ---- Printer technology (FFF vs SLA routing) ----------------------------------------------------------------
// The technology is a property of the printer profile, exactly as upstream models it: one settings map, two
//  disjoint key families, and the profile's technology key decides which family the UI shows and which slicing
//  path runs. The schema already carries the key (inherited from the upstream lineage), so an imported preset
//  that names a resin printer routes itself.
export function printerTechnology(settings) {
  return String(settingRaw(settings, 'printer_technology') ?? 'FFF').toUpperCase() === 'SLA' ? 'SLA' : 'FFF'
}

// SLA settings provenance table. Rows come from the schema's `defined_in` marker so a new resin option cannot
// silently leave the UI/bridge without a documented omission/default decision. Explicit rows cover upstream
// expression defaults the extractor cannot evaluate (support_tree_type and branching's bridge limits).
const SLA_SETTING_OVERRIDES = {
  layer_height: { omission: 'resin-default', default: 0.05, provenance: 'shared key; FFF schema default is not used' },
  support_tree_type: { default: 'default', enum: ['default', 'branching', 'organic'], provenance: 'upstream enum expression' },
  branchingsupport_pillar_connection_mode: { default: 'dynamic', enum: ['zigzag', 'cross', 'dynamic'], provenance: 'upstream enum expression' },
  sla_archive_format: { default: 'SL1', enum: ['SL1'], provenance: 'Original Prusa SL1 archive' },
}

const SLA_SCHEMA_ROWS = Object.fromEntries(Object.entries(schema)
  .filter(([key, meta]) => key === 'printer_technology' || String(meta.defined_in ?? '').includes('sla_'))
  .map(([key, meta]) => [key, {
    source: 'config-schema.json',
    omission: 'schema-default',
    default: meta.default,
    ...(meta.enum_values ? { enum: [...meta.enum_values] } : {}),
    provenance: `${meta.defined_in}:${meta.line}`,
  }]))

export const SLA_SETTING_CONTRACT = Object.freeze(Object.fromEntries(
  Object.entries({ ...SLA_SCHEMA_ROWS, ...SLA_SETTING_OVERRIDES }).map(([key, row]) => [key, Object.freeze({
    ...row,
    ...(SLA_SETTING_OVERRIDES[key] ?? {}),
  })]),
))
export const slaSettingContract = SLA_SETTING_CONTRACT
export const slaSettingKeys = Object.freeze(Object.keys(SLA_SETTING_CONTRACT))

// Right-panel settings values -> SLA slice parameters (sla_core.js) + the raster/export geometry the viewer's
//  SL1 writer needs. A separate function, NOT a branch inside deriveKernelParams: that one feeds the WASM kernel
//  and its empty-map key count is a pinned invariant — this one feeds the JS contour slicer and owes bytes to
//  nobody yet. Keys the schema does not define (the resin display's pixel grid, the per-layer height override)
//  are read from the map directly, so they follow the same omission-friendly rule: absent means the default.
export function deriveSlaParams(settings) {
  const S = k => settingScalar(settings, k)
  const num = (k, d = SLA_FALLBACKS[k]) => { const v = Number(S(k)); return Number.isFinite(v) && v > 0 ? v : d }

  // Read from the MAP, not through the schema fallback: the key is shared with FFF and its schema default is that
  //  technology's opinion (0.2mm) — four resin layers thick. Absent means the resin default here.
  const rawLayerHeight = settings?.layer_height
  const mapLayerHeight = Number(Array.isArray(rawLayerHeight) ? rawLayerHeight[0] : rawLayerHeight)
  const layer_height = Number.isFinite(mapLayerHeight) && mapLayerHeight > 0 ? mapLayerHeight : SLA_FALLBACKS.layer_height
  // Zero is a legal fade count (no fade band), so this one cannot go through the positives-only reader.
  const fadedRaw = Number(S('faded_layers'))
  const requestedSupportTree = String(S('support_tree_type') ?? 'default').toLowerCase()
  const support_tree_type = ['default', 'branching', 'organic'].includes(requestedSupportTree)
    ? requestedSupportTree
    : 'default'
  return {
    layer_height,
    initial_layer_height: num('initial_layer_height', layer_height),
    exposure_time: num('exposure_time'),
    initial_exposure_time: num('initial_exposure_time'),
    faded_layers: Number.isFinite(fadedRaw) && fadedRaw >= 0 ? fadedRaw : 10,
    // The physical display and its pixel grid — what turns millimetres into raster pixels at export time.
    //  Fallbacks are the SL1's own panel, the reference machine of the format this exports to.
    display_width: num('display_width'),
    display_height: num('display_height'),
    display_pixels_x: num('display_pixels_x'),
    display_pixels_y: num('display_pixels_y'),
    // Panel mounting: the whole SL1 family is portrait with X mirrored (projection through the vat floor);
    //  the raster writer swaps the image axes for portrait exactly like upstream SL1.cpp create_raster.
    display_orientation: String(S('display_orientation') ?? 'portrait') === 'landscape' ? 'landscape' : 'portrait',
    display_mirror_x: settingRaw(settings, 'display_mirror_x') === undefined ? true : !!settingRaw(settings, 'display_mirror_x'),
    display_mirror_y: !!settingRaw(settings, 'display_mirror_y'),
    // SL1 archive identity fields (config.ini): written as-is, empty when the host never set a named
    //  profile — the same thing upstream produces then. material_print_speed defaults to 'fast', the value
    //  every Prusa vendor SL1 material carries (-> expUserProfile 0 in the archive).
    material_print_speed: String(S('material_print_speed') ?? 'fast'),
    printer_model: String(S('printer_model') ?? ''),
    printer_variant: String(S('printer_variant') ?? ''),
    printer_settings_id: String(S('printer_settings_id') ?? ''),
    sla_print_settings_id: String(S('sla_print_settings_id') ?? ''),
    sla_material_settings_id: String(S('sla_material_settings_id') ?? ''),
    // The kernel's over-bed check and centring read bed dimensions; for a resin printer the printable area IS
    //  the display, so the display doubles as the bed the shared parser sees.
    bed_width: num('display_width'),
    bed_depth: num('display_height'),
    // Support generation (kernel slice_sla): the grid-pillar generator's shape parameters, all schema keys the
    //  SLA extraction pass brought in — schema defaults rule, an edit wins.
    supports_enable: !!settingRaw(settings, 'supports_enable'),
    pad_enable: !!settingRaw(settings, 'pad_enable'),
    // Passed through so a requested hollow is REFUSED (typed kernel error) instead of silently sliced solid —
    //  the OpenVDB chain hollowing needs is not ported, and a solid print labeled hollowed is the worst outcome.
    hollowing_enable: !!settingRaw(settings, 'hollowing_enable'),
    support_buildplate_only: !!settingRaw(settings, 'support_buildplate_only'),
    support_pillar_diameter: num('support_pillar_diameter'),
    support_head_front_diameter: num('support_head_front_diameter'),
    support_head_width: num('support_head_width'),
    support_head_penetration: num('support_head_penetration'),
    support_points_density_relative: num('support_points_density_relative'),
    support_critical_angle: num('support_critical_angle'),
    support_tree_type,
    // The tree shape (upstream SupportTreeConfig): bridge reach, bracing distance, the base foot cone, the
    //  pillar connection style, and how far the object is lifted onto its supports. Elevation may legally be
    //  ZERO (print directly on the plate), so it cannot go through the positives-only reader.
    support_max_bridge_length: num('support_max_bridge_length'),
    support_max_pillar_link_distance: num('support_max_pillar_link_distance'),
    support_base_diameter: num('support_base_diameter'),
    support_base_height: num('support_base_height'),
    // The rest of upstream make_support_cfg (SLAPrint.cpp:50) — small-pillar percent arrives as "50%" so the
    //  percent sign is stripped here; widening factor and base safety distance are legally ZERO (zero safety
    //  falls back to the kernel's own safety_distance), so neither can go through the positives-only reader.
    support_small_pillar_diameter_percent:
      (() => { const v = Number(String(S('support_small_pillar_diameter_percent') ?? '').replace('%', '')); return Number.isFinite(v) && v > 0 ? v : 50 })(),
    support_pillar_widening_factor:
      (() => { const v = Number(S('support_pillar_widening_factor')); return Number.isFinite(v) && v >= 0 ? v : 0 })(),
    support_base_safety_distance:
      (() => { const v = Number(S('support_base_safety_distance')); return Number.isFinite(v) && v >= 0 ? v : 1 })(),
    support_max_bridges_on_pillar: num('support_max_bridges_on_pillar'),
    support_max_weight_on_model: num('support_max_weight_on_model'),
    // The generator's input slices are gap-closed with this radius, exactly like upstream slice_mesh_ex.
    slice_closing_radius: num('slice_closing_radius'),
    support_object_elevation: (() => { const v = Number(S('support_object_elevation')); return Number.isFinite(v) && v >= 0 ? v : 5 })(),
    support_pillar_connection_mode: String(S('support_pillar_connection_mode') ?? 'dynamic'),
    // The pad (upstream make_pad_cfg): wall height is legally ZERO (flat pad, no cavity), so it cannot go
    //  through the positives-only reader.
    pad_brim_size: num('pad_brim_size'),
    pad_wall_thickness: num('pad_wall_thickness'),
    pad_wall_height:
      (() => { const v = Number(S('pad_wall_height')); return Number.isFinite(v) && v >= 0 ? v : 0 })(),
    pad_wall_slope: num('pad_wall_slope'),
    pad_max_merge_distance: num('pad_max_merge_distance'),
    pad_around_object: !!settingRaw(settings, 'pad_around_object'),
    // Embed mode (upstream PadConfig::EmbedObject): the ring's gap and the connector sticks that keep the
    //  object attached to the pad. Read even when embed is off — the kernel ignores them then.
    pad_around_object_everywhere: !!settingRaw(settings, 'pad_around_object_everywhere'),
    pad_object_gap: num('pad_object_gap'),
    pad_object_connector_width: num('pad_object_connector_width'),
    pad_object_connector_stride: num('pad_object_connector_stride'),
    pad_object_connector_penetration: num('pad_object_connector_penetration'),
  }
}

// ---- Preset application -------------------------------------------------------------------------------------
// The clear-then-merge every preset consumer needs and each demo used to rewrite: a preset carries only the
// keys it sets, so merging one over another leaves the previous pick's leftovers underneath (an ABS chamber
// temperature under a PLA pick). `keys` is the catalog's own key set (filaments.keys, processApi.keys,
// printerKeys) — cleared first, so applying a material never disturbs a process pick and vice versa.
// A null/undefined preset (a failed settingsFor lookup) applies NOTHING — the previous pick stays whole,
// because half-clearing on a bad name would be worse than doing nothing.
export function applyPreset(settings, preset, keys) {
  if (!preset) return settings ?? {}
  const next = { ...(settings ?? {}) }
  for (const key of keys ?? []) delete next[key]
  return Object.assign(next, preset)
}

// ---- Ignored-key reporting ----------------------------------------------------------------------------------
// The FFF derivation consumes a curated key set (generated by probing — types/gen_kernel_params.mjs). Every
// other key in a settings map is accepted and silently does nothing to a slice, which is exactly how a
// support_type request once sliced grid with no warning. This is the inspection surface for that class:
// which of MY map's keys does deriveKernelParams actually read?
// Scope: the FFF kernel derivation ONLY. A key ignored here can still be real elsewhere — the SLA derivation
// (slaSettingKeys), the viewer (enable_prime_tower, printable_area), or project metadata — so treat the
// result as "has no effect on an FFF slice", not "useless".
import { KERNEL_SETTING_KEYS } from './kernel_setting_keys.js'
export const kernelSettingKeys = Object.freeze([...KERNEL_SETTING_KEYS])
const KERNEL_SETTING_KEY_SET = new Set(KERNEL_SETTING_KEYS)
export function ignoredKernelSettings(settings) {
  return Object.keys(settings ?? {}).filter(key => !KERNEL_SETTING_KEY_SET.has(key)).sort()
}

// ---- Preset files (the .json OrcaSlicer imports/exports) ----------------------------------------------------
// Re-exported here rather than given their own subpath: they are settings-map transforms like the 3mf project
//  codecs above, and a consumer that has one hand on `settings` should not need a second import path for them.
export { writePresetFile, readPresetFile, presetFileText, presetOptionKeys } from './preset_file.js'
