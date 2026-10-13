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

EmitPrecompute precompute_layer_emit(const SliceContext& context, int i) {
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
    EmitPrecompute emitPre;
    LayerData& layer = layers[i];
    const double layerZ = layer.z + zShift;
    // The overhang fan's region: the layer below offset by w*(0.5 - threshold) (GcodeWriter::overhang_area). Not on the first
    //  object layer, which upstream skips too (on_first_layer / object_layer_over_raft).
    if (context.overhangOverlap >= 0 && i > 0 && !layers[i-1].contour.empty())
      emitPre.overhangArea = offset_paths(layers[i-1].contour, lineWidth * (0.5 - context.overhangOverlap));
    // reduce_infill_retraction's region: the slice without its exposed top and bottom (upstream's internal surfaces).
    if (context.reduceInfillRetraction && !layer.contour.empty()) {
      emitPre.internalArea = clip_paths(layer.contour, layer.topSurf, ctDifference);
      emitPre.internalArea = clip_paths(emitPre.internalArea, layer.botSurf, ctDifference);
    }
    double supportSpeed;
    if (i==0) supportSpeed = params.first_layer_speed;
    else supportSpeed = params.print_speed;
    emitPre.fSup = (int)std::llround(supportSpeed*60);
    // Support lines — shared whether or not there is a model (same formulas as the empty-layer branch: angB==supBaseAng, ifSp==interfaceSpacing)
    double supportAngleOffset;
    if (i % 2) supportAngleOffset = -45.0;
    else supportAngleOffset = 45.0;
    const double supBaseAng  = params.support_angle + supportAngleOffset;
    const double supIfaceAng = supBaseAng + 90.0;
    auto resolvePattern = [](const std::string& pattern) -> std::string {
      if (pattern=="default"||pattern=="auto"||pattern=="rectilinear-grid") return std::string("rectilinear");
      return pattern;
    };
    double interfaceSpacing;
    if (params.support_interface_spacing > 1e-6) interfaceSpacing = lineWidth + params.support_interface_spacing;
    else interfaceSpacing = solid_spacing;
    if (params.enable_support && !layer.supIface.empty())
      emitPre.supI = build_sparse(layer.supIface, resolvePattern(params.support_interface_pattern), supIfaceAng, interfaceSpacing, i, layerZ, lineWidth, 1.0);
    if (params.enable_support && !layer.supBase.empty())
      emitPre.supB = build_sparse(layer.supBase, resolvePattern(params.support_base_pattern), supBaseAng, support_spacing, i, layerZ, lineWidth, params.support_density);
    // An empty layer prints support only, at fSup — the speed the kernel always used there.
    emitPre.feeds = role_feeds(params, i==0 && raftLayers==0, i + raftLayers, raftLayers, emitPre.fSup, emitPre.fSup, -1.0);
    if (layer.contour.empty() || params.spiral_mode) return emitPre;   // empty layer = support only, spiral = emitPre unused

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
    if (!gap.empty()) emitPre.gapLines = infill_clipped(gap, params.infill_angle, lineWidth);

    Paths topSolid, botSolid;
    for (int j=i; j<=std::min(layerCount-1, i + params.top_shell_layers - 1); ++j) topSolid = union_paths(topSolid, layers[j].topSurf);
    for (int j=std::max(0, i - params.bottom_shell_layers + 1); j<=i; ++j) botSolid = union_paths(botSolid, layers[j].botSurf);
    Paths solid  = clip_paths(union_paths(topSolid, botSolid), fillCore, ctIntersection);
    // Bridge: the part of this layer's (i>0) exposed bottom ∩ solid that is not held up by support -> fan 100% + bridge_speed slowdown
    Paths bridge;
    if (i>0 && !layer.botSurf.empty()) {
      bridge = clip_paths(solid, layer.botSurf, ctIntersection);
      if (params.enable_support && !layers[i-1].supIface.empty())
        bridge = clip_paths(bridge, offset_paths(layers[i-1].supIface, lineWidth), ctDifference);   // a support contact surface is not a bridge
      if (!bridge.empty()) solid = clip_paths(solid, bridge, ctDifference);            // split it out of the regular solid
    }
    Paths sparse = clip_paths(fillCore, solid, ctDifference);
    double solidAngle;
    if (i%2==0) solidAngle = 45.0;
    else solidAngle = 135.0;
    // Upstream's exposed top (this layer's own top surface) and bottom (its own bottom that is not a bridge) print
    //  with their own flow ratio. The kernel's solid is the shell region, so they are cut out of it here, after
    //  sparse is taken, and only when the ratio makes them print differently: with both at 1 nothing is split.
    Paths topExposed, bottomExposed;
    if (params.top_solid_infill_flow_ratio != 1.0 && !layer.topSurf.empty()) {
      topExposed = clip_paths(solid, layer.topSurf, ctIntersection);
      if (!topExposed.empty()) solid = clip_paths(solid, topExposed, ctDifference);
    }
    if (params.bottom_solid_infill_flow_ratio != 1.0 && !layer.botSurf.empty()) {
      bottomExposed = clip_paths(solid, layer.botSurf, ctIntersection);
      if (!bottomExposed.empty()) solid = clip_paths(solid, bottomExposed, ctDifference);
    }
    // Stage 21: per-feature widths (the first layer uses the initial_layer values throughout). With the defaults (every feature 0 -> line_width) the values are identical -> no regression.
    bool firstLayer = (i==0 && raftLayers==0);
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
    if (!restSolid.empty()) emitPre.solidLines = infill_clipped(restSolid, solidAngle, solid_spacing);
    if (!emitPre.solidLines.empty()) sort_monotonic(emitPre.solidLines, solidAngle);
    if (!topPart.empty()) emitPre.topLines = infill_clipped(topPart, solidAngle, solid_spacing);
    if (!emitPre.topLines.empty()) sort_monotonic(emitPre.topLines, solidAngle);
    if (!bridge.empty()) emitPre.bridgeLines = infill_clipped(bridge, solidAngle, solid_spacing);
    if (!topExposed.empty()) {
      emitPre.topExposedLines = infill_clipped(topExposed, solidAngle, solid_spacing);
      sort_monotonic(emitPre.topExposedLines, solidAngle);
    }
    if (!bottomExposed.empty()) {
      emitPre.bottomLines = infill_clipped(bottomExposed, solidAngle, solid_spacing);
      sort_monotonic(emitPre.bottomLines, solidAngle);
    }
    if (sparse_spacing>0 && !sparse.empty())
      emitPre.sparseLines = build_sparse(sparse, params.sparse_infill_pattern, params.infill_angle, sparse_spacing, i, layerZ, lineWidth, params.infill_density);
    // Skirt/brim — stage 33: wiring up skirt_height and brim_object_gap
    if (i < std::max(1, params.skirt_height) && raftLayers==0) {
      int brimRings = (int)std::llround(params.brim_width / lineWidth);
      emitPre.brim = brimRings>0 && i==0;   // the brim is on the first layer only
      for (int k=0; k<params.skirt_loops; ++k) {
        Paths rings=offset_paths(layer.contour,(params.skirt_distance+lineWidth*0.5+k*lineWidth));
        for (auto& ring:rings) emitPre.flExtra.push_back(ring);
      }
      Paths& brimTarget = emitPre.flExtra;                // the brim prints with the skirt unless its own ratio differs
      Paths& brimOwn = emitPre.brimLoops;
      const bool ownBrim = params.brim_flow_ratio != 1.0;
      if (i==0) for (int k=1; k<=brimRings; ++k) {
        Paths rings=offset_paths(layer.contour,(params.brim_object_gap+lineWidth*0.5+k*lineWidth));
        for (auto& ring:rings) {
          if (ownBrim) brimOwn.push_back(ring);
          else brimTarget.push_back(ring);
        }
      }
    }

    double classicLen = 0;   // the classic generator's thin walls and gap fill (its loops are in layer.walls)
    for (const ClassicWall& wall : layer.classicWalls) if (!wall.loop) classicLen += paths_length(Paths{wall.path}, false);
    for (const TreePath& gapPath : layer.classicGapFill) classicLen += paths_length(Paths{gapPath.path}, false);
    double layerLen = walls_length(layer.walls) + paths_length(emitPre.solidLines,false) + paths_length(emitPre.sparseLines,false)
                    + paths_length(emitPre.supI,false) + paths_length(emitPre.supB,false) + paths_length(emitPre.flExtra,true)
                    + paths_length(emitPre.gapLines,false) + paths_length(emitPre.bridgeLines,false) + classicLen;
    double baseSpeed;
    if (i==0 && raftLayers==0) baseSpeed = params.first_layer_speed;
    else baseSpeed = params.print_speed;
    double useSpeed = baseSpeed;
    if (!context.cooling && params.slow_down_layer_time > 0 && layerLen > 1e-6 && layerLen/baseSpeed < params.slow_down_layer_time)
      useSpeed = std::min(baseSpeed, std::max(20.0, layerLen / params.slow_down_layer_time));   // slow down small layers (floor 20mm/s)
    emitPre.fPrint = (int)std::llround(useSpeed*60);
    emitPre.fBridge = (int)std::llround(std::max(5.0, params.bridge_speed)*60);
    double slowDownCap = -1.0;   // the layer-time cap above, for the roles' own speeds when it took effect
    if (useSpeed < baseSpeed) slowDownCap = useSpeed;
    emitPre.feeds = role_feeds(params, i==0 && raftLayers==0, i + raftLayers, raftLayers, emitPre.fPrint, emitPre.fBridge, slowDownCap);

    // Precompute the ironing (type10) lines — emission uses pre.ironLines
    if (ironOn && !layer.topSurf.empty()) {
      Paths ironArea = clip_paths(layer.topSurf, fillCore, ctIntersection);
      if (!ironArea.empty()) emitPre.ironLines = infill_clipped(ironArea, solidAngle+45.0, std::max(0.05, params.ironing_spacing));
    }
    return emitPre;
}
