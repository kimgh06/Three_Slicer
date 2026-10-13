// Stage-20: project painted enforcer/blocker facets to per-layer polygons by XY footprint.
// slice_mesh_slabs() returns empty for an isolated (non-watertight) painted patch, so we use a direct,
// deterministic footprint: each painted triangle contributes its 2D (XY) projection to every slicing
// plane whose z falls within the triangle's z-span (flat faces -> the nearest plane). The per-layer
// union is the enforced/blocked region, consumed by generate_overhangs (tree) and the grid path.
#pragma once
#include "TriangleMesh.hpp"     // indexed_triangle_set
#include "Polygon.hpp"
#include "ClipperUtils.hpp"     // union_
#include <vector>
#include <algorithm>

namespace Slic3r {

inline std::vector<Polygons> project_custom_facets_footprint(const indexed_triangle_set &facets,
                                                             const std::vector<float> &zs)
{
    std::vector<Polygons> out(zs.size());
    if (facets.indices.empty() || zs.empty()) return out;
    // half the layer spacing (uniform layers) — tolerance so a flat face lands on its nearest plane.
    float half_gap;
    if (zs.size() > 1)
        half_gap = std::max(1e-4f, 0.5f * std::abs(zs[1] - zs[0]));
    else
        half_gap = 1e-3f;
    for (const auto &face : facets.indices) {
        const Vec3f &vertex_a = facets.vertices[face[0]];
        const Vec3f &vertex_b = facets.vertices[face[1]];
        const Vec3f &vertex_c = facets.vertices[face[2]];
        float z_min = std::min({vertex_a.z(), vertex_b.z(), vertex_c.z()});
        float z_max = std::max({vertex_a.z(), vertex_b.z(), vertex_c.z()});
        Point point_a(scale_(vertex_a.x()), scale_(vertex_a.y()));
        Point point_b(scale_(vertex_b.x()), scale_(vertex_b.y()));
        Point point_c(scale_(vertex_c.x()), scale_(vertex_c.y()));
        // Orientation via double cross product (scaled coords overflow coord_t area math on large facets).
        double cross = double(point_b.x()-point_a.x())*double(point_c.y()-point_a.y())
                     - double(point_b.y()-point_a.y())*double(point_c.x()-point_a.x());
        if (cross == 0.0) continue;   // degenerate (edge-on) projection
        Polygon triangle;
        if (cross > 0.0)   // ensure CCW
            triangle.points = Points{point_a, point_b, point_c};
        else
            triangle.points = Points{point_a, point_c, point_b};
        for (size_t i = 0; i < zs.size(); ++i)
            if (zs[i] >= z_min - half_gap && zs[i] <= z_max + half_gap)
                out[i].push_back(triangle);
    }
    for (Polygons &polygons : out)
        if (!polygons.empty()) polygons = union_(polygons);
    return out;
}

} // namespace Slic3r
