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

double first_layer_bed(const Params& params) {
  if (params.first_layer_bed_temp >= 0) return params.first_layer_bed_temp;
  return params.bed_temp;
}
double first_layer_nozzle(const Params& params, int tool) {
  const double first = params.first_layer_nozzle_temp_of(tool);
  if (first >= 0) return first;
  return Params::forTool(params.extruder_nozzle_temp, tool, params.nozzle_temp);
}

// GCode::process_layer's transition from the first to the second layer (GCode.cpp:5631-5650): every tool whose
//  temperature differs from its first-layer one (only the loaded one, without a tool word, when one nozzle carries
//  every filament), then the bed through the writer's dedupe against `bed_set`. Empty when the host sent no
//  first-layer temperatures, which is every caller before these keys existed.
std::string second_layer_temperatures(const Params& params, const std::vector<int>& tools, bool multiple_extruders, int bed_set) {
  const Flavor flavor = flavor_of(params.gcode_flavor);
  std::string text;
  for (size_t k = 0; k < tools.size(); ++k) {
    if (params.single_extruder_multi_material && k > 0) break;   // the loaded filament only
    const int tool = tools[k];
    const double temperature = Params::forTool(params.extruder_nozzle_temp, tool, params.nozzle_temp);
    int toolWord = -1;
    if (multiple_extruders && !params.single_extruder_multi_material) toolWord = tool;
    if (temperature > 0 && std::lround(temperature) != std::lround(first_layer_nozzle(params, tool)))
      text += machine_set_temperature((unsigned)std::lround(temperature), flavor, false, toolWord);
  }
  const int bed = (int)std::lround(params.bed_temp);
  if (bed != bed_set)
    text += machine_set_bed_temperature(bed, false);
  return text;
}

void gw_setup_machine(GW& writer, const Params& params) {
  writer.flavor = flavor_of(params.gcode_flavor);
  writer.absolute_e = !params.use_relative_e_distances;
  writer.firmware_retraction = params.use_firmware_retraction;
  writer.z_offset = params.z_offset;
  writer.line_width = params.line_width;
  gw_setup_motion(writer, params, custom_gcode_is_bbl(params));
}

void gw_write_modes(GW& writer, const Params& params, bool is_bbl) {
  if (writer.flavor == Flavor::Unset && !writer.absolute_e) {
    // The kernel's own modes, for a host that sent no flavor (every caller before gcode_flavor was mapped).
    writer.raw("G21 ; mm");
    writer.raw("G90 ; absolute XYZ");
    writer.raw("M83 ; relative E");
    // Pressure advance: Marlin M900 K<v>. Klipper uses SET_PRESSURE_ADVANCE, noted here only as a comment.
    if (params.enable_pressure_advance) {
      char line[96];
      std::snprintf(line,sizeof line,"M900 K%.3f ; pressure advance (Marlin/RRF)",params.pressure_advance);
      writer.raw(line);
      std::snprintf(line,sizeof line,"; SET_PRESSURE_ADVANCE ADVANCE=%.3f  ; (Klipper equivalent — comment only)",params.pressure_advance);
      writer.raw(line);
    }
    return;
  }
  // Upstream's preamble and the initial filament's pressure advance in the flavor's own command (set_extruder for
  //  the first tool, GCode.cpp:8754; right after the start block on a Bambu Lab printer, :3566).
  writer.raw_lines(machine_preamble(writer.flavor, !writer.absolute_e));
  if (params.enable_pressure_advance)
    writer.raw_lines(machine_set_pressure_advance(params.pressure_advance, writer.flavor, is_bbl));
}

EmitFlags gw_setup_preamble(GW& writer, const Params& params, int treeSupLayers, double treeZMaxResid, const CustomStart* start) {
  gw_setup_machine(writer, params);
  writer.retract_length = params.retract_length;
  writer.retract_min_travel = params.retraction_minimum_travel;
  writer.retract_feed    = (int)std::llround(params.retract_speed * 60);
  writer.z_hop       = params.z_hop;
  writer.offset_x        = params.bed_center_x();
  writer.offset_y        = params.bed_center_y();
  writer.arc_fitting = params.enable_arc_fitting;
  writer.arc_resolution = params.gcode_resolution;
  writer.scarf_length   = params.scarf_length;
  double peSlope = 0.0;   // in-kernel PE-lite only when pe_lite; else real PE post-processes
  if (params.pe_lite) peSlope = std::max(0.0, params.max_volumetric_extrusion_rate_slope);
  writer.pe_slope    = peSlope;
  writer.filament_area = PI * params.filament_diameter * params.filament_diameter / 4.0;
  writer.tool_filament_diameter = params.filament_diameter;   // single-material path: one tool, so these never change again
  writer.tool_flow_ratio        = params.flow_ratio;
  writer.max_volumetric_speed          = Params::forTool(params.filament_max_volumetric_speed, params.single_tool, 0.0);
  writer.print_flow             = params.print_flow_ratio;
  writer.scarf_flow             = params.scarf_joint_flow_ratio;
  writer.avoid_walls = params.reduce_crossing_wall;                                 // wall-avoiding travel
  bool realPE    = (!params.pe_lite && params.max_volumetric_extrusion_rate_slope > 0);
  writer.emit_pe_tags = params.emit_pe_tags || realPE;                             // tags are emitted automatically when the real PE is used
  writer.emit_role_tags = params.gcode_role_tags;
  bool ironOn    = (params.ironing_type=="top" || params.ironing_type=="topmost" || params.ironing_type=="solid");
  bool scarfOn   = (params.seam_slope_type=="external" || params.seam_slope_type=="all");
  int seamMode = 0;   // back by default
  if (params.seam_position=="nearest") seamMode = 1;
  else if (params.seam_position=="aligned") seamMode = 2;
  else if (params.seam_position=="random") seamMode = 3;
  if (start) {
    writer.raw_lines(start->file_start);   // file_start_gcode: the very top of the file, as upstream writes it
    // Where upstream writes the printer's thumbnails (GCode.cpp:2994): the host fills it from its scene
    //  (three-slicer-viewer thumbnails.js withThumbnails, THUMBNAILS_PLACEHOLDER) or removes it.
    writer.raw(";_GP_THUMBNAILS_PLACEHOLDER");
  }
  writer.raw("; OrcaSlicer RE mini-kernel (Track C stage 6) — NOT full libslic3r");
  { char line[320];
    std::snprintf(line,sizeof line,"; params: lh=%.3f flh=%.3f lw=%.3f walls=%d infill=%.2f@%.0fdeg top=%d bottom=%d",
      params.layer_height,params.first_layer_height,params.line_width,params.wall_loops,params.infill_density,params.infill_angle,params.top_shell_layers,params.bottom_shell_layers);
    writer.raw(line);
    std::snprintf(line,sizeof line,"; skirt=%d@%.1fmm brim=%.1fmm retract=%.2fmm@%.0fmm/s zhop=%.2fmm",
      params.skirt_loops,params.skirt_distance,params.brim_width,params.retract_length,params.retract_speed,params.z_hop);
    writer.raw(line);
    std::snprintf(line,sizeof line,"; support=%d angle=%.0f density=%.2f topz=%.2f xy=%.2f iface=%d  raft=%d  bed=%.0fx%.0f off=%.1f,%.1f",
      (int)params.enable_support,params.support_threshold_angle,params.support_density,params.support_top_z_distance,params.support_xy_distance,
      params.support_interface_top_layers,params.raft_layers,params.bed_width,params.bed_depth,writer.offset_x,writer.offset_y);
    writer.raw(line);
    if (treeSupLayers > 0) {   // stage 19: tree support z alignment diagnostics (max residual against the object z grid, mm)
      std::snprintf(line,sizeof line,"; tree_support layers=%d z_resid_max=%.6fmm", treeSupLayers, treeZMaxResid);
      writer.raw(line);
    }
    std::snprintf(line,sizeof line,"; pattern=%s fan=%.0f%% closeFan=%d fullFan=%d slowT=%.0fs arc=%d seam=%s spiral=%d",
      params.sparse_infill_pattern.c_str(),params.fan_speed,params.close_fan_the_first_x_layers,params.full_fan_speed_layer,
      params.slow_down_layer_time,(int)params.enable_arc_fitting,params.seam_position.c_str(),(int)params.spiral_mode);
    writer.raw(line);
    std::snprintf(line,sizeof line,"; speeds(mm/s): print=%.0f first=%.0f travel=%.0f  temps: nozzle=%.0f bed=%.0f",
      params.print_speed,params.first_layer_speed,params.travel_speed,params.nozzle_temp,params.bed_temp);
    writer.raw(line);
    std::snprintf(line,sizeof line,"; scarf=%s@%.0fmm support_style=%s bridge=%.0fmm/s PA=%d@%.3f",
      params.seam_slope_type.c_str(),params.scarf_length,params.support_style.c_str(),params.bridge_speed,
      (int)params.enable_pressure_advance,params.pressure_advance);
    writer.raw(line);
    std::snprintf(line,sizeof line,"; ironing=%s@%.2fmm flow=%.0f%% spd=%.0f  reduce_crossing_wall=%d  PE_slope=%.1f  extruders=%d",
      params.ironing_type.c_str(),params.ironing_spacing,params.ironing_flow,params.ironing_speed,
      (int)params.reduce_crossing_wall,params.max_volumetric_extrusion_rate_slope,params.extruder_count);
    writer.raw(line);
    // Upstream's first progress line (GCode.cpp:3026), filled once the estimate exists (finalizeGcode).
    if (!params.disable_m73) writer.raw(";_GP_FIRST_LINE_M73_PLACEHOLDER");
    // The machine limits, upstream's print_machine_envelope — ahead of everything else, as upstream writes them.
    writer.raw_lines(machine_envelope_text(params.machine_envelope, writer.flavor));
    if (!start) {   // with a custom start block the temperatures follow upstream's rule instead (custom_gcode_bridge)
      // The first layer's own temperatures when the host sent them; the switch to the others is at the second layer.
      const double bedFirst = first_layer_bed(params);
      const double nozzleFirst = first_layer_nozzle(params, params.single_tool);
      std::snprintf(line,sizeof line,"M140 S%.0f",bedFirst);
      writer.raw(line);
      std::snprintf(line,sizeof line,"M104 S%.0f",nozzleFirst);
      writer.raw(line);
      std::snprintf(line,sizeof line,"M190 S%.0f",bedFirst);
      writer.raw(line);
      std::snprintf(line,sizeof line,"M109 S%.0f",nozzleFirst);
      writer.raw(line);
    }
  }
  {
    int bedSet = (int)std::lround(first_layer_bed(params));
    if (start) bedSet = start->bed_set;
    writer.second_layer_text = second_layer_temperatures(params, { params.single_tool }, false, bedSet);
  }
  auto writeModes = [&]{ gw_write_modes(writer, params, custom_gcode_is_bbl(params)); };
  if (start) {
    // Upstream's order (GCode.cpp:3511-3593): temperatures, the start G-code, the Bambu Lab M109s. The writer's own
    //  modes come after it, as upstream's GCodeWriter::preamble does at the first layer, so a start G-code that
    //  leaves G91 or M82 behind cannot change how the print is read.
    writer.raw_lines(start->before);
    if (writer.emit_role_tags) writer.raw(";TYPE:Custom");
    writer.raw_lines(start->chamber);
    writer.raw("; machine_start_gcode (printer profile, expanded)");
    writer.raw_lines(start->text);
    writer.raw_lines(start->after);
    writeModes();
    writer.raw("G92 E0");
    return { realPE, ironOn, scarfOn, seamMode };
  }
  writeModes();
  // Printer profile custom start G-code, after the temperature/unit setup and before the extruder reset —
    //  the same slot upstream uses. Absent by default, so the emitted G-code is unchanged unless a printer sets it.
  if (!params.machine_start_gcode.empty()) {
    writer.raw("; machine_start_gcode (printer profile)");
    writer.raw_lines(params.machine_start_gcode);
  } else {
    writer.raw("; (no G28 homing — mini-kernel preamble)");
  }
  writer.raw("G92 E0");
  return { realPE, ironOn, scarfOn, seamMode };
}

  // Machine limits for the time estimate (shared by streaming and batch) — depends only on params, so it is built once before the loop.
void setup_time_limits(const Params& params, gcode_time::Limits& timeLimits, gcodeproc_bridge::Limits& processorLimits) {
  timeLimits.max_speed[0]=timeLimits.max_speed[1]=(float)params.machine_max_speed_xy;
  timeLimits.max_speed[2]=(float)params.machine_max_speed_z;
  timeLimits.max_speed[3]=(float)params.machine_max_speed_e;
  timeLimits.max_accel[0]=timeLimits.max_accel[1]=(float)params.machine_max_accel_xy;
  timeLimits.max_accel[2]=(float)params.machine_max_accel_z;
  timeLimits.max_accel[3]=(float)params.machine_max_accel_e;
  timeLimits.max_jerk[0]=timeLimits.max_jerk[1]=(float)params.machine_jerk_xy;
  timeLimits.max_jerk[2]=(float)params.machine_jerk_z;
  timeLimits.max_jerk[3]=(float)params.machine_jerk_e;
  timeLimits.accel_print=(float)params.machine_accel_print;
  timeLimits.accel_travel=(float)params.machine_accel_travel;
  timeLimits.accel_retract=(float)params.machine_accel_retract;
  for (int k=0;k<4;++k){
    processorLimits.max_speed[k]=timeLimits.max_speed[k];
    processorLimits.max_accel[k]=timeLimits.max_accel[k];
    processorLimits.max_jerk[k]=timeLimits.max_jerk[k];
  }
  processorLimits.accel_print=timeLimits.accel_print;
  processorLimits.accel_travel=timeLimits.accel_travel;
  processorLimits.accel_retract=timeLimits.accel_retract;
  processorLimits.min_extrude_rate=timeLimits.min_extrude_rate;
  processorLimits.min_travel_rate=timeLimits.min_travel_rate;
}
