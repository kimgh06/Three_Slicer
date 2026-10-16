// Stage-9 bridge impl: drives the real ported MinimumSpanningTree (TreeSupport branch-merge core).
#include "tree_bridge.h"
#include "arachne_port/libslic3r/MinimumSpanningTree.hpp"
#include <set>
#include <cmath>
using namespace Slic3r;

namespace tree_bridge {
std::vector<Edge> branch_mst(const std::vector<std::pair<double,double>>& points_mm)
{
    std::vector<Edge> out;
    if (points_mm.size() < 2) return out;
    std::vector<Point> vertices;
    vertices.reserve(points_mm.size());
    for (const auto& point : points_mm)
        vertices.emplace_back((coord_t)std::llround(point.first / SCALING_FACTOR),
                              (coord_t)std::llround(point.second / SCALING_FACTOR));
    MinimumSpanningTree spanning_tree(vertices);
    std::set<std::pair<long long,long long>> seen;
    for (const Point& vertex : spanning_tree.vertices())
        for (const Point& neighbor : spanning_tree.adjacent_nodes(vertex)) {
            long long vertex_key = (long long)vertex.x() * 1000003LL + vertex.y();
            long long neighbor_key = (long long)neighbor.x() * 1000003LL + neighbor.y();
            auto key = std::minmax(vertex_key, neighbor_key);
            if (!seen.insert({key.first, key.second}).second) continue;   // undirected, unique
            out.push_back({ vertex.x()*SCALING_FACTOR, vertex.y()*SCALING_FACTOR, neighbor.x()*SCALING_FACTOR, neighbor.y()*SCALING_FACTOR });
        }
    return out;
}
}
