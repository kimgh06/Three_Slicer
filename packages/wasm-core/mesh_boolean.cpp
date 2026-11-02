// Mesh boolean through CGAL's corefinement, the same engine upstream's MeshBoolean.cpp uses for its CGAL path. The viewer
//  sends two triangle soups in one frame and gets the result back as a soup; Boolean, Cut (with a half-space box) and
//  negative parts all come through here. Exact constructions, because a rounded construction can leave the result
//  open along the intersection curve. CGAL's refusal of a non-solid input is reported with a typed code rather than
//  approximated: a boolean of an open or self-intersecting mesh has no defined inside.
#include "mesh_boolean.h"

#include <CGAL/Exact_predicates_exact_constructions_kernel.h>
#include <CGAL/Polygon_mesh_processing/corefinement.h>
#include <CGAL/Polygon_mesh_processing/orient_polygon_soup.h>
#include <CGAL/Polygon_mesh_processing/orientation.h>
#include <CGAL/Polygon_mesh_processing/polygon_soup_to_polygon_mesh.h>
#include <CGAL/Polygon_mesh_processing/repair_polygon_soup.h>
#include <CGAL/Polygon_mesh_processing/self_intersections.h>
#include <CGAL/Surface_mesh.h>
#include <CGAL/boost/graph/helpers.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <map>

namespace {
namespace PMP = CGAL::Polygon_mesh_processing;
using Kernel = CGAL::Exact_predicates_exact_constructions_kernel;
using Point = Kernel::Point_3;
using Mesh = CGAL::Surface_mesh<Point>;

using FloatBits = std::array<uint32_t, 3>;

// Unwelded triangles become a mesh by joining corners with identical float bits, the weld write_3mf.js uses.
bool soup_to_mesh(const float* positions, size_t floatCount, Mesh& mesh) {
  std::map<FloatBits, size_t> corners;
  std::vector<Point> points;
  std::vector<std::vector<size_t>> faces;
  faces.reserve(floatCount / 9);
  for (size_t at = 0; at + 9 <= floatCount; at += 9) {
    std::vector<size_t> face;
    for (int corner = 0; corner < 3; ++corner) {
      const float* xyz = positions + at + corner * 3;
      FloatBits bits;
      std::memcpy(bits.data(), xyz, sizeof bits);
      auto found = corners.find(bits);
      if (found == corners.end()) {
        found = corners.emplace(bits, points.size()).first;
        points.emplace_back(xyz[0], xyz[1], xyz[2]);
      }
      face.push_back(found->second);
    }
    faces.push_back(std::move(face));
  }
  PMP::repair_polygon_soup(points, faces);
  PMP::orient_polygon_soup(points, faces);
  PMP::polygon_soup_to_polygon_mesh(points, faces, mesh);
  return !CGAL::is_empty(mesh) && CGAL::is_triangle_mesh(mesh) && CGAL::is_closed(mesh);
}

void mesh_to_soup(const Mesh& mesh, std::vector<float>& positions) {
  positions.clear();
  positions.reserve(mesh.number_of_faces() * 9);
  for (Mesh::Face_index face : mesh.faces()) {
    for (Mesh::Vertex_index vertex : CGAL::vertices_around_face(mesh.halfedge(face), mesh)) {
      const Point& point = mesh.point(vertex);
      positions.push_back((float)CGAL::to_double(point.x()));
      positions.push_back((float)CGAL::to_double(point.y()));
      positions.push_back((float)CGAL::to_double(point.z()));
    }
  }
}

std::string prepare(const float* positions, size_t floatCount, const char* name, Mesh& mesh) {
  if (!soup_to_mesh(positions, floatCount, mesh))
    return std::string("MESH_BOOLEAN_NOT_SOLID: ") + name + " is not a closed mesh";
  if (PMP::does_self_intersect(mesh))
    return std::string("MESH_BOOLEAN_SELF_INTERSECTING: ") + name + " intersects itself";
  if (!PMP::does_bound_a_volume(mesh)) PMP::orient_to_bound_a_volume(mesh);
  return "";
}
}  // namespace

std::string mesh_boolean_run(const float* first, size_t firstFloats, const float* second, size_t secondFloats, int operation,
                             std::vector<float>& positions) {
  Mesh meshA, meshB, result;
  std::string error = prepare(first, firstFloats, "the first object", meshA);
  if (error.empty()) error = prepare(second, secondFloats, "the second object", meshB);
  if (!error.empty()) return error;
  bool done = false;
  try {
    const auto options = CGAL::parameters::throw_on_self_intersection(true);
    const auto none = CGAL::parameters::default_values();
    if (operation == MESH_BOOLEAN_UNION) done = PMP::corefine_and_compute_union(meshA, meshB, result, options, none, none);
    else if (operation == MESH_BOOLEAN_DIFFERENCE) done = PMP::corefine_and_compute_difference(meshA, meshB, result, options, none, none);
    else if (operation == MESH_BOOLEAN_INTERSECTION) done = PMP::corefine_and_compute_intersection(meshA, meshB, result, options, none, none);
    else return "MESH_BOOLEAN_BAD_OPERATION: unknown operation";
  } catch (const std::exception& exception) {
    return std::string("MESH_BOOLEAN_FAILED: ") + exception.what();
  }
  if (!done) return "MESH_BOOLEAN_FAILED: the result would not be a solid";
  if (result.number_of_faces() == 0) return "MESH_BOOLEAN_EMPTY: the result is empty";
  mesh_to_soup(result, positions);
  return "";
}
