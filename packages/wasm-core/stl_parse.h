// stl_parse.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#pragma once
#include <cstdint>
#include <vector>

// ---- STL parser (binary + ASCII) ----------------------------------------------
struct Vertex { float x, y, z; };
struct Triangle { Vertex vertices[3]; };

std::vector<Triangle> parse_stl(const std::vector<uint8_t>& bytes);
