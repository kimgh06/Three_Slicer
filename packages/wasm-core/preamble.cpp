// preamble.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  GW configuration + the G-code preamble text, and the machine-limit fill for the time estimate.
//  The four emission flags the preamble computes (realPE/ironOn/scarfOn/seamMode) are handed back in EmitFlags
//  because slice() keeps using them; `SeamCtx seamCtx;` stayed at the call site (the preamble never touches it).
#include "slice_ctx.h"

#include "clip_util.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

EmitFlags gw_setup_preamble(GW& gw, const Params& p, int treeSupLayers, double treeZMaxResid) {
  gw.retract_len = p.retract_length;
  gw.retract_min_travel = p.retraction_minimum_travel;
  gw.retractF    = (int)std::llround(p.retract_speed * 60);
  gw.z_hop       = p.z_hop;
  gw.offX        = p.bed_width  * 0.5;
  gw.offY        = p.bed_depth  * 0.5;
  gw.arc_fitting = p.enable_arc_fitting;
  gw.arc_resolution = p.gcode_resolution;
  gw.scarf_len   = p.scarf_length;
  gw.pe_slope    = (p.pe_lite ? std::max(0.0, p.max_volumetric_extrusion_rate_slope) : 0.0);   // in-kernel PE-lite only when pe_lite; else real PE post-processes
  gw.filament_area = PI * p.filament_diameter * p.filament_diameter / 4.0;
  gw.tool_filament_diameter = p.filament_diameter;   // single-material path: one tool, so these never change again
  gw.tool_flow_ratio        = p.flow_ratio;
  gw.avoid_walls = p.reduce_crossing_wall;                                 // wall-avoiding travel
  bool realPE    = (!p.pe_lite && p.max_volumetric_extrusion_rate_slope > 0);
  gw.emit_pe_tags = p.emit_pe_tags || realPE;                             // tags are emitted automatically when the real PE is used
  gw.emit_role_tags = p.gcode_role_tags;
  bool ironOn    = (p.ironing_type=="top" || p.ironing_type=="topmost" || p.ironing_type=="solid");
  bool scarfOn   = (p.seam_slope_type=="external" || p.seam_slope_type=="all");
  int seamMode = (p.seam_position=="nearest")?1 : (p.seam_position=="aligned")?2 : (p.seam_position=="random")?3 : 0; // back by default
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
    std::snprintf(h,sizeof h,"M140 S%.0f",p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M104 S%.0f",p.nozzle_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M190 S%.0f",p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M109 S%.0f",p.nozzle_temp); gw.raw(h);
  }
  gw.raw("G21 ; mm"); gw.raw("G90 ; absolute XYZ"); gw.raw("M83 ; relative E");
  // Pressure advance: Marlin M900 K<v>. Klipper uses SET_PRESSURE_ADVANCE, noted here only as a comment.
  if (p.enable_pressure_advance) {
    char h[96];
    std::snprintf(h,sizeof h,"M900 K%.3f ; pressure advance (Marlin/RRF)",p.pressure_advance); gw.raw(h);
    std::snprintf(h,sizeof h,"; SET_PRESSURE_ADVANCE ADVANCE=%.3f  ; (Klipper equivalent — comment only)",p.pressure_advance); gw.raw(h);
  }
  // Printer profile custom start G-code, after the temperature/unit setup and before the extruder reset —
    //  the same slot upstream uses. Absent by default, so the emitted G-code is unchanged unless a printer sets it.
  if (!p.machine_start_gcode.empty()) {
    gw.raw("; machine_start_gcode (printer profile)");
    for (size_t i = 0, n = p.machine_start_gcode.size(); i <= n; ) {
      size_t e = p.machine_start_gcode.find('\n', i);
      if (e == std::string::npos) e = n;
      if (e > i) gw.raw(p.machine_start_gcode.substr(i, e - i).c_str());
      i = e + 1;
    }
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
