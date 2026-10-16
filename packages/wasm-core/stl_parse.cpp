// stl_parse.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#include "stl_parse.h"

#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

static bool is_binary_stl(const std::vector<uint8_t>& bytes) {
  if (bytes.size() < 84) return false;
  uint32_t triangleCount;
  std::memcpy(&triangleCount, &bytes[80], 4);
  return bytes.size() == (size_t)84 + (size_t)triangleCount * 50;   // an exact match means binary
}
static std::vector<Triangle> parse_binary(const std::vector<uint8_t>& bytes) {
  std::vector<Triangle> triangles;
  uint32_t triangleCount;
  std::memcpy(&triangleCount, &bytes[80], 4);
  size_t requiredSize = 84 + (size_t)triangleCount * 50;
  if (bytes.size() < requiredSize) triangleCount = (uint32_t)((bytes.size() - 84) / 50);
  triangles.reserve(triangleCount);
  size_t offset = 84;
  for (uint32_t i = 0; i < triangleCount; ++i) {
    Triangle triangle;
    offset += 12;
    for (int k = 0; k < 3; ++k) {
      float coordinates[3];
      std::memcpy(coordinates, &bytes[offset], 12);
      offset += 12;
      triangle.vertices[k]={coordinates[0],coordinates[1],coordinates[2]};
    }
    offset += 2;
    triangles.push_back(triangle);
  }
  return triangles;
}
// ASCII: collect "vertex x y z" in order, three at a time into a triangle (facet/loop/normal ignored)
static std::vector<Triangle> parse_ascii(const std::vector<uint8_t>& bytes) {
  std::vector<Triangle> triangles;
  std::string text((const char*)bytes.data(), bytes.size());
  std::vector<Vertex> vertices;
  size_t position = 0;
  while ((position = text.find("vertex", position)) != std::string::npos) {
    position += 6;
    char* end = nullptr;
    double x = std::strtod(text.c_str()+position, &end);
    if (end==text.c_str()+position) break;
    position = end - text.c_str();
    double y = std::strtod(text.c_str()+position, &end);
    position = end - text.c_str();
    double z = std::strtod(text.c_str()+position, &end);
    position = end - text.c_str();
    vertices.push_back({(float)x,(float)y,(float)z});
  }
  for (size_t i = 0; i + 2 < vertices.size(); i += 3) {
    Triangle triangle;
    triangle.vertices[0]=vertices[i];
    triangle.vertices[1]=vertices[i+1];
    triangle.vertices[2]=vertices[i+2];
    triangles.push_back(triangle);
  }
  return triangles;
}
std::vector<Triangle> parse_stl(const std::vector<uint8_t>& bytes) {
  if (bytes.size() < 15) return {};
  if (is_binary_stl(bytes)) return parse_binary(bytes);
  return parse_ascii(bytes);
}
