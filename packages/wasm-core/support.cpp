// support.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#include "slice_ctx.h"

#include "clip_util.h"
#include "selector_bridge.h"
#include "treesupport_bridge.h"

#include <algorithm>
#include <cmath>
#include <vector>

void support_run(SliceContext& context) {
  const Params& params = *context.params;
  std::vector<LayerData>& layers = *context.layers;
  const int layerCount = context.layerCount;
  const double lineWidth = context.lineWidth;
  const double modelCenterX = context.centerX;
  const double modelCenterY = context.centerY;
  const double support_spacing = context.support_spacing;
  double& treeZMaxResid = *context.treeZMaxResid;
  int&    treeSupLayers = *context.treeSupLayers;
  // ---- PASS 1.6: support (overhang detection -> vertical projection -> interface/base) ----
  // (G003: used in the preamble outside the skip block -> hoisted above)
  if (params.enable_support) {
   // WP2: "grid"/"snug" now also go through the upstream port (PrintObjectSupportMaterial) — our own reimplementation is used only by tree_lite
   //  (and the explicit "grid_kernel" fallback). It shares the same facade, coordinate transform and rebinding as tree.
   const bool portNormal = (params.support_style == "grid" || params.support_style == "snug");
   if (params.support_style == "tree" || portNormal) {
    // Stage 18: the real organic TreeSupport (generate_tree_support_3D) — build the facade PrintObject graph from the kernel lslices (mm)
    //  -> TreeSupport::generate() -> emit SupportLayer::support_fills (the branch toolpaths) as type5.
    //  A separate path from grid/tree_lite (the simple descending approximation). treesupport_bridge is the ODR boundary (isolating port types).
    // Stage 28 P2: with viewer coordinates (auto_center=false) the model sits away from the origin -> the tree bridge (the generate_tree_support_3D port)
    //  hits a memory access violation at off-origin coordinates. The rings are shifted to the origin by the model's XY center before being handed to the bridge, and the branch output is shifted
    //  back by the same amount (to the model position) before emission -> avoids the crash and preserves the P2 overlap (round trip: input −treeShiftX, output +treeShiftX). With auto_center=true it is already at the origin.
    // Stage 31: the model stays centered on the origin (small coordinates = the safe zone). The bug where support appeared on one side only came from the bridge's
    //  printable_area (= machine_border) being the positive quadrant [0,bed], so intersection_ex clipped away the support on the origin-centered model's
    //  negative X/Y half -> fixed in treesupport_bridge_impl.cpp by making the border **origin-centered** ([-bed/2,bed/2])
    //  (model coordinates stay small -> this also avoids the cross-slice OOB that reappeared at large coordinates).
    double treeShiftX = modelCenterX;
    double treeShiftY = modelCenterY;
    if (params.auto_center) {
      treeShiftX = 0.0;
      treeShiftY = 0.0;
    }
    std::vector<std::vector<treesupport_bridge::Ring>> slices(layerCount);
    std::vector<double> layerZs(layerCount);
    // [Ultra-dense contour guard] Same rule as the arachne guard: a 5µm reduction only above 20k points per layer.
    //  Upstream OrcaSlicer hands support contours that went through resolution simplification, but the kernel's PASS1 skips it, so on
    //  large models (measured at 774k tri) the ported support cost explodes in proportion to the point count. Below the threshold (the golden fixtures) nothing changes.
    auto sanitized = [&](const Paths& sourcePaths) -> Paths {
      size_t pointCount = 0;
      for (const Path& path : sourcePaths) pointCount += path.size();
      if (pointCount <= 20000) return sourcePaths;
      Paths out = sourcePaths;
      CleanPolygons(out, SCALE * 0.005);
      return out;
    };
    for (int j=0;j<layerCount;++j) {
      layerZs[j] = layers[j].z;
      for (const Path& contourPath : sanitized(layers[j].contour)) {
        treesupport_bridge::Ring ring;
        ring.reserve(contourPath.size());
        for (const IntPoint& point : contourPath) ring.emplace_back(point.x()*INV - treeShiftX, point.y()*INV - treeShiftY);
        if (ring.size()>=3) slices[j].push_back(std::move(ring));
      }
    }
    treesupport_bridge::Params treeParams;
    treeParams.layer_height_mm=params.layer_height;
    treeParams.nozzle_mm=params.nozzle_diameter;
    treeParams.first_layer_height_mm=params.first_layer_height;                 // WP1: matches upstream initial_layer_print_height
    treeParams.line_width_mm=params.line_width;                                 // WP1: the lslices_extrudable filter + auto-threshold flow
    treeParams.support_threshold_angle=params.support_threshold_angle;
    treeParams.support_top_z_distance=params.support_top_z_distance;
    treeParams.support_bottom_z_distance=params.support_bottom_z_distance;      // WP1: → gap_object_support
    treeParams.support_xy_distance=params.support_xy_distance;
    treeParams.first_layer_gap_mm=params.support_object_first_layer_gap;        // WP1
    treeParams.interface_top_layers=params.support_interface_top_layers;
    treeParams.interface_bottom_layers=params.support_interface_bottom_layers;  // WP1: -1 => same as top
    treeParams.independent_support_layer_height=params.independent_support_layer_height; // WP1: gap quantization switch
    treeParams.support_auto=params.support_auto;                                // stage 20: automatic/manual (painted enforcers only)
    treeParams.support_line_width_mm=params.support_line_width;                 // stage 19: the real support extrusion width (config -> flow -> per-path)
    treeParams.support_angle_deg=params.support_angle;                          // WP1: SupportParameters::base_angle
    treeParams.on_build_plate_only=params.support_on_build_plate_only;          // WP1
    treeParams.tree_style=params.tree_style;                                    // WP1: organic|slim|strong|hybrid
    treeParams.branch_angle_deg=params.tree_support_branch_angle;               // WP1: wiring up the tree shape keys
    treeParams.angle_slow_deg=params.tree_support_angle_slow;
    treeParams.branch_diameter_mm=params.tree_support_branch_diameter;
    treeParams.branch_distance_mm=params.tree_support_branch_distance;
    treeParams.branch_diameter_angle_deg=params.tree_support_branch_diameter_angle;
    treeParams.tip_diameter_mm=params.tree_support_tip_diameter;
    treeParams.top_rate_pct=params.tree_support_top_rate;
    treeParams.wall_count=params.tree_support_wall_count;
    treeParams.interface_pattern=params.support_interface_pattern;              // WP1: interface/base patterns and spacing
    treeParams.base_pattern=params.support_base_pattern;
    treeParams.interface_spacing_mm=params.support_interface_spacing;
    treeParams.base_pattern_spacing_mm=params.support_base_pattern_spacing;
    treeParams.bed_width_mm=params.bed_width;
    treeParams.bed_depth_mm=params.bed_depth;
    // The rings below were shifted by −treeShiftX/−treeShiftY; the bed must be shifted with them or the clip window follows the model.
    treeParams.model_shift_x_mm=treeShiftX;
    treeParams.model_shift_y_mm=treeShiftY;
    treeParams.printable_height_mm=params.printable_height;                     // WP1: BuildVolume height (previously hardcoded to 100mm)
    treeParams.resolution_mm=params.gcode_resolution;   // stage 33: path simplification tolerance for the tree path (the upstream print_config "resolution")
    std::vector<treesupport_bridge::LayerOut> treeLayers;
    if (portNormal) {
      // WP2: the upstream normal (grid/snug) support — supplies the PASS 1.5 surfaces (topSurf/botSurf) as stTop/stBottom
      //  (so upstream bottom-contact detection and sharp-tail handling work as-is). Coordinates are shifted by −treeShiftX/−treeShiftY exactly like the slices.
      treeParams.normal_style = params.support_style;                           // grid|snug → smsGrid|smsSnug
      treeParams.support_expansion_mm = params.support_expansion;
      treeParams.bridge_no_support    = params.bridge_no_support;
      treeParams.remove_small_overhang= params.support_remove_small_overhang;
      treeParams.threshold_overlap_pct= params.support_threshold_overlap * 100.0; // kernel fraction (0.5) -> upstream percentage (50)
      std::vector<treesupport_bridge::LayerSurf> layerSurfaces(layerCount);
      auto toRings=[&](const Paths& rawPaths, std::vector<treesupport_bridge::Ring>& out){
        Paths paths = sanitized(rawPaths);               // surfaces get the same guard (reduction on large models only)
        for (const Path& contourPath : paths) {
          treesupport_bridge::Ring ring;
          ring.reserve(contourPath.size());
          for (const IntPoint& point : contourPath) ring.emplace_back(point.x()*INV - treeShiftX, point.y()*INV - treeShiftY);
          if (ring.size()>=3) out.push_back(std::move(ring));
        }
      };
      for (int j=0;j<layerCount;++j) {
        toRings(layers[j].topSurf, layerSurfaces[j].top);
        toRings(layers[j].botSurf, layerSurfaces[j].bottom);
      }
      treeLayers = treesupport_bridge::generate_normal(slices, layerZs, layerSurfaces, treeParams);
    } else {
      treeLayers = treesupport_bridge::generate(slices, layerZs, treeParams);
    }
    for (const treesupport_bridge::LayerOut& treeLayer : treeLayers) {
      // Stage 19 z alignment: support layers are synchronized with the object layers (layer_z uses the same slicing_params), so
      //  print_z lands exactly on the object z grid. Each is bound to the object layer with the smallest residual and the residual is recorded
      //  -> treeZMaxResid≈0 proves that "nearest" is in fact "exact" (zero error). The emitted Z is that object layer's print_z.
      int bestLayer=-1;
      double bestDistance=1e18;
      for (int j=0;j<layerCount;++j){
        double distance=std::fabs(layers[j].z - treeLayer.print_z_mm);
        if(distance<bestDistance){
          bestDistance=distance;
          bestLayer=j;
        }
      }
      if (bestLayer<0) continue;
      treeZMaxResid = std::max(treeZMaxResid, bestDistance);
      ++treeSupLayers;
      for (const treesupport_bridge::Line& line : treeLayer.lines) {
        Path polyline;
        polyline.reserve(line.points.size());
        for (const auto& xy : line.points)
          polyline.push_back(IntPoint((cInt)std::llround((xy.first+treeShiftX)*SCALE),(cInt)std::llround((xy.second+treeShiftY)*SCALE)));  // stage 28: shift back to the model position
        if (polyline.size()>=2) layers[bestLayer].supTree.push_back({std::move(polyline), (float)line.width,
                              line.role, (float)line.height, (float)line.mm3_per_mm});  // WP3: preserve role/height/mm3
      }
    }
   } else {
    // Allowed horizontal step per layer = layer_height / tan(θ). Identical to upstream detect_overhangs (SupportMaterial.cpp:1439)
    //  lower_layer_offset = scale_(lower_layer.height / tan(threshold_rad)).
    //  θ is the "slope angle" (90° = vertical), so a smaller θ means a gentler slope -> a larger expansion and less support (matching the upstream tooltip).
    //  Note: before stage 33, tan was in the numerator and the direction was inverted (3x over-detection at 30°). It matched only by coincidence at 45°.
    //  Bounds: clamped at 89° like upstream (avoiding tan -> ∞), and θ<=0 is treated as "support everywhere" (zero expansion).
    const double thresholdDegrees = std::min(89.0, params.support_threshold_angle);
    // Stage 33: θ=0 means "auto" — upstream uses an overlap criterion instead of an angle (detect_overhangs):
    //   lower_layer_offset = fw - scale_(support_threshold_overlap.get_abs_value(fw))
    //  Previously 0 was used literally, making the lower-layer expansion 0 (= every increase in the upper layer counted as an overhang), which over-detected.
    double maxStep;
    if (thresholdDegrees > 0.0) maxStep = params.layer_height / std::tan(thresholdDegrees * PI/180.0);
    else maxStep = std::max(0.0, lineWidth - params.support_threshold_overlap * lineWidth);
    int topGapLayers = std::max(1, (int)std::llround(params.support_top_z_distance / params.layer_height)); // contact z gap (in layers)
    int interfaceLayers = std::max(1, params.support_interface_top_layers);
    // Stage 20: painted enforcers/blockers -> per-layer polygons (slice_mesh_slabs projection, the same slice_z as the facade)
    std::vector<double> sliceZs(layerCount);
    for (int j=0;j<layerCount;++j) sliceZs[j]=layers[j].z - params.layer_height*0.5;
    // The bridge now takes an EnforcerBlockerType state number (1..16) instead of a bool, so the two support states
    //  are named explicitly here — ENFORCER/BLOCKER are exactly what the old true/false meant.
    auto projectPaintedState=[&](int state)->std::vector<Paths>{
      auto projected = selector_bridge::project_layers(sliceZs, state);
      std::vector<Paths> out(layerCount);
      for (int j=0;j<layerCount && j<(int)projected.size();++j) for (auto& ring:projected[j]) {
        Path path;
        path.reserve(ring.size());
        for (auto& xy:ring) path.push_back(IntPoint((cInt)std::llround(xy.first*SCALE),(cInt)std::llround(xy.second*SCALE)));
        if (path.size()>=3) out[j].push_back(std::move(path));
      }
      return out;
    };
    std::vector<Paths> enforcerPaths = projectPaintedState(selector_bridge::STATE_ENFORCER),
                       blockerPaths = projectPaintedState(selector_bridge::STATE_BLOCKER);
    // Overhang: contour_i − offset(contour_{i-1}, +maxStep)
    // Stage 33: the old morphological opening (offset -openR -> +openR) is removed. The opening erased whole bands narrower than
    //  2*openR (=1.26w), so on gentle slopes (measured from 25°) no support was generated at all
    //  (effectively neutralizing support_threshold_angle). Upstream detect_overhangs does not erode the overhang result; instead it
    //  (1) first filters out islands in the lower slice narrower than the extrusion width (excluded when offset(-fw/2) is empty; "Do not use offset2()") and
    //  (2) cleans up the result by area. The same is done here.
    double minOverhangArea;
    if (params.support_overhang_min_area > 1e-9) minOverhangArea = params.support_overhang_min_area;
    else minOverhangArea = lineWidth*lineWidth;
    std::vector<Paths> overhang(layerCount);
    if (params.support_auto) for (int i=1;i<layerCount;++i) {
      // Stage 32 Fix A: do not skip when the lower layer is empty (a floating part, above a full z gap) — with no lower layer
      //  offset(empty)=empty, so the clip result is the whole contour_i = a full overhang -> support is generated beneath it.
      if (layers[i].contour.empty()) continue;
      // (1) Lower-island filter: lower-layer fragments thinner than the extrusion width cannot support anything, so they are excluded from the lower layer (the upstream rule)
      Paths lower;
      for (const Path& island : layers[i-1].contour) {
        Paths one{island};
        if (!offset_paths(one, -lineWidth*0.5).empty()) lower.push_back(island);
      }
      Paths layerOverhang = clip_paths(layers[i].contour, offset_paths(lower, maxStep), ctDifference);
      if (layerOverhang.empty()) continue;
      // Stage 33: bridge_no_support — no support is created under regions that will be bridged (the upstream option of the same name).
      //  Bridge candidates = this layer's exposed bottom surfaces (botSurf, from PASS 1.5). The kernel already handled the opposite direction
      //  (a support contact surface is not a bridge); this direction was missing.
      if (params.bridge_no_support && !layers[i].botSurf.empty()) {
        layerOverhang = clip_paths(layerOverhang, layers[i].botSurf, ctDifference);
        if (layerOverhang.empty()) continue;
      }
      // Stage 33: support_expansion — widens the overhang region to enlarge the contact area (upstream xy_expansion).
      if (params.support_expansion > 1e-9) layerOverhang = offset_paths(layerOverhang, params.support_expansion);
      // (2) Per-component selection (a verdict, not an erosion — components that pass are preserved in their original shape)
      //   (a) area: below the minimum area it is numerical noise
      //   (b) support_remove_small_overhang (upstream default true, SupportMaterial.cpp:2244):
      //      Upstream clusters overhangs across layers, erodes by 1x the extrusion width and discards them when the bbox is under 2x the extrusion width.
      //      Here it is approximated per component — if offset(-w) is empty the fragment "cannot fit even two lines" and is discarded.
      //      Note: this does not carve the shape (verdict only). The old openR opening eroded the shape itself and erased the bands.
      // Floating island exemption: when the lower layer is entirely empty, this layer is an island starting in mid-air.
      //  Regardless of size it cannot be printed without support, so it is exempt from small-overhang removal.
      //  Upstream saves the same situation with its cantilever/sharp-tail exceptions (around SupportMaterial.cpp:2270) —
      //  lacking those detectors, we approximate with "is the layer below empty".
      //  Note (measured): without this exemption, a real Benchy chimney (a thin-walled ring, z40.4) vanished at offset(-w) and
      //    got no support at all, leaving it floating.
      const bool floatingIsland = lower.empty();
      Paths keep;
      for (const Paths& component : split_components(layerOverhang)) {
        if (paths_area(component) < minOverhangArea) continue;
        if (params.support_remove_small_overhang && !floatingIsland) {
          // Implements the two categories upstream exempts from small-overhang removal (around SupportMaterial.cpp:2270).
          //  (a) sharp tail: a thin pointed island with area < 36mm² (=6x6, area_thresh_well_supported) that survives a 0.1x fw erosion.
          //     It collapses without support, so it is kept.  (upstream :1484)
          const bool sharpTail = paths_area(component) < 36.0 && !offset_paths(component, -0.1*lineWidth).empty();
          //  (b) cantilever: attached to the lower layer but extending more than 3mm beyond that attachment. (upstream :1524-1542)
          //     Upstream measures the maximum distance to the attachment; here an equivalent set operation is used —
          //     if anything remains after expanding the attachment by 3mm, it extends more than 3mm.
          bool cantilever = false;
          {
            Paths base = clip_paths(component, offset_paths(lower, std::max(lineWidth, maxStep) + 0.1), ctIntersection);
            if (!base.empty()) cantilever = !clip_paths(component, offset_paths(base, 3.0), ctDifference).empty();
          }
          if (!sharpTail && !cantilever && offset_paths(component, -lineWidth).empty()) continue;
        }
        for (const Path& path : component) keep.push_back(path);
      }
      if (!keep.empty()) overhang[i] = keep;
    }
    // enforcer: painted regions are forcibly added as overhangs (projecting a support column downward). blocker: subtracted from the overhangs (no
    //  column beneath them) — the same meaning as tree's generate_overhangs (overhangs -= blockers).
    for (int i=0;i<layerCount;++i) if (!enforcerPaths[i].empty()) overhang[i] = union_paths(overhang[i], enforcerPaths[i]);
    for (int i=0;i<layerCount;++i) if (!blockerPaths[i].empty()) overhang[i] = clip_paths(overhang[i], blockerPaths[i], ctDifference);
    // Downward projection: top to bottom.
    // Stage 33 [floating support fix] Follows the upstream project_support_to_grid (SupportMaterial.cpp) rule:
    //   Polygons trimming = offset(layer.lslices, EPS);
    //   overhangs_projection = diff(overhangs, trimming);   // <- the projection itself is carved before being passed down
    //   ...  out.second (the carved projection) becomes the next (lower) layer's overhangs_projection
    // So a projection that touches the model dies there permanently (= that point is a bottom contact, where support lands on the model).
    // The old implementation only accumulated into accum without subtracting the model and clipped "per layer afterwards", so
    //  a region erased behind the model on layer j came back on j-1 where the model disappears, producing **support floating in mid-air**.
    // Note: upstream's "stop propagating thinned columns" (an opening by column_propagation_filtering_radius) is in fact
    //   commented out and inactive (SupportMaterial.cpp:2701). We do not do it either —
    //   erasing a column on layer j robs the support above it on j+1 of its base and actually creates floating parts (confirmed by measurement).
    bool treeLite = (params.support_style == "tree_lite");
    // Stage 33: support_on_build_plate_only — when this option is on, upstream's project_support_to_grid switches trimming
    //  from "this layer's model" to buildplate_covered (the model footprint accumulated from below).
    //  As a result no projection survives at any XY the model ever occupied, leaving only columns that run straight down to the bed.
    std::vector<Paths> covered;
    if (params.support_on_build_plate_only) {
      covered.resize(layerCount);
      Paths coveredSoFar;
      for (int j=0;j<layerCount;++j) {
        if (!layers[j].contour.empty()) coveredSoFar = union_paths(coveredSoFar, layers[j].contour);
        covered[j]=coveredSoFar;
      }
    }
    std::vector<Paths> column(layerCount);
    Paths accum;
    for (int j=layerCount-1;j>=0;--j) {
      if (treeLite) accum = tree_taper(accum, params.tree_lite_shrink, params.tree_lite_min_radius);  // per-layer taper (keeping the minimum pillar)
      int sourceLayer=j+topGapLayers;
      if (sourceLayer<layerCount) accum = union_paths(accum, overhang[sourceLayer]);
      // * Upstream diff(overhangs, trimming): subtract this layer's model from the projection, and the result continues downward.
      //   This one line is what makes "support that lands on the model ends there" (bottom contact).
      const Paths& trimming = [&]() -> const Paths& {
        if (params.support_on_build_plate_only) return covered[j];
        return layers[j].contour;
      }();
      if (!trimming.empty()) accum = clip_paths(accum, offset_paths(trimming, params.support_xy_distance), ctDifference);
      column[j]=accum;
    }
    // Stage 32 Fix B: bottom z gap (support_bottom_z_distance) — the gap between a model top surface and the support bottom resting on it.
    //  botGap layers = round(dist/lh). With the default 0.2/0.2=1 the extra clip loop below does not run -> identical to today (golden byte-identical).
    int botGap = std::max(1, (int)std::llround(params.support_bottom_z_distance / params.layer_height));
    // Per-layer interface (solid) / base (sparse) split + model avoidance
    for (int j=0;j<layerCount;++j) {
      if (column[j].empty()) continue;
      Paths modelClear = offset_paths(layers[j].contour, params.support_xy_distance);
      // Bottom z gap: also remove support above the model top surface on the (botGap-1) layers directly below -> the support starts botGap above the model top surface.
      for (int k=1;k<botGap;++k){
        int belowLayer=j-k;
        if (belowLayer>=0 && !layers[belowLayer].contour.empty()) modelClear = union_paths(modelClear, offset_paths(layers[belowLayer].contour, params.support_xy_distance));
      }
      Paths columnPaths = clip_paths(column[j], modelClear, ctDifference);
      if (columnPaths.empty()) continue;
      // Stage 33: grid snapping (the upstream SupportGridPattern). After snapping it is trimmed back against the model region —
      //  upstream also passes both arguments together as support_grid_pattern(support_polygons, trimming_polygons).
      //  Applied to the grid style only (tree_lite exists for its taper shape, which snapping would destroy).
      if (!treeLite && params.support_grid_snap) {
        Paths snapped = grid_snap(columnPaths, support_spacing);
        snapped = clip_paths(snapped, modelClear, ctDifference);   // keep the parts inflated by snapping from intruding into the model
        if (!snapped.empty()) columnPaths = snapped;
      }
      Paths interfacePaths;
      for (int k=0;k<interfaceLayers;++k){
        int contactLayer=j+topGapLayers+k;
        if (contactLayer<layerCount) interfacePaths = union_paths(interfacePaths, overhang[contactLayer]);
      }
      interfacePaths = clip_paths(interfacePaths, columnPaths, ctIntersection);
      // Stage 33: support_interface_bottom_layers — the interface on the side where support rests on a model top surface
      //  (bottom contact). Upstream generate_interface_layers builds top and bottom interfaces separately
      //  (SupportParameters.hpp:37 num_bottom_interface_layers). We only had top.
      //  Test: if there is model near the point directly below this layer's support (botGap down), that part is a bottom contact surface.
      if (params.support_interface_bottom_layers > 0) {
        Paths under;
        for (int k=botGap;k<botGap+params.support_interface_bottom_layers;++k) {
          int belowLayer=j-k;
          if (belowLayer>=0 && !layers[belowLayer].contour.empty()) under = union_paths(under, offset_paths(layers[belowLayer].contour, params.support_xy_distance));
        }
        if (!under.empty()) {
          Paths bottomInterface = clip_paths(columnPaths, under, ctIntersection);
          if (!bottomInterface.empty()) interfacePaths = union_paths(interfacePaths, bottomInterface);
        }
      }
      layers[j].supIface = interfacePaths;
      layers[j].supBase  = clip_paths(columnPaths, interfacePaths, ctDifference);
    }
   }
  }
}
