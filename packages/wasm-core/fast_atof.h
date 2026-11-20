// atof for the G-code the kernel reads back, without libc's long double scanner.
//  musl's strtod goes through __floatscan, which works in long double; wasm has no hardware long double, so every digit
//  costs soft-float calls (__addtf3, __multf3, fmodl). Measured on three plates of a 28-plate project (st, 35.1 s):
//  atof was 3.0 s, 2.5 s of it under CoolingBuffer::parse_layer_gcode and 0.6 s under parse_filament_chunk.
//  fast_float and strtod are both correctly rounded, so the value is the same double. What fast_float does not read as
//  atof does (leading whitespace, a leading '+', hex, an out-of-range value) goes to atof itself.
#pragma once
#include <cstdlib>
#include <system_error>
#include <fast_float/fast_float.h>

inline double fast_atof(const char* text, const char* end) {
  double value = 0.0;
  const auto parsed = fast_float::from_chars(text, end, value);
  const bool hexPrefix = parsed.ptr != end && (*parsed.ptr == 'x' || *parsed.ptr == 'X');
  if (parsed.ec == std::errc() && !hexPrefix) return value;
  return std::atof(text);
}
