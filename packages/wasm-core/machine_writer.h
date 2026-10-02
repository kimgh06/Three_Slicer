// machine_writer.h — the machine commands of upstream's GCodeWriter (GCodeWriter.cpp) whose text depends on the
// firmware flavor: temperatures, accelerations, jerk, pressure advance. Plain functions over the flavor, so the
// kernel's own writer (GW) and the start / second-layer blocks format them one way. Header-only, like
// gcode_writer.h.
//
// The flavor comes from Params::gcode_flavor. When the host sends none (Flavor::Unset), every command the kernel
// wrote before keeps its old form at its own call site; a command that only exists because a new key was sent uses
// Marlin's form, upstream's default flavor ("marlin" in the schema).
#pragma once
#include <cmath>
#include <cstdio>
#include <vector>
#include <iomanip>
#include <sstream>
#include <string>

enum class Flavor { Unset, MarlinLegacy, MarlinFirmware, Klipper, RepRapFirmware, RepRapSprinter, Repetier, Teacup,
                    MakerWare, Sailfish, Smoothie, Mach3, Machinekit, NoExtrusion };

// s_keys_map_GCodeFlavor (PrintConfig.cpp:172).
inline Flavor flavor_of(const std::string& name) {
  static const struct { const char* key; Flavor flavor; } KEYS[] = {
    { "marlin", Flavor::MarlinLegacy }, { "klipper", Flavor::Klipper }, { "reprapfirmware", Flavor::RepRapFirmware },
    { "repetier", Flavor::Repetier }, { "marlin2", Flavor::MarlinFirmware }, { "reprap", Flavor::RepRapSprinter },
    { "teacup", Flavor::Teacup }, { "makerware", Flavor::MakerWare }, { "sailfish", Flavor::Sailfish },
    { "smoothie", Flavor::Smoothie }, { "mach3", Flavor::Mach3 }, { "machinekit", Flavor::Machinekit },
    { "no-extrusion", Flavor::NoExtrusion } };
  for (const auto& entry : KEYS)
    if (name == entry.key) return entry.flavor;
  return Flavor::Unset;
}

// The flavor a command that did not exist before the key was sent is written in.
inline Flavor flavor_or_marlin(Flavor flavor) {
  if (flavor == Flavor::Unset) return Flavor::MarlinLegacy;
  return flavor;
}

// GCodeWriter::set_temperature (GCodeWriter.cpp:242), verbatim. tool -1 = no tool word.
inline std::string machine_set_temperature(unsigned int temperature, Flavor flavor, bool wait, int tool,
                                           std::string comment = std::string()) {
  flavor = flavor_or_marlin(flavor);
  if (wait && (flavor == Flavor::MakerWare || flavor == Flavor::Sailfish))
    return "";
  std::string code;
  if (wait && flavor != Flavor::Teacup && flavor != Flavor::RepRapFirmware) {
    code = "M109";
    if (comment.empty())
      comment = "set nozzle temperature and wait for it to be reached";
  } else {
    if (flavor == Flavor::RepRapFirmware) {   // M104 is deprecated on RepRapFirmware
      code = "G10";
    } else {
      code = "M104";
    }
    if (comment.empty())
      comment = "set nozzle temperature";
  }
  std::ostringstream gcode;
  gcode << code << " ";
  if (flavor == Flavor::Mach3 || flavor == Flavor::Machinekit) {
    gcode << "P";
  } else {
    gcode << "S";
  }
  gcode << temperature;
  if (tool != -1) {
    if (flavor == Flavor::RepRapFirmware) {
      gcode << " P" << tool;
    } else {
      gcode << " T" << tool;
    }
  }
  gcode << " ; " << comment << "\n";
  if ((flavor == Flavor::Teacup || flavor == Flavor::RepRapFirmware) && wait)
    gcode << "M116 ; wait for temperature to be reached\n";
  return gcode.str();
}

// GCodeWriter::set_bed_temperature (GCodeWriter.cpp:293). The writer's dedupe state lives with the caller
//  (MachineState below); this is the text.
inline std::string machine_set_bed_temperature(int temperature, bool wait) {
  std::ostringstream gcode;
  if (wait)
    gcode << "M190 S" << temperature << " ; set bed temperature and wait for it to be reached\n";
  else
    gcode << "M140 S" << temperature << " ; set bed temperature\n";
  return gcode.str();
}

// GCodeWriter::set_chamber_temperature (GCodeWriter.cpp:317).
inline std::string machine_set_chamber_temperature(int temperature, bool wait, bool auxiliary_fan) {
  std::ostringstream gcode;
  if (wait) {
    if (auxiliary_fan)
      gcode << "M106 P2 S255 \n";
    gcode << "M191 S" << std::to_string(temperature) << " ;" << "set chamber_temperature and wait for it to be reached\n";
    if (auxiliary_fan)
      gcode << "M106 P2 S0 \n";
  } else {
    gcode << "M141 S" << temperature << ";" << "set chamber_temperature" << "\n";
  }
  return gcode.str();
}

// GCodeWriter::preamble (GCodeWriter.cpp:206): absolute XYZ and millimetres, then the E mode for the flavors that
//  have one. reset_e writes G92 E0 only in absolute mode.
inline std::string machine_preamble(Flavor flavor, bool relative_e) {
  flavor = flavor_or_marlin(flavor);
  std::ostringstream gcode;
  if (flavor != Flavor::MakerWare) {
    gcode << "G90\n";
    gcode << "G21\n";
  }
  const bool has_e_mode = flavor == Flavor::RepRapSprinter || flavor == Flavor::RepRapFirmware || flavor == Flavor::MarlinLegacy ||
                          flavor == Flavor::MarlinFirmware || flavor == Flavor::Teacup || flavor == Flavor::Repetier ||
                          flavor == Flavor::Smoothie || flavor == Flavor::Klipper;
  if (has_e_mode) {
    if (relative_e) {
      gcode << "M83 ; use relative distances for extrusion\n";
    } else {
      gcode << "M82 ; use absolute distances for extrusion\n";
      gcode << "G92 E0 ; reset extrusion distance\n";
    }
  }
  return gcode.str();
}

// GCodeWriter::postamble (GCodeWriter.cpp:234).
inline std::string machine_postamble(Flavor flavor) {
  if (flavor == Flavor::Machinekit) return "M2 ; end of program\n";
  return "";
}

// GCodeWriter::set_pressure_advance (GCodeWriter.cpp:499). setprecision(4) as upstream: significant digits.
inline std::string machine_set_pressure_advance(double pa, Flavor flavor, bool is_bbl) {
  flavor = flavor_or_marlin(flavor);
  std::ostringstream gcode;
  if (pa < 0)
    return gcode.str();
  if (is_bbl) {
    gcode << "M900 K" << std::setprecision(4) << pa << " L1000 M10 ; Override pressure advance value\n";
  } else if (flavor == Flavor::Klipper) {
    gcode << "SET_PRESSURE_ADVANCE ADVANCE=" << std::setprecision(4) << pa << "; Override pressure advance value\n";
  } else if (flavor == Flavor::RepRapFirmware) {
    gcode << ("M572 D0 S") << std::setprecision(4) << pa << "; Override pressure advance value\n";
  } else if (flavor == Flavor::Repetier) {
    gcode << "M233 X" << std::setprecision(4) << pa << " Y" << std::setprecision(4) << pa << " ; Override pressure advance value\n";
  } else {
    gcode << "M900 K" << std::setprecision(4) << pa << "; Override pressure advance value\n";
  }
  return gcode.str();
}

// GCodeWriter::_retract / unretract with firmware retraction (GCodeWriter.cpp:1197, :1225).
inline const char* machine_firmware_retract(Flavor flavor) {
  if (flavor == Flavor::Machinekit) return "G22 ; retract";
  return "G10 ; retract";
}
inline const char* machine_firmware_unretract(Flavor flavor) {
  if (flavor == Flavor::Machinekit) return "G23 ; unretract";
  return "G11 ; unretract";
}

// GCode::print_machine_envelope (GCode.cpp:4419) for one extruder: Marlin (both) and RepRapFirmware only. `limits`
//  is Params::machine_envelope's 16 numbers. Junction deviation (M205 J) is Marlin 2's, written when above 0.
inline std::string machine_envelope_text(const std::vector<double>& limits, Flavor flavor) {
  flavor = flavor_or_marlin(flavor);
  if (limits.size() < 16) return "";
  if (!(flavor == Flavor::MarlinLegacy || flavor == Flavor::MarlinFirmware || flavor == Flavor::RepRapFirmware)) return "";
  const double ax = limits[0], ay = limits[1], az = limits[2], ae = limits[3];
  const double vx = limits[4], vy = limits[5], vz = limits[6], ve = limits[7];
  const double extruding = limits[8], retracting = limits[9], travel = limits[10];
  const double jx = limits[11], jy = limits[12], jz = limits[13], je = limits[14], junction = limits[15];
  int factor = 1;
  if (flavor == Flavor::RepRapFirmware) factor = 60;   // RRF M203 and M566 are in mm/min
  char line[192];
  std::string text;
  std::snprintf(line, sizeof line, "M201 X%d Y%d Z%d E%d\n", int(ax + 0.5), int(ay + 0.5), int(az + 0.5), int(ae + 0.5));
  text += line;
  std::snprintf(line, sizeof line, "M203 X%d Y%d Z%d E%d\n", int(vx * factor + 0.5), int(vy * factor + 0.5), int(vz * factor + 0.5), int(ve * factor + 0.5));
  text += line;
  // Legacy Marlin exports travel acceleration the same as printing acceleration; Marlin 2 has the two separated.
  int travel_acc = int(travel + 0.5);
  if (flavor == Flavor::MarlinLegacy) travel_acc = int(extruding + 0.5);
  if (flavor == Flavor::RepRapFirmware)
    std::snprintf(line, sizeof line, "M204 P%d T%d ; sets acceleration (P, T), mm/sec^2\n", int(extruding + 0.5), travel_acc);
  else if (flavor == Flavor::MarlinFirmware)
    std::snprintf(line, sizeof line, "M204 P%d R%d T%d ; sets acceleration (P, T) and retract acceleration (R), mm/sec^2\n",
                  int(extruding + 0.5), int(retracting + 0.5), int(travel + 0.5));
  else
    std::snprintf(line, sizeof line, "M204 P%d R%d T%d\n", int(extruding + 0.5), int(retracting + 0.5), travel_acc);
  text += line;
  if (flavor == Flavor::RepRapFirmware)
    std::snprintf(line, sizeof line, "M566 X%.2lf Y%.2lf Z%.2lf E%.2lf ; sets the jerk limits, mm/min\n", jx * factor, jy * factor, jz * factor, je * factor);
  else
    std::snprintf(line, sizeof line, "M205 X%.2lf Y%.2lf Z%.2lf E%.2lf ; sets the jerk limits, mm/sec\n", jx * factor, jy * factor, jz * factor, je * factor);
  text += line;
  // GCodeWriter::set_junction_deviation (GCodeWriter.cpp:481): Marlin 2 only, limit and value the same number here.
  if (flavor == Flavor::MarlinFirmware && junction > 0) {
    std::snprintf(line, sizeof line, "M205 J%.3f ; Junction Deviation\n", junction);
    text += line;
  }
  return text;
}

// GCodeWriter::supports_separate_travel_acceleration (GCodeWriter.cpp:25).
inline bool machine_separate_travel_acceleration(Flavor flavor) {
  flavor = flavor_or_marlin(flavor);
  return flavor == Flavor::Repetier || flavor == Flavor::MarlinFirmware || flavor == Flavor::RepRapFirmware;
}

// The text of GCodeWriter::set_acceleration_internal (GCodeWriter.cpp:345) once the caller has clamped the value and
//  checked it against the last one. `separate_travel`: a travel acceleration on a flavor that has its own command.
inline std::string machine_acceleration_text(unsigned int acceleration, bool separate_travel, Flavor flavor,
                                             bool accel_to_decel_enable, double accel_to_decel_factor) {
  flavor = flavor_or_marlin(flavor);
  std::ostringstream gcode;
  if (flavor == Flavor::Repetier) {
    if (separate_travel) gcode << "M202 X"; else gcode << "M201 X";
    gcode << acceleration << " Y" << acceleration;
  } else if (flavor == Flavor::RepRapFirmware || flavor == Flavor::MarlinFirmware) {
    if (separate_travel) gcode << "M204 T"; else gcode << "M204 P";
    gcode << acceleration;
  } else if (flavor == Flavor::Klipper) {
    gcode << "SET_VELOCITY_LIMIT ACCEL=" << acceleration;
    if (accel_to_decel_enable) {
      gcode << " ACCEL_TO_DECEL=" << acceleration * accel_to_decel_factor / 100;
      gcode << " ; adjust ACCEL_TO_DECEL";
    }
  } else {
    gcode << "M204 S" << acceleration;
  }
  gcode << " ; adjust acceleration";
  gcode << "\n";
  return gcode.str();
}

// The text of GCodeWriter::set_jerk_xy (GCodeWriter.cpp:384) for a jerk the caller checked against the last one.
//  `max_x` / `max_y` are the writer's clamps (0 = none); a Bambu Lab printer appends its Z and E jerk limits.
inline std::string machine_jerk_text(double jerk, Flavor flavor, double max_x, double max_y, bool is_bbl, double jerk_z, double jerk_e) {
  flavor = flavor_or_marlin(flavor);
  std::ostringstream gcode;
  if (flavor == Flavor::Klipper) {
    if (max_x > 0 && jerk > max_x) jerk = max_x;
    if (max_y > 0 && jerk > max_y) jerk = max_y;
    gcode << "SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=" << jerk;
  } else if (flavor == Flavor::Repetier) {
    double jerk_xy = jerk;
    if (max_x > 0 && jerk_xy > max_x) jerk_xy = max_x;
    if (max_y > 0 && jerk_xy > max_y) jerk_xy = max_y;
    gcode << "M207 X" << jerk_xy;
  } else {
    double jerk_x = jerk, jerk_y = jerk;
    if (max_x > 0 && jerk > max_x) jerk_x = max_x;
    if (max_y > 0 && jerk > max_y) jerk_y = max_y;
    gcode << "M205 X" << jerk_x << " Y" << jerk_y;
  }
  if (is_bbl)
    gcode << std::setprecision(2) << " Z" << jerk_z << " E" << jerk_e;
  gcode << " ; adjust jerk";
  gcode << "\n";
  return gcode.str();
}

// The text of GCodeWriter::set_accel_and_jerk (GCodeWriter.cpp:437), Klipper's one command for both. The caller has
//  decided which of the two changed; neither = no text.
inline std::string machine_klipper_velocity_limit(bool set_accel, unsigned int acceleration, bool accel_to_decel_enable,
                                                  double accel_to_decel_factor, bool set_jerk, double jerk) {
  if (!set_accel && !set_jerk) return "";
  std::ostringstream gcode;
  gcode << "SET_VELOCITY_LIMIT";
  if (set_accel) {
    gcode << " ACCEL=" << acceleration;
    if (accel_to_decel_enable)
      gcode << " ACCEL_TO_DECEL=" << acceleration * accel_to_decel_factor / 100;
  }
  if (set_jerk)
    gcode << " SQUARE_CORNER_VELOCITY=" << jerk;
  gcode << " ; adjust VELOCITY_LIMIT(accel/jerk)";
  gcode << "\n";
  return gcode.str();
}
