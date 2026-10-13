// stl_parse.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#pragma once
#include <cstdint>
#include <vector>

// ---- STL parser (binary + ASCII) ----------------------------------------------
struct V3 { float x, y, z; };
struct Tri { V3 v[3]; };

std::vector<Tri> parse_stl(const std::vector<uint8_t>& bytes);
