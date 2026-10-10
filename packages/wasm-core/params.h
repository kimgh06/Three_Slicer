// params.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#pragma once
#include <algorithm>
#include <string>
#include <vector>

// ---- Parameters (stage-1 names unchanged + stage-2 additions) ------------------
struct Params {
  double layer_height=0.2, first_layer_height=0.2, line_width=0.42;
  // Stage 21: per-feature extrusion width (0 = derive automatically). 0 resolves at parse time to line_width (>0) or the upstream Flow auto (nozzle based).
  double outer_wall_line_width=0, inner_wall_line_width=0, top_surface_line_width=0;
  double sparse_infill_line_width=0, internal_solid_infill_line_width=0, initial_layer_line_width=0;
  int    wall_loops=2;
  double infill_density=0.15, nozzle_diameter=0.4, filament_diameter=1.75, flow_ratio=1.0;
  double print_speed=60, first_layer_speed=20, travel_speed=150;
  double nozzle_temp=210, bed_temp=60;
  // The first layer's own temperatures (nozzle_temperature_initial_layer, the plate type's _initial_layer bed option).
  //  <0 = the host sent none: the print runs at nozzle_temp/bed_temp throughout, as it always did. Given, the print
  //  starts at them and switches at the second printed layer (upstream GCode.cpp:5631-5650).
  double first_layer_nozzle_temp=-1.0;   // nozzle_temperature_initial_layer (<0 = none sent)
  double first_layer_bed_temp=-1.0;      // the plate type's _initial_layer bed option (<0 = none sent)
  inline double first_layer_nozzle_temp_of(int tool) const { return forTool(extruder_first_layer_temp, tool, first_layer_nozzle_temp); }
  bool   single_extruder_multi_material=true;   // one nozzle carries every filament: the switch names no tool
  // Upstream's gcode_flavor ("marlin", "marlin2", "klipper", "reprapfirmware", "repetier", ...). Empty = the host sent
  //  none: the commands the kernel always wrote keep their form, and new ones use Marlin's (machine_writer.h).
  std::string gcode_flavor;
  // disable_m73 false: the G-code carries upstream's progress placeholders (;_GP_FIRST_LINE_M73_PLACEHOLDER at the top,
  //  ;_GP_LAST_LINE_M73_PLACEHOLDER at the end), which the host fills with M73 from the finished estimate
  //  (three-slicer-viewer/gcode finalizeGcode). true (no key sent) writes neither.
  bool   disable_m73=true;
  bool   reduce_infill_retraction=false;   // no retraction for a travel inside the infill (GCode::needs_retraction); off = the kernel's own rule
  bool   use_relative_e_distances=true;   // false = absolute E (M82, G92 E0 after each retraction), upstream's two modes
  bool   use_firmware_retraction=false;   // G10/G11 instead of E moves (upstream GCodeWriter::_retract)
  double z_offset=0.0;                    // added to every Z the G-code writes (upstream GCodeWriter, z_offset)
  // emit_machine_limits_to_gcode: upstream's print_machine_envelope (M201/M203/M204/M205) for Marlin and RepRap.
  //  Sent only when the profile turns it on, as 16 numbers in this order: max acceleration X Y Z E, max speed X Y Z E,
  //  acceleration extruding, retracting, travel, jerk X Y Z E, junction deviation. Empty = not written.
  std::vector<double> machine_envelope;
  // Per-role speeds (mm/s), upstream's names. <0 = not sent: the role prints at print_speed, as every role did before
  //  these were mapped. Any one of them sent switches the speed rule to upstream's (emit.cpp role_feeds).
  double inner_wall_speed=-1.0;
  double sparse_infill_speed=-1.0;
  double internal_solid_infill_speed=-1.0;
  double top_surface_speed=-1.0;
  double support_speed=-1.0;
  double support_interface_speed=-1.0;
  double initial_layer_infill_speed=-1.0;
  double skirt_speed=-1.0;                  // 0 = follow the role's speed
  double initial_layer_travel_speed=-1.0;   // the first layer's travel speed
  int    slow_down_layers=0;                // layers over which the first layer's speed ramps up to the print's
  double small_perimeter_speed=-1.0;        // mm/s for a wall loop within small_perimeter_threshold; 0 = half the outer wall's
  double small_perimeter_threshold=0.0;     // a RADIUS (mm): loops up to 2*pi*threshold long are small (0 = off)
  // Per-role acceleration (mm/s^2) and jerk (mm/s), upstream's names. default_acceleration / default_jerk <0 = not
  //  sent, 0 = off: no command is written. The role values are 0 = "use the default".
  double default_acceleration=-1.0;
  double outer_wall_acceleration=0.0;
  double inner_wall_acceleration=0.0;
  double top_surface_acceleration=0.0;
  double sparse_infill_acceleration=0.0;
  double internal_solid_infill_acceleration=0.0;
  double bridge_acceleration=0.0;
  double initial_layer_acceleration=0.0;
  double travel_acceleration=0.0;
  double initial_layer_travel_acceleration=0.0;
  double default_jerk=-1.0;
  double outer_wall_jerk=0.0;
  double inner_wall_jerk=0.0;
  double top_surface_jerk=0.0;
  double infill_jerk=0.0;
  double initial_layer_jerk=0.0;
  double travel_jerk=0.0;
  double initial_layer_travel_jerk=0.0;
  // The writer's clamps (upstream GCodeWriter::apply_print_config) and Klipper's ACCEL_TO_DECEL.
  double machine_max_acceleration_extruding=0.0;
  double machine_max_acceleration_travel=0.0;
  double machine_max_acceleration_y=0.0;
  double machine_max_jerk_y=0.0;
  bool   accel_to_decel_enable=false;
  double accel_to_decel_factor=50.0;      // percent
  // New in stage 2 (defaults follow the matching config-schema.json keys)
  int    top_shell_layers=4, bottom_shell_layers=3;   // top_shell_layers/bottom_shell_layers
  int    skirt_loops=1;                                // skirt_loops
  double skirt_distance=2.0, brim_width=0.0;           // skirt_distance / brim_width
  double retract_length=0.8, retract_speed=30.0, z_hop=0.4; // retraction_length/speed[0], z_hop[0]
  double infill_angle=45.0;                            // infill_direction
  // New in stage 3 (defaults follow the matching config-schema.json keys / coordinate adjustment directives)
  bool   enable_support=false;                         // enable_support
  double support_threshold_angle=30.0;                 // support_threshold_angle
  double support_density=0.15;                         // density of the support body
  double support_top_z_distance=0.2;                   // support_top_z_distance
  double support_bottom_z_distance=0.2;                // stage 32: z gap under support resting on a model top surface (default 0.2 = equivalent to today's 1 layer -> default behavior and golden unchanged)
  double support_xy_distance=0.35;                     // support_object_xy_distance
  int    support_interface_top_layers=2;               // support_interface_top_layers
  bool   support_auto=true;                             // stage 20: true = automatic overhang detection, false = manual (painted enforcers only)
  double support_line_width=0.0;                        // support_line_width (0=auto; the real tree support extrusion width)
  // Stage 33: hardcoding removed — wired to the upstream setting keys (defaults match the upstream config-schema defaults)
  double support_angle=0.0;                             // support_angle: base angle of the support body (°). Upstream SupportParameters::base_angle
  std::string support_base_pattern="default";           // support_base_pattern: default|rectilinear|rectilinear-grid|honeycomb|...
  std::string support_interface_pattern="auto";         // support_interface_pattern: auto|rectilinear|concentric|rectilinear_interlaced|grid
  double support_interface_spacing=0.5;                 // support_interface_spacing (mm, 0=solid). Upstream default 0.5
  double support_base_pattern_spacing=2.5;              // support_base_pattern_spacing (mm). Determines spacing together with density
  double support_overhang_min_area=0.0;                 // minimum overhang area (mm², 0 = auto w²). Replaces the morphological opening filter
  bool   support_remove_small_overhang=true;            // support_remove_small_overhang (upstream default true)
  bool   bridge_no_support=false;                       // bridge_no_support: no support under bridge regions
  double support_expansion=0.0;                         // support_expansion (mm): expands the overhang region
  double support_threshold_overlap=0.5;                 // support_threshold_overlap: the overlap criterion when θ=0 (as a fraction of extrusion width)
  bool   support_on_build_plate_only=false;             // support_on_build_plate_only: only support reaching the bed
  int    support_interface_bottom_layers=0;             // support_interface_bottom_layers (0 = none)
  bool   support_grid_snap=true;                        // equivalent of the upstream SupportGridPattern (default behavior of the grid style)
  // Upstream support_filament / support_interface_filament (both coInt, min 0). The value is a 1-based filament
  //  index and 0 means "Default" — no dedicated filament, keep whatever tool is loaded. With 0 the kernel emits no
  //  T command at all, so the single-material G-code is exactly what it was.
  int    support_filament=0;                            // filament for the support base (and, upstream, the raft)
  int    support_interface_filament=0;                  // filament for the support interface
  double tree_lite_shrink=0.5, tree_lite_min_radius=1.5;// tree_lite taper constants (our own approximation — no matching upstream key)
  // WP1: shape keys for the real tree support (support_style=tree) — defaults identical to the upstream PrintConfig defaults
  std::string tree_style="organic";                     // organic|slim|strong|hybrid (upstream support_style smsTree*)
  double tree_support_branch_angle=40.0;                // tree_support_branch_angle_organic (deg)
  double tree_support_angle_slow=25.0;                  // tree_support_angle_slow (deg)
  double tree_support_branch_diameter=2.0;              // tree_support_branch_diameter_organic (mm)
  double tree_support_branch_distance=1.0;              // tree_support_branch_distance_organic (mm)
  double tree_support_branch_diameter_angle=5.0;        // tree_support_branch_diameter_angle (deg)
  double tree_support_tip_diameter=0.8;                 // tree_support_tip_diameter (mm)
  double tree_support_top_rate=30.0;                    // tree_support_top_rate (%)
  int    tree_support_wall_count=0;                     // tree_support_wall_count (organic applies max(1,·) internally)
  double printable_height=250.0;                        // printable_height (mm) — the tree BuildVolume height
  bool   independent_support_layer_height=false;        // false by default because of the kernel z grid constraint (gap quantized to layers)
  double support_object_first_layer_gap=0.2;            // support_object_first_layer_gap (mm)
  int    raft_layers=0;                                // raft_layers
  double raft_expansion=1.5;                           // raft_expansion (mm). Upstream default 1.5 (previously hardcoded to 3.0)
  double raft_contact_distance=0.1;                    // raft_contact_distance (mm)
  double raft_first_layer_height=0.30;                 // raft first layer height (mm)
  int    skirt_height=1;                               // skirt_height: how many layers the skirt is drawn on
  double brim_object_gap=0.0;                          // brim_object_gap (mm): gap between brim and object
  double retraction_minimum_travel=2.0;                // retraction_minimum_travel (mm): minimum travel that triggers a retraction
  double gcode_resolution=0.01;                        // resolution (mm): path simplification tolerance. Upstream PrintConfig default 0.01
  // wipe_tower_x/y (G-code coordinates, mm). The upstream schema default is (15, 220), but that assumes a 256mm bed and
  //  falls off a 200mm bed. The kernel default stays at a corner safe on any bed (10,10), and the upstream coordinates
  //  are used only when the UI/consumer passes them explicitly (preserving existing behavior).
  double prime_tower_x=10.0, prime_tower_y=10.0;
  double prime_tower_ring_size=15.0;                   // side length of the fallback square ring (mm)
  double bed_width=256.0, bed_depth=256.0;             // bed size
  // The printable area's lower-left corner in printer coordinates. Most beds start at (0,0); a delta bed is centred
  //  on it (Anycubic Predator: -185..185) and some cartesian beds are offset (CR-10 V3: 5..305). The kernel slices in
  //  plate-local coordinates around the bed centre, so the G-code adds the centre, bed_center_x/y(), not bed/2.
  double bed_origin_x=0.0, bed_origin_y=0.0;
  inline double bed_center_x() const { return bed_origin_x + bed_width * 0.5; }
  inline double bed_center_y() const { return bed_origin_y + bed_depth * 0.5; }
  double bed_height=0.0;                                // printable_height (mm). 0 = no ceiling (backwards compatible)
  std::string machine_start_gcode, machine_end_gcode;   // printer profile custom G-code. Empty = the mini-kernel's own preamble/footer only
  // Issue 63: the flattened settings as a JSON object of upstream option strings (plus "$model_name", "$plate_name",
  //  "$plate_number"), sent as a single escaped string so the flat key search above never finds a key inside it. Present =
  //  the custom G-code templates are expanded by upstream's PlaceholderParser (custom_gcode.cpp); absent = the raw path.
  std::string placeholder_config;
  // New in stage 4 (path and G-code level)
  std::string sparse_infill_pattern="rectilinear";     // rectilinear|grid|triangles|zigzag|gyroid
  double fan_speed=100.0;                               // fan_speed (%)
  int    close_fan_the_first_x_layers=1;               // close_fan_the_first_x_layers
  int    full_fan_speed_layer=3;                        // full_fan_speed_layer
  double slow_down_layer_time=8.0;                      // slow_down_layer_time (s)
  bool   enable_arc_fitting=false;                      // enable_arc_fitting
  std::string seam_position="back";                     // nearest|aligned|back|random
  bool   spiral_mode=false;                             // spiral_mode (vase)
  // New in stage 5 (gap fill · thin wall · scarf · pressure advance · tree-lite · bridge)
  std::string seam_slope_type="none";                   // none|external|all -> scarf seam (external/all = on)
  double scarf_length=10.0;                              // length of the scarf z/flow ramp (mm)
  // Upstream's flow multipliers (GCode.cpp:7343-7390, LayerRegion::bridging_flow). All 1 / off by default, and the
  //  host sends them only when its settings hold them, so a caller without them gets the G-code it always got.
  double print_flow_ratio=1.0, top_solid_infill_flow_ratio=1.0, bottom_solid_infill_flow_ratio=1.0, bridge_flow=1.0,
         brim_flow_ratio=1.0, scarf_joint_flow_ratio=1.0;
  bool   thick_bridges=false, set_other_flow_ratios=false;
  double outer_wall_flow_ratio=1.0, inner_wall_flow_ratio=1.0, sparse_infill_flow_ratio=1.0,
         internal_solid_infill_flow_ratio=1.0, gap_fill_flow_ratio=1.0, support_flow_ratio=1.0,
         support_interface_flow_ratio=1.0, first_layer_flow_ratio=1.0;
  bool   enable_pressure_advance=false;                 // enable_pressure_advance[0]
  double pressure_advance=0.02;                          // pressure_advance[0]
  std::string support_style="grid";                     // grid|tree_lite
  double bridge_speed=25.0;                              // bridge_speed[0] (slowdown for unsupported bottoms)
  // New in stage 6 (ironing · wall avoidance · PE-lite · multi-material)
  std::string ironing_type="none";                      // none|top|topmost|solid (the top family = on)
  double ironing_spacing=0.1;                           // ironing line spacing (mm)
  double ironing_flow=10.0;                             // ironing flow (%)
  double ironing_speed=30.0;                            // ironing speed (mm/s)
  bool   reduce_crossing_wall=false;                    // wall-avoiding travel
  double max_volumetric_extrusion_rate_slope=0.0;       // PE-lite flow change rate limit (mm³/s², 0=off)
  int    extruder_count=1;                              // multi-material: how many extruders are used (1|2)
  // Per-extruder filament values, indexed by tool: a two-material print wants ABS at 270 on T0 and PLA at 220 on
  //  T1, which the scalars above cannot express. Empty (the default) means every tool uses the scalar, so a
  //  single-material slice — and any host that never sends these — behaves exactly as before.
  std::vector<double> extruder_nozzle_temp, extruder_filament_diameter, extruder_flow_ratio,
                      extruder_retract_length, extruder_retract_speed, extruder_z_hop;
  std::vector<double> extruder_first_layer_temp;   // nozzle_temperature_initial_layer per extruder (the first layer's own)
  // support_filament / support_interface_filament are 1-based with 0 = "keep the object's tool": the tool to switch
  //  to, or -1 for none.
  static int support_tool_of(int filament_index) {
    if (filament_index > 0) return filament_index - 1;
    return -1;
  }
  static double forTool(const std::vector<double>& per, int tool, double fallback) {
    return (tool >= 0 && tool < (int)per.size()) ? per[tool] : fallback;
  }
  int    mm_group_split=0;                              // triangle group boundary index ([0,split)=T0, [split,N)=T1)
  // N-way grouping: every boundary in triangle order, so three materials are three groups rather than the second
  //  one silently swallowing the third. Empty falls back to the single mm_group_split above.
  //  mm_group_tools names the tool each group prints with — extruder numbers can be sparse (objects on T1 and T3
  //  only), and the per-extruder filament arrays are indexed by the real tool, not by group position.
  std::vector<double> mm_group_splits, mm_group_tools;
  // The filament (0-based) a single-material slice prints with: every object of the plate assigned to filament 4
  //  is tool 3. Its per-extruder values replace the scalars and the custom G-code starts on it. 0, the default,
  //  is the first filament, which is what the single-material path always printed with.
  int    single_tool=0;
  // Per-feature filament, upstream's *_filament_id family (PrintConfig.cpp). 1-based filament index, 0 = "Default"
  //  meaning the tool the region already prints with. Only the features slice_multimaterial actually emits are
  //  honoured: it prints walls and sparse infill and has no shell detection, so the top/bottom/solid ids are parsed
  //  and reported but cannot be applied — see slice_mm.cpp, which says so in the G-code rather than silently
  //  ignoring them.
  int    outer_wall_filament_id=0, inner_wall_filament_id=0, sparse_infill_filament_id=0;
  int    top_surface_filament_id=0, bottom_surface_filament_id=0, internal_solid_filament_id=0;
  // Upstream's filament_map: which PHYSICAL extruder each filament is loaded into (1-based), for machines with more
  //  than one nozzle. Empty (the default) is the identity — filament i is extruder i — which is what every
  //  single-nozzle machine has and what keeps the emitted T numbers unchanged.
  //  It changes two things: the number after T, and whether a change has to purge at all. Two filaments sharing one
  //  nozzle must purge the old colour out; two on different nozzles never mix, so the tower is skipped entirely.
  std::vector<double> filament_map;
  // Upstream's purging volumes (PrintConfig flush_volumes_matrix): a flat N×N table in mm³ where entry [from*N+to]
  //  is how much has to be pushed out to go from filament `from` to filament `to`. It is what makes white->black
  //  cost more than white->white; without it every change purges the same fixed amount, which is either wasteful
  //  or not enough depending on the pair. Empty = no table, and the tower keeps its previous fixed size.
  // Whether a prime tower is built at all. Upstream's own default is FALSE, because it can send the purge into the
  //  model instead (flush_into_infill below); this kernel defaults to TRUE because until that option existed the
  //  tower was the only place the purge could go, and flipping the default would silently change every existing
  //  multi-material slice. The UI offers all three destinations.
  bool   enable_prime_tower=true;
  // Purge into the model's own sparse infill instead of a tower (upstream flush_into_infill). The material is not
  //  thrown away — it is printed where nobody sees it — but it only works where the layer HAS sparse infill to
  //  give, so what a layer cannot absorb still needs a tower.
  bool   flush_into_infill=false;
  std::vector<double> flush_volumes_matrix;
  double flush_multiplier=1.0;                          // upstream scales the whole table by this
  double prime_volume=0.0;                              // extra volume primed on every change, on top of the pair's
  // How much filament a change from `from` to `to` has to purge, in mm³. Returns <0 when the host sent no table,
  //  which the caller reads as "keep the fixed tower you always printed".
  double flushVolume(int from, int to, int extruderCount) const {
    const int n = extruderCount > 0 ? extruderCount : 1;
    const size_t idx = (size_t)from * (size_t)n + (size_t)to;
    if ((int)flush_volumes_matrix.size() < n * n || idx >= flush_volumes_matrix.size()) return -1.0;
    const double mult = flush_multiplier > 1e-6 ? flush_multiplier : 1.0;
    return std::max(0.0, flush_volumes_matrix[idx] * mult + prime_volume);
  }
  // Per-filament material identity and physical constants. Upstream carries all of these as one entry per filament
  //  and reports them in the G-code footer; the kernel needs density/cost only to turn extruded millimetres into
  //  the grams and currency a user actually reasons about, and the type only to make the two decisions upstream
  //  makes by material name (PETG's extra unretract, TPU on the first layer).
  std::vector<std::string> filament_type, filament_settings_id;
  std::vector<double> filament_density;      // g/cm3, per filament
  std::vector<double> filament_max_volumetric_speed;   // mm³/s, per filament; empty = no cap (GW::capped_feed)
  std::vector<double> filament_cost;         // currency per kg, per filament
  // Upstream always writes the per-filament totals and the config dump. Here they are opt-in, because every byte the
  //  default path emits is pinned by golden.mjs — the viewer turns them on, so the shipped app matches upstream
  //  while `slice()` with a bare params object still produces exactly the G-code it always did.
  bool   gcode_stats_block=false;            // ; filament used [mm]/[cm3]/[g], cost, total filament change
  bool   gcode_config_block=false;           // ; CONFIG_BLOCK_START … the parameters this slice ran with … END
  // Upstream's ;TYPE:<role> tag on every role change (GCodeProcessor reserved tag), written from the same role the
  //  toolpath stream records, so a G-code read back as TEXT (an opened .gcode / .gcode.3mf) colours as the slice did.
  //  Opt-in for the same reason as the two blocks above: the default G-code is pinned by golden.mjs.
  bool   gcode_role_tags=false;              // ;TYPE:<role> on every role change (upstream GCodeProcessor tag)
  std::string params_json;                   // the raw params object, for the config block above
  int    physicalExtruderOf(int tool) const {          // tool (0-based) -> physical extruder (0-based)
    return (tool >= 0 && tool < (int)filament_map.size()) ? std::max(0, (int)filament_map[tool] - 1) : tool;
  }
  bool   auto_center=false;                             // stage 28: true = realign the combined bbox to the origin (stage-3 legacy). false (default) = trust the viewer coordinates (no realignment, only Z seating) -> the toolpath overlaps the on-screen model exactly. Upstream = only the plate origin offset (GCode.cpp:932).
  // Stage 33: the default switched to true. Evidence (compare_wipetower.mjs measurements, 2-box MM):
  //  the real path succeeded on 49/49 layers without a fallback, purge volumes are actually computed (filament 1098 -> 4902mm),
  //  the upstream G-code structure is emitted (343 CP TOOLCHANGE/WIPE_TOWER markers), and there is no performance penalty (25ms vs 31ms).
  //  The old false path (three 15mm square rings) is decoration with no notion of purging and unfit for real G-code — kept only as a fallback.
  // Default OFF again. The ported WipeTower is NOT deterministic: slicing the same input three times in one
  //  process produced three different G-code files, differing only in feedrates — 76, 50 and 42 lines of "F0"
  //  respectively, while the filament total (1566.2021 mm) and segment count (2210) were identical every time.
  //  F0 is not a feedrate a printer accepts, and a slicer that cannot reproduce its own output cannot be diffed
  //  or trusted. The fallback ring is deterministic (measured: three identical runs, zero F0 lines), so it is
  //  what runs unless a caller explicitly asks for the real tower. See the [wipe tower] invariants in test.mjs.
  //  Suspected cause: set_extruder() reads ~14 per-filament config vectors with get_at(idx) for idx 0 and 1, and
  //  config_bridge.cpp sizes only three of them to two entries — extruder_printable_height is even left empty.
  bool   wipe_tower_real=false;                         // stage 12: use the real WipeTower.generate() on MM changes instead of the stage-6 square ring
  double prime_tower_width=30.0;                        //  width of the real WipeTower (mm). Separate from the square ring width (15).
  // New in stage 7 (the real Arachne port)
  std::string wall_generator="classic";                // classic|arachne (arachne = the real ported WallToolPaths)
  // The classic wall generator (classic_bridge.cpp, the port of upstream process_classic). Each default is upstream's
  //  schema default, because a key the settings map leaves out has to slice the way upstream does.
  bool   detect_thin_wall=false;                        // detect_thin_wall: medial-axis thin walls where one loop does not fit
  std::string wall_sequence="inner wall/outer wall";   // wall_sequence (inner wall/outer wall | outer wall/inner wall | inner-outer-inner wall)
  std::string wall_direction="ccw";                    // wall_direction (ccw | cw)
  double filter_out_gap_fill=0.0;                       // filter_out_gap_fill (mm): gap fill shorter than this is dropped
  std::vector<double> gap_infill_speed;                 // gap_infill_speed (mm/s, per extruder): a first entry of 0 turns gap fill off (upstream has_gap_fill); empty = the schema's 30
  bool   has_gap_fill() const { return forTool(gap_infill_speed, 0, 30.0) > 0; }   // PerimeterGenerator.cpp:1205, the wall filament's entry
  double infill_wall_overlap=15.0;                      // infill_wall_overlap (percent)
  double top_bottom_infill_wall_overlap=25.0;           // top_bottom_infill_wall_overlap (percent, first and topmost layer)
  bool   precise_outer_wall=true;                       // precise_outer_wall
  bool   only_one_wall_first_layer=false;               // only_one_wall_first_layer
  bool   alternate_extra_wall=false;                    // alternate_extra_wall
  // New in stage 8 (the real PressureEqualizer port)
  //  ⚠ pe_lite=true by default: the real PE only adjusts flow in g-code carrying OrcaSlicer's ;_EXTRUDE_SET_SPEED tags, and
  //    this mini kernel emits plain g-code, so the real PE passes through (no-op). Hence the effective PE-lite is
  //    the default and the real PE is opt-in via pe_lite=false (port/link/run/E-preservation verified; the tag requirement is recorded as a limitation).
  bool   pe_lite=true;                                  // true = the effective PE-lite (default), false = the ported real PE (tagged g-code)
  double extrusion_rate_slope_segment_length=1.0;       // segment split length for the real PE (mm)
  bool   pe_external_perimeter_only=false;              // real PE: smooth outer walls only
  // Stage 9: full real PE integration — the kernel emits the OrcaSlicer tags (;_EXTRUDE_SET_SPEED/;_EXTRUDE_END/;_EXTRUSION_ROLE)
  bool   emit_pe_tags=false;                            // emit PE tags on extrusion runs (enabled automatically when the real PE is used). Default false (backwards compatible)
  bool   pe_strip_tags=true;                            // strip the tags from the final output after real PE post-processing
  // Stage 10: machine limits for the time estimate (upstream machine_max_*/machine_min_*, defaulting to representative profile values). Tunable.
  double machine_accel_print=5000, machine_accel_travel=5000, machine_accel_retract=5000; // mm/s²
  double machine_jerk_xy=9.0, machine_jerk_z=0.4, machine_jerk_e=2.5;                       // mm/s
  double machine_max_speed_xy=500, machine_max_speed_z=12, machine_max_speed_e=30;          // mm/s
  double machine_max_accel_xy=5000, machine_max_accel_z=500, machine_max_accel_e=5000;      // mm/s² (machine_max_acceleration_*) — per-axis ceiling, distinct from the accel_* feedrates above
  // Stage 13: time estimation engine. full = the real ported GCodeProcessor itself (the new default), transcribed = the stage-10 gcode_time transcription.
  std::string time_engine="full";
  // Stage 30: economy mode — the last rung of the OOM retry ladder that still finishes. Skips emitting preview toolpaths (empty arrays)
  //  and the time estimate (r.moves would stay resident in bulk) -> only G-code is streamed out to the end. Effective only on the
  //  streaming path with a layer sink installed (default false — no effect on the batch path).
  bool   economy=false;
  // G003 incremental: decided and requested by the viewer (invalidation-map). 0 = full, 1 = reuse geometry (tris), 2 = reuse through support (L[]).
  int    reuse_stages=0;
  bool   keep_stages=false;                             // keep the stages cached after slicing (skips the early release — a memory trade-off)
  bool   arachne_dump=false;   // temporary diagnostic: dump the PASS1 arachne input polygons to stderr
};

Params parse_params(const std::string& j);
