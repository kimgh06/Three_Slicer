// The fallbacks deriveKernelParams / deriveSlaParams use when neither the settings map nor the schema gives a
//  usable value, written once so every reader of the same key agrees (the per-extruder hole fill and the scalar
//  used to carry separate copies of the same literal). Re-exported from `three-slicer-viewer/settings` for callers
//  that need the same numbers, and frozen so an importer cannot change the derivation for everyone else.
//
// These are NOT the schema defaults (config-schema.json) and must not be "fixed" to match them: several
//  disagree on purpose, and the golden check pins every value here — changing one reslices every caller's
//  model (AGENTS.md, "Omission is now the general rule"). The viewer keeps its own copies of the few it draws with
//  (core/viewer_defaults.js, so the react-free toolpath/gcode entries do not load the schema); a test pins them equal.

// FFF, keyed by the SCHEMA key each reader asks for (an override pair falls back to its machine key).
export const FFF_FALLBACKS = Object.freeze({
  line_width: 0,
  prime_tower_width: 0,
  flush_multiplier: 0,
  prime_volume: 0,
  nozzle_diameter: 0.4,
  nozzle_temperature: 200,
  filament_diameter: 1.75,
  filament_flow_ratio: 1.0,
  layer_height: 0.2,
  initial_layer_print_height: 0.2,
  wall_loops: 2,
  sparse_infill_density: 20,
  infill_direction: 45,
  top_shell_layers: 4,
  bottom_shell_layers: 3,
  skirt_loops: 1,
  skirt_distance: 2,
  skirt_height: 1,
  brim_width: 0,
  brim_object_gap: 0,
  resolution: 0.01,
  travel_speed: 120,
  initial_layer_speed: 30,
  outer_wall_speed: 60,
  hot_plate_temp: 45,
  printable_height: 0,
  enable_support: false,
  support_threshold_angle: 30,
  support_top_z_distance: 0.2,
  support_bottom_z_distance: 0.2,
  support_object_xy_distance: 0.35,
  support_interface_top_layers: 2,
  support_angle: 0,
  support_interface_spacing: 0.5,
  support_base_pattern_spacing: 2.5,
  support_remove_small_overhang: true,
  bridge_no_support: false,
  support_expansion: 0,
  support_on_build_plate_only: false,
  support_interface_bottom_layers: 0,
  raft_layers: 0,
  raft_expansion: 1.5,
  raft_contact_distance: 0.1,
  fan_max_speed: 100,
  close_fan_the_first_x_layers: 1,
  full_fan_speed_layer: 0,
  slow_down_layer_time: 5,
  enable_arc_fitting: false,
  spiral_mode: false,
  enable_pressure_advance: false,
  pressure_advance: 0.02,
  bridge_speed: 25,
  ironing_spacing: 0.1,
  ironing_flow: 10,
  ironing_speed: 20,
  reduce_crossing_wall: false,
  max_volumetric_extrusion_rate_slope: 0,
  retraction_length: 0.8,
  retraction_speed: 30,
  z_hop: 0.4,
  retraction_minimum_travel: 2,
  sparse_infill_pattern: 'rectilinear',
  seam_position: 'back',
  support_style: 'default',
  support_type: 'normal(auto)',
  support_base_pattern: 'default',
  support_interface_pattern: 'auto',
  seam_slope_type: 'none',
  ironing_type: 'no ironing',
  wall_generator: 'classic',
})

// What line_width 0 ("auto") resolves to.
export const AUTO_LINE_WIDTH = 0.42

// The bed when printable_area is empty or not a point list. It is the bbox of the schema's own printable_area
//  default, so a malformed value and an absent one land on the same bed; it used to be 256, which no other part of
//  the viewer agreed with (every viewer fallback was 200).
export const BED_FALLBACK = Object.freeze({ width: 200, depth: 200 })

// SLA. Its reader treats any non-positive value as absent, unlike the FFF one. `layer_height` is read from the map
//  only (the schema default is FFF's 0.2), so its fallback is the resin value.
export const SLA_FALLBACKS = Object.freeze({
  layer_height: 0.05,
  exposure_time: 7,
  initial_exposure_time: 35,
  display_width: 120.96,
  display_height: 68.04,
  display_pixels_x: 2560,
  display_pixels_y: 1440,
  support_pillar_diameter: 1.0,
  support_head_front_diameter: 0.4,
  support_head_width: 1.0,
  support_head_penetration: 0.2,
  support_points_density_relative: 100,
  support_critical_angle: 45,
  support_max_bridge_length: 15,
  support_max_pillar_link_distance: 10,
  support_base_diameter: 4,
  support_base_height: 1,
  support_max_bridges_on_pillar: 3,
  support_max_weight_on_model: 10,
  slice_closing_radius: 0.049,
  pad_brim_size: 1.6,
  pad_wall_thickness: 2,
  pad_wall_slope: 90,
  pad_max_merge_distance: 50,
  pad_object_gap: 1,
  pad_object_connector_width: 0.5,
  pad_object_connector_stride: 10,
  pad_object_connector_penetration: 0.3,
})

// Machine limits (the "Motion ability" printer page) -> kernel time-estimate parameters.
//  Declarative on purpose: the kernel collapses X/Y into one axis, so the mapping cannot be a plain pass-through,
//  but adding a limit stays a data row instead of code. The fallback is the kernel's own default, so an unedited
//  profile produces exactly the previous estimate. Upstream leaves machine_max_*_x/y/z/e without a schema default
//  (they only ever come from a printer preset), hence the explicit fallbacks here.
export const MACHINE_LIMITS = Object.freeze({
  machine_max_speed_xy: Object.freeze(['machine_max_speed_x', 500]),
  machine_max_speed_z:  Object.freeze(['machine_max_speed_z', 12]),
  machine_max_speed_e:  Object.freeze(['machine_max_speed_e', 30]),
  machine_max_accel_xy: Object.freeze(['machine_max_acceleration_x', 5000]),
  machine_max_accel_z:  Object.freeze(['machine_max_acceleration_z', 500]),
  machine_max_accel_e:  Object.freeze(['machine_max_acceleration_e', 5000]),
  machine_jerk_xy:      Object.freeze(['machine_max_jerk_x', 9]),
  machine_jerk_z:       Object.freeze(['machine_max_jerk_z', 0.4]),
  machine_jerk_e:       Object.freeze(['machine_max_jerk_e', 2.5]),
  machine_accel_print:  Object.freeze(['default_acceleration', 5000]),
  machine_accel_travel: Object.freeze(['travel_acceleration', 5000]),
  machine_accel_retract: Object.freeze(['machine_max_acceleration_retracting', 5000]),
})
