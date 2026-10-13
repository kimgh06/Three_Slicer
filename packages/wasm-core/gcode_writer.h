// gcode_writer.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  Header-only (like clip_util.h / slice_planes.h): GW's members are all defined inside the struct,
//  and the fixed-point formatters they call keep their original `static inline` linkage.
#pragma once
#include "arcfit_bridge.h"
#include "clip_util.h"
#include "geom_helpers.h"
#include "machine_writer.h"
#include "params.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

// The slots a layer's custom G-code goes into (custom_gcode.cpp custom_gcode_layer): before_layer_change_gcode ahead
//  of the layer's Z move, the timelapse and layer_change_gcode after it — upstream's GCode::process_layer order.
//  The writers only mark them, because the template session is single-threaded and the parallel writers are not.
static const char* const BEFORE_LAYER_SLOT = ";_BEFORE_LAYER_CHANGE_SLOT";
static const char* const AFTER_LAYER_SLOT = ";_AFTER_LAYER_CHANGE_SLOT";
// A tool change on a printer with custom G-code (custom_gcode_toolchanges): the line names the change by its index.
static const char* const TOOLCHANGE_SLOT = ";_TOOLCHANGE_SLOT ";

struct GWBedOverflow {
  double x = 0.0, y = 0.0, z = 0.0;
  bool any() const { return x > 0.0 || y > 0.0 || z > 0.0; }
};

// ---- G-code writer (relative E, z_hop, parameterized retraction) ----------------
// (performance) Fixed-point formatter for the G-code hot path — ~5x faster than snprintf (fmt_bench2 measurements: 2 datasets x 2 runs, 0 mismatches out of 2M).
//  At a rounding boundary (|frac−0.5|<1e-6) it returns nullptr -> the caller falls back to snprintf, guaranteeing byte-identical output.
//  The sign comes from signbit(v) (including −0.0) — matching snprintf's "-0.000" output.
static const long long FMT_P10[] = {1,10,100,1000,10000,100000};
static inline char* fmt_fixed_safe(char* out, double value, int precision) {
  double magnitude = std::fabs(value);
  double scaled  = magnitude * FMT_P10[precision];
  double fraction = scaled - std::floor(scaled);
  if (fraction > 0.5 - 1e-6 && fraction < 0.5 + 1e-6) return nullptr;   // rounding boundary -> snprintf fallback
  long long rounded = (long long)llround(scaled);
  if (std::signbit(value)) *out++ = '-';
  long long integerPart = rounded / FMT_P10[precision];
  long long fractionPart = rounded % FMT_P10[precision];
  char digits[24];
  int digitCount = 0;
  do {
    digits[digitCount++] = (char)('0' + integerPart % 10);
    integerPart /= 10;
  } while (integerPart);
  while (digitCount) *out++ = digits[--digitCount];
  *out++ = '.';
  for (int k = precision - 1; k >= 0; --k) {
    out[k] = (char)('0' + fractionPart % 10);
    fractionPart /= 10;
  }
  return out + precision;
}
static inline char* fmt_i(char* out, int value) {
  if (value < 0) {
    *out++ = '-';
    value = -value;
  }
  char digits[12];
  int digitCount = 0;
  do {
    digits[digitCount++] = (char)('0' + value % 10);
    value /= 10;
  } while (value);
  while (digitCount) *out++ = digits[--digitCount];
  return out;
}

struct GW {
  bool dry=false;   // G003 E1 dry run: skips strings/toolpaths and only updates position, curF, fan and seam state (to chain the entry state)
  std::string s;
  double px=0, py=0, z=0;
  double e_per_mm=0, filament=0;
  long   segments=0;
  // Extent of everything actually EXTRUDED, in model coordinates (the G-code adds offX/offY on the way out).
  //  The model's own bbox cannot answer "does this print fit on the bed": support, skirt, brim and the raft are
  //  generated during slicing and reach past it. Upstream asks the same question of the finished G-code
  //  (BuildVolume::all_paths_inside over GCodeProcessorResult::moves), which is what makes it indifferent to
  //  WHICH feature produced a path. Travels are excluded there and here — only extrusions have to stay on the bed.
  double exMinX=1e18, exMaxX=-1e18, exMinY=1e18, exMaxY=-1e18, exMaxZ=-1e18;
  inline void note_xy(double x, double y) {
    if (x < exMinX) exMinX = x;
    if (x > exMaxX) exMaxX = x;
    if (y < exMinY) exMinY = y;
    if (y > exMaxY) exMaxY = y;
    if (z > exMaxZ) exMaxZ = z;   // the layer z this extrusion is being written at
  }
  bool extruded_anything() const { return exMaxX >= exMinX; }
  int    curF=-1;
  double retract_len=0.8;                    // mm
  int    retractF=1800;                      // mm/min
  double retract_min_travel=2.0;             // stage 33: retraction_minimum_travel (formerly the TRAVEL_RETRACT_MIN constant)
  double z_hop=0.0;
  double offX=128.0, offY=128.0;   // G-code XY offset = the bed centre in printer coordinates (Params::bed_center_x/y)
  // Upstream's E modes and firmware retraction (GCodeWriter.cpp _retract/unretract/reset_e). The defaults are the
  //  kernel's own relative E with E-move retractions, which every caller before these keys got.
  Flavor flavor=Flavor::Unset;
  bool   absolute_e=false;          // M82: every E word is the running position, reset by G92 E0 after a retraction
  double e_pos=0.0;                 // the running E position in absolute mode
  bool   firmware_retraction=false; // G10/G11 instead of E moves
  double z_offset=0.0;              // added to every Z written (upstream's z_offset)
  // Upstream's per-role acceleration and jerk (GCode::_extrude :7289-7342, travel_to :8285-8333): what each role and
  //  travel prints at, resolved once from the profile (gw_setup_motion, emit.cpp) as [on_first_layer][role], and the
  //  writer's dedupe state (GCodeWriter m_last_acceleration / m_last_travel_acceleration / m_last_jerk). Both off — the
  //  host sent no default_acceleration / default_jerk — writes nothing, as every caller before these keys got.
  bool     motion_accel=false, motion_jerk=false, motion_bbl=false;
  unsigned role_accel[2][16] = {};
  double   role_jerk[2][16] = {};
  unsigned travel_accel[2] = {0, 0};
  double   travel_jerk[2] = {0, 0};
  unsigned short_travel_accel=0;  // a short travel ahead of the outer wall moves at the wall's acceleration (Orca)
  double   short_travel_jerk=0;
  int      outer_wall_role=0;     // FlowRole::OuterWall's index, for that rule
  int      inner_wall_role=1;     // FlowRole::InnerWall's index (the small perimeter rule)
  // Upstream's small perimeter rule (GCode::extrude_loop :6667): a wall loop no longer than 2*pi*small_perimeter_threshold
  //  prints at small_perimeter_speed — on the first layer the first layer's speed wins, as it does upstream. 0 = off.
  double   small_perimeter_length=0.0;
  int      small_perimeter_feed=0;
  int loop_feed(double loopLength, int fPrint) const {
    if (small_perimeter_length <= 0 || on_first_layer) return fPrint;
    if (feature_role != outer_wall_role && feature_role != inner_wall_role) return fPrint;
    if (loopLength > small_perimeter_length) return fPrint;
    return small_perimeter_feed;
  }
  int      feature_role=0;        // the role being printed (set_feature)
  unsigned max_accel=0, max_travel_accel=0;   // the writer's clamps, 0 = none
  double   max_jerk_x=0, max_jerk_y=0, jerk_z=0, jerk_e=0;
  bool     accel_to_decel=false;
  double   accel_to_decel_factor=50.0;
  unsigned last_accel=0, last_travel_accel=0;
  double   last_jerk=0;
  void set_feature(int role) { feature_role = role; }
  // GCodeWriter::set_print_acceleration / set_travel_acceleration + set_jerk_xy, or Klipper's set_accel_and_jerk.
  //  Runs in the dry pass too (raw() writes nothing there), so the state the parallel writers start from is right.
  void apply_motion(unsigned accel, double jerk, bool travel) {
    if (!motion_accel) accel = 0;
    if (!motion_jerk) jerk = 0;
    if (accel == 0 && jerk == 0) return;
    if (flavor == Flavor::Klipper) {
      if (max_accel > 0 && accel > max_accel) accel = max_accel;
      if (max_jerk_x > 0 && jerk > max_jerk_x) jerk = max_jerk_x;
      if (max_jerk_y > 0 && jerk > max_jerk_y) jerk = max_jerk_y;
      const bool setAccel = accel != 0 && accel != last_accel;
      const bool setJerk = jerk > 0.01 && std::fabs(jerk - last_jerk) > 1e-10;
      if (setAccel) last_accel = accel;
      if (setJerk) last_jerk = jerk;
      raw_lines(machine_klipper_velocity_limit(setAccel, accel, accel_to_decel, accel_to_decel_factor, setJerk, jerk));
      return;
    }
    if (!travel && max_accel > 0 && accel > max_accel) accel = max_accel;
    if (travel && max_travel_accel > 0 && accel > max_travel_accel) accel = max_travel_accel;
    const bool separate = travel && machine_separate_travel_acceleration(flavor);
    unsigned* lastValue = &last_accel;
    if (separate) lastValue = &last_travel_accel;
    if (accel != 0 && accel != *lastValue) {
      *lastValue = accel;
      raw_lines(machine_acceleration_text(accel, separate, flavor, accel_to_decel, accel_to_decel_factor));
    }
    if (jerk >= 0.01 && std::fabs(jerk - last_jerk) > 1e-10) {
      last_jerk = jerk;
      raw_lines(machine_jerk_text(jerk, flavor, max_jerk_x, max_jerk_y, motion_bbl, jerk_z, jerk_e));
    }
  }
  void apply_print_motion() {
    const int layer = on_first_layer;
    apply_motion(role_accel[layer][feature_role], role_jerk[layer][feature_role], false);
  }
  void apply_travel_motion(double distance) {
    const int layer = on_first_layer;
    unsigned accel = travel_accel[layer];
    double jerk = travel_jerk[layer];
    if (!on_first_layer && feature_role == outer_wall_role && distance < retract_min_travel) {
      accel = short_travel_accel;
      jerk = short_travel_jerk;
    }
    apply_motion(accel, jerk, true);
  }
  // The E word of an extrusion of dE: dE itself in relative mode, the position after it in absolute mode.
  double e_word(double deltaE) {
    if (!absolute_e) return deltaE;
    e_pos += deltaE;
    return e_pos;
  }
  // The Z move that starts a layer. In absolute mode the layer also starts from E0 (G92 E0) — upstream resets after
  //  every retraction instead, which leaves the machine in the same state; resetting here as well lets each layer
  //  writer of the parallel path (slicer_core.cpp) start from a known position.
  bool layer_slots=false;   // the printer has layer templates (custom_gcode_layer_slots)
  void layer_z(double zLayer, int fTravel) {
    if (layer_slots) raw(BEFORE_LAYER_SLOT);
    char line[64];
    std::snprintf(line, sizeof line, "G1 Z%.3f F%d", zLayer + z_offset, fTravel);
    raw(line);
    if (absolute_e) {
      raw("G92 E0");
      e_pos = 0.0;
    }
    if (layer_slots) {
      raw(AFTER_LAYER_SLOT);
      // A layer template may set the acceleration or jerk itself (upstream invalidates the writer's state after any
      //  custom G-code that does, GCode::placeholder_parser_process): the next move states them again.
      last_accel = 0;
      last_travel_accel = 0;
      last_jerk = 0;
    }
    // The cooling filter takes a layer at a time: an open role fan region is opened again on the new layer.
    fan_marker_on[0] = fan_marker_on[1] = fan_marker_on[2] = false;
    last_extrusion_role = -1;
  }
  int    lastFan=-1;               // current cooling fan value (M106 only on change)
  bool   arc_fitting=false;        // G2/G3 arc fitting
  double arc_resolution=0.01;     // the print's `resolution` (mm): the arc fitting tolerance outside sparse infill and support
  double scarf_len=10.0;           // length of the scarf seam ramp (mm)
  // Stage 6: PE-lite (limit on the volumetric flow change rate between adjacent extrusions)
  double pe_slope=0.0;             // mm³/s² (0=off)
  double filament_area=2.405;      // π·d²/4 (set in the preamble)
  // Multi-material: the flow math has to follow the tool currently loaded, not the single material Params names.
  //  Set next to filament_area at preamble time and re-set on every tool change; the defaults match the Params
  //  defaults so a caller that never touches them is unchanged.
  double tool_filament_diameter=1.75;
  double tool_flow_ratio=1.0;
  // Currently loaded tool, so support_filament can print support with a different extruder. tool<0 means "keep the
  //  current one" (the upstream 0 = Default), and a T is written only on an actual change — with the defaults
  //  nothing is ever emitted and the single-material G-code is byte-identical to before.
  int    cur_tool=0;
  void set_tool(int tool){
    if (tool < 0 || tool == cur_tool) return;
    cur_tool = tool;
    char command[16];
    std::snprintf(command, sizeof command, "T%d", tool);
    raw(command);
  }
  double last_vol_flow=-1.0;       // previous extrusion volumetric flow in mm³/s (reset at layer start, not reset by travels)
  static constexpr int MIN_FEED=60;  // mm/min: the slowest feed pe_feed and capped_feed write (1 mm/s)
  // Upstream's flow multipliers on top of the filament's own (GCode.cpp:7343-7390): print_flow_ratio for every path,
  //  the role's ratio set by the emitter before each feature (role_flow_ratio, emit.cpp), and scarf_joint_flow_ratio
  //  on the sloped scarf ramps. All 1.0 unless the host sends the keys, and a product with 1.0 is exact, so the
  //  G-code without them is byte-identical. on_first_layer is upstream's on_first_layer(): the first printed layer,
  //  the raft's when there is one.
  double print_flow=1.0, role_flow=1.0, scarf_flow=1.0;
  bool   on_first_layer=false;
  // A new role ratio for a feature that keeps the current width: the current flow is rescaled rather than recomputed
  //  (a recompute from the float ribbon width would move E even with every ratio at 1; x / 1.0 * 1.0 is exact).
  void set_role_flow(double next) {
    e_per_mm = e_per_mm / role_flow * next;
    role_flow = next;
  }
  // The loaded filament's filament_max_volumetric_speed (mm³/s); 0 = no cap, the value when the host sends none.
  double max_vol_speed=0.0;
  // Upstream's volumetric cap (GCode.cpp:7492): speed = min(speed, filament_max_volumetric_speed / mm3_per_mm), with
  //  mm3_per_mm the flow-scaled cross-section — here e_per_mm * filament_area, which already carries the flow ratio.
  //  Rounded down so the written F never exceeds the cap. Every extrusion entry point calls it, the dry run included,
  //  so curF chains to the value a real emit leaves.
  int capped_feed(int fPrint) const {
    if (max_vol_speed <= 0.0) return fPrint;
    const double crossSection = e_per_mm * filament_area;
    if (crossSection <= 1e-9) return fPrint;
    int fMax = (int)std::floor(max_vol_speed / crossSection * 60.0);
    if (fMax < MIN_FEED) fMax = MIN_FEED;
    return std::min(fPrint, fMax);
  }
  // Stage 6: wall-avoiding travel
  Paths  island;                   // region travels should stay inside (inside the walls). Empty means no check.
  // reduce_infill_retraction (GCode::needs_retraction): a travel that stays inside the layer's internal region (the
  //  slice minus its top and bottom surfaces) and leads to something other than a wall is not retracted, unless the
  //  last extrusion was the outer wall. Empty = the option is off or the layer has no internal region.
  Paths  internal_area;
  int    last_extrusion_role=-1;   // reset on every layer (layer_z), so the parallel writers start where st starts
  bool   avoid_walls=false;
  long   wall_crossings=0;         // number of travels that actually crossed a wall (for cross-checking)
  // Upstream's ;TYPE: role tag (Params::gcode_role_tags). `type` is the kernel's toolpath type, the value push_seg
  //  records into the stream (0=travel … 11=prime tower, emit.cpp), so the text and the stream name the same role.
  //  Stated again after every layer marker, because a reader keyed on layers (gcode_parse.js) resets its role there.
  //  Upstream's own names where one exists; upstream folds raft into Support and thin walls into walls, which would
  //  recolour both on a read-back here, so those two keep names of their own (upstream reads them as Undefined).
  bool   emit_role_tags=false;
  int    tag_type=-1;
  void role_tag(int type){
    if (!emit_role_tags || dry || type <= 0 || type == tag_type) return;
    static const char* const NAMES[] = { "", "Outer wall", "Sparse infill", "Internal solid infill", "Skirt", "Support",
      "Raft", "Gap infill", "Thin wall", "Bridge", "Ironing", "Prime tower" };
    if (type >= (int)(sizeof NAMES / sizeof NAMES[0])) return;
    tag_type = type;
    s += ";TYPE:";
    s += NAMES[type];
    s += '\n';
  }
  void role_tag_unknown(){ tag_type = -1; }
  // The temperature switch of the second printed layer (second_layer_temperatures, preamble.cpp), set once the
  //  preamble knows what it left the printer at. Copied with the writer into the parallel layer writers, and written
  //  by whichever of them starts the second printed layer (second_layer_begin).
  std::string second_layer_text;
  void second_layer_begin(){ raw_lines(second_layer_text); }
  void layer_begin(const char* marker){
    raw(marker);
    tag_type = -1;
  }
  // Stage 9: emitting the real PE tags (OrcaSlicer format)
  bool   emit_pe_tags=false;
  int    pe_cur_role=-1;
  char   buf[200];
  void pe_reset(){ last_vol_flow=-1.0; }
  // Start an extrusion run: ;_EXTRUSION_ROLE on a role change, then G1 F<v> ;_EXTRUDE_SET_SPEED (opening the block)
  //  curF is set to f so later extrusion G1s omit F (inheriting the SET_SPEED speed) — PE adjusts the flow within the block.
  void pe_begin_run(int role, int feed){
    if (!emit_pe_tags) return;
    if (role != pe_cur_role) {
      std::snprintf(buf,sizeof buf,";_EXTRUSION_ROLE:%d",role);
      raw(buf);
      pe_cur_role=role;
    }
    feed = capped_feed(feed);
    std::snprintf(buf,sizeof buf,"G1 F%d ;_EXTRUDE_SET_SPEED",feed);
    raw(buf);
    curF=feed;
  }
  void pe_end_run(){ if (emit_pe_tags) raw(";_EXTRUDE_END"); }
  // PE-lite: limits the volumetric flow change rate (mm³/s²) between adjacent extrusions. With segment time Δt=d/v_n and v_n=Fn/A,
  //  slope = |Fn−Fl|·Fn/(d·A) ≤ pe_slope, S=pe_slope·d·A.
  //  acceleration (Fn>Fl): the Fn ceiling = (Fl+√(Fl²+4S))/2.  deceleration (Fn<Fl): inside a steep drop band (lo,hi), clamp to hi (the minimum drop).
  //  An approximation that adjusts only the per-segment speed at emission time, without splitting segments.
  int pe_feed(double distance, int requestedFeed){
    double crossSection=e_per_mm*filament_area;
    double requestedSpeed=requestedFeed/60.0;
    double desiredFlow=crossSection*requestedSpeed;
    if (pe_slope<=0.0 || last_vol_flow<0.0 || distance<1e-6 || crossSection<=1e-9) {
      last_vol_flow=desiredFlow;
      return requestedFeed;
    }
    double lastFlow=last_vol_flow;
    double nextFlow=desiredFlow;
    double slopeBudget=pe_slope*distance*crossSection;
    if (desiredFlow > lastFlow) {                           // acceleration (more flow)
      double ceiling=(lastFlow+std::sqrt(lastFlow*lastFlow+4.0*slopeBudget))/2.0;
      if (nextFlow>ceiling) nextFlow=ceiling;
    } else if (desiredFlow < lastFlow) {                    // deceleration (less flow)
      double discriminant=lastFlow*lastFlow-4.0*slopeBudget;
      if (discriminant>0) {
        double root=std::sqrt(discriminant);
        double upper=(lastFlow+root)/2.0;
        double lower=(lastFlow-root)/2.0;
        if (nextFlow>lower && nextFlow<upper) nextFlow=upper;
      }
    }
    int feed=(int)std::llround((nextFlow/crossSection)*60.0);
    if (feed<MIN_FEED) feed=MIN_FEED;
    last_vol_flow=crossSection*(feed/60.0);
    return feed;
  }
  void set_e_per_mm(double layerHeight, const Params& params) {
    double crossSection = layerHeight * (params.line_width - layerHeight * (1.0 - PI/4.0));
    double toolFilamentArea = PI * tool_filament_diameter * tool_filament_diameter / 4.0;
    e_per_mm = crossSection / toolFilamentArea * tool_flow_ratio * print_flow * role_flow;
  }
  // Stage 7: sets the flow for an arbitrary width (variable-width Arachne walls). Cross-section A = h·(w − h·(1−π/4)).
  void set_e_per_mm_width(double width, double layerHeight, const Params& params) {
    double crossSection = layerHeight * (width - layerHeight * (1.0 - PI/4.0));
    if (crossSection < 0) crossSection = 0;
    double toolFilamentArea = PI * tool_filament_diameter * tool_filament_diameter / 4.0;
    e_per_mm = crossSection / toolFilamentArea * tool_flow_ratio * print_flow * role_flow;
  }
  // WP3: sets the upstream volumetric flow (mm³/mm, ExtrusionPath::mm3_per_mm) directly — lets tree support reproduce the flow
  //  computed by the upstream Flow verbatim (including cases where it differs from the rectangular width x height approximation, such as bridging contact layers).
  void set_e_per_mm_vol(double mm3PerMm, const Params& params) {
    if (mm3PerMm < 0) mm3PerMm = 0;
    double toolFilamentArea = PI * tool_filament_diameter * tool_filament_diameter / 4.0;
    e_per_mm = mm3PerMm / toolFilamentArea * tool_flow_ratio * print_flow * role_flow;
  }
  void raw(const char* line){
    if (dry) return;
    s += line;
    s += '\n';
  }
  // A multi-line block (a printer profile's custom G-code), one raw line per line; empty lines are dropped.
  void raw_lines(const std::string& text) {
    for (size_t start = 0, size = text.size(); start <= size; ) {
      size_t end = text.find('\n', start);
      if (end == std::string::npos) end = size;
      if (end > start) raw(text.substr(start, end - start).c_str());
      start = end + 1;
    }
  }
  // Hot-path line emission — when the fast path (fixed point) fails, fall back to the original snprintf format (byte-identical).
  inline void line_xyf(const char* head, double xValue, double yValue, int feed, const char* fallbackFormat) {
    char* cursor = buf;
    size_t headLength = strlen(head);
    memcpy(cursor, head, headLength);
    cursor += headLength;
    char* end = fmt_fixed_safe(cursor, xValue, 3);
    if (end) {
      memcpy(end, " Y", 2);
      end = fmt_fixed_safe(end+2, yValue, 3);
    }
    if (end) {
      memcpy(end, " F", 2);
      end = fmt_i(end+2, feed);
      *end = '\0';
      raw(buf);
      return;
    }
    std::snprintf(buf, sizeof buf, fallbackFormat, xValue, yValue, feed);
    raw(buf);
  }
  inline void line_vf(const char* head, double value, int precision, int feed, const char* fallbackFormat) {
    char* cursor = buf;
    size_t headLength = strlen(head);
    memcpy(cursor, head, headLength);
    cursor += headLength;
    char* end = fmt_fixed_safe(cursor, value, precision);
    if (end) {
      memcpy(end, " F", 2);
      end = fmt_i(end+2, feed);
      *end = '\0';
      raw(buf);
      return;
    }
    std::snprintf(buf, sizeof buf, fallbackFormat, value, feed);
    raw(buf);
  }
  // Straight travel including retraction (upstream behavior)
  void travel_raw(double x, double y, int fTravel) {
    double distance = std::hypot(x-px, y-py);
    if (distance < 1e-6) return;
    // Firmware retraction retracts whatever length is configured, 0 included (GCodeWriter::_retract's "fake 1").
    bool retract = distance > retract_min_travel && (retract_len > 0 || firmware_retraction);
    if (retract) {
      retract_move();
      if (z_hop > 0) line_vf("G1 Z", z + z_hop + z_offset, 3, fTravel, "G1 Z%.3f F%d");
    }
    line_xyf("G0 X", x+offX, y+offY, fTravel, "G0 X%.3f Y%.3f F%d");
    if (retract) {
      if (z_hop > 0) line_vf("G1 Z", z + z_offset, 3, fTravel, "G1 Z%.3f F%d");
      unretract_move();
    }
    px=x;
    py=y;
    curF=-1;
  }
  // GCodeWriter::_retract / unretract: G10/G11 with firmware retraction, else an E move — relative, or in absolute
  //  mode the position minus the length followed by G92 E0 (reset_e), then the unretract back to +length.
  void retract_move() {
    if (firmware_retraction) {
      raw(machine_firmware_retract(flavor));
      return;
    }
    if (!absolute_e) {
      line_vf("G1 E-", retract_len, 4, retractF, "G1 E-%.4f F%d");
      return;
    }
    char line[64];
    std::snprintf(line, sizeof line, "G1 E%.5f F%d", e_pos - retract_len, retractF);
    raw(line);
    raw("G92 E0");
    e_pos = 0.0;
  }
  void unretract_move() {
    if (firmware_retraction) {
      raw(machine_firmware_unretract(flavor));
      if (absolute_e) {
        raw("G92 E0");
        e_pos = 0.0;
      }
      return;
    }
    if (!absolute_e) {
      line_vf("G1 E", retract_len, 4, retractF, "G1 E%.4f F%d");
      return;
    }
    char line[64];
    std::snprintf(line, sizeof line, "G1 E%.5f F%d", retract_len, retractF);
    raw(line);
    e_pos = retract_len;
  }
  // Detour move inside the material (no retraction — stays inside the material, the §6.5 desktop behavior)
  void travel_hop(double x, double y, int fTravel) {
    double distance = std::hypot(x-px, y-py);
    if (distance < 1e-6) return;
    line_xyf("G0 X", x+offX, y+offY, fTravel, "G0 X%.3f Y%.3f F%d");
    px=x;
    py=y;
    curF=-1;
  }
  // True when the straight line A->B lies entirely inside internal_area (RetractWhenCrossingPerimeters::
  //  travel_inside_internal_regions: diff_pl(travel, island).empty()).
  bool inside_internal_area(double startX, double startY, double endX, double endY) const {
    Path segment;
    segment.push_back(IntPoint((cInt)std::llround(startX*SCALE),(cInt)std::llround(startY*SCALE)));
    segment.push_back(IntPoint((cInt)std::llround(endX*SCALE),(cInt)std::llround(endY*SCALE)));
    Paths travelPaths;
    travelPaths.push_back(segment);
    return paths_len(clip_open(travelPaths, internal_area), false) >= std::hypot(endX-startX, endY-startY) - 1e-3;
  }
  // True when the straight line A->B lies (almost) entirely inside the island (inside the walls)
  bool seg_inside(double startX,double startY,double endX,double endY){
    if (island.empty()) return true;
    Path segment;
    segment.push_back(IntPoint((cInt)std::llround(startX*SCALE),(cInt)std::llround(startY*SCALE)));
    segment.push_back(IntPoint((cInt)std::llround(endX*SCALE),(cInt)std::llround(endY*SCALE)));
    Paths travelPaths;
    travelPaths.push_back(segment);
    double fullLength=std::hypot(endX-startX,endY-startY);
    double insideLength=paths_len(clip_open(travelPaths, island), false);
    return insideLength >= fullLength - 0.05;
  }
  // Detour along the island boundary: walk the boundary of the polygon nearest A from the vertex nearest A to the vertex nearest B (the shorter way)
  std::vector<DPt> detour_path(double startX,double startY,double endX,double endY){
    const Path* nearestPolygon=nullptr;
    double bestDistance=1e30;
    IntPoint startPoint((cInt)std::llround(startX*SCALE),(cInt)std::llround(startY*SCALE));
    for (const Path& candidate : island){
      if (candidate.size()<3 || Area(candidate)<=0) continue;       // outlines only (positive area)
      if (PointInPolygon(startPoint, candidate)!=0){
        nearestPolygon=&candidate;
        break;
      }
      for (const IntPoint& vertex:candidate){
        double distance=std::hypot(vertex.x()*INV-startX,vertex.y()*INV-startY);
        if(distance<bestDistance){
          bestDistance=distance;
          nearestPolygon=&candidate;
        }
      }
    }
    if (!nearestPolygon) return {};
    const Path& polygon=*nearestPolygon;
    int vertexCount=(int)polygon.size();
    auto nearestIndexOf=[&](double x,double y){
      int nearestIndex=0;
      double nearestDistance=1e30;
      for(int i=0;i<vertexCount;++i){
        double distance=std::hypot(polygon[i].x()*INV-x,polygon[i].y()*INV-y);
        if(distance<nearestDistance){
          nearestDistance=distance;
          nearestIndex=i;
        }
      }
      return nearestIndex;
    };
    int startIndex=nearestIndexOf(startX,startY);
    int endIndex=nearestIndexOf(endX,endY);
    if (startIndex==endIndex) return {};
    auto arcLength=[&](int direction){
      double length=0;
      int index=startIndex;
      while(index!=endIndex){
        int next=(index+direction+vertexCount)%vertexCount;
        length+=std::hypot((polygon[next].x()-polygon[index].x())*INV,(polygon[next].y()-polygon[index].y())*INV);
        index=next;
      }
      return length;
    };
    int direction = -1;
    if (arcLength(+1)<=arcLength(-1)) direction = +1;
    std::vector<DPt> waypoints;
    waypoints.push_back({polygon[startIndex].x()*INV, polygon[startIndex].y()*INV});
    int index=startIndex;
    while(index!=endIndex){
      index=(index+direction+vertexCount)%vertexCount;
      waypoints.push_back({polygon[index].x()*INV, polygon[index].y()*INV});
    }
    return waypoints;
  }
  // Smart travel: detect wall crossings -> detour along the boundary (when avoiding), otherwise a straight line and a crossing count
  // Fast guard (statistics only) — with avoid_walls=false the verdict only feeds the wall_crossings counter (no effect on G-code).
  //  Replaces Clipper clip_open (measured at ~20µs per travel, the single largest cost in the serial emission section) with an integer
  //  orientation intersection test plus an even-odd PIP on the midpoint. Only boundary cases (tangency, collinearity) may disagree with the clip verdict (counter error accepted).
  //  With avoid_walls=true the detour path (G-code) depends on the verdict -> the existing seg_inside (clip_open) is kept.
  bool seg_inside_fast(double startX,double startY,double endX,double endY){
    const cInt x1=(cInt)std::llround(startX*SCALE);
    const cInt y1=(cInt)std::llround(startY*SCALE);
    const cInt x2=(cInt)std::llround(endX*SCALE);
    const cInt y2=(cInt)std::llround(endY*SCALE);
    auto orient=[](cInt originX,cInt originY,cInt firstX,cInt firstY,cInt secondX,cInt secondY)->int{
      long long cross=(long long)(firstX-originX)*(long long)(secondY-originY)-(long long)(firstY-originY)*(long long)(secondX-originX);
      if (cross>0) return 1;
      return -(int)(cross<0);
    };
    for (const Path& polygon : island){
      size_t vertexCount=polygon.size();
      if (vertexCount<3) continue;
      for (size_t i=0;i<vertexCount;++i){
        const IntPoint& edgeStart=polygon[i];
        const IntPoint& edgeEnd=polygon[(i+1)%vertexCount];
        int edgeStartSide=orient(x1,y1,x2,y2,edgeStart.x(),edgeStart.y());
        int edgeEndSide=orient(x1,y1,x2,y2,edgeEnd.x(),edgeEnd.y());
        if (edgeStartSide*edgeEndSide>=0) continue;
        int segmentStartSide=orient(edgeStart.x(),edgeStart.y(),edgeEnd.x(),edgeEnd.y(),x1,y1);
        int segmentEndSide=orient(edgeStart.x(),edgeStart.y(),edgeEnd.x(),edgeEnd.y(),x2,y2);
        if (segmentStartSide*segmentEndSide<0) return false;   // proper intersection -> crosses the boundary
      }
    }
    IntPoint midpoint((x1+x2)/2,(y1+y2)/2);      // no crossing -> decide by whether the midpoint is inside
    int containingCount=0;
    for (const Path& polygon : island){
      int location=PointInPolygon(midpoint,polygon);
      if (location==-1) return true;
      if (location!=0) ++containingCount;
    }
    return (containingCount&1)==1;
  }
  void travel(double x, double y, int fTravel) {
    double distance = std::hypot(x-px, y-py);
    if (distance < 1e-6) return;
    apply_travel_motion(distance);
    if (dry) {                                   // G003: a detour ends at the same point -> position only
      px=x;
      py=y;
      curF=-1;
      return;
    }
    if (!internal_area.empty() && feature_role != outer_wall_role && feature_role != inner_wall_role &&
        last_extrusion_role != outer_wall_role && inside_internal_area(px, py, x, y)) {
      travel_hop(x, y, fTravel);
      return;
    }
    if (!island.empty()) {
      bool staysInside;
      if (avoid_walls) staysInside = seg_inside(px,py,x,y);
      else staysInside = seg_inside_fast(px,py,x,y);
      if (!staysInside) {
        if (avoid_walls) {
          std::vector<DPt> waypoints = detour_path(px,py,x,y);
          if (!waypoints.empty()) {
            for (auto& waypoint:waypoints) travel_hop(waypoint.x,waypoint.y,fTravel);
            travel_hop(x,y,fTravel);
            return;
          }
        }
        ++wall_crossings;                        // no detour / detour failed -> a real crossing
      }
    }
    travel_raw(x, y, fTravel);
  }
  void extrude(double x, double y, int fPrint) {
    if (!dry && checks_overhang_segments()) {
      // Each piece between two crossings is either over the layer below or not; its middle decides, and the fan
      //  follows. Pieces shorter than a quarter of the line width are not split off (upstream's min_spacing).
      const double startX = px;
      const double startY = py;
      const double length = std::hypot(x-startX, y-startY);
      std::vector<double> cuts;
      for (double fraction : overhang_crossings(startX, startY, x, y))
        if (fraction * length >= 0.25*line_width && (1 - fraction) * length >= 0.25*line_width && (cuts.empty() || (fraction - cuts.back()) * length >= 0.25*line_width))
          cuts.push_back(fraction);
      cuts.push_back(1.0);
      double from = 0.0;
      for (double to : cuts) {
        const double middleX = startX + (x-startX)*(from+to)/2;
        const double middleY = startY + (y-startY)*(from+to)/2;
        fan_marker(0, outside_overhang_area(middleX, middleY), "_OVERHANG");
        extrude_move(startX + (x-startX)*to, startY + (y-startY)*to, fPrint);
        from = to;
      }
      return;
    }
    extrude_move(x, y, fPrint);
  }
  void extrude_move(double x, double y, int fPrint) {
    double distance = std::hypot(x-px, y-py);
    if (distance < 1e-9) return;
    apply_print_motion();
    fPrint = capped_feed(fPrint);
    if (dry) {                                   // G003 dry run (assumes pe off — guarded in parallel mode)
      px=x;
      py=y;
      curF=fPrint;
      return;
    }
    last_extrusion_role = feature_role;
    int feed = pe_feed(distance, fPrint);        // PE-lite: apply the flow change rate limit (fPrint when off)
    double deltaE = e_per_mm * distance;
    filament += deltaE;
    ++segments;
    const double eWord = e_word(deltaE);
    note_xy(px, py);   // both ends: an open path's first point follows a travel, so it is noted nowhere else
    note_xy(x, y);
    char* cursor = buf;
    memcpy(cursor, "G1 X", 4);
    cursor += 4;
    cursor = fmt_fixed_safe(cursor, x+offX, 3);
    if (cursor) {
      memcpy(cursor, " Y", 2);
      cursor = fmt_fixed_safe(cursor+2, y+offY, 3);
    }
    if (cursor) {
      memcpy(cursor, " E", 2);
      cursor = fmt_fixed_safe(cursor+2, eWord, 5);
    }
    if (cursor) {                                // fast path succeeded — F only when it changes
      if (feed != curF) {
        memcpy(cursor, " F", 2);
        cursor = fmt_i(cursor+2, feed);
      }
      *cursor = '\0';
    } else if (feed != curF) std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f E%.5f F%d", x+offX,y+offY,eWord,feed);
    else                     std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f E%.5f",     x+offX,y+offY,eWord);
    curF = feed;
    raw(buf);
    px=x;
    py=y;
  }
  // For spiral mode: extrusion that raises Z as it goes
  void extrude_z(double x, double y, double nextZ, int fPrint) {
    double distance = std::hypot(x-px, y-py);
    if (distance < 1e-9) {
      z=nextZ;
      return;
    }
    apply_print_motion();
    fPrint = capped_feed(fPrint);
    double deltaE = e_per_mm * distance;
    filament += deltaE;
    ++segments;
    const double eWord = e_word(deltaE);
    note_xy(px, py);
    note_xy(x, y);
    if (nextZ > exMaxZ) exMaxZ = nextZ;     // z ramps within the move here, so the member z is one layer behind
    if (fPrint != curF) {
      std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f F%d", x+offX,y+offY,nextZ+z_offset,eWord,fPrint);
      curF=fPrint;
    } else {
      std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f",     x+offX,y+offY,nextZ+z_offset,eWord);
    }
    raw(buf);
    px=x;
    py=y;
    z=nextZ;
  }
  // For the scarf seam: extrusion applying both Z and flow (an E multiplier) (Z always written)
  void extrude_zf(double x, double y, double nextZ, double flowMul, int fPrint) {
    double distance = std::hypot(x-px, y-py);
    if (distance < 1e-9) {
      z=nextZ;
      return;
    }
    apply_print_motion();
    fPrint = capped_feed(fPrint);
    double deltaE = e_per_mm * distance * flowMul * scarf_flow;
    filament += deltaE;
    ++segments;
    const double eWord = e_word(deltaE);
    note_xy(px, py);
    note_xy(x, y);
    if (nextZ > exMaxZ) exMaxZ = nextZ;     // z ramps within the move here, so the member z is one layer behind
    if (fPrint != curF) {
      std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f F%d", x+offX,y+offY,nextZ+z_offset,eWord,fPrint);
      curF=fPrint;
    } else {
      std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f",     x+offX,y+offY,nextZ+z_offset,eWord);
    }
    raw(buf);
    px=x;
    py=y;
    z=nextZ;
  }
  // Cooling fan (M106 emitted only on change). With the cooling filter running the fan is the filter's to set.
  void set_fan(int fanValue) {
    if (cooling_markers) return;
    if (fanValue==lastFan) return;
    lastFan=fanValue;
    if (dry) return;
    std::snprintf(buf,sizeof buf,"M106 S%d",fanValue);
    raw(buf);
  }
  // Upstream's cooling markers around every extrusion path (GCode::_extrude :7767-8171) for the cooling filter
  //  (cooling_bridge.h), which reads and removes them: the speed line marked ;_EXTRUDE_SET_SPEED (and
  //  ;_EXTERNAL_PERIMETER on the outer wall), ;_EXTRUDE_END after the path, and the role fan regions — the overhang
  //  fan on bridges (and on the outer wall when overhang_fan_threshold is 0%), the support interface fan and the
  //  ironing fan, each opened and closed as the role changes and re-opened on a new layer. Off without the filter.
  bool cooling_markers=false;
  bool fan_overhang=false, fan_overhang_external=false, fan_support_interface=false, fan_ironing=false;
  int  bridge_role=6, support_interface_role=9, ironing_role=12;   // FlowRole indices (emit.h), set by gw_setup_motion
  bool fan_marker_on[3] = { false, false, false };                 // overhang, support interface, ironing
  // The overhang fan per wall segment (GCode::_extrude with ExtrusionQualityEstimator): a segment whose overlap with
  //  the layer below is at most the threshold gets it. overlap = 1 - (signed distance to the lower slice + w/2) / w, so
  //  "overlap <= t" is "outside the lower slice offset by w*(0.5 - t)"; that offset region is overhang_area, set per
  //  layer. Empty = not checked (first layer, threshold 0%, the fan off or no cooling filter).
  // ponytail: a segment is judged by its two ends against one region, the line width of the print (not each wall's
  //  own), and without upstream's curled-line distance or its smoothing between neighbouring points.
  Paths overhang_area;
  double line_width = 0.42;   // the print's line width (gw_setup_machine), the overhang pieces' scale
  bool outside_overhang_area(double x, double y) const {
    const IntPoint point((cInt)std::llround(x*SCALE), (cInt)std::llround(y*SCALE));
    int inside = 0;
    for (const Path& polygon : overhang_area) if (PointInPolygon(point, polygon) != 0) ++inside;
    return (inside & 1) == 0;
  }
  bool checks_overhang_segments() const {
    return cooling_markers && fan_overhang && !overhang_area.empty() &&
           (feature_role == outer_wall_role || feature_role == inner_wall_role);
  }
  // Where the segment A->B crosses overhang_area's boundary, as fractions of its length in (0, 1), ascending. Upstream
  //  adds these points to the path (estimate_points_properties ADD_INTERSECTIONS) so that only the part of a line
  //  that leaves the layer below gets the fan.
  std::vector<double> overhang_crossings(double startX, double startY, double endX, double endY) const {
    std::vector<double> cuts;
    const double dx = endX - startX;
    const double dy = endY - startY;
    for (const Path& polygon : overhang_area) {
      const size_t vertexCount = polygon.size();
      for (size_t k = 0; k < vertexCount; ++k) {
        const double edgeStartX = polygon[k].x()*INV;
        const double edgeStartY = polygon[k].y()*INV;
        const double edgeDeltaX = polygon[(k+1)%vertexCount].x()*INV - edgeStartX;
        const double edgeDeltaY = polygon[(k+1)%vertexCount].y()*INV - edgeStartY;
        const double denominator = dx*edgeDeltaY - dy*edgeDeltaX;
        if (std::fabs(denominator) < 1e-12) continue;
        const double segmentFraction = ((edgeStartX-startX)*edgeDeltaY - (edgeStartY-startY)*edgeDeltaX) / denominator;
        const double edgeFraction = ((edgeStartX-startX)*dy - (edgeStartY-startY)*dx) / denominator;
        if (segmentFraction > 1e-9 && segmentFraction < 1-1e-9 && edgeFraction >= 0 && edgeFraction <= 1) cuts.push_back(segmentFraction);
      }
    }
    std::sort(cuts.begin(), cuts.end());
    return cuts;
  }
  bool overhang_touches(double startX, double startY, double endX, double endY) const {
    return outside_overhang_area(startX, startY) || outside_overhang_area(endX, endY) || !overhang_crossings(startX, startY, endX, endY).empty();
  }
  void fan_marker(int which, bool on, const char* prefix) {
    if (on == fan_marker_on[which]) return;
    fan_marker_on[which] = on;
    const char* edge = "END";
    if (on) edge = "START";
    std::snprintf(buf, sizeof buf, ";%s_FAN_%s", prefix, edge);
    raw(buf);
  }
  void path_begin(int fPrint) {
    if (!cooling_markers) return;
    fPrint = capped_feed(fPrint);
    if (feature_role == outer_wall_role) std::snprintf(buf, sizeof buf, "G1 F%d;_EXTRUDE_SET_SPEED;_EXTERNAL_PERIMETER", fPrint);
    else                                 std::snprintf(buf, sizeof buf, "G1 F%d;_EXTRUDE_SET_SPEED", fPrint);
    raw(buf);
    curF = fPrint;
    bool overhang = fan_overhang && (feature_role == bridge_role || (fan_overhang_external && feature_role == outer_wall_role));
    fan_marker(0, overhang, "_OVERHANG");
    fan_marker(1, fan_support_interface && feature_role == support_interface_role, "_SUPP_INTERFACE");
    fan_marker(2, fan_ironing && feature_role == ironing_role, "_IRONING");
  }
  void path_end() { if (cooling_markers) raw(";_EXTRUDE_END"); }
  // Emit a continuous polyline (pts[0] = current position). G2/G3 with arc_fitting, otherwise G1.
  //  The arcs are upstream's ArcFitter (arcfit_bridge.cpp) at upstream's per-role tolerance (LayerRegion::simplify_path,
  //  Layer::simplify_support_path): SPARSE_INFILL_RESOLUTION for sparse infill, SUPPORT_RESOLUTION for support and raft,
  //  the print's `resolution` for everything else. `type` is the toolpath type the caller emits (emit.cpp).
  void extrude_run(const std::vector<DPt>& path, int fPrint, float type) {
    if (path.size() > 1) apply_print_motion();
    if (dry) {
      if (path.size()>1) {
        px=path.back().x;
        py=path.back().y;
        curF=capped_feed(fPrint);
      }
      return;
    }
    if (!arc_fitting) {
      for (size_t i=1;i<path.size();++i) extrude(path[i].x,path[i].y,fPrint);
      return;
    }
    // A wall path with an overhang goes out as G1 moves, as upstream's per-point branch does: an arc cannot carry a fan
    //  switch in its middle.
    if (checks_overhang_segments()) {
      bool touches = false;
      for (size_t k = 1; k < path.size() && !touches; ++k) touches = overhang_touches(path[k-1].x, path[k-1].y, path[k].x, path[k].y);
      if (touches) {
        for (size_t k = 1; k < path.size(); ++k) extrude(path[k].x, path[k].y, fPrint);
        return;
      }
    }
    extrude_fitted(path, fPrint, type);
  }
  void extrude_fitted(const std::vector<DPt>& path, int fPrint, float type) {
    // An arc stands for the points it was fitted to, so they never reach extrude() and its note_xy. Noting every
    //  input point here keeps the extent honest: the arc stays within the fitting tolerance of them.
    for (const DPt& point : path) note_xy(point.x, point.y);
    double tolerance = arc_resolution;
    if ((int)type == 2) tolerance = 0.04;                          // SPARSE_INFILL_RESOLUTION (libslic3r.h)
    if ((int)type == 5 || (int)type == 6) tolerance = 0.0375;      // SUPPORT_RESOLUTION
    std::vector<std::pair<double,double>> points;
    points.reserve(path.size());
    for (const DPt& point : path) points.emplace_back(point.x, point.y);
    std::vector<arcfit_bridge::Move> moves;
    arcfit_bridge::fit(points, tolerance, moves);
    for (const arcfit_bridge::Move& move : moves) {
      if (move.kind == arcfit_bridge::Linear) {
        for (size_t k=move.start+1; k<=move.end && k<path.size(); ++k) extrude(path[k].x, path[k].y, fPrint);
        continue;
      }
      if (move.length < 1e-9) continue;                            // upstream GCode.cpp skips a zero-length arc
      extrude_arc(path[move.end], move.centerX, move.centerY, move.length, move.kind == arcfit_bridge::ArcCounterClockwise, fPrint);
    }
  }
  // One G2/G3 from the current position to `end` around (centerX, centerY), E from upstream's arc length.
  void extrude_arc(DPt end, double centerX, double centerY, double length, bool counterClockwise, int fPrint) {
    apply_print_motion();
    fPrint = capped_feed(fPrint);
    double deltaE = e_per_mm*length;
    filament+=deltaE;
    ++segments;
    const double eWord = e_word(deltaE);
    double centerOffsetX=centerX-px;
    double centerOffsetY=centerY-py;
    const char* command = "G2";
    if (counterClockwise) command = "G3";
    if (fPrint!=curF){
      std::snprintf(buf,sizeof buf,"%s X%.3f Y%.3f I%.3f J%.3f E%.5f F%d",command,end.x+offX,end.y+offY,centerOffsetX,centerOffsetY,eWord,fPrint);
      curF=fPrint;
    } else {
      std::snprintf(buf,sizeof buf,"%s X%.3f Y%.3f I%.3f J%.3f E%.5f",   command,end.x+offX,end.y+offY,centerOffsetX,centerOffsetY,eWord);
    }
    raw(buf);
    px=end.x;
    py=end.y;
    last_extrusion_role = feature_role;
  }
};

// How far the EMITTED extrusions reach past the printable area, per axis in mm (0 on an axis that stays inside).
//  This is the check that sees support, skirt, brim, raft and the prime tower: all of them are produced during
//  slicing, so the model bbox prepare_model() measures cannot predict any of them. Upstream answers the same
//  question the same way, over the finished G-code rather than the model (BuildVolume::all_paths_inside).
//  Z is measured here too, for the same reason: a raft lifts every model layer, so the model's own height cannot
//  answer whether the print clears the ceiling. Upstream splits this into a second warning taken from the same
//  G-code (ToolHeightOutside — the top layer's z against max_print_height), and this is that check.
//  The tolerance is upstream's BedEpsilon (3 * EPSILON, libslic3r.h): it absorbs coordinate noise, not an overhang.
inline GWBedOverflow extrusion_bed_overflow(const GW& writer, const Params& params) {
  GWBedOverflow overflow;
  if (!writer.extruded_anything()) return overflow;  // nothing was printed -> nothing can be off the bed
  const double tolerance = 3e-4;
  const double halfWidth = params.bed_width * 0.5;
  const double halfDepth = params.bed_depth * 0.5;
  overflow.x = std::max(0.0, std::max(writer.exMaxX - halfWidth, -halfWidth - writer.exMinX) - tolerance);
  overflow.y = std::max(0.0, std::max(writer.exMaxY - halfDepth, -halfDepth - writer.exMinY) - tolerance);
  // bed_height 0 = the profile states no ceiling, so nothing is ever too tall (same rule as prepare_model).
  if (params.bed_height > 0.0) overflow.z = std::max(0.0, writer.exMaxZ - params.bed_height - tolerance);
  return overflow;
}
