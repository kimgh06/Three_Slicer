// preamble.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  GW configuration + the G-code preamble text, and the machine-limit fill for the time estimate.
//  The four emission flags the preamble computes (realPE/ironOn/scarfOn/seamMode) are handed back in EmitFlags
//  because slice() keeps using them; `SeamCtx seamCtx;` stayed at the call site (the preamble never touches it).
#include "slice_ctx.h"

#include "clip_util.h"
#include "custom_gcode.h"
#include "machine_writer.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

double first_layer_bed(const Params& p) {
  if (p.first_layer_bed_temp >= 0) return p.first_layer_bed_temp;
  return p.bed_temp;
}
double first_layer_nozzle(const Params& p, int tool) {
  const double first = p.first_layer_nozzle_temp_of(tool);
  if (first >= 0) return first;
  return Params::forTool(p.extruder_nozzle_temp, tool, p.nozzle_temp);
}

// GCode::process_layer's transition from the first to the second layer (GCode.cpp:5631-5650): every tool whose
//  temperature differs from its first-layer one (only the loaded one, without a tool word, when one nozzle carries
//  every filament), then the bed through the writer's dedupe against `bed_set`. Empty when the host sent no
//  first-layer temperatures, which is every caller before these keys existed.
std::string second_layer_temperatures(const Params& p, const std::vector<int>& tools, bool multiple_extruders, int bed_set) {
  const Flavor flavor = flavor_of(p.gcode_flavor);
  std::string text;
  for (size_t k = 0; k < tools.size(); ++k) {
    if (p.single_extruder_multi_material && k > 0) break;   // the loaded filament only
    const int tool = tools[k];
    const double temperature = Params::forTool(p.extruder_nozzle_temp, tool, p.nozzle_temp);
    int toolWord = -1;
    if (multiple_extruders && !p.single_extruder_multi_material) toolWord = tool;
    if (temperature > 0 && std::lround(temperature) != std::lround(first_layer_nozzle(p, tool)))
      text += machine_set_temperature((unsigned)std::lround(temperature), flavor, false, toolWord);
  }
  const int bed = (int)std::lround(p.bed_temp);
  if (bed != bed_set)
    text += machine_set_bed_temperature(bed, false);
  return text;
}

void gw_setup_machine(GW& gw, const Params& p) {
  gw.flavor = flavor_of(p.gcode_flavor);
  gw.absolute_e = !p.use_relative_e_distances;
  gw.firmware_retraction = p.use_firmware_retraction;
  gw.z_offset = p.z_offset;
  gw_setup_motion(gw, p, custom_gcode_is_bbl(p));
}

void gw_write_modes(GW& gw, const Params& p, bool is_bbl) {
  if (gw.flavor == Flavor::Unset && !gw.absolute_e) {
    // The kernel's own modes, for a host that sent no flavor (every caller before gcode_flavor was mapped).
    gw.raw("G21 ; mm"); gw.raw("G90 ; absolute XYZ"); gw.raw("M83 ; relative E");
    // Pressure advance: Marlin M900 K<v>. Klipper uses SET_PRESSURE_ADVANCE, noted here only as a comment.
    if (p.enable_pressure_advance) {
      char h[96];
      std::snprintf(h,sizeof h,"M900 K%.3f ; pressure advance (Marlin/RRF)",p.pressure_advance); gw.raw(h);
      std::snprintf(h,sizeof h,"; SET_PRESSURE_ADVANCE ADVANCE=%.3f  ; (Klipper equivalent — comment only)",p.pressure_advance); gw.raw(h);
    }
    return;
  }
  // Upstream's preamble and the initial filament's pressure advance in the flavor's own command (set_extruder for
  //  the first tool, GCode.cpp:8754; right after the start block on a Bambu Lab printer, :3566).
  gw.raw_lines(machine_preamble(gw.flavor, !gw.absolute_e));
  if (p.enable_pressure_advance)
    gw.raw_lines(machine_set_pressure_advance(p.pressure_advance, gw.flavor, is_bbl));
}

EmitFlags gw_setup_preamble(GW& gw, const Params& p, int treeSupLayers, double treeZMaxResid, const CustomStart* start) {
  gw_setup_machine(gw, p);
  gw.retract_len = p.retract_length;
  gw.retract_min_travel = p.retraction_minimum_travel;
  gw.retractF    = (int)std::llround(p.retract_speed * 60);
  gw.z_hop       = p.z_hop;
  gw.offX        = p.bed_center_x();
  gw.offY        = p.bed_center_y();
  gw.arc_fitting = p.enable_arc_fitting;
  gw.arc_resolution = p.gcode_resolution;
  gw.scarf_len   = p.scarf_length;
  gw.pe_slope    = (p.pe_lite ? std::max(0.0, p.max_volumetric_extrusion_rate_slope) : 0.0);   // in-kernel PE-lite only when pe_lite; else real PE post-processes
  gw.filament_area = PI * p.filament_diameter * p.filament_diameter / 4.0;
  gw.tool_filament_diameter = p.filament_diameter;   // single-material path: one tool, so these never change again
  gw.tool_flow_ratio        = p.flow_ratio;
  gw.max_vol_speed          = Params::forTool(p.filament_max_volumetric_speed, p.single_tool, 0.0);
  gw.print_flow             = p.print_flow_ratio;
  gw.scarf_flow             = p.scarf_joint_flow_ratio;
  gw.avoid_walls = p.reduce_crossing_wall;                                 // wall-avoiding travel
  bool realPE    = (!p.pe_lite && p.max_volumetric_extrusion_rate_slope > 0);
  gw.emit_pe_tags = p.emit_pe_tags || realPE;                             // tags are emitted automatically when the real PE is used
  gw.emit_role_tags = p.gcode_role_tags;
  bool ironOn    = (p.ironing_type=="top" || p.ironing_type=="topmost" || p.ironing_type=="solid");
  bool scarfOn   = (p.seam_slope_type=="external" || p.seam_slope_type=="all");
  int seamMode = (p.seam_position=="nearest")?1 : (p.seam_position=="aligned")?2 : (p.seam_position=="random")?3 : 0; // back by default
  if (start) {
    gw.raw_lines(start->file_start);   // file_start_gcode: the very top of the file, as upstream writes it
    // Where upstream writes the printer's thumbnails (GCode.cpp:2994): the host fills it from its scene
    //  (three-slicer-viewer thumbnails.js withThumbnails, THUMBNAILS_PLACEHOLDER) or removes it.
    gw.raw(";_GP_THUMBNAILS_PLACEHOLDER");
  }
  gw.raw("; OrcaSlicer RE mini-kernel (Track C stage 6) — NOT full libslic3r");
  { char h[320];
    std::snprintf(h,sizeof h,"; params: lh=%.3f flh=%.3f lw=%.3f walls=%d infill=%.2f@%.0fdeg top=%d bottom=%d",
      p.layer_height,p.first_layer_height,p.line_width,p.wall_loops,p.infill_density,p.infill_angle,p.top_shell_layers,p.bottom_shell_layers); gw.raw(h);
    std::snprintf(h,sizeof h,"; skirt=%d@%.1fmm brim=%.1fmm retract=%.2fmm@%.0fmm/s zhop=%.2fmm",
      p.skirt_loops,p.skirt_distance,p.brim_width,p.retract_length,p.retract_speed,p.z_hop); gw.raw(h);
    std::snprintf(h,sizeof h,"; support=%d angle=%.0f density=%.2f topz=%.2f xy=%.2f iface=%d  raft=%d  bed=%.0fx%.0f off=%.1f,%.1f",
      p.enable_support?1:0,p.support_threshold_angle,p.support_density,p.support_top_z_distance,p.support_xy_distance,
      p.support_interface_top_layers,p.raft_layers,p.bed_width,p.bed_depth,gw.offX,gw.offY); gw.raw(h);
    if (treeSupLayers > 0) {   // stage 19: tree support z alignment diagnostics (max residual against the object z grid, mm)
      std::snprintf(h,sizeof h,"; tree_support layers=%d z_resid_max=%.6fmm", treeSupLayers, treeZMaxResid); gw.raw(h);
    }
    std::snprintf(h,sizeof h,"; pattern=%s fan=%.0f%% closeFan=%d fullFan=%d slowT=%.0fs arc=%d seam=%s spiral=%d",
      p.sparse_infill_pattern.c_str(),p.fan_speed,p.close_fan_the_first_x_layers,p.full_fan_speed_layer,
      p.slow_down_layer_time,p.enable_arc_fitting?1:0,p.seam_position.c_str(),p.spiral_mode?1:0); gw.raw(h);
    std::snprintf(h,sizeof h,"; speeds(mm/s): print=%.0f first=%.0f travel=%.0f  temps: nozzle=%.0f bed=%.0f",
      p.print_speed,p.first_layer_speed,p.travel_speed,p.nozzle_temp,p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"; scarf=%s@%.0fmm support_style=%s bridge=%.0fmm/s PA=%d@%.3f",
      p.seam_slope_type.c_str(),p.scarf_length,p.support_style.c_str(),p.bridge_speed,
      p.enable_pressure_advance?1:0,p.pressure_advance); gw.raw(h);
    std::snprintf(h,sizeof h,"; ironing=%s@%.2fmm flow=%.0f%% spd=%.0f  reduce_crossing_wall=%d  PE_slope=%.1f  extruders=%d",
      p.ironing_type.c_str(),p.ironing_spacing,p.ironing_flow,p.ironing_speed,
      p.reduce_crossing_wall?1:0,p.max_volumetric_extrusion_rate_slope,p.extruder_count); gw.raw(h);
    // Upstream's first progress line (GCode.cpp:3026), filled once the estimate exists (finalizeGcode).
    if (!p.disable_m73) gw.raw(";_GP_FIRST_LINE_M73_PLACEHOLDER");
    // The machine limits, upstream's print_machine_envelope — ahead of everything else, as upstream writes them.
    gw.raw_lines(machine_envelope_text(p.machine_envelope, gw.flavor));
    if (!start) {   // with a custom start block the temperatures follow upstream's rule instead (custom_gcode_bridge)
      // The first layer's own temperatures when the host sent them; the switch to the others is at the second layer.
      const double bedFirst = first_layer_bed(p), nozzleFirst = first_layer_nozzle(p, p.single_tool);
      std::snprintf(h,sizeof h,"M140 S%.0f",bedFirst); gw.raw(h);
      std::snprintf(h,sizeof h,"M104 S%.0f",nozzleFirst); gw.raw(h);
      std::snprintf(h,sizeof h,"M190 S%.0f",bedFirst); gw.raw(h);
      std::snprintf(h,sizeof h,"M109 S%.0f",nozzleFirst); gw.raw(h);
    }
  }
  {
    int bedSet = (int)std::lround(first_layer_bed(p));
    if (start) bedSet = start->bed_set;
    gw.second_layer_text = second_layer_temperatures(p, { p.single_tool }, false, bedSet);
  }
  auto modes = [&]{ gw_write_modes(gw, p, custom_gcode_is_bbl(p)); };
  if (start) {
    // Upstream's order (GCode.cpp:3511-3593): temperatures, the start G-code, the Bambu Lab M109s. The writer's own
    //  modes come after it, as upstream's GCodeWriter::preamble does at the first layer, so a start G-code that
    //  leaves G91 or M82 behind cannot change how the print is read.
    gw.raw_lines(start->before);
    if (gw.emit_role_tags) gw.raw(";TYPE:Custom");
    gw.raw_lines(start->chamber);
    gw.raw("; machine_start_gcode (printer profile, expanded)");
    gw.raw_lines(start->text);
    gw.raw_lines(start->after);
    modes();
    gw.raw("G92 E0");
    return { realPE, ironOn, scarfOn, seamMode };
  }
  modes();
  // Printer profile custom start G-code, after the temperature/unit setup and before the extruder reset —
    //  the same slot upstream uses. Absent by default, so the emitted G-code is unchanged unless a printer sets it.
  if (!p.machine_start_gcode.empty()) {
    gw.raw("; machine_start_gcode (printer profile)");
    gw.raw_lines(p.machine_start_gcode);
  } else {
    gw.raw("; (no G28 homing — mini-kernel preamble)");
  }
  gw.raw("G92 E0");
  return { realPE, ironOn, scarfOn, seamMode };
}

  // Machine limits for the time estimate (shared by streaming and batch) — depends only on p, so it is built once before the loop.
void setup_time_limits(const Params& p, gcode_time::Limits& glim, gcodeproc_bridge::Limits& gl) {
  glim.max_speed[0]=glim.max_speed[1]=(float)p.machine_max_speed_xy;
  glim.max_speed[2]=(float)p.machine_max_speed_z; glim.max_speed[3]=(float)p.machine_max_speed_e;
  glim.max_accel[0]=glim.max_accel[1]=(float)p.machine_max_accel_xy;
  glim.max_accel[2]=(float)p.machine_max_accel_z; glim.max_accel[3]=(float)p.machine_max_accel_e;
  glim.max_jerk[0]=glim.max_jerk[1]=(float)p.machine_jerk_xy;
  glim.max_jerk[2]=(float)p.machine_jerk_z; glim.max_jerk[3]=(float)p.machine_jerk_e;
  glim.accel_print=(float)p.machine_accel_print; glim.accel_travel=(float)p.machine_accel_travel; glim.accel_retract=(float)p.machine_accel_retract;
  for (int k=0;k<4;++k){ gl.max_speed[k]=glim.max_speed[k]; gl.max_accel[k]=glim.max_accel[k]; gl.max_jerk[k]=glim.max_jerk[k]; }
  gl.accel_print=glim.accel_print; gl.accel_travel=glim.accel_travel; gl.accel_retract=glim.accel_retract;
  gl.min_extrude_rate=glim.min_extrude_rate; gl.min_travel_rate=glim.min_travel_rate;
}
