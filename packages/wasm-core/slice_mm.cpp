// slice_mm.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  slice_group stays `static` (used only here); slice_multimaterial is declared in layer_data.h.
#include "layer_data.h"

#include "config_bridge.h"
#include "gcode_writer.h"
#include "geom_helpers.h"
#include "selector_bridge.h"
#include "slice_planes.h"
#include "cooling_bridge.h"
#include "custom_gcode.h"
#include "slice_ctx.h"          // support_run: the same support pass the single-material path uses

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <set>
#include <sstream>

// Slice the triangle subset [firstTri,endTri) at a z plane -> contour
static Paths slice_group(const std::vector<Triangle>& tris, int firstTri, int endTri, double z){
  std::vector<SliceSegment> segments;
  SliceSegment segment;
  for (int triIndex=firstTri; triIndex<endTri; ++triIndex){
    const Triangle& tri=tris[triIndex];
    double zmin=std::min({tri.vertices[0].z,tri.vertices[1].z,tri.vertices[2].z}), zmax=std::max({tri.vertices[0].z,tri.vertices[1].z,tri.vertices[2].z});
    if (z<zmin||z>=zmax) continue;
    if (intersect_triangle_with_plane(tri,z,segment)) segments.push_back(segment);
  }
  return SimplifyPolygons(chain_polygons(segments), pftNonZero);   // NonZero on oriented loops (slice_planes.h): upstream's Regular mode; coincident shells union instead of cancelling
}
// =============================================================================
// Multi-material basics (a stretch goal): two triangle groups (mm_group_split) are sliced separately within a layer,
//  and a group switch emits T0/T1 plus a simple prime tower (a 15x15 square ring in the bed corner, only on switching layers).
//  ⚠ Not a proper wipe tower — no purge/ramming/wipe volume calculation and no tower density optimization. Walls + sparse infill only.
// =============================================================================
em::val slice_multimaterial(std::vector<Triangle>& tris, const Params& params, em::val onProgress,
                                   double height, bool over_bed){
  auto report=[&](int done,int total){ if(!onProgress.isUndefined()&&!onProgress.isNull()) onProgress(done,total); };
  const double lineWidth=params.line_width;
  int groupSplit=params.mm_group_split, triangleCount=(int)tris.size();
  // Group boundaries in triangle order: [bounds[g], bounds[g+1]) is group g. A host that only sends the scalar
  //  mm_group_split still gets the two-group split it always did.
  std::vector<int> bounds{0};
  for (double splitValue : params.mm_group_splits) {
    int splitIndex=(int)splitValue;
    if (splitIndex>bounds.back() && splitIndex<triangleCount) bounds.push_back(splitIndex);
  }
  if (bounds.size()==1 && groupSplit>0 && groupSplit<triangleCount) bounds.push_back(groupSplit);
  bounds.push_back(triangleCount);
  const int nGroups=(int)bounds.size()-1;
  auto toolOf=[&](int group){
    if (group<(int)params.mm_group_tools.size()) return (int)params.mm_group_tools[group];
    return group;
  };
  // Upstream branches on the material name in exactly two places, and both are reproduced here rather than being
  //  left as "the type is only temperatures and flow":
  //   · PETG oozes on a tool change, so it unretracts 2mm extra (GCode.cpp:1321);
  //   · TPU on the first layer is surfaced as a flag for the machine's start G-code (GCode.cpp:3458). There is no
  //     placeholder parser here, so it becomes a comment — the one form a downstream reader can still act on.
  auto filamentTypeOf=[&](int tool){
    if (tool>=0 && tool<(int)params.filament_type.size()) return params.filament_type[tool];
    return std::string();
  };
  const LayerPlan layerPlan = plan_layers(params.first_layer_height, params.layer_height, height);
  int layerCount=(int)layerPlan.top.size();

  // =========================================================================================================
  // Painted multi-material regions.
  //  A triangle group is a whole object, so grouping by triangle index can never give ONE object's layer two
  //  materials. Painting therefore splits the SLICED POLYGONS instead: the painted facets of each state are
  //  projected to per-layer rings (project_custom_facets_volume) and the layer polygon is partitioned against them.
  //  That projector is NOT the one the painted support enforcers use (project_custom_facets_footprint, support.cpp):
  //  the footprint one drops vertical facets and only reaches a plane within half a layer of a flat face, which on
  //  axis-aligned geometry is *every* facet of a box — measured, painting the top of table.stl/cube20.stl marked
  //  thousands of facets and emitted zero tool changes. See custom_facet_project.hpp for the volume rule.
  //  State -> tool is the upstream identity documented in selector_bridge.h: ENFORCER(1)==Extruder1==T0,
  //  BLOCKER(2)==Extruder2==T1, state s == Extruder s == T(s-1).
  //  ⚠ One selector serves both jobs (support painting AND MMU painting) because upstream's EnforcerBlockerType is
  //   one enum, so on a >=2 extruder machine a support BLOCKER paint is indistinguishable from an Extruder2 paint.
  //   slice() only routes a *paint-only* model here when support is off, which is what keeps support painting intact.
  std::vector<int> paintedStates;                 // ascending; only tools the machine actually has
  for (int state=selector_bridge::STATE_ENFORCER; state<=selector_bridge::STATE_EXTRUDER_MAX; ++state) {
    if (state-1 >= params.extruder_count) break;
    if (selector_bridge::painted_count(state) > 0) paintedStates.push_back(state);
  }
  bool paintedMM = !paintedStates.empty();
  // paintRegion[stateIdx][layer]: the area that state owns on that layer. The segmentation partitions the contour,
  //  so the states are disjoint by construction — there is no priority rule to apply on top of it.
  std::vector<std::vector<Paths>> paintRegion;
  // preSliced[layer][group]: every layer's contour, cut once up front. The segmentation is a whole-object pass
  //  (it needs each layer's neighbours to build the projection grid), so the contours cannot be produced lazily
  //  inside the emission loop the way the unpainted path does — and slicing twice would double the slice cost.
  std::vector<std::vector<Paths>> preSliced;
  // Every layer's contour, cut once up front — the segmentation (a whole-object pass) and the tower pre-pass below
  //  both need it, and the emission loop reuses it, so nothing is sliced twice.
  const std::vector<double>& layerZs = layerPlan.plane;   // the cutting planes (plan_layers); print z stays below
  preSliced.assign(layerCount, std::vector<Paths>(nGroups));
  for (int i=0;i<layerCount;++i) for (int group=0; group<nGroups; ++group)
    preSliced[i][group] = slice_group(tris, bounds[group], bounds[group+1], layerZs[i]);
  if (paintedMM) {
    // The segmentation planes are exactly the planes slice_group cuts at. Any offset between the two would move the
    //  material boundary by up to half a layer relative to the geometry it is supposed to divide.
    selector_bridge::LayerRings layerRings(layerCount);
    for (int i=0;i<layerCount;++i) {
      Paths contour;
      for (int group=0; group<nGroups; ++group) for (const auto& path : preSliced[i][group]) contour.push_back(path);
      layerRings[i].reserve(contour.size());
      for (const auto& path : contour) {
        std::vector<std::pair<double,double>> ring;
        ring.reserve(path.size());
        for (const auto& point : path) ring.emplace_back((double)point.x()/SCALE, (double)point.y()/SCALE);
        if (ring.size()>=3) layerRings[i].push_back(std::move(ring));
      }
    }
    // The outer wall is the width the segmentation measures its "too thin to print" threshold against; params.cpp
    //  resolves the 0-means-auto case, but the fallback keeps this honest if it ever stops doing so.
    double outerWallWidth;
    if (params.outer_wall_line_width > 0) outerWallWidth = params.outer_wall_line_width;
    else outerWallWidth = params.line_width;
    // segmented_region_max_width is upstream's option for clipping a colour band to a maximum width; the kernel does
    //  not expose it, and 0 is upstream's own default meaning "do not clip".
    paintedMM = selector_bridge::segment_prepare(layerZs, layerRings, params.extruder_count,
                                                 params.top_shell_layers, params.bottom_shell_layers,
                                                 params.layer_height, outerWallWidth, /*segmented_region_max_width*/0.0);
    if (paintedMM) {
      const int stateCount=(int)paintedStates.size();
      paintRegion.assign(stateCount, std::vector<Paths>(layerCount));
      for (int stateIndex=0;stateIndex<stateCount;++stateIndex) {
        auto regions = selector_bridge::segment_regions(paintedStates[stateIndex]);
        for (int i=0;i<layerCount && i<(int)regions.size();++i) for (const auto& ring : regions[i]) {
          Path polygon;
          polygon.reserve(ring.size());
          for (const auto& vertex : ring)
            polygon.push_back(IntPoint((cInt)std::llround(vertex.first*SCALE),(cInt)std::llround(vertex.second*SCALE)));
          if (polygon.size()>=3) paintRegion[stateIndex][i].push_back(std::move(polygon));
        }
      }
    }
  }

  // =========================================================================================================
  // Where the prime tower must exist. A tower that appears only on the layers that purge starts in mid-air —
  //  measured: a patch painted at z=35 put the first tower ring at z=31.2 with nothing under it, which no printer
  //  can extrude. So every layer from the bed up to the LAST layer that can purge carries tower material: the purge
  //  block where a change happens, a plain sustain ring where none does. The pre-pass is conservative (a painted
  //  region that covers its whole layer still counts as two tools), which can only make the tower a little taller
  //  than strictly needed — deterministic either way.
  int lastTowerLayer = -1;
  for (int i=0;i<layerCount;++i) {
    std::set<int> layerTools;
    for (int group=0; group<nGroups; ++group) if (!preSliced[i][group].empty()) layerTools.insert(toolOf(group));
    if (paintedMM && !layerTools.empty())
      for (size_t stateIndex=0;stateIndex<paintedStates.size();++stateIndex) if (!paintRegion[stateIndex][i].empty()) layerTools.insert(paintedStates[stateIndex]-1);
    if (!layerTools.empty()) {                        // a per-feature id adds its tool wherever the layer prints
      if (params.outer_wall_filament_id    > 0) layerTools.insert(params.outer_wall_filament_id - 1);
      if (params.inner_wall_filament_id    > 0) layerTools.insert(params.inner_wall_filament_id - 1);
      if (params.sparse_infill_filament_id > 0) layerTools.insert(params.sparse_infill_filament_id - 1);
    }
    if (layerTools.size() < 2) continue;
    // Only pairs sharing a physical extruder purge; two nozzles never mix (filament_map). SAME rule as the
    //  emission loop's crossNozzle: an absent map means one nozzle for everything — the identity fallback of
    //  physicalExtruderOf is for T-numbering, not for this test, and using it here once made every pair look
    //  cross-nozzle and silently disabled the sustain rings entirely.
    bool purgeable = false;
    for (auto firstTool=layerTools.begin(); firstTool!=layerTools.end() && !purgeable; ++firstTool)
      for (auto secondTool=std::next(firstTool); secondTool!=layerTools.end() && !purgeable; ++secondTool)
        if (params.filament_map.empty() || params.physicalExtruderOf(*firstTool) == params.physicalExtruderOf(*secondTool)) purgeable = true;
    if (purgeable) lastTowerLayer = i;
  }

  // =========================================================================================================
  // Shells. This path used to print walls and sparse infill only, so a model routed here came out with an OPEN
  //  bottom and no top skin — measured on a 20mm cube: 427 solid-infill segments on the single-material path, 0
  //  here, with the bottom three layers carrying 9 sparse lines where the other path lays 61 solid ones. The rule
  //  is upstream's and the same one pass2.cpp applies: a layer's fill that has nothing above it is a top surface,
  //  nothing below it a bottom surface, and each is thickened over its shell count.
  //  Computed for every layer up front because a surface is defined against its NEIGHBOURS, which the emission
  //  loop (one layer at a time) cannot see.
  const double solid_spacing = lineWidth;                        // solid = 100% fill, as slicer_core.cpp defines it
  double sparse_spacing;
  if (params.infill_density>1e-4) sparse_spacing = lineWidth/params.infill_density;
  else sparse_spacing = lineWidth*3.0;
  double support_spacing;
  if (params.support_density>1e-4) support_spacing = lineWidth/params.support_density;
  else support_spacing = lineWidth*3.0;
  std::vector<Paths> layerContour(layerCount), layerFill(layerCount);
  std::vector<std::vector<Paths>> layerWalls(layerCount);         // [layer][loop level], so the emitter re-uses these offsets
  for (int i=0;i<layerCount;++i) {
    Paths contour;
    for (int group=0; group<nGroups; ++group) for (const auto& path : preSliced[i][group]) contour.push_back(path);
    layerContour[i] = contour;
    if (contour.empty()) continue;
    Paths lastWall = contour;
    for (int wallLoop=0; wallLoop<params.wall_loops; ++wallLoop) {
      Paths wallPaths = offset_paths(contour, -(lineWidth*0.5 + wallLoop*lineWidth));
      if (wallPaths.empty()) break;
      layerWalls[i].push_back(wallPaths);
      lastWall = wallPaths;
    }
    if (lastWall.empty()) layerFill[i] = Paths{};
    else layerFill[i] = offset_paths(lastWall, -lineWidth*0.5);
  }
  // fill minus the neighbouring CONTOUR: exactly surfaces.cpp's surfOne.
  std::vector<Paths> topSurf(layerCount), botSurf(layerCount);
  for (int i=0;i<layerCount;++i) {
    if (layerFill[i].empty()) continue;
    Paths contourAbove;
    if (i+1<layerCount) contourAbove = layerContour[i+1];
    topSurf[i] = clip_paths(layerFill[i], contourAbove, ctDifference);
    Paths contourBelow;
    if (i-1>=0) contourBelow = layerContour[i-1];
    botSurf[i] = clip_paths(layerFill[i], contourBelow, ctDifference);
  }
  // …thickened over the shell counts, then intersected back with this layer's own fill (pass2.cpp:59-70).
  std::vector<Paths> layerSolid(layerCount), layerSparse(layerCount);
  for (int i=0;i<layerCount;++i) {
    if (layerFill[i].empty()) continue;
    Paths topSolid, botSolid;
    for (int j=i; j<=std::min(layerCount-1, i + params.top_shell_layers - 1); ++j) topSolid = union_paths(topSolid, topSurf[j]);
    for (int j=std::max(0, i - params.bottom_shell_layers + 1); j<=i; ++j) botSolid = union_paths(botSolid, botSurf[j]);
    layerSolid[i]  = clip_paths(union_paths(topSolid, botSolid), layerFill[i], ctIntersection);
    layerSparse[i] = clip_paths(layerFill[i], layerSolid[i], ctDifference);
  }

  // ---- Support -------------------------------------------------------------------------------------------
  //  This path used to emit none at all, so routing a model here silently dropped it — measured on a table
  //  fixture: 1848 support segments on the single-material path, 0 here, with no warning. support_run reads only
  //  the contour, z and the two surface sets, all of which are already computed above, so the same pass runs here
  //  over a LayerData view of this path's geometry rather than being reimplemented.
  std::vector<LayerData> supportLayers;
  double treeZMaxResid = 0;
  int treeSupLayers = 0;
  if (params.enable_support) {
    supportLayers.resize(layerCount);
    for (int i=0;i<layerCount;++i) {
      LayerData& supportLayer = supportLayers[i];
      double heightAboveFirstLayer = 0.0;
      if (i>0) heightAboveFirstLayer = i*params.layer_height;
      supportLayer.z = params.first_layer_height + heightAboveFirstLayer;
      supportLayer.index = i;
      double supportLayerHeight = params.layer_height;
      if (i==0) supportLayerHeight = params.first_layer_height;
      supportLayer.thickness = supportLayerHeight;
      supportLayer.contour = layerContour[i];
      supportLayer.fill = layerFill[i];
      supportLayer.topSurf = topSurf[i];
      supportLayer.botSurf = botSurf[i];
    }
    SliceContext supportContext;
    supportContext.params = &params;
    supportContext.triangles = &tris;
    supportContext.layers = &supportLayers;
    supportContext.treeZMaxResid = &treeZMaxResid;
    supportContext.treeSupLayers = &treeSupLayers;
    supportContext.isCanceled = [](){ return false; };                 // the MM path has no cancel poll of its own yet
    supportContext.report = [](int,int){};
    supportContext.layerCount = layerCount;
    supportContext.total = layerCount;
    supportContext.height = height;
    supportContext.lineWidth = lineWidth;
    supportContext.centerX = 0;                // the merged mesh is already centred by the caller
    supportContext.centerY = 0;
    supportContext.sparse_spacing = sparse_spacing;
    supportContext.solid_spacing = solid_spacing;
    if (params.support_density > 1e-4) supportContext.support_spacing = lineWidth / params.support_density;
    else supportContext.support_spacing = lineWidth * 3.0;
    support_run(supportContext);
  }

  GcodeWriter writer;
  writer.gcode.reserve(1<<16);
  // Issue 63: with the flattened settings present the custom start G-code is expanded after emission, from the facts
  //  the emission itself produced (tools that printed, tool changes, the tower's extent, the first layer's paths),
  //  and spliced in at startAt. This path is batch-only (writer.gcode is returned whole), so nothing has left yet.
  const bool customGcode = custom_gcode_active(params);
  custom_gcode_bridge::Facts customFacts;
  // Per-tool filament: two materials mean two temperatures, two flow ratios and two retraction settings, so
  //  everything the writer holds about "the loaded filament" is (re)loaded here and again on every tool change.
  //  Params::forTool falls back to the scalar, so a caller that sends no per-extruder arrays gets the old G-code.
  auto loadTool=[&](int tool){
    writer.tool_filament_diameter = Params::forTool(params.extruder_filament_diameter, tool, params.filament_diameter);
    writer.tool_flow_ratio        = Params::forTool(params.extruder_flow_ratio,        tool, params.flow_ratio);
    // A hole takes tool 0's value (the kernel cannot tell absent from 0); no vector at all = no cap.
    writer.max_volumetric_speed          = Params::forTool(params.filament_max_volumetric_speed, tool, Params::forTool(params.filament_max_volumetric_speed, 0, 0.0));
    writer.filament_area          = PI*writer.tool_filament_diameter*writer.tool_filament_diameter/4.0;
    writer.retract_length            = Params::forTool(params.extruder_retract_length,    tool, params.retract_length);
    writer.retract_feed               = (int)std::llround(Params::forTool(params.extruder_retract_speed, tool, params.retract_speed)*60);
    writer.z_hop                  = Params::forTool(params.extruder_z_hop,             tool, params.z_hop);
  };
  auto toolTemp=[&](int tool){ return Params::forTool(params.extruder_nozzle_temp, tool, params.nozzle_temp); };
  loadTool(0);
  writer.print_flow = params.print_flow_ratio;               // upstream's print-wide multiplier (the st path sets it in the preamble)
  writer.retract_min_travel=params.retraction_minimum_travel;
  writer.offset_x=params.bed_center_x();
  writer.offset_y=params.bed_center_y();
  writer.emit_role_tags = params.gcode_role_tags;
  gcode_writer_setup_machine(writer, params);
  // Upstream's cooling filter, as on the single-material path (slicer_core.cpp). This path is batch-only, so the
  //  layers go through it after emission (coolLayers below); the fan markers follow the loaded tool (loadTool).
  bool cooling = false;
  struct CoolingSession { bool active = false; ~CoolingSession(){ if (active) cooling_bridge::end(); } } coolingSession;
  if (customGcode && !writer.emit_pe_tags) {
    std::vector<unsigned int> tools;
    for (int tool = 0; tool < std::max(1, params.extruder_count); ++tool) tools.push_back((unsigned int)tool);
    for (int tool : params.mm_group_tools)
      if (tool >= 0 && std::find(tools.begin(), tools.end(), (unsigned int)tool) == tools.end()) tools.push_back((unsigned int)tool);
    if (cooling_bridge::begin(params.placeholder_config, tools).empty()) {
      cooling = true;
      coolingSession.active = true;
      writer.cooling_markers = true;
    }
  }
  // The overhang fan's region for the loaded filament's threshold (GcodeWriter::overhang_area, the single-material path's
  //  precompute_layer_emit): the layer below offset by lineWidth*(0.5 - threshold), refreshed on each layer and tool change.
  double overhangOverlap = -1.0;
  Paths lowerSlice;
  auto refreshOverhangArea=[&](){
    writer.overhang_area.clear();
    if (overhangOverlap >= 0 && !lowerSlice.empty()) writer.overhang_area = offset_paths(lowerSlice, lineWidth * (0.5 - overhangOverlap));
  };
  auto coolingMarkersFor=[&](int tool){
    if (!cooling) return;
    const cooling_bridge::Markers markers = cooling_bridge::markers((unsigned int)tool);
    writer.fan_overhang = markers.overhang;
    writer.fan_overhang_external = markers.overhang_external;
    writer.fan_support_interface = markers.support_interface;
    writer.fan_ironing = markers.ironing;
    overhangOverlap = -1.0;
    if (markers.overhang) overhangOverlap = markers.overhang_overlap;
    refreshOverhangArea();
  };
  coolingMarkersFor(0);
  // The layer templates' slots (custom_gcode_layer): this path learns whether the printer has any only once the
  //  template session starts after emission, so the writer marks them whenever a custom G-code is present and
  //  finishLayers fills them, or takes them out.
  writer.layer_slots = customGcode;
  SeamContext seamCtx;
  writer.raw("; OrcaSlicer RE mini-kernel (Track C stage 6) — MULTIMATERIAL (basic, NOT a real wipe tower)");
  { char line[200];
    std::snprintf(line,sizeof line,"; MM extruders=%d group_split=%d/%d  lh=%.3f lw=%.3f walls=%d infill=%.2f",
      params.extruder_count,groupSplit,triangleCount,params.layer_height,lineWidth,params.wall_loops,params.infill_density);
    writer.raw(line);
    if (params.outer_wall_filament_id || params.inner_wall_filament_id || params.sparse_infill_filament_id) {
      std::snprintf(line,sizeof line,"; MM per-feature filament: outer_wall=%d inner_wall=%d sparse_infill=%d (0=default)",
        params.outer_wall_filament_id,params.inner_wall_filament_id,params.sparse_infill_filament_id);
      writer.raw(line);
    }
    if (!params.filament_map.empty()) {
      std::string filamentMapLine="; MM filament_map (filament -> physical extruder):";
      for (size_t k=0;k<params.filament_map.size();++k){
        char entry[32];
        std::snprintf(entry,sizeof entry," T%zu=E%d",k,(int)params.filament_map[k]);
        filamentMapLine+=entry;
      }
      writer.raw(filamentMapLine.c_str());
    }
    // Paint that reached the selector but produced no segmentation would otherwise leave a single-material export
    //  with nothing to explain it. Said in the G-code because that is the artifact the user keeps.
    // What this path still does NOT generate, said plainly: everything else about it now matches the
    //  single-material path (walls, shells, sparse infill, support), so the remaining gaps are the ones worth naming.
    writer.raw("; NOTE: multi-material path — bridge detection and ironing are not generated here");
    if (!params.enable_prime_tower) {
      const char* note;
      if (params.flush_into_infill) note = "; prime tower disabled — the purge goes into the model's sparse infill";
      else note = "; WARNING: prime tower disabled and no flush destination — a tool change carries the previous colour "
                  "into the model";
      writer.raw(note);
    }
    if (selector_bridge::painted_count(selector_bridge::STATE_BLOCKER) > 0 && params.enable_support)
      writer.raw("; WARNING: one selector serves both brushes, so a support BLOCKER paint and an Extruder2 paint are "
             "the same mark — the Extruder2 reading was used");
    if (!paintedStates.empty() && !paintedMM)
      writer.raw("; WARNING: painted facets found but the layer segmentation produced no regions — sliced single-material");
    if (nGroups>2) {                                  // only the N-way case adds a line, so ≤2 groups stay identical
      std::string groupsLine="; MM groups:";
      for (int group=0;group<nGroups;++group){
        char entry[48];
        std::snprintf(entry,sizeof entry," T%d[%d,%d)",toolOf(group),bounds[group],bounds[group+1]);
        groupsLine+=entry;
      }
      writer.raw(groupsLine.c_str());
    }
    if (!params.disable_m73) writer.raw(";_GP_FIRST_LINE_M73_PLACEHOLDER");     // upstream's first progress line (finalizeGcode)
    writer.raw_lines(machine_envelope_text(params.machine_envelope, writer.flavor));   // upstream's print_machine_envelope, first
    if (!customGcode) {   // with a custom start block the temperatures follow upstream's rule (custom_gcode_bridge)
      // The first layer's own temperatures when the host sent them; the switch is at the second layer.
      std::snprintf(line,sizeof line,"M140 S%.0f",first_layer_bed(params));
      writer.raw(line);
      std::snprintf(line,sizeof line,"M104 S%.0f",first_layer_nozzle(params, 0));
      writer.raw(line);
      std::snprintf(line,sizeof line,"M190 S%.0f",first_layer_bed(params));
      writer.raw(line);
      std::snprintf(line,sizeof line,"M109 S%.0f",first_layer_nozzle(params, 0));
      writer.raw(line);
    } }
  // TPU on the first layer changes how a machine should start (upstream hands it to the start-G-code template as
  //  has_tpu_in_first_layer). No template engine here, so it is stated where a reader or a post-processor can act.
  for (int group=0; group<nGroups; ++group)
    if (filamentTypeOf(toolOf(group)) == "TPU") {
      writer.raw("; has_tpu_in_first_layer = 1");
      break;
    }
  const size_t startAt = writer.gcode.size();   // where the expanded start block goes (before the writer's own modes)
  gcode_writer_write_modes(writer, params, custom_gcode_is_bbl(params));
  // With custom G-code every tool change, the first selection included, is upstream's sequence
  //  (custom_gcode_toolchanges), written once the template session runs; the writer leaves a slot per change.
  std::vector<ToolchangeAt> toolchanges;
  auto toolchangeSlot=[&](const ToolchangeAt& change){
    char slot[48];
    std::snprintf(slot,sizeof slot,"%s%zu",TOOLCHANGE_SLOT,toolchanges.size());
    writer.raw(slot);
    toolchanges.push_back(change);
  };
  if (customGcode) {
    ToolchangeAt first;
    first.initial = true;
    first.change.to = 0;
    toolchangeSlot(first);
  } else {
    writer.raw("T0 ; start extruder");
    writer.raw("G92 E0");
  }

  int travelFeed=(int)std::llround(params.travel_speed*60);

  // Prime tower fallback (square ring). Stage 33: position (10,10) and size 15 were hardcoded -> now wired to prime_tower_x/y/ring_size.
  //  Note: the default path is wipe_tower_real (the real WipeTower) and this ring is the fallback when that fails.
  double towerX=params.prime_tower_x-writer.offset_x, towerY=params.prime_tower_y-writer.offset_y;
  const double towerRingSize=params.prime_tower_ring_size;
  // Three loops was a fixed guess. With a purge table the count comes from the volume the pair actually needs:
  //  one loop of side S extrudes 4*S*e_per_mm millimetres of filament, i.e. 4*S*w*h mm³ of plastic.
  auto ringLoopsFor=[&](double volume_mm3, double side, double layerHeight){
    if (volume_mm3 <= 0) return 3;                        // no table -> the tower this path always printed
    const double perLoop = 4.0 * side * lineWidth * layerHeight;            // mm³ laid down by one loop
    if (perLoop <= 1e-9) return 3;
    // Clamped: one loop is the least that can be a tower, and the ring must not swallow the layer if a table asks
    //  for a volume this footprint cannot hold — that is a sign the tower is too small, not a reason to spiral.
    return std::max(1, std::min(60, (int)std::ceil(volume_mm3 / perLoop)));
  };
  auto primeRings=[&](double side, int loops){
    Paths rings;
    for(int k=0;k<loops;++k){
      double inset=k*lineWidth;
      double x0=towerX+inset,y0=towerY+inset,x1=towerX+side-inset,y1=towerY+side-inset;
      if (x1-x0 <= lineWidth || y1-y0 <= lineWidth) break;                  // the ring has closed on itself — no room for another loop
      Path ring;
      ring.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y0*SCALE)));
      ring.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y0*SCALE)));
      ring.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y1*SCALE)));
      ring.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y1*SCALE)));
      rings.push_back(ring);
    }
    return rings;
  };

  em::val layersArray=em::val::array();
  int currentTool=0, toolChanges=0;
  // Per-tool filament: one total cannot answer "how much ABS and how much PLA", and the filament profiles carry
  //  cost/density per material — so the split is what makes a cost estimate possible at all. writer.filament stays the
  //  single source of truth: everything it gains since the last checkpoint is charged to whichever tool is loaded,
  //  which keeps the per-tool figures summing to the unchanged filament_mm total by construction.
  std::vector<double> filamentByTool;
  double filamentCharged=0.0;
  auto chargeCurrentTool=[&](){
    double spent = writer.filament - filamentCharged;
    filamentCharged = writer.filament;
    if ((int)filamentByTool.size() <= currentTool) filamentByTool.resize(currentTool+1, 0.0);
    filamentByTool[currentTool] += spent;
  };
  // Prime/wipe tower consumption, tracked separately: painting multiplies tool changes and each one purges, so the
  //  purge total is the one figure a user can actually act on (fewer changes / a narrower tower). It is a subset of
  //  the per-tool figures above (charged to the tool doing the purging), not an extra term of the total.
  double filamentPurge=0.0;
  std::vector<double> filamentPurgeByTool;
  double lastTemp=first_layer_nozzle(params, 0);   // the preamble already heated to T0's material (its first-layer temperature)
  // A tool's temperature on layer i: its first-layer one on the first layer, its own after (GCode.cpp:5631).
  auto toolTempAt=[&](int tool, int layer){
    if (layer == 0) return first_layer_nozzle(params, tool);
    return toolTemp(tool);
  };
  int currentLayer=0;
  // Where the second layer starts in writer.gcode: its temperature switch goes there once the start block (spliced in after
  //  emission, below) has said what bed temperature it left set.
  size_t secondLayerAt=std::string::npos;
  std::vector<size_t> layerStarts;   // where each layer's text starts in writer.gcode, and the tool loaded there
  std::vector<int> layerTools;
  std::vector<std::vector<double>> layerFilament;   // each tool's filament (mm) before the layer, and the layer's z
  std::vector<double> layerZ;
  int secondLayerTool=0;   // the tool loaded when the second layer starts: the one a single nozzle switches
  double zShift=0.0;
  for (int i=0;i<layerCount;++i){
    double heightAboveFirstLayer = 0.0;
    if (i>0) heightAboveFirstLayer = i*params.layer_height;
    double z=params.first_layer_height + heightAboveFirstLayer;   // approximate z
    double printZ=z+zShift;
    double layerHeight=params.layer_height;
    if (i==0) layerHeight=params.first_layer_height;
    writer.role_flow = 1.0;
    writer.on_first_layer = (i == 0);   // no raft on this path
    writer.set_e_per_mm(layerHeight,params);
    writer.z=printZ;
    writer.pe_reset();
    std::vector<float> toolpath, widths;
    g_seg_w = &widths;
    g_seg_w_cur = (float)params.line_width;   // stage 21: record MM widths
    chargeCurrentTool();                             // the per-tool totals as of this layer's start (the layer templates')
    layerStarts.push_back(writer.gcode.size());
    layerTools.push_back(currentTool);   // the layers finishLayers makes final
    layerFilament.push_back(filamentByTool);
    layerZ.push_back(printZ);
    char layerComment[64];
    std::snprintf(layerComment,sizeof layerComment,"; LAYER %d Z%.3f",i,printZ);
    writer.layer_begin(layerComment);
    writer.layer_z(printZ, travelFeed);
    currentLayer = i;
    if (i == 1) {
      secondLayerAt = writer.gcode.size();
      secondLayerTool = currentTool;
      lastTemp = toolTemp(currentTool);                  // the switch below sets the loaded tool to its own temperature
    }
    double layerSpeed=params.print_speed;
    if (i==0) layerSpeed=params.first_layer_speed;
    int printFeed=(int)std::llround(layerSpeed*60);
    // Each feature's own feed (emit.cpp role_feeds); every one at printFeed without per-role speeds, as before.
    const RoleFeeds feeds = role_feeds(params, i == 0, i, 0, printFeed, printFeed, -1.0);

    std::vector<Paths> groups(nGroups);
    if (!preSliced.empty()) groups = preSliced[i];      // already cut above for the segmentation — do not cut twice
    else for (int group=0; group<nGroups; ++group) groups[group]=slice_group(tris,bounds[group],bounds[group+1],layerZs[i]);
    writer.island = Paths{};
    lowerSlice.clear();
    if (i > 0) lowerSlice = layerContour[i-1];
    refreshOverhangArea();
    writer.internal_area.clear();
    if (params.reduce_infill_retraction && params.infill_density > 0 && !layerContour[i].empty())
      writer.internal_area = clip_paths(clip_paths(layerContour[i], topSurf[i], ctDifference), botSurf[i], ctDifference);
    // One region's geometry, kept split by FEATURE so a per-feature filament id has something to address. The wall
    //  loops stay a list of one Paths per loop level rather than being merged: emit_loops is called once per level
    //  and its seam handling is per call, so merging them would move seams even when no feature id is set.
    struct FeatureGeometry { Paths outer; std::vector<Paths> inner; Paths fillLines; Paths solidLines; };
    auto buildGeom=[&](const Paths& contour) -> FeatureGeometry {
      FeatureGeometry geom;
      if (contour.empty()) return geom;
      Paths lastWall=contour;
      for (int wallLoop=0; wallLoop<params.wall_loops; ++wallLoop){
        Paths wallPaths=offset_paths(contour,-(lineWidth*0.5+wallLoop*lineWidth));
        if(wallPaths.empty())break;
        if (wallLoop==0) geom.outer=wallPaths; else geom.inner.push_back(wallPaths);   // loop 0 is what upstream calls the outer wall
        lastWall=wallPaths;
      }
      Paths fillArea = [&]() -> Paths {
        if (lastWall.empty()) return Paths{};
        return offset_paths(lastWall,-lineWidth*0.5);
      }();
      if (fillArea.empty()) return geom;
      // The layer's shells were resolved above against its neighbours; this region takes its share of them.
      Paths solidHere  = clip_paths(fillArea, layerSolid[i],  ctIntersection);
      Paths sparseHere = clip_paths(fillArea, layerSparse[i], ctIntersection);
      double infillAngle = 45.0;
      if (i%2) infillAngle = 135.0;
      if (!sparseHere.empty()) geom.fillLines  = infill_clipped(sparseHere,infillAngle,sparse_spacing);
      if (!solidHere.empty())  geom.solidLines = infill_clipped(solidHere, infillAngle,solid_spacing);
      return geom;
    };
    enum : int { FEAT_OUTER=0, FEAT_INNER=1, FEAT_FILL=2, FEAT_SOLID=3 };
    // Each feature takes upstream's role flow ratio (emit.cpp role_flow_ratio) on the layer's width.
    auto featureFlow=[&](FlowRole role){
      writer.set_role_flow(role_flow_ratio(params, role, writer.on_first_layer));
      writer.set_feature((int)role);
    };
    auto emitFeature=[&](const FeatureGeometry& geom, int feature){
      if (feature==FEAT_OUTER) {
        featureFlow(FlowRole::OuterWall);
        if (!geom.outer.empty()) emit_loops(writer,toolpath,geom.outer,printZ,1.0f,feeds.of(FlowRole::OuterWall),travelFeed,-1,seamCtx);
        return;
      }
      if (feature==FEAT_INNER) {
        featureFlow(FlowRole::InnerWall);
        for (const auto& loops : geom.inner) emit_loops(writer,toolpath,loops,printZ,1.0f,feeds.of(FlowRole::InnerWall),travelFeed,-1,seamCtx);
        return;
      }
      // Solid before sparse, the order emit_layer.cpp uses — the skin is what the sparse fill anchors against.
      if (feature==FEAT_SOLID) {
        featureFlow(FlowRole::InternalSolid);
        if (!geom.solidLines.empty()) emit_lines(writer,toolpath,geom.solidLines,printZ,3.0f,feeds.of(FlowRole::InternalSolid),travelFeed);
        return;
      }
      featureFlow(FlowRole::SparseInfill);
      if (!geom.fillLines.empty()) emit_lines(writer,toolpath,geom.fillLines,printZ,2.0f,feeds.of(FlowRole::SparseInfill),travelFeed);
    };
    // ponytail: M109 (wait) right at the switch. A real slicer pre-heats the idle tool a few layers early to hide
    //  the stall; do that when the wipe tower knows the upcoming tool per layer.
    auto toolTo=[&](int tool, bool viaTower){
      if (currentTool==tool) return;
      chargeCurrentTool();                           // close the outgoing tool's account before the switch
      if (customGcode) {
        // Upstream's order: the outgoing filament retracts, the change sequence runs (its slot), the incoming one
        //  unretracts. Temperatures and the T command are the sequence's (custom_gcode_bridge::expand_toolchange).
        ToolchangeAt change;
        change.change.to = tool;
        change.change.layer = currentLayer;
        change.change.layer_z = writer.z;
        change.change.x = writer.position_x + writer.offset_x;
        change.change.y = writer.position_y + writer.offset_y;
        change.change.z = writer.z;
        change.change.tower = viaTower;
        change.change.purge_mm3 = params.flushVolume(currentTool, tool, params.extruder_count);
        change.change.tower_x = params.prime_tower_x;
        change.change.tower_y = params.prime_tower_y;
        writer.retract_move();
        toolchangeSlot(change);
        currentTool=tool;
        loadTool(tool);
        coolingMarkersFor(tool);
        ++toolChanges;
        if (writer.absolute_e) writer.extruder_position = 0.0;           // the sequence resets E (GCodeWriter::toolchange's reset_e)
        writer.unretract_move();
        g_seg_tool = tool;
        return;
      }
      char toolCommand[16];
      std::snprintf(toolCommand,sizeof toolCommand,"T%d",tool);
      writer.raw(toolCommand);
      currentTool=tool;
      loadTool(tool);
      coolingMarkersFor(tool);
      ++toolChanges;
      if (filamentTypeOf(tool) == "PETG") {                 // upstream's extra unretract for a material that oozes
        char unretractLine[64];
        std::snprintf(unretractLine,sizeof unretractLine,"G1 E%.4f F%d ; PETG extra unretract",writer.e_word(2.0),writer.retract_feed);
        writer.raw(unretractLine);
      }
      g_seg_tool = tool;                                // the preview's tool channel follows the T command
      if (toolTempAt(tool, currentLayer) != lastTemp) {     // only when the materials actually disagree
        char line[48];
        std::snprintf(line,sizeof line,"M109 S%.0f",toolTempAt(tool, currentLayer));
        writer.raw(line);
        lastTemp=toolTempAt(tool, currentLayer);
      }
    };
    g_seg_tool = currentTool;                            // a layer starts on whatever tool the previous one left loaded

    // What this layer emits, in emission order: (tool, contour).
    //  Without paint this is literally "every group in turn" — the same contours, in the same order, with the same
    //  tools — so the no-paint G-code is unchanged by construction.
    std::vector<std::pair<int,Paths>> units;
    if (!paintedMM) {
      for (int group=0; group<nGroups; ++group) if (!groups[group].empty()) units.emplace_back(toolOf(group), groups[group]);
    } else {
      // One bucket per tool. Emitting the painted regions in geometric order instead would purge through the prime
      //  tower at every region boundary, and a purge is real filament — the measured wipe-tower share is what
      //  stats.filament_mm_purge reports — so this is correctness, not tidiness: each tool is entered once a layer.
      std::map<int,Paths> byTool;
      for (int group=0; group<nGroups; ++group){
        if (groups[group].empty()) continue;
        Paths unpainted = groups[group];
        for (int stateIndex=0; stateIndex<(int)paintedStates.size(); ++stateIndex){
          const Paths& region = paintRegion[stateIndex][i];
          if (region.empty()) continue;
          Paths painted = clip_paths(groups[group], region, ctIntersection);
          if (painted.empty()) continue;
          const int tool = paintedStates[stateIndex]-1;
          byTool[tool] = union_paths(byTool[tool], painted);
          unpainted = clip_paths(unpainted, region, ctDifference);
        }
        // Whatever nobody painted keeps the group's own tool — the default the user did not override.
        if (!unpainted.empty()) byTool[toolOf(group)] = union_paths(byTool[toolOf(group)], unpainted);
      }
      // Order: the tool already loaded goes first (that alone removes one purge per layer), then the rest ascending.
      //  Fixed and total, so the same paint always produces the same G-code.
      auto take=[&](int tool){
        auto it=byTool.find(tool);
        if (it==byTool.end()) return;
        if (!it->second.empty()) units.emplace_back(tool, it->second);
        byTool.erase(it);                            // erased either way, or the ascending drain below never ends
      };
      take(currentTool);
      while (!byTool.empty()) take(byTool.begin()->first);
    }

    // Each region's geometry, built once — the per-feature buckets below reference it rather than re-offsetting.
    std::vector<FeatureGeometry> unitGeom(units.size());
    for (size_t unitIndex=0; unitIndex<units.size(); ++unitIndex) unitGeom[unitIndex]=buildGeom(units[unitIndex].second);
    // Which tool a feature resolves to: its own filament id when set, otherwise the region's. Bucketing by that
    //  instead of by the region keeps the "a tool is entered once per layer" property when a feature id splits a
    //  region across two tools — the alternative purges at every feature boundary.
    auto featureTool=[&](int regionTool, int featureId){
      if (featureId>0) return featureId-1;
      return regionTool;
    };
    std::map<int, std::vector<std::pair<size_t,int>>> byToolFeature;   // tool -> [(unit, feature)] in emission order
    for (size_t unitIndex=0; unitIndex<units.size(); ++unitIndex) {
      const int regionTool = units[unitIndex].first;
      byToolFeature[featureTool(regionTool, params.outer_wall_filament_id)].push_back({unitIndex, FEAT_OUTER});
      byToolFeature[featureTool(regionTool, params.inner_wall_filament_id)].push_back({unitIndex, FEAT_INNER});
      // A solid region is top, bottom or internal; the kernel does not separate the three, so the surface ids
      //  resolve in upstream's own precedence — an explicit top id wins, then bottom, then internal solid.
      int solidId;
      if (params.top_surface_filament_id > 0) solidId = params.top_surface_filament_id;
      else if (params.bottom_surface_filament_id > 0) solidId = params.bottom_surface_filament_id;
      else solidId = params.internal_solid_filament_id;
      byToolFeature[featureTool(regionTool, solidId)].push_back({unitIndex, FEAT_SOLID});
      byToolFeature[featureTool(regionTool, params.sparse_infill_filament_id)].push_back({unitIndex, FEAT_FILL});
    }
    // Same order rule as the regions had: the loaded tool first, then ascending. With no feature ids set every
    //  feature lands in its own region's bucket in outer/inner/fill order, which is the sequence emitGroup used to
    //  produce — that is what keeps a slice without feature ids byte-identical.
    std::vector<int> toolOrder;
    if (byToolFeature.count(currentTool)) toolOrder.push_back(currentTool);
    for (const auto& entry : byToolFeature) if (entry.first != currentTool) toolOrder.push_back(entry.first);

    bool printedThisLayer=false;
    // Purge into the model (upstream flush_into_infill). Instead of building a tower, the tool that just took over
    //  prints part of THIS layer's sparse infill — material that had to be laid anyway, inside the part where its
    //  colour cannot be seen. Harvested before emission because it moves lines out of the units' own fill, and a
    //  line must not be printed twice.
    std::map<int, Paths> flushInfill;                 // tool -> the lines it takes over to absorb its purge
    if (params.flush_into_infill && toolOrder.size() > 1) {
      for (size_t k=1;k<toolOrder.size();++k) {
        const int from=toolOrder[k-1], to=toolOrder[k];
        const bool crossNozzle = !params.filament_map.empty() && params.physicalExtruderOf(from) != params.physicalExtruderOf(to);
        if (crossNozzle) continue;
        const double purgeVolume = params.flushVolume(from, to, params.extruder_count);
        // mm³ -> millimetres of extruded line at this layer's cross-section. No table means no number to satisfy,
        //  so nothing is diverted and the tower (if any) keeps its fixed size.
        double remainingLength = 0.0;
        if (purgeVolume > 0) remainingLength = purgeVolume / (lineWidth * layerHeight);
        for (size_t unitIndex=0; unitIndex<unitGeom.size() && remainingLength > 1e-6; ++unitIndex) {
          Paths& lines = unitGeom[unitIndex].fillLines;
          while (!lines.empty() && remainingLength > 1e-6) {
            const Path& line = lines.back();
            double lineLength = 0;
            for (size_t pointIndex=1;pointIndex<line.size();++pointIndex) {
              const double dx=(double)(line[pointIndex].x()-line[pointIndex-1].x())/SCALE, dy=(double)(line[pointIndex].y()-line[pointIndex-1].y())/SCALE;
              lineLength += std::sqrt(dx*dx+dy*dy);
            }
            flushInfill[to].push_back(line);
            lines.pop_back();
            remainingLength -= lineLength;
          }
        }
      }
    }

    // Support first on the layer, the order emit_layer.cpp uses. It prints with support_filament when one is set
    //  (1-based, 0 = "keep the loaded tool"), which is the same contract the single-material path honours.
    if (params.enable_support && i < (int)supportLayers.size()) {
      const LayerData& supportLayer = supportLayers[i];
      const bool anySupport = !supportLayer.supBase.empty() || !supportLayer.supIface.empty() || !supportLayer.supTree.empty();
      if (anySupport) {
        int supportTool = currentTool;
        if (params.support_filament > 0) supportTool = params.support_filament - 1;
        int interfaceTool = supportTool;
        if (params.support_interface_filament > 0) interfaceTool = params.support_interface_filament - 1;
        if (supportTool != currentTool) toolTo(supportTool, false);
        writer.set_role_flow(role_flow_ratio(params, FlowRole::Support, writer.on_first_layer));
        writer.set_feature((int)FlowRole::Support);
        if (!supportLayer.supBase.empty()) {
          Paths lines = infill_clipped(supportLayer.supBase, 45.0, support_spacing);
          if (!lines.empty()) emit_lines(writer,toolpath,lines,printZ,5.0f,feeds.of(FlowRole::Support),travelFeed);
        }
        if (!supportLayer.supTree.empty()) emit_lines_variable_width(writer,toolpath,supportLayer.supTree,printZ,layerHeight,params,5.0f,feeds.of(FlowRole::Support),travelFeed);
        if (!supportLayer.supIface.empty()) {
          if (interfaceTool != currentTool) toolTo(interfaceTool, false);
          writer.set_role_flow(role_flow_ratio(params, FlowRole::SupportInterface, writer.on_first_layer));
          writer.set_feature((int)FlowRole::SupportInterface);
          Paths lines = infill_clipped(supportLayer.supIface, 45.0, solid_spacing);
          if (!lines.empty()) emit_lines(writer,toolpath,lines,printZ,5.0f,feeds.of(FlowRole::SupportInterface),travelFeed);
        }
        printedThisLayer = true;      // the layer has extruded, so a later tool change purges
      }
    }

    // Grounding: a layer below the tower's top that will NOT purge still prints a sustain ring, so the purge
    //  blocks above it have something to stand on. Decided before the units run because the ring belongs at the
    //  start of the layer, not after the model. Charged to the purge account — it is tower material.
    bool willPurge=false;
    for (size_t k=1;k<toolOrder.size();++k)
      if (params.filament_map.empty() || params.physicalExtruderOf(toolOrder[k-1]) == params.physicalExtruderOf(toolOrder[k])) {
        willPurge=true;
        break;
      }
    if (params.enable_prime_tower && i<=lastTowerLayer && !willPurge) {
      const double sustainStart = writer.filament;
      double side = towerRingSize;   // match the footprint printed above it
      if (params.wipe_tower_real) side = params.prime_tower_width;
      writer.raw("; prime tower (sustain — keeps the tower grounded under the purges above)");
      emit_loops(writer,toolpath,primeRings(side,3),printZ,11.0f,printFeed,travelFeed,-1,seamCtx);   // sustain: shape only, no purge to size
      const double spent = writer.filament - sustainStart;
      filamentPurge += spent;
      if ((int)filamentPurgeByTool.size() <= currentTool) filamentPurgeByTool.resize(currentTool+1, 0.0);
      filamentPurgeByTool[currentTool] += spent;
    }

    // Every tool in turn; each change of tool *within* a layer purges through the prime tower first.
    for (const int to : toolOrder){
      const int from=currentTool;
      // Two filaments loaded into DIFFERENT physical extruders never share a melt zone, so a change between them
      //  has nothing to purge. Only asked when the host actually sent a filament_map — without one the kernel has
      //  no reason to believe there is a second nozzle, and every change purges exactly as it always did.
      const bool crossNozzle = !params.filament_map.empty() && params.physicalExtruderOf(from) != params.physicalExtruderOf(to);
      const bool purge = printedThisLayer && from!=to && !crossNozzle && params.enable_prime_tower;
      toolTo(to, purge);
      // Whatever this tool diverted into the model is printed right after the change, which is where a purge
      //  belongs: the first material out of the nozzle is the mixed one.
      if (!flushInfill[to].empty()) {
        emit_lines(writer,toolpath,flushInfill[to],printZ,2.0f,printFeed,travelFeed);
        printedThisLayer = true;
      }
      if (purge) {
        const double purgeStart = writer.filament;            // whatever the tower costs, real or fallback ring
        const double pairFlushVolume = params.flushVolume(from, to, params.extruder_count);   // mm³ this pair needs, <0 = no table
        if (params.wipe_tower_real) {                          // stage 12: the real WipeTower.generate()
          auto wipeTower = config_bridge::wipe_tower_block(params.bed_origin_x,params.bed_origin_y,params.bed_width,params.bed_depth,params.first_layer_height,
                        params.layer_height, printZ, i==0, from, to, params.prime_tower_x, params.prime_tower_y,   // stage 33: the 10,10 constants -> wipe_tower_x/y
                        params.prime_tower_width, writer.tool_filament_diameter,
                        pairFlushVolume);                        // the pair's own purge volume, not a fixed guess
          if (wipeTower.ok) {
            writer.raw("; wipe_tower_real: real ported WipeTower.generate()");
            // The tower's block is written in relative E (config_bridge sums it that way). In absolute mode it runs
            //  inside an M83 ... M82 bracket and the position starts over after it.
            if (writer.absolute_e) writer.raw("M83");
            if (customGcode) {
              // The tower marks where upstream puts the change sequence; here it already ran at the switch above.
              std::string block;
              std::istringstream towerLines(wipeTower.gcode);
              std::string line;
              while (std::getline(towerLines, line)) if (line.rfind("; [", 0) != 0) block += line + "\n";
              writer.raw_lines(block);
            } else writer.raw(wipeTower.gcode.c_str());
            if (writer.absolute_e) {
              writer.raw("M82");
              writer.raw("G92 E0");
              writer.extruder_position = 0.0;
            }
            writer.role_tag_unknown();                        // the tower wrote its own ;TYPE: — the next run re-states ours
            writer.filament += wipeTower.filament_mm;
            // The real WipeTower builds its own stride-8 segments, so it never passes through push_toolpath_segment — the tool
            //  channel is folded in here instead. The purge is extruded by the tool just switched to (currentTool), and
            //  with T0 the term is 0, which leaves the stream exactly as the tower emitted it.
            for (size_t k=0; k<wipeTower.toolpath.size(); ++k) {
              float value = wipeTower.toolpath[k];
              if (k%8==3) value = wipeTower.toolpath[k] + (float)(currentTool*16);
              toolpath.push_back(value);
            }
          } else {                                        // square ring fallback on failure
            writer.raw("; prime tower (fallback square ring)");
            emit_loops(writer,toolpath,primeRings(towerRingSize,ringLoopsFor(pairFlushVolume,towerRingSize,layerHeight)),printZ,11.0f,printFeed,travelFeed,-1,seamCtx);
          }
        } else {
          { const int loops = ringLoopsFor(pairFlushVolume, towerRingSize, layerHeight);
            char ringComment[128];
            const char* purgeTableNote;
            if (pairFlushVolume > 0) purgeTableNote = "";
            else purgeTableNote = " — no purge table, fixed size";
            std::snprintf(ringComment,sizeof ringComment,"; prime tower (ring, %d loops%s)", loops, purgeTableNote);
            writer.raw(ringComment);
            const Paths rings = primeRings(towerRingSize, loops);
            // A ring closes on itself once its loops meet in the middle, so a footprint this small cannot absorb
            //  an arbitrarily large purge. Reported rather than quietly under-purging: the answer is a wider tower.
            if (pairFlushVolume > 0 && (int)rings.size() < loops)
              writer.raw("; WARNING: the tower footprint is too small for the requested purging volume — widen it");
            emit_loops(writer,toolpath,rings,printZ,11.0f,printFeed,travelFeed,-1,seamCtx); }
        }
        const double spent = writer.filament - purgeStart;
        filamentPurge += spent;
        // Charged to the tool doing the purging, so the stats can separate what went into the model from what the
        //  tower ate — one scalar cannot answer "which colour is this tower costing me".
        if ((int)filamentPurgeByTool.size() <= currentTool) filamentPurgeByTool.resize(currentTool+1, 0.0);
        filamentPurgeByTool[currentTool] += spent;
      }
      for (const auto& item : byToolFeature[to]) emitFeature(unitGeom[item.first], item.second);
      printedThisLayer=true;
    }
    if (customGcode) {
      // Stride-8 segments, role + tool*16 in slot 3 (toolpath_encoding). Travel (role 0) is not an extrusion; the
      //  prime tower is role 11. Points go to the printer's frame the way the writer does (+offset_x/offset_y).
      for (size_t k=0; k+7<toolpath.size(); k+=8) {
        const int encoded = (int)toolpath[k+3], role = encoded & 15, tool = encoded >> 4;
        if (role == 0) continue;
        for (int endpoint=0; endpoint<2; ++endpoint) {
          const double x = toolpath[k+endpoint*4] + writer.offset_x, y = toolpath[k+endpoint*4+1] + writer.offset_y;
          if (i == 0) {
            customFacts.first_layer_points.push_back(x);
            customFacts.first_layer_points.push_back(y);
          }
          if (role == 11) {
            double* box = customFacts.wipe_tower_bbox;
            if (!customFacts.has_wipe_tower) {
              box[0]=box[2]=x;
              box[1]=box[3]=y;
              customFacts.has_wipe_tower=true;
            }
            box[0]=std::min(box[0],x);
            box[1]=std::min(box[1],y);
            box[2]=std::max(box[2],x);
            box[3]=std::max(box[3],y);
          }
        }
        if (i == 0 && role != 11 &&
            std::find(customFacts.first_layer_filaments.begin(), customFacts.first_layer_filaments.end(), tool) == customFacts.first_layer_filaments.end())
          customFacts.first_layer_filaments.push_back(tool);
        if (role != 11 &&
            std::find(customFacts.filament_order.begin(), customFacts.filament_order.end(), tool) == customFacts.filament_order.end())
          customFacts.filament_order.push_back(tool);
      }
      customFacts.max_print_z = printZ;
    }
    em::val layerObject=em::val::object();
    layerObject.set("z",printZ);
    layerObject.set("paths",to_f32(toolpath));
    layerObject.set("widths",to_f32(widths));
    layersArray.call<void>("push",layerObject);
    report(i+1,layerCount);
  }
  g_seg_w = nullptr;   // stage 21: the local MM widths goes out of scope here
  g_seg_tool = 0;      // thread_local and shared with the single-material path — a leaked tool would tag its segments
  chargeCurrentTool();  // flush the last tool's remainder -> sum(filamentByTool) == writer.filament
  // One slot per extruder even when a tool never printed, so a caller can index the array by tool number
  //  (the material names it shows come from the same per-extruder lists).
  if ((int)filamentByTool.size() < params.extruder_count) filamentByTool.resize(params.extruder_count, 0.0);
  std::vector<int> usedTools;
  for (int tool=0; tool<(int)filamentByTool.size(); ++tool)
    if (filamentByTool[tool] > 0) usedTools.push_back(tool);
  if (usedTools.empty()) usedTools.push_back(0);
  // The second layer's temperature switch, inserted at the position recorded during emission. Before the start
  //  block's splice, which sits earlier in writer.gcode and would shift that position.
  size_t layersEnd = writer.gcode.size();   // the last layer ends here: everything after is the end block
  auto insertSecondLayer=[&](int bedSet){
    if (secondLayerAt == std::string::npos) return;
    std::vector<int> tools = { secondLayerTool };   // the loaded tool first: the only one a single nozzle switches
    for (int tool : usedTools) if (tool != secondLayerTool) tools.push_back(tool);
    const std::string text = second_layer_temperatures(params, tools, usedTools.size() > 1, bedSet);
    writer.gcode.insert(secondLayerAt, text);
    for (size_t& start : layerStarts) if (start > secondLayerAt) start += text.size();
    layersEnd += text.size();
  };
  // Every layer made final in print order once its text is (after the second-layer switch): its templates expanded
  //  with the template session the start block opened, then the cooling filter. "" or the layer template's error.
  auto finishLayers=[&]() -> std::string {
    if ((!cooling && !writer.layer_slots) || layerStarts.empty()) return std::string();
    std::string error;
    if (writer.layer_slots) custom_gcode_layers_begin();
    std::string out = writer.gcode.substr(0, layerStarts[0]);
    if (customGcode) {   // the first selection, ahead of the first layer
      out = custom_gcode_toolchanges(std::move(out), toolchanges, writer.flavor, error);
      if (!error.empty()) return error;
    }
    for (size_t k = 0; k < layerStarts.size(); ++k) {
      size_t end = layersEnd;
      if (k + 1 < layerStarts.size()) end = layerStarts[k + 1];
      std::string text = writer.gcode.substr(layerStarts[k], end - layerStarts[k]);
      if (writer.layer_slots) {
        std::vector<double> volumes(layerFilament[k].size(), 0.0);
        for (size_t tool = 0; tool < volumes.size(); ++tool) {
          const double diameter = Params::forTool(params.extruder_filament_diameter, (int)tool, params.filament_diameter);
          volumes[tool] = layerFilament[k][tool] * PI * diameter * diameter / 4.0;
        }
        text = custom_gcode_layer(std::move(text), (int)k, layerZ[k], layerTools[k], volumes, error);
        if (!error.empty()) return error;
      }
      if (customGcode) {
        text = custom_gcode_toolchanges(std::move(text), toolchanges, writer.flavor, error);
        if (!error.empty()) return error;
      }
      if (cooling) text = cooling_bridge::process_layer(std::move(text), (int)k, (unsigned int)layerTools[k]);
      out += text;
    }
    out += writer.gcode.substr(layersEnd);
    writer.gcode.swap(out);
    return std::string();
  };
  if (customGcode) {
    for (int tool=0; tool<(int)filamentByTool.size(); ++tool)
      if (filamentByTool[tool] > 0) customFacts.used_filaments.push_back(tool);
    if (customFacts.used_filaments.empty()) customFacts.used_filaments.push_back(0);
    if (customFacts.filament_order.empty()) customFacts.filament_order.push_back(0);
    std::sort(customFacts.first_layer_filaments.begin(), customFacts.first_layer_filaments.end());
    if (customFacts.first_layer_filaments.empty()) customFacts.first_layer_filaments.push_back(0);
    customFacts.initial_extruder = 0;                 // this path always starts on T0 ("T0 ; start extruder")
    customFacts.initial_no_support_extruder = 0;
    customFacts.total_layer_count = layerCount;
    customFacts.total_toolchanges = toolChanges;
    double minX=1e18, minY=1e18, maxX=-1e18, maxY=-1e18;
    for (const Triangle& tri : tris) for (const Vertex& vertex : tri.vertices) {
      minX=std::min(minX,(double)vertex.x);
      minY=std::min(minY,(double)vertex.y);
      maxX=std::max(maxX,(double)vertex.x);
      maxY=std::max(maxY,(double)vertex.y);
    }
    customFacts.object_bboxes = { minX+writer.offset_x, minY+writer.offset_y, maxX+writer.offset_x, maxY+writer.offset_y };
    Paths firstLayer;
    if (!preSliced.empty()) for (const Paths& group : preSliced[0]) firstLayer = union_paths(firstLayer, group);
    customFacts.first_layer_area_mm2 = paths_area(firstLayer);
    { double firstLayerMinX, firstLayerMinY, firstLayerMaxX, firstLayerMaxY;
      bounding_box_of(firstLayer, firstLayerMinX, firstLayerMinY, firstLayerMaxX, firstLayerMaxY);
      if (firstLayerMaxX >= firstLayerMinX)
        customFacts.object_first_layer_bboxes = { firstLayerMinX+writer.offset_x, firstLayerMinY+writer.offset_y, firstLayerMaxX+writer.offset_x, firstLayerMaxY+writer.offset_y }; }
    CustomStart customStart;
    std::string error = custom_gcode_start(params, customFacts, customStart);
    if (error.empty()) {
      insertSecondLayer(customStart.bed_set);
      error = finishLayers();
    }
    if (error.empty()) {
      std::string block = customStart.before;
      if (writer.emit_role_tags) block += ";TYPE:Custom\n";
      block += customStart.chamber + "; machine_start_gcode (printer profile, expanded)\n" + customStart.text;
      if (!block.empty() && block.back() != '\n') block += '\n';
      block += customStart.after;
      writer.gcode.insert(startAt, block);
      {   // file_start_gcode at the very top of the file, then the thumbnails' place (preamble.cpp)
        std::string top = customStart.file_start;
        if (!top.empty() && top.back() != '\n') top += '\n';
        top += ";_GP_THUMBNAILS_PLACEHOLDER\n";
        writer.gcode.insert(0, top);
      }
      writer.raw("; end");
      error = custom_gcode_end(writer, layerCount - 1, writer.z, writer.z, currentTool);
    }
    if (!error.empty()) {
      custom_gcode_bridge::end();
      em::val errorResult=em::val::object();
      errorResult.set("error", error);
      return errorResult;
    }
  } else {
    insertSecondLayer((int)std::lround(first_layer_bed(params)));
    (void)finishLayers();   // without a custom G-code there are no slots and no filter: nothing to do
    writer.raw("; end");
    writer.raw("M104 S0");
    writer.raw("M140 S0");
    writer.raw("M107");
  }
  if (!params.disable_m73) writer.raw(";_GP_LAST_LINE_M73_PLACEHOLDER");   // upstream's last progress line (GCode.cpp:3957)
  writer.raw_lines(machine_postamble(writer.flavor));   // GCodeWriter::postamble: M2 on Machinekit
  { char line[64];
    std::snprintf(line,sizeof line,"; filament used: %.2f mm",writer.filament);
    writer.raw(line); }
  emit_gcode_footer_blocks(writer, params, filamentByTool, toolChanges);
  em::val result=em::val::object(), stats=em::val::object();
  stats.set("layers",layerCount);
  stats.set("model_layers",layerCount);
  stats.set("raft_layers",0);
  stats.set("path_segments",(double)writer.segments);
  stats.set("filament_mm",writer.filament);
  { em::val byTool=em::val::array();
    for (double filament : filamentByTool) byTool.call<void>("push", filament);
    stats.set("filament_mm_by_tool", byTool);      // indexed by tool number; sums to filament_mm
    stats.set("filament_mm_purge", filamentPurge);     // prime/wipe tower share (already included in the above)
    // The same figure split per tool, so a caller can show upstream's Model/Tower/Total columns: model = by_tool
    //  minus purge_by_tool. One slot per extruder for the same reason by_tool has one — the caller indexes it.
    if ((int)filamentPurgeByTool.size() < params.extruder_count) filamentPurgeByTool.resize(params.extruder_count, 0.0);
    em::val purgeByTool=em::val::array();
    for (double purge : filamentPurgeByTool) purgeByTool.call<void>("push", purge);
    stats.set("filament_mm_purge_by_tool", purgeByTool); }
  // Same widening as the single-material path (finish.cpp): the model verdict cannot see support/skirt/brim/tower.
  { const ExtrusionBedOverflow overflow = extrusion_bed_overflow(writer, params);
    stats.set("over_bed", over_bed || overflow.any());
    stats.set("over_bed_model", over_bed);
    stats.set("over_bed_x", overflow.x);
    stats.set("over_bed_y", overflow.y);
    stats.set("over_bed_z", overflow.z); }
  stats.set("wall_crossings",(double)writer.wall_crossings);
  stats.set("extruders",params.extruder_count);
  result.set("gcode",writer.gcode);
  result.set("stats",stats);
  result.set("layers",layersArray);
  return result;
}
