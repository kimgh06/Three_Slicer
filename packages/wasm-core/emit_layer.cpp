// emit_layer.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  emit_layer_full stays `static` (called only by emit_layer_any); emit_layer_any lost it because slice() calls it.
#include "emit_layer.h"

#include <cstdio>

// support_filament / support_interface_filament are upstream coInt filament indices: 0 = "Default" (keep the tool
// that is loaded), 1..n = that filament, which is tool n-1 (Params::support_tool_of). Returning -1 for the default is what makes GW::set_tool
// a no-op, so the default configuration emits no T command anywhere and the G-code is unchanged.
// ponytail: only the T command is switched — the extruder's own filament diameter/flow (Params::forTool) is not
//  reloaded for the support block, so a support filament of a different diameter still extrudes at the object's
//  E-per-mm. Wire loadTool-style reloading here once the single-material path tracks per-tool flow at all.
// The T command and the toolpath stream's tool channel have to move together, or the preview colours support with
//  the object's filament while the G-code prints it with another. -1 ("Default", keep the loaded tool) leaves both
//  alone, so the default configuration still emits no T command and no tool bits at all.
static void use_tool(GW& writer, int tool) {
  writer.set_tool(tool);
  if (tool >= 0) g_seg_tool = tool;
}

// G003 step 1: the normal layer emission body extracted — a single implementation shared by the serial path and (in step 2) the parallel writer.
//  Behavior unchanged (a pure move) — equivalence verified by the golden and st vs mt gates.
static void emit_layer_full(GW& writer, std::vector<float>& toolpath, std::vector<float>& widths,
                            int layerIndex, LayerData& layerData, EmitPre& pre, const Params& params,
                            double layerZ, double defaultWidth, int layerCount, int raftLayers, int travelFeed,
                            int seamMode, bool scarfOn, bool ironOn, SeamCtx& seamCtx) {
    char comment[72];
    (void)comment;
    (void)widths;
    (void)layerCount;
    writer.layer_z(layerZ, travelFeed);
    if (layerIndex + raftLayers == 1) writer.second_layer_begin();   // the second printed layer (the raft's layers come first)

    // --- Emission path: unpack the compute_pre results (aliases so the emission code stays untouched) ---
    Paths& gapLines = pre.gapLines;
    Paths& solidLines = pre.solidLines;
    Paths& topLines = pre.topLines;
    Paths& bridgeLines = pre.bridgeLines;
    Paths& sparseLines = pre.sparseLines;
    Paths& supportInterfaceLines = pre.supI;
    Paths& supportBaseLines = pre.supB;
    Paths& skirtBrimLoops = pre.flExtra;
    const bool brim = pre.brim;
    const RoleFeeds& feeds = pre.feeds;   // the feed of each role (emit.cpp role_feeds; fPrint for all without per-role speeds)
    // Stage 21: per-feature widths (the first layer uses the initial_layer values throughout) — scalars, so they are recomputed at emission (same formula).
    bool firstLayer = (layerIndex==0 && raftLayers==0);
    double outerWidth = params.outer_wall_line_width;
    if (firstLayer) outerWidth = params.initial_layer_line_width;
    double innerWidth = params.inner_wall_line_width;
    if (firstLayer) innerWidth = params.initial_layer_line_width;
    double solidWidth = params.internal_solid_infill_line_width;
    if (firstLayer) solidWidth = params.initial_layer_line_width;
    double topWidth = params.top_surface_line_width;
    if (firstLayer) topWidth = params.initial_layer_line_width;
    double sparseWidth = params.sparse_infill_line_width;
    if (firstLayer) sparseWidth = params.initial_layer_line_width;

    // Stage 21: helper that applies a feature width — set_e_per_mm_width (E) and g_seg_w_cur (the ribbon) together. With the default (0.42) the values are unchanged.
    auto setWidth = [&](double width){
      writer.set_e_per_mm_width(width, layerData.h, params);
      g_seg_w_cur = (float)width;
    };
  // Upstream's role flow ratio for the feature about to be emitted (emit.cpp role_flow_ratio), on the current width,
  //  and the role the writer's acceleration and jerk follow (GW::set_feature).
  auto flow = [&](FlowRole role){
    writer.set_role_flow(role_flow_ratio(params, role, writer.on_first_layer));
    writer.set_feature((int)role);
  };

    // --- Emission: support -> skirt/brim -> walls (seam/scarf) -> thin walls -> gap fill -> bridge -> solid -> sparse ---
    const int supportTool  = Params::support_tool_of(params.support_filament);           // -1 = keep the object's tool
    const int interfaceTool = Params::support_tool_of(params.support_interface_filament);
    if (!supportInterfaceLines.empty() || !supportBaseLines.empty()) {
      writer.raw("; support");
      if (!supportInterfaceLines.empty()) {
        use_tool(writer, interfaceTool);
        flow(FlowRole::SupportInterface);
        emit_lines(writer, toolpath, supportInterfaceLines, layerZ, 5.0f, feeds.of(FlowRole::SupportInterface), travelFeed);
      }
      if (!supportBaseLines.empty()) {
        use_tool(writer, supportTool);
        flow(FlowRole::Support);
        emit_lines(writer, toolpath, supportBaseLines, layerZ, 5.0f, feeds.of(FlowRole::Support), travelFeed);
      }
      use_tool(writer, params.single_tool);
    }
    if (params.enable_support && !layerData.supTree.empty()) {                    // stages 18/19: the real organic tree support (per-path width)
      writer.raw("; support (organic tree — real ported TreeSupport)");
      use_tool(writer, supportTool);                                       // branches are one body: the base filament covers them
      writer.role_flow = role_flow_ratio(params, FlowRole::Support, writer.on_first_layer);   // emit_lines_vw sets each branch's own section
      writer.set_feature((int)FlowRole::Support);
      emit_lines_vw(writer, toolpath, layerData.supTree, layerZ, layerData.h, params, 5.0f, feeds.of(FlowRole::Support), travelFeed);
      use_tool(writer, params.single_tool);
    }
    if (!skirtBrimLoops.empty()) {
      flow(FlowRole::Skirt);
      if (brim) writer.raw("; skirt/brim");
      else writer.raw("; skirt");
      emit_loops(writer, toolpath, skirtBrimLoops, layerZ, 4.0f, feeds.of(FlowRole::Skirt), travelFeed, -1, seamCtx);
    }
    if (!pre.brimLoops.empty()) {
      flow(FlowRole::Brim);
      writer.raw("; brim");
      emit_loops(writer, toolpath, pre.brimLoops, layerZ, 4.0f, feeds.of(FlowRole::Brim), travelFeed, -1, seamCtx);
    }
    if (params.wall_generator=="arachne" && !layerData.arachneWalls.empty()) {
      writer.raw("; walls (Arachne — real ported WallToolPaths, variable width)");
      emit_arachne_walls(writer, toolpath, layerData.arachneWalls, layerZ, layerData.h, params, feeds, travelFeed);
      writer.role_flow = 1.0;
      writer.set_e_per_mm(layerData.h, params);   // restore the default width/flow (for the infill that follows)
      g_seg_w_cur=(float)defaultWidth;
    } else if (params.wall_generator != "arachne") {
      // The classic generator's walls in upstream's print order (classic_bridge.cpp): each loop at the width upstream
      //  gave it (BBS's narrow external loop is thinner than outer_wall_line_width), thin walls at their own width.
      for (const ClassicWall& wall : layerData.classicWalls) {
        FlowRole wallRole = FlowRole::InnerWall;
        if (wall.inset == 0 || !wall.loop) wallRole = FlowRole::OuterWall;   // thin walls print as the external perimeter
        writer.role_flow = role_flow_ratio(params, wallRole, writer.on_first_layer);
        writer.set_feature((int)wallRole);
        const int wallFeed = feeds.of(wallRole);
        if (!wall.loop) {
          emit_lines_vw(writer, toolpath, std::vector<TreePath>{ { wall.pl, wall.w, 0, (float)layerData.h, 0.0f } }, layerZ, layerData.h, params, 8.0f, wallFeed, travelFeed);
          continue;
        }
        setWidth(wall.w);
        if (wall.inset == 0 && scarfOn) emit_scarf_loop(writer, toolpath, wall.pl, layerZ, layerData.h, wallFeed, travelFeed, seamMode, seamCtx);
        else emit_loops(writer, toolpath, Paths{wall.pl}, layerZ, 1.0f, wallFeed, travelFeed, seamMode, seamCtx, wall.inset == 0);  // record the seam only for the outer wall
      }
    } else {
      for (size_t wallIndex=0; wallIndex<layerData.walls.size(); ++wallIndex) {
        FlowRole wallRole = FlowRole::InnerWall;
        if (wallIndex == 0) wallRole = FlowRole::OuterWall;
        writer.role_flow = role_flow_ratio(params, wallRole, writer.on_first_layer);
        writer.set_feature((int)wallRole);
        const int wallFeed = feeds.of(wallRole);
        double wallWidth = innerWidth;
        if (wallIndex==0) wallWidth = outerWidth;
        setWidth(wallWidth);   // stage 21: outer wall (wallIndex==0) = outer_wall_line_width, inner walls = inner_wall_line_width
        if (wallIndex==0 && scarfOn) {
          for (Path wallPath : layerData.walls[wallIndex]) emit_scarf_loop(writer, toolpath, wallPath, layerZ, layerData.h, wallFeed, travelFeed, seamMode, seamCtx);
        }
        else emit_loops(writer, toolpath, layerData.walls[wallIndex], layerZ, 1.0f, wallFeed, travelFeed, seamMode, seamCtx, wallIndex==0);  // record the seam only for the outer wall (wallIndex==0)
      }
    }
    writer.role_flow = role_flow_ratio(params, FlowRole::GapFill, writer.on_first_layer);
    writer.set_feature((int)FlowRole::GapFill);
    if (!layerData.classicGapFill.empty()) {
      writer.raw("; gap-fill");
      emit_lines_vw(writer, toolpath, layerData.classicGapFill, layerZ, layerData.h, params, 7.0f, feeds.of(FlowRole::GapFill), travelFeed);
    }
    double defaultLineWidth = params.line_width;
    if (firstLayer) defaultLineWidth = params.initial_layer_line_width;
    setWidth(defaultLineWidth);   // stage 21: gap/bridge use the default width
    if (!gapLines.empty()) {
      writer.raw("; gap-fill");
      emit_lines(writer, toolpath, gapLines, layerZ, 7.0f, feeds.of(FlowRole::GapFill), travelFeed);
    }
    if (!bridgeLines.empty()) {
      writer.raw("; bridge (unsupported bottom: fan 100% + bridge_speed)");
      int savedFan = writer.lastFan;
      writer.set_fan(255);
      flow(FlowRole::Bridge);
      if (params.thick_bridges) writer.set_e_per_mm_vol(thick_bridge_mm3_per_mm(params), params);
      emit_lines(writer, toolpath, bridgeLines, layerZ, 9.0f, feeds.of(FlowRole::Bridge), travelFeed);
      int restoredFan = savedFan;
      if (savedFan < 0) restoredFan = 0;
      writer.set_fan(restoredFan);
    }
    writer.role_flow = role_flow_ratio(params, FlowRole::InternalSolid, writer.on_first_layer);
    writer.set_feature((int)FlowRole::InternalSolid);
    if (!solidLines.empty()) {   // stage 21: internal solid width
      setWidth(solidWidth);
      emit_lines(writer, toolpath, solidLines, layerZ, 3.0f, feeds.of(FlowRole::InternalSolid), travelFeed);
    }
    if (!pre.bottomLines.empty()) {
      writer.role_flow = role_flow_ratio(params, FlowRole::BottomSurface, writer.on_first_layer);
      writer.set_feature((int)FlowRole::BottomSurface);
      setWidth(solidWidth);
      emit_lines(writer, toolpath, pre.bottomLines, layerZ, 3.0f, feeds.of(FlowRole::BottomSurface), travelFeed);
    }
    // topLines is the top SHELL region split for its width (pass2.cpp), which upstream prints as solid infill.
    writer.role_flow = role_flow_ratio(params, FlowRole::InternalSolid, writer.on_first_layer);
    writer.set_feature((int)FlowRole::InternalSolid);
    if (!topLines.empty()) {   // stage 21: top-surface width
      setWidth(topWidth);
      emit_lines(writer, toolpath, topLines,   layerZ, 3.0f, feeds.of(FlowRole::InternalSolid), travelFeed);
    }
    if (!pre.topExposedLines.empty()) {
      writer.role_flow = role_flow_ratio(params, FlowRole::TopSurface, writer.on_first_layer);
      writer.set_feature((int)FlowRole::TopSurface);
      setWidth(topWidth);
      emit_lines(writer, toolpath, pre.topExposedLines, layerZ, 3.0f, feeds.of(FlowRole::TopSurface), travelFeed);
    }
    writer.role_flow = role_flow_ratio(params, FlowRole::SparseInfill, writer.on_first_layer);
    writer.set_feature((int)FlowRole::SparseInfill);
    if (!sparseLines.empty()) {   // stage 21: sparse infill width
      setWidth(sparseWidth);
      emit_lines(writer, toolpath, sparseLines,layerZ, 2.0f, feeds.of(FlowRole::SparseInfill), travelFeed);
    }

    // Ironing (type10): a low-flow second pass at the same z over exposed top solid (the lines come from compute_pre).
    {
      Paths& ironLines = pre.ironLines;
      if (!ironLines.empty()) {
        writer.raw("; ironing");
        writer.set_feature((int)FlowRole::Ironing);
        writer.pe_reset();                               // low-flow ironing is excluded from PE flow matching
        int ironFeed = (int)std::llround(std::max(5.0, params.ironing_speed)*60);
        // The last feature's role ratio is taken back out: ironing is not one of the roles a ratio applies to.
        double savedEPerMm = writer.e_per_mm;
        writer.e_per_mm = savedEPerMm / writer.role_flow * std::max(0.0, params.ironing_flow/100.0);
        emit_lines(writer, toolpath, ironLines, layerZ, 10.0f, ironFeed, travelFeed);
        writer.e_per_mm = savedEPerMm;
        writer.pe_reset();
      }
    }

}

// G003 step 2: full emission of one layer (setup + the empty/normal branches) — a single implementation shared by the serial path and the parallel writer.
//  Spiral mode is inlined at the call site (guarded out of parallelism), and scarf/PE tags/PE-lite/real PE also fall back to serial via the parEmit guard.
void emit_layer_any(GW& writer, std::vector<float>& toolpath, std::vector<float>& widths,
                           int layerIndex, LayerData& layerData, EmitPre& pre, const Params& params,
                           double layerZ, double defaultWidth, int layerCount, int raftLayers, int travelFeed,
                           int seamMode, bool scarfOn, bool ironOn, SeamCtx& seamCtx) {
  writer.role_flow = 1.0;                              // no role ratio leaks across a layer boundary
  writer.on_first_layer = (layerIndex == 0 && raftLayers == 0);      // with a raft the first layer is the raft's (raft.cpp)
  writer.set_e_per_mm(layerData.h, params);
  writer.z = layerZ;
  writer.pe_reset();
  if (!writer.dry) {   // G003: copy when the cache is kept
    if (g_keep_island) writer.island = layerData.island;
    else writer.island = std::move(layerData.island);
  }
  if (!writer.dry) {
    writer.overhang_area = std::move(pre.overhangArea);
    writer.internal_area = std::move(pre.internalArea);
  }
  seamCtx.rng = 2654435761u * (uint32_t)(layerIndex+1);
  std::vector<float>* segmentWidths = &widths;
  if (writer.dry) segmentWidths = nullptr;
  g_seg_w = segmentWidths;
  g_seg_w_cur = (float)defaultWidth;
  char comment[72];
  if (layerData.contour.empty()) {
    // Stage 33 [floating model fix] Support must be emitted even on layers with no model.
    std::snprintf(comment,sizeof comment,"; LAYER %d Z%.3f (no model)",layerIndex,layerZ);
    writer.layer_begin(comment);
    writer.layer_z(layerZ, travelFeed);
    if (layerIndex + raftLayers == 1) writer.second_layer_begin();
    writer.z = layerZ;
    writer.set_e_per_mm(layerData.h, params);
    writer.pe_reset();
    writer.set_fan(fan_S(layerIndex, params));
    Paths& supportInterfaceLines = pre.supI;
    Paths& supportBaseLines = pre.supB;
    const int supportTool  = Params::support_tool_of(params.support_filament);
    const int interfaceTool = Params::support_tool_of(params.support_interface_filament);
    if (!supportInterfaceLines.empty() || !supportBaseLines.empty()) {
      writer.raw("; support");
      auto supportFlow = [&](FlowRole role){
        writer.set_role_flow(role_flow_ratio(params, role, writer.on_first_layer));
        writer.set_feature((int)role);
      };
      if (!supportInterfaceLines.empty()) {
        use_tool(writer, interfaceTool);
        supportFlow(FlowRole::SupportInterface);
        emit_lines(writer, toolpath, supportInterfaceLines, layerZ, 5.0f, pre.feeds.of(FlowRole::SupportInterface), travelFeed);
      }
      if (!supportBaseLines.empty()) {
        use_tool(writer, supportTool);
        supportFlow(FlowRole::Support);
        emit_lines(writer, toolpath, supportBaseLines, layerZ, 5.0f, pre.feeds.of(FlowRole::Support), travelFeed);
      }
      use_tool(writer, params.single_tool);
    }
    if (params.enable_support && !layerData.supTree.empty()) {
      writer.raw("; support (organic tree — real ported TreeSupport)");
      use_tool(writer, supportTool);
      writer.role_flow = role_flow_ratio(params, FlowRole::Support, writer.on_first_layer);   // emit_lines_vw sets each branch's section
      writer.set_feature((int)FlowRole::Support);
      emit_lines_vw(writer, toolpath, layerData.supTree, layerZ, layerData.h, params, 5.0f, pre.feeds.of(FlowRole::Support), travelFeed);
      use_tool(writer, params.single_tool);
    }
    return;
  }
  std::snprintf(comment,sizeof comment,"; LAYER %d Z%.3f",layerIndex,layerZ);
  writer.layer_begin(comment);
  writer.set_fan(fan_S(layerIndex, params));
  emit_layer_full(writer, toolpath, widths, layerIndex, layerData, pre, params, layerZ, defaultWidth, layerCount, raftLayers, travelFeed, seamMode, scarfOn, ironOn, seamCtx);
}
