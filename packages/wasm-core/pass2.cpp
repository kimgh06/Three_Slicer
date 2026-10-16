// pass2.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  The PASS 2 per-layer precomputation, formerly a lambda inside slice(). slice() now keeps a one-line lambda
//  (precomputeLayer) that forwards to this, so every call site is untouched.
#include "slice_ctx.h"

#include "clip_util.h"
#include "geom_helpers.h"

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

EmitPrecompute precompute_layer_emit(const SliceContext& context, int layerIndex) {
  const Params& params = *context.params;
  std::vector<LayerData>& layers = *context.layers;
  const int layerCount = context.layerCount;
  const int raftLayers = context.raftLayerCount;
  const double lineWidth = context.lineWidth;
  const double zShift = context.zShift;
  const double sparse_spacing = context.sparse_spacing;
  const double solid_spacing = context.solid_spacing;
  const double support_spacing = context.support_spacing;
  const bool ironOn = context.ironOn;
    EmitPrecompute precompute;
    LayerData& layer = layers[layerIndex];
    const double layerZ = layer.z + zShift;
    // The overhang fan's region: the layer below offset by w*(0.5 - threshold) (GcodeWriter::overhang_area). Not on the first
    //  object layer, which upstream skips too (on_first_layer / object_layer_over_raft).
    if (context.overhangOverlap >= 0 && layerIndex > 0 && !layers[layerIndex-1].contour.empty())
      precompute.overhangArea = offset_paths(layers[layerIndex-1].contour, lineWidth * (0.5 - context.overhangOverlap));
    // reduce_infill_retraction's region: the slice without its exposed top and bottom (upstream's internal surfaces).
    if (context.reduceInfillRetraction && !layer.contour.empty()) {
      precompute.internalArea = clip_paths(layer.contour, layer.topSurface, ctDifference);
      precompute.internalArea = clip_paths(precompute.internalArea, layer.bottomSurface, ctDifference);
    }
    double supportSpeed;
    if (layerIndex==0) supportSpeed = params.first_layer_speed;
    else supportSpeed = params.print_speed;
    precompute.supportFeed = (int)std::llround(supportSpeed*60);
    // Support lines — shared whether or not there is a model (same formulas as the empty-layer branch)
    double supportAngleOffset;
    if (layerIndex % 2) supportAngleOffset = -45.0;
    else supportAngleOffset = 45.0;
    const double supportBaseAngle      = params.support_angle + supportAngleOffset;
    const double supportInterfaceAngle = supportBaseAngle + 90.0;
    auto resolvePattern = [](const std::string& pattern) -> std::string {
      if (pattern=="default"||pattern=="auto"||pattern=="rectilinear-grid") return std::string("rectilinear");
      return pattern;
    };
    double interfaceSpacing;
    if (params.support_interface_spacing > 1e-6) interfaceSpacing = lineWidth + params.support_interface_spacing;
    else interfaceSpacing = solid_spacing;
    if (params.enable_support && !layer.supportInterface.empty())
      precompute.supportInterfaceLines = build_sparse(layer.supportInterface, resolvePattern(params.support_interface_pattern), supportInterfaceAngle, interfaceSpacing, layerIndex, layerZ, lineWidth, 1.0);
    if (params.enable_support && !layer.supportBase.empty())
      precompute.supportBaseLines = build_sparse(layer.supportBase, resolvePattern(params.support_base_pattern), supportBaseAngle, support_spacing, layerIndex, layerZ, lineWidth, params.support_density);
    // An empty layer prints support only, at supportFeed — the speed the kernel always used there.
    precompute.feeds = role_feeds(params, layerIndex==0 && raftLayers==0, layerIndex + raftLayers, raftLayers, precompute.supportFeed, precompute.supportFeed, -1.0);
    if (layer.contour.empty() || params.spiral_mode) return precompute;   // empty layer = support only, spiral = precompute unused

    // Gap fill. The classic generator already produced it (medial axis, variable width) and took it out of layer.fill, as
    //  upstream's process_classic does. Arachne mode keeps the approximation it had: the morphological-open leftover of
    //  the fill (gaps narrower than w) filled with single-width lines, open(X)=dilate(erode(X)), leftover = X−open,
    //  excluded from fillCore to prevent double extrusion.
    Paths gap, fillCore = layer.fill;
    if (params.wall_generator == "arachne" && !layer.fill.empty()) {
      Paths opened = morph_open(layer.fill, lineWidth*0.5);
      gap = clip_paths(layer.fill, opened, ctDifference);
      gap = offset_paths(offset_paths(gap, -lineWidth*0.1), lineWidth*0.1);            // remove noise below 0.2w
      if (!gap.empty()) fillCore = clip_paths(layer.fill, gap, ctDifference);
    }
    if (!gap.empty()) precompute.gapLines = infill_clipped(gap, params.infill_angle, lineWidth);

    Paths topSolid, bottomSolid;
    for (int j=layerIndex; j<=std::min(layerCount-1, layerIndex + params.top_shell_layers - 1); ++j) topSolid = union_paths(topSolid, layers[j].topSurface);
    for (int j=std::max(0, layerIndex - params.bottom_shell_layers + 1); j<=layerIndex; ++j) bottomSolid = union_paths(bottomSolid, layers[j].bottomSurface);
    Paths solid  = clip_paths(union_paths(topSolid, bottomSolid), fillCore, ctIntersection);
    // Bridge: the part of this layer's (layerIndex>0) exposed bottom ∩ solid that is not held up by support -> fan 100% + bridge_speed slowdown
    Paths bridge;
    if (layerIndex>0 && !layer.bottomSurface.empty()) {
      bridge = clip_paths(solid, layer.bottomSurface, ctIntersection);
      if (params.enable_support && !layers[layerIndex-1].supportInterface.empty())
        bridge = clip_paths(bridge, offset_paths(layers[layerIndex-1].supportInterface, lineWidth), ctDifference);   // a support contact surface is not a bridge
      if (!bridge.empty()) solid = clip_paths(solid, bridge, ctDifference);            // split it out of the regular solid
    }
    Paths sparse = clip_paths(fillCore, solid, ctDifference);
    double solidAngle;
    if (layerIndex%2==0) solidAngle = 45.0;
    else solidAngle = 135.0;
    // Upstream's exposed top (this layer's own top surface) and bottom (its own bottom that is not a bridge) print
    //  with their own flow ratio. The kernel's solid is the shell region, so they are cut out of it here, after
    //  sparse is taken, and only when the ratio makes them print differently: with both at 1 nothing is split.
    Paths topExposed, bottomExposed;
    if (params.top_solid_infill_flow_ratio != 1.0 && !layer.topSurface.empty()) {
      topExposed = clip_paths(solid, layer.topSurface, ctIntersection);
      if (!topExposed.empty()) solid = clip_paths(solid, topExposed, ctDifference);
    }
    if (params.bottom_solid_infill_flow_ratio != 1.0 && !layer.bottomSurface.empty()) {
      bottomExposed = clip_paths(solid, layer.bottomSurface, ctIntersection);
      if (!bottomExposed.empty()) solid = clip_paths(solid, bottomExposed, ctDifference);
    }
    // Stage 21: per-feature widths (the first layer uses the initial_layer values throughout). With the defaults (every feature 0 -> line_width) the values are identical -> no regression.
    bool firstLayer = (layerIndex==0 && raftLayers==0);
    double solidWidth  = params.internal_solid_infill_line_width;
    double topWidth    = params.top_surface_line_width;
    if (firstLayer) {
      solidWidth = params.initial_layer_line_width;
      topWidth   = params.initial_layer_line_width;
    }
    // Splitting the top surface out of solid (applying top_surface_line_width) happens only when the widths differ — otherwise it stays one solid (no regression).
    Paths topPart, restSolid = solid;
    if (!topSolid.empty() && std::abs(topWidth - solidWidth) > 1e-6) {
      topPart   = clip_paths(solid, topSolid, ctIntersection);
      restSolid = clip_paths(solid, topPart, ctDifference);
    }
    if (!restSolid.empty()) precompute.solidLines = infill_clipped(restSolid, solidAngle, solid_spacing);
    if (!precompute.solidLines.empty()) sort_monotonic(precompute.solidLines, solidAngle);
    if (!topPart.empty()) precompute.topLines = infill_clipped(topPart, solidAngle, solid_spacing);
    if (!precompute.topLines.empty()) sort_monotonic(precompute.topLines, solidAngle);
    if (!bridge.empty()) precompute.bridgeLines = infill_clipped(bridge, solidAngle, solid_spacing);
    if (!topExposed.empty()) {
      precompute.topExposedLines = infill_clipped(topExposed, solidAngle, solid_spacing);
      sort_monotonic(precompute.topExposedLines, solidAngle);
    }
    if (!bottomExposed.empty()) {
      precompute.bottomLines = infill_clipped(bottomExposed, solidAngle, solid_spacing);
      sort_monotonic(precompute.bottomLines, solidAngle);
    }
    if (sparse_spacing>0 && !sparse.empty())
      precompute.sparseLines = build_sparse(sparse, params.sparse_infill_pattern, params.infill_angle, sparse_spacing, layerIndex, layerZ, lineWidth, params.infill_density);
    // Skirt/brim — stage 33: wiring up skirt_height and brim_object_gap
    if (layerIndex < std::max(1, params.skirt_height) && raftLayers==0) {
      int brimRings = (int)std::llround(params.brim_width / lineWidth);
      precompute.brim = brimRings>0 && layerIndex==0;   // the brim is on the first layer only
      for (int k=0; k<params.skirt_loops; ++k) {
        Paths rings=offset_paths(layer.contour,(params.skirt_distance+lineWidth*0.5+k*lineWidth));
        for (auto& ring:rings) precompute.skirtBrimLoops.push_back(ring);
      }
      Paths& brimTarget = precompute.skirtBrimLoops;                // the brim prints with the skirt unless its own ratio differs
      Paths& brimOwn = precompute.brimLoops;
      const bool ownBrim = params.brim_flow_ratio != 1.0;
      if (layerIndex==0) for (int k=1; k<=brimRings; ++k) {
        Paths rings=offset_paths(layer.contour,(params.brim_object_gap+lineWidth*0.5+k*lineWidth));
        for (auto& ring:rings) {
          if (ownBrim) brimOwn.push_back(ring);
          else brimTarget.push_back(ring);
        }
      }
    }

    double classicLength = 0;   // the classic generator's thin walls and gap fill (its loops are in layer.walls)
    for (const ClassicWall& wall : layer.classicWalls) if (!wall.loop) classicLength += paths_length(Paths{wall.path}, false);
    for (const TreePath& gapPath : layer.classicGapFill) classicLength += paths_length(Paths{gapPath.path}, false);
    double layerLength = walls_length(layer.walls) + paths_length(precompute.solidLines,false) + paths_length(precompute.sparseLines,false)
                    + paths_length(precompute.supportInterfaceLines,false) + paths_length(precompute.supportBaseLines,false) + paths_length(precompute.skirtBrimLoops,true)
                    + paths_length(precompute.gapLines,false) + paths_length(precompute.bridgeLines,false) + classicLength;
    double baseSpeed;
    if (layerIndex==0 && raftLayers==0) baseSpeed = params.first_layer_speed;
    else baseSpeed = params.print_speed;
    double useSpeed = baseSpeed;
    if (!context.cooling && params.slow_down_layer_time > 0 && layerLength > 1e-6 && layerLength/baseSpeed < params.slow_down_layer_time)
      useSpeed = std::min(baseSpeed, std::max(20.0, layerLength / params.slow_down_layer_time));   // slow down small layers (floor 20mm/s)
    precompute.printFeed = (int)std::llround(useSpeed*60);
    precompute.bridgeFeed = (int)std::llround(std::max(5.0, params.bridge_speed)*60);
    double slowDownCap = -1.0;   // the layer-time cap above, for the roles' own speeds when it took effect
    if (useSpeed < baseSpeed) slowDownCap = useSpeed;
    precompute.feeds = role_feeds(params, layerIndex==0 && raftLayers==0, layerIndex + raftLayers, raftLayers, precompute.printFeed, precompute.bridgeFeed, slowDownCap);

    // Precompute the ironing (type10) lines — emission uses pre.ironLines
    if (ironOn && !layer.topSurface.empty()) {
      Paths ironArea = clip_paths(layer.topSurface, fillCore, ctIntersection);
      if (!ironArea.empty()) precompute.ironLines = infill_clipped(ironArea, solidAngle+45.0, std::max(0.05, params.ironing_spacing));
    }
    return precompute;
}
