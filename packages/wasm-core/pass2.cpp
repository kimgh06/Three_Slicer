// pass2.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  The PASS 2 per-layer precomputation, formerly the compute_pre lambda inside slice(). slice() now keeps a
//  one-line lambda that forwards to this, so every call site is untouched.
#include "slice_ctx.h"

#include "clip_util.h"
#include "geom_helpers.h"

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

EmitPre compute_pre_layer(const SliceCtx& C, int i) {
  const Params& p = *C.p;
  std::vector<LayerData>& L = *C.L;
  const int N = C.N, nraft = C.nraft;
  const double w = C.w, zShift = C.zShift;
  const double sparse_spacing = C.sparse_spacing, solid_spacing = C.solid_spacing, support_spacing = C.support_spacing;
  const bool ironOn = C.ironOn;
    EmitPre ep;
    LayerData& ld = L[i];
    const double zE = ld.z + zShift;
    ep.fSup = (int)std::llround(((i==0)?p.first_layer_speed:p.print_speed)*60);
    // Support lines — shared whether or not there is a model (same formulas as the empty-layer branch: angB==supBaseAng, ifSp==ifaceSp)
    const double supBaseAng  = p.support_angle + (i % 2 ? -45.0 : 45.0);
    const double supIfaceAng = supBaseAng + 90.0;
    auto resolvePat = [](const std::string& s) { return (s=="default"||s=="auto"||s=="rectilinear-grid") ? std::string("rectilinear") : s; };
    const double ifaceSp = (p.support_interface_spacing > 1e-6) ? (w + p.support_interface_spacing) : solid_spacing;
    ep.supI = (p.enable_support && !ld.supIface.empty())
      ? build_sparse(ld.supIface, resolvePat(p.support_interface_pattern), supIfaceAng, ifaceSp, i, zE, w, 1.0) : Paths{};
    ep.supB = (p.enable_support && !ld.supBase.empty())
      ? build_sparse(ld.supBase, resolvePat(p.support_base_pattern), supBaseAng, support_spacing, i, zE, w, p.support_density) : Paths{};
    if (ld.contour.empty() || p.spiral_mode) return ep;   // empty layer = support only, spiral = ep unused

    // Gap fill. The classic generator already produced it (medial axis, variable width) and took it out of ld.fill, as
    //  upstream's process_classic does. Arachne mode keeps the approximation it had: the morphological-open leftover of
    //  the fill (gaps narrower than w) filled with single-width lines, open(X)=dilate(erode(X)), leftover = X−open,
    //  excluded from fillCore to prevent double extrusion.
    Paths gap, fillCore = ld.fill;
    if (p.wall_generator == "arachne" && !ld.fill.empty()) {
      Paths opened = morph_open(ld.fill, w*0.5);
      gap = clip_paths(ld.fill, opened, ctDifference);
      gap = offset_paths(offset_paths(gap, -w*0.1), w*0.1);            // remove noise below 0.2w
      if (!gap.empty()) fillCore = clip_paths(ld.fill, gap, ctDifference);
    }
    if (!gap.empty()) ep.gapLines = infill_clipped(gap, p.infill_angle, w);

    Paths topSolid, botSolid;
    for (int j=i; j<=std::min(N-1, i + p.top_shell_layers - 1); ++j) topSolid = union_paths(topSolid, L[j].topSurf);
    for (int j=std::max(0, i - p.bottom_shell_layers + 1); j<=i; ++j) botSolid = union_paths(botSolid, L[j].botSurf);
    Paths solid  = clip_paths(union_paths(topSolid, botSolid), fillCore, ctIntersection);
    // Bridge: the part of this layer's (i>0) exposed bottom ∩ solid that is not held up by support -> fan 100% + bridge_speed slowdown
    Paths bridge;
    if (i>0 && !ld.botSurf.empty()) {
      bridge = clip_paths(solid, ld.botSurf, ctIntersection);
      if (p.enable_support && !L[i-1].supIface.empty())
        bridge = clip_paths(bridge, offset_paths(L[i-1].supIface, w), ctDifference);   // a support contact surface is not a bridge
      if (!bridge.empty()) solid = clip_paths(solid, bridge, ctDifference);            // split it out of the regular solid
    }
    Paths sparse = clip_paths(fillCore, solid, ctDifference);
    double sa = (i%2==0) ? 45.0 : 135.0;
    // Stage 21: per-feature widths (the first layer uses the initial_layer values throughout). With the defaults (every feature 0 -> line_width) the values are identical -> no regression.
    bool firstL = (i==0 && nraft==0);
    double wSolid  = firstL ? p.initial_layer_line_width : p.internal_solid_infill_line_width;
    double wTop    = firstL ? p.initial_layer_line_width : p.top_surface_line_width;
    // Splitting the top surface out of solid (applying top_surface_line_width) happens only when the widths differ — otherwise it stays one solid (no regression).
    Paths topPart, restSolid = solid;
    if (!topSolid.empty() && std::abs(wTop - wSolid) > 1e-6) {
      topPart   = clip_paths(solid, topSolid, ctIntersection);
      restSolid = clip_paths(solid, topPart, ctDifference);
    }
    ep.solidLines = restSolid.empty() ? Paths{} : infill_clipped(restSolid, sa, solid_spacing);
    if (!ep.solidLines.empty()) sort_monotonic(ep.solidLines, sa);
    ep.topLines  = topPart.empty() ? Paths{} : infill_clipped(topPart, sa, solid_spacing);
    if (!ep.topLines.empty()) sort_monotonic(ep.topLines, sa);
    ep.bridgeLines = bridge.empty() ? Paths{} : infill_clipped(bridge, sa, solid_spacing);
    ep.sparseLines = (sparse_spacing>0 && !sparse.empty())
        ? build_sparse(sparse, p.sparse_infill_pattern, p.infill_angle, sparse_spacing, i, zE, w, p.infill_density) : Paths{};
    // Skirt/brim — stage 33: wiring up skirt_height and brim_object_gap
    if (i < std::max(1, p.skirt_height) && nraft==0) {
      int brimRings = (int)std::llround(p.brim_width / w); ep.brim = brimRings>0 && i==0;   // the brim is on the first layer only
      for (int k=0; k<p.skirt_loops; ++k) { Paths r=offset_paths(ld.contour,(p.skirt_distance+w*0.5+k*w)); for (auto& q:r) ep.flExtra.push_back(q); }
      if (i==0) for (int k=1; k<=brimRings; ++k) { Paths r=offset_paths(ld.contour,(p.brim_object_gap+w*0.5+k*w)); for (auto& q:r) ep.flExtra.push_back(q); }
    }

    double classicLen = 0;   // the classic generator's thin walls and gap fill (its loops are in ld.walls)
    for (const ClassicWall& wall : ld.classicWalls) if (!wall.loop) classicLen += paths_len(Paths{wall.pl}, false);
    for (const TreePath& gapPath : ld.classicGapFill) classicLen += paths_len(Paths{gapPath.pl}, false);
    double layerLen = vwalls_len(ld.walls) + paths_len(ep.solidLines,false) + paths_len(ep.sparseLines,false)
                    + paths_len(ep.supI,false) + paths_len(ep.supB,false) + paths_len(ep.flExtra,true)
                    + paths_len(ep.gapLines,false) + paths_len(ep.bridgeLines,false) + classicLen;
    double baseSpeed = (i==0 && nraft==0) ? p.first_layer_speed : p.print_speed;
    double useSpeed = baseSpeed;
    if (p.slow_down_layer_time > 0 && layerLen > 1e-6 && layerLen/baseSpeed < p.slow_down_layer_time)
      useSpeed = std::min(baseSpeed, std::max(20.0, layerLen / p.slow_down_layer_time));   // slow down small layers (floor 20mm/s)
    ep.fPrint = (int)std::llround(useSpeed*60);
    ep.fBridge = (int)std::llround(std::max(5.0, p.bridge_speed)*60);

    // Precompute the ironing (type10) lines — emission uses pre.ironLines
    if (ironOn && !ld.topSurf.empty()) {
      Paths ironArea = clip_paths(ld.topSurf, fillCore, ctIntersection);
      ep.ironLines = ironArea.empty() ? Paths{} : infill_clipped(ironArea, sa+45.0, std::max(0.05, p.ironing_spacing));
    }
    return ep;
}
