// STUB (stage 7 Arachne port): only debug_out_path() is referenced by Arachne
// (inside #ifdef ARACHNE_DEBUG blocks). Real Utils.hpp pulls boost::filesystem/
// date_time/openssl which require linking.
// (stage 8) also supplies IsTriviallyCopyable / next_highest_power_of_2 used by Fill/FillBase
// (real definitions copied from src/libslic3r/Utils.hpp, unchanged).
#pragma once
#include <string>
#include <cstdarg>
#include <cstdio>
#include <cstdint>
#include <system_error>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <type_traits>
#include <boost/algorithm/string/predicate.hpp>
#include <boost/nowide/cstdio.hpp>
namespace Slic3r {
inline std::string debug_out_path(const char* name, ...) {
    char buf[512]; va_list a; va_start(a, name); std::vsnprintf(buf, sizeof buf, name, a); va_end(a);
    return std::string("debug/") + buf;
}
// ---- (stage 11/13) file / time / g-code helpers used by config + GCodeProcessor. All verbatim from
// src/libslic3r/Utils.hpp / Utils.cpp; header-only so no Utils.cpp link. File-I/O paths are inert in
// WASM (string input). This is the single canonical Utils.hpp (config/libslic3r/Utils.hpp forwards). ----
inline bool is_gcode_file(const std::string &path) { return boost::iends_with(path, ".gcode"); }
inline bool is_json_file (const std::string &path) { return boost::iends_with(path, ".json"); }
inline std::string header_slic3r_generated() { return std::string("OrcaSlicer WASM config port"); }
struct FilePtr {
    FilePtr(FILE *f) : f(f) {}
    ~FilePtr() { this->close(); }
    void close() { if (this->f) { ::fclose(this->f); this->f = nullptr; } }
    FILE* f = nullptr;
};
inline std::error_code rename_file(const std::string &from, const std::string &to) {
    boost::nowide::remove(to.c_str());
    return std::make_error_code(static_cast<std::errc>(std::rename(from.c_str(), to.c_str())));
}
inline std::string format_diameter_to_str(double diameter, int precision = 1) {
    double candidates[] = {0.2, 0.4, 0.6, 0.8};
    double best = *std::min_element(std::begin(candidates), std::end(candidates),
        [diameter](double a, double b) { return std::abs(a - diameter) < std::abs(b - diameter); });
    std::ostringstream oss; oss << std::fixed << std::setprecision(precision) << best; return oss.str();
}
inline std::string get_time_dhms(float time_in_secs) {
    int days = (int)(time_in_secs / 86400.0f);  time_in_secs -= (float)days * 86400.0f;
    int hours = (int)(time_in_secs / 3600.0f);  time_in_secs -= (float)hours * 3600.0f;
    int minutes = (int)(time_in_secs / 60.0f);  time_in_secs -= (float)minutes * 60.0f;
    char buffer[64];
    if (days > 0)             ::sprintf(buffer, "%dd %dh %dm %ds", days, hours, minutes, (int)time_in_secs);
    else if (hours > 0)       ::sprintf(buffer, "%dh %dm %ds", hours, minutes, (int)time_in_secs);
    else if (minutes > 0)     ::sprintf(buffer, "%dm %ds", minutes, (int)time_in_secs);
    else if (time_in_secs > 1)::sprintf(buffer, "%ds", (int)time_in_secs);
    else                      ::sprintf(buffer, "%fs", time_in_secs);
    return buffer;
}
inline std::string short_time(const std::string &time) {
    int days = 0, hours = 0, minutes = 0, seconds = 0; float f_seconds = 0.0;
    if (time.find('d') != std::string::npos) ::sscanf(time.c_str(), "%dd %dh %dm %ds", &days, &hours, &minutes, &seconds);
    else if (time.find('h') != std::string::npos) ::sscanf(time.c_str(), "%dh %dm %ds", &hours, &minutes, &seconds);
    else if (time.find('m') != std::string::npos) ::sscanf(time.c_str(), "%dm %ds", &minutes, &seconds);
    else if (time.find('s') != std::string::npos) { ::sscanf(time.c_str(), "%fs", &f_seconds); seconds = int(f_seconds); }
    if (days + hours > 0 && seconds >= 30) { if (++minutes == 60) { minutes = 0; if (++hours == 24) { hours = 0; ++days; } } }
    char buffer[64];
    if (days > 0)               ::sprintf(buffer, "%dd%dh%dm", days, hours, minutes);
    else if (hours > 0)         ::sprintf(buffer, "%dh%dm", hours, minutes);
    else if (minutes > 0)       ::sprintf(buffer, "%dm%ds", minutes, (int)seconds);
    else if (seconds >= 1)      ::sprintf(buffer, "%ds", (int)seconds);
    else if (f_seconds > 0 && f_seconds < 1) ::sprintf(buffer, "<1s");
    else if (seconds == 0)      ::sprintf(buffer, "0s");
    return buffer;
}
// from Utils.hpp:454
template<typename T> struct IsTriviallyCopyable : public std::is_trivially_copyable<T> {};
// from Utils.hpp (bit trick), used by KDTreeIndirect/ShortestPath. Single template avoids the
// overload ambiguity the real multi-overload set resolves via SFINAE.
template<class T> inline size_t next_highest_power_of_2(T v_) {
    uint64_t v = uint64_t(v_);
    if (v != 0) --v; v |= v >> 1; v |= v >> 2; v |= v >> 4; v |= v >> 8; v |= v >> 16; v |= v >> 32; return size_t(++v);
}
// modulo index/value helpers (copied verbatim from Utils.hpp, used by FillBase)
template<typename I> inline I prev_idx_modulo(I idx, const I count) { if (idx==0) idx=count; return --idx; }
template<typename I> inline I next_idx_modulo(I idx, const I count) { if (++idx==count) idx=0; return idx; }
template<typename C> inline typename C::size_type prev_idx_modulo(typename C::size_type idx, const C& c) { return prev_idx_modulo(idx, c.size()); }
template<typename C> inline typename C::size_type next_idx_modulo(typename C::size_type idx, const C& c) { return next_idx_modulo(idx, c.size()); }
template<typename C> inline const typename C::value_type& prev_value_modulo(typename C::size_type idx, const C& c) { return c[prev_idx_modulo(idx, c.size())]; }
template<typename C> inline typename C::value_type& prev_value_modulo(typename C::size_type idx, C& c) { return c[prev_idx_modulo(idx, c.size())]; }
template<typename C> inline const typename C::value_type& next_value_modulo(typename C::size_type idx, const C& c) { return c[next_idx_modulo(idx, c.size())]; }
template<typename C> inline typename C::value_type& next_value_modulo(typename C::size_type idx, C& c) { return c[next_idx_modulo(idx, c.size())]; }
// (stage 16) verbatim from Utils.hpp:369/402 — used by TreeModelVolumes/TreeSupportCommon.
template <class VectorType> inline void reserve_power_of_2(VectorType &vector, size_t n) { vector.reserve(next_highest_power_of_2(n)); }
template<typename INDEX_TYPE> inline INDEX_TYPE round_up_divide(const INDEX_TYPE dividend, const INDEX_TYPE divisor) { return (dividend + divisor - 1) / divisor; }
// (issue 63) verbatim from Utils.hpp:209-210 — PlaceholderParser's string functions; bodies in utils_utf8.cpp.
extern size_t get_utf8_sequence_length(const std::string& text, size_t pos = 0);
extern size_t get_utf8_sequence_length(const char *seq, size_t size);
} // namespace Slic3r
