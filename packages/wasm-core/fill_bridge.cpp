// Stage-8 bridge impl: builds an ExPolygon from kernel contours, runs the real ported Fill pattern,
// returns polylines (mm). Only TU where slicer_core meets Slic3r Fill/Surface types.
#include "fill_bridge.h"
#include "arachne_port/libslic3r/Fill/FillBase.hpp"
#include "arachne_port/libslic3r/Surface.hpp"
#include "arachne_port/libslic3r/ExPolygon.hpp"
#include "arachne_port/libslic3r/Geometry.hpp"
#include "arachne_port/libslic3r/ExtrusionEntityCollection.hpp"
#include "arachne_port/libslic3r/ShortestPath.hpp"
#include <memory>
#include <cmath>

using namespace Slic3r;

namespace fill_bridge {

static inline coord_t sc(double mm) { return (coord_t) std::llround(mm / SCALING_FACTOR); }
static inline double  um(coord_t c) { return double(c) * SCALING_FACTOR; }

static InfillPattern pat_from_name(const std::string& n) {
    if (n=="gyroid")       return ipGyroid;
    if (n=="honeycomb")    return ipHoneycomb;
    if (n=="3dhoneycomb")  return ip3DHoneycomb;
    if (n=="crosshatch")   return ipCrossHatch;
    if (n=="concentric")   return ipConcentric;
    return ipCount; // unknown
}

static Polygon to_polygon(const Poly& p) {
    Polygon poly; poly.points.reserve(p.size());
    for (const auto& xy : p) poly.points.emplace_back(sc(xy.first), sc(xy.second));
    return poly;
}

std::vector<Poly> generate_fill(const std::vector<Poly>& region_mm, const std::string& pattern,
                                double density, double spacing_mm, double angle_deg,
                                double z_mm, int layer_id)
{
    std::vector<Poly> out;
    InfillPattern ip = pat_from_name(pattern);
    if (ip == ipCount || region_mm.empty() || region_mm[0].size() < 3) return out;

    ExPolygon ex;
    ex.contour = to_polygon(region_mm[0]);
    for (size_t i = 1; i < region_mm.size(); ++i)
        if (region_mm[i].size() >= 3) ex.holes.push_back(to_polygon(region_mm[i]));

    std::unique_ptr<Fill> fill(Fill::new_from_type(ip));
    if (!fill) return out;
    fill->spacing        = spacing_mm;
    fill->z              = z_mm;
    fill->layer_id       = (size_t) std::max(0, layer_id);
    fill->angle          = float(angle_deg * M_PI / 180.0);
    fill->bounding_box   = get_extents(ex);
    fill->loop_clipping  = 0;
    fill->link_max_length= 0;
    fill->overlap        = 0;

    FillParams params;
    params.density     = float(density <= 0 ? 0.15 : density);
    params.dont_adjust = true;

    Surface surface(stInternal, ex);
    Polylines pls;
    try { pls = fill->fill_surface(&surface, params); }
    catch (...) { return out; }

    for (const Polyline& pl : pls) {
        Poly poly; poly.reserve(pl.points.size());
        for (const Point& pt : pl.points) poly.push_back({ um(pt.x()), um(pt.y()) });
        if (poly.size() >= 2) out.push_back(std::move(poly));
    }
    return out;
}

static double path_length_mm(const ExtrusionEntity *entity) {
    double length = 0;
    if (auto collection = dynamic_cast<const ExtrusionEntityCollection *>(entity))
        for (const ExtrusionEntity *child : collection->entities) length += path_length_mm(child);
    if (auto path = dynamic_cast<const ExtrusionPath *>(entity))
        length += path->polyline.length() * SCALING_FACTOR;
    return length;
}

double chain_reorder_kept_length() {
    auto path_of_length = [](double length_mm) {
        ExtrusionPath path(erSupportMaterial, 0.1, 0.42f, 0.2f);
        Polyline line;
        line.points = { Point(0, 0), Point(sc(length_mm), 0) };
        path.polyline = Polyline3(line);
        return path;
    };
    ExtrusionEntityCollection layer;
    auto *empty_first = new ExtrusionEntityCollection();
    empty_first->entities.push_back(new ExtrusionEntityCollection());
    empty_first->append(path_of_length(10));
    auto *empty_last = new ExtrusionEntityCollection();
    empty_last->append(path_of_length(5));
    empty_last->append(ExtrusionPath(erSupportMaterial));
    layer.entities.push_back(empty_first);
    layer.entities.push_back(empty_last);
    chain_and_reorder_extrusion_entities(layer.entities);
    return path_length_mm(&layer);
}
} // namespace fill_bridge
