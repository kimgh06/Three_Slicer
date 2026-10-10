// STUB (stage 8 port): real GCodeWriter.hpp pulls Extruder/PrintConfig/GCode/CoolingBuffer.
// PressureEqualizer only needs the self-contained GCodeFormatter + GCodeG1Formatter (G1 line
// text formatting). Extracted verbatim from src/libslic3r/GCodeWriter.hpp lines 220-319 (unchanged).
#pragma once
#include "libslic3r.h"
#include <string>
#include <charconv>
#include <cstring>
#include <cmath>
#include "Point.hpp"
namespace Slic3r {
class GCodeFormatter {
public:
    GCodeFormatter() {
        this->buf_end = buf + buflen;
        this->ptr_err.ptr = this->buf;
    }

    GCodeFormatter(const GCodeFormatter&) = delete;
    GCodeFormatter& operator=(const GCodeFormatter&) = delete;

    // At layer height 0.15mm, extrusion width 0.2mm and filament diameter 1.75mm,
    // the crossection of extrusion is 0.4 * 0.15 = 0.06mm2
    // and the filament crossection is 1.75^2 = 3.063mm2
    // thus the filament moves 3.063 / 0.6 = 51x slower than the XY axes
    // and we need roughly two decimal digits more on extruder than on XY.
#if 1
    static constexpr const int XYZF_EXPORT_DIGITS = 3;
    static constexpr const int E_EXPORT_DIGITS    = 5;
#else
    // order of magnitude smaller extrusion rate erros
    static constexpr const int XYZF_EXPORT_DIGITS = 4;
    static constexpr const int E_EXPORT_DIGITS    = 6;
    // excessive accuracy
//    static constexpr const int XYZF_EXPORT_DIGITS = 6;
//    static constexpr const int E_EXPORT_DIGITS    = 9;
#endif
    static constexpr const std::array<double, 10> pow_10 { 1., 10., 100., 1000., 10000., 100000., 1000000., 10000000., 100000000., 1000000000. };
    static constexpr const std::array<double, 10> pow_10_inv { 1. / 1., 1. / 10., 1. / 100., 1. / 1000., 1. / 10000., 1. / 100000., 1. / 1000000., 1. / 10000000., 1. / 100000000., 1. / 1000000000. };

    // Quantize doubles to a resolution of the G-code.
    static double quantize(double v, size_t ndigits) { return std::round(v * pow_10[ndigits]) * pow_10_inv[ndigits]; }
    static double quantize_xyzf(double v) { return quantize(v, XYZF_EXPORT_DIGITS); }
    static double quantize_e(double v) { return quantize(v, E_EXPORT_DIGITS); }

    void emit_axis(const char axis, const double v, size_t digits);

    void emit_xy(const Vec2d &point) {
        this->emit_axis('X', point.x(), XYZF_EXPORT_DIGITS);
        this->emit_axis('Y', point.y(), XYZF_EXPORT_DIGITS);
    }

    void emit_xyz(const Vec3d &point) {
        this->emit_axis('X', point.x(), XYZF_EXPORT_DIGITS);
        this->emit_axis('Y', point.y(), XYZF_EXPORT_DIGITS);
        this->emit_z(point.z());
    }

    void emit_z(const double z) {
        this->emit_axis('Z', z, XYZF_EXPORT_DIGITS);
    }

    void emit_e(double v) {
        this->emit_axis('E', v, E_EXPORT_DIGITS);
    }

    void emit_f(double speed) {
        this->emit_axis('F', speed, XYZF_EXPORT_DIGITS);
    }
    //BBS
    void emit_ij(const Vec2d &point) {
        this->emit_axis('I', point.x(), XYZF_EXPORT_DIGITS);
        this->emit_axis('J', point.y(), XYZF_EXPORT_DIGITS);
    }

    void emit_string(const std::string &s) {
        strncpy(ptr_err.ptr, s.c_str(), s.size());
        ptr_err.ptr += s.size();
    }

    void emit_comment(bool allow_comments, const std::string &comment) {
        if (allow_comments && ! comment.empty()) {
            *ptr_err.ptr ++ = ' '; *ptr_err.ptr ++ = ';'; *ptr_err.ptr ++ = ' ';
            this->emit_string(comment);
        }
    }

    std::string string() {
        *ptr_err.ptr ++ = '\n';
        return std::string(this->buf, ptr_err.ptr - buf);
    }

protected:
    static constexpr const size_t   buflen = 256;
    char                            buf[buflen];
    char* buf_end;
    std::to_chars_result            ptr_err;
};

class GCodeG1Formatter : public GCodeFormatter {
public:
    GCodeG1Formatter() {
        this->buf[0] = 'G';
        this->buf[1] = '1';
        this->buf_end = buf + buflen;
        this->ptr_err.ptr = this->buf + 2;
    }

    GCodeG1Formatter(const GCodeG1Formatter&) = delete;
    GCodeG1Formatter& operator=(const GCodeG1Formatter&) = delete;
};

// (stage 13 GCodeProcessor port) GCodeProcessor.cpp uses two static GCodeWriter helpers only
// (set_temperature @1409, supports_separate_travel_acceleration). The real GCodeWriter class pulls
// Extruder/CoolingBuffer/GCode; here just those two, verbatim from GCodeWriter.cpp. Additive — the
// PressureEqualizer TU (which also includes this header) never references the GCodeWriter class.
} // namespace Slic3r
#include "PrintConfig.hpp"   // GCodeFlavor (real via forwarder); GCodeProcessor includes this header first
#include <sstream>
namespace Slic3r {
class GCodeWriter {
public:
    static std::string set_temperature(unsigned int temperature, GCodeFlavor flavor, bool wait = false, int tool = -1, std::string comment = std::string()) {
        if (wait && (flavor == gcfMakerWare || flavor == gcfSailfish)) return "";
        std::string code;
        if (wait && flavor != gcfTeacup && flavor != gcfRepRapFirmware) {
            code = "M109"; if (comment.empty()) comment = "set nozzle temperature and wait for it to be reached";
        } else {
            code = (flavor == gcfRepRapFirmware) ? "G10" : "M104";
            if (comment.empty()) comment = "set nozzle temperature";
        }
        std::ostringstream gcode;
        gcode << code << " ";
        gcode << ((flavor == gcfMach3 || flavor == gcfMachinekit) ? "P" : "S");
        gcode << temperature;
        if (tool != -1) gcode << ((flavor == gcfRepRapFirmware) ? " P" : " T") << tool;
        gcode << " ; " << comment << "\n";
        if ((flavor == gcfTeacup || flavor == gcfRepRapFirmware) && wait)
            gcode << "M116 ; wait for temperature to be reached\n";
        return gcode.str();
    }
    static bool supports_separate_travel_acceleration(GCodeFlavor flavor) {
        return (flavor == gcfRepetier || flavor == gcfMarlinFirmware || flavor == gcfRepRapFirmware);
    }
    // set_fan / set_additional_fan, verbatim from GCodeWriter.cpp:1258/:1305 — what the ported CoolingBuffer writes
    //  its fan commands with (full_gcode_comment is upstream's default, true).
    static std::string set_fan(const GCodeFlavor gcode_flavor, unsigned int speed, unsigned int part_cooling_fan_min_pwm) {
        std::ostringstream gcode;
        if (speed > 0 && part_cooling_fan_min_pwm > 0 && speed < part_cooling_fan_min_pwm)
            speed = part_cooling_fan_min_pwm;
        if (speed == 0) {
            switch (gcode_flavor) {
            case gcfTeacup:
                gcode << "M106 S0"; break;
            case gcfMakerWare:
            case gcfSailfish:
                gcode << "M127";    break;
            default:
                gcode << "M106 S0";    break;
            }
            gcode << " ; disable fan";
            gcode << "\n";
        } else {
            switch (gcode_flavor) {
            case gcfMakerWare:
            case gcfSailfish:
                gcode << "M126";    break;
            case gcfMach3:
            case gcfMachinekit:
                gcode << "M106 P" << static_cast<unsigned int>(255.5 * speed / 100.0); break;
            default:
                gcode << "M106 S" << static_cast<unsigned int>(255.5 * speed / 100.0); break;
            }
            gcode << " ; enable fan";
            gcode << "\n";
        }
        return gcode.str();
    }
    static std::string set_additional_fan(unsigned int speed) {
        std::ostringstream gcode;
        gcode << "M106 " << "P2 " << "S" << (int)(255.0 * speed / 100.0);
        if (speed == 0)
            gcode << " ; disable additional fan ";
        else
            gcode << " ; enable additional fan ";
        gcode << "\n";
        return gcode.str();
    }
};
} // namespace Slic3r
