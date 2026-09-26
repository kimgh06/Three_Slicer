// emit_layer.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  emit_layer_full stays `static` (called only by emit_layer_any); emit_layer_any lost it because slice() calls it.
#include "emit_layer.h"

#include <cstdio>

// support_filament / support_interface_filament are upstream coInt filament indices: 0 = "Default" (keep the tool
// that is loaded), 1..n = that filament, which is tool n-1. Returning -1 for the default is what makes GW::set_tool
// a no-op, so the default configuration emits no T command anywhere and the G-code is unchanged.
// ponytail: only the T command is switched — the extruder's own filament diameter/flow (Params::forTool) is not
//  reloaded for the support block, so a support filament of a different diameter still extrudes at the object's
//  E-per-mm. Wire loadTool-style reloading here once the single-material path tracks per-tool flow at all.
static const int OBJECT_TOOL = 0;   // the tool the model itself prints with on the single-material path
static int support_tool_of(int filament_index) { return filament_index > 0 ? filament_index - 1 : -1; }
// The T command and the toolpath stream's tool channel have to move together, or the preview colours support with
//  the object's filament while the G-code prints it with another. -1 ("Default", keep the loaded tool) leaves both
//  alone, so the default configuration still emits no T command and no tool bits at all.
static void use_tool(GW& gw, int tool) { gw.set_tool(tool); if (tool >= 0) g_seg_tool = tool; }

// G003 step 1: the normal layer emission body extracted — a single implementation shared by the serial path and (in step 2) the parallel writer.
//  Behavior unchanged (a pure move) — equivalence verified by the golden and st vs mt gates.
static void emit_layer_full(GW& gw, std::vector<float>& tp, std::vector<float>& widths,
                            int i, LayerData& ld, EmitPre& pre, const Params& p,
                            double zE, double w, int N, int nraft, int fTravel,
                            int seamMode, bool scarfOn, bool ironOn, SeamCtx& seamCtx) {
    char cm[72]; (void)cm; (void)widths; (void)N;
    std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);

    // --- Emission path: unpack the compute_pre results (aliases so the emission code stays untouched) ---
    Paths& gapLines = pre.gapLines;
    Paths& solidLines = pre.solidLines;   Paths& topLines = pre.topLines;
    Paths& bridgeLines = pre.bridgeLines; Paths& sparseLines = pre.sparseLines;
    Paths& supI = pre.supI; Paths& supB = pre.supB; Paths& flExtra = pre.flExtra;
    const bool brim = pre.brim; const int fPrint = pre.fPrint, fBridge = pre.fBridge;
    // Stage 21: per-feature widths (the first layer uses the initial_layer values throughout) — scalars, so they are recomputed at emission (same formula).
    bool firstL = (i==0 && nraft==0);
    double wOuter  = firstL ? p.initial_layer_line_width : p.outer_wall_line_width;
    double wInner  = firstL ? p.initial_layer_line_width : p.inner_wall_line_width;
    double wSolid  = firstL ? p.initial_layer_line_width : p.internal_solid_infill_line_width;
    double wTop    = firstL ? p.initial_layer_line_width : p.top_surface_line_width;
    double wSparse = firstL ? p.initial_layer_line_width : p.sparse_infill_line_width;

    // Stage 21: helper that applies a feature width — set_e_per_mm_width (E) and g_seg_w_cur (the ribbon) together. With the default (0.42) the values are unchanged.
    auto setW = [&](double ww){ gw.set_e_per_mm_width(ww, ld.h, p); g_seg_w_cur = (float)ww; };

    // --- Emission: support -> skirt/brim -> walls (seam/scarf) -> thin walls -> gap fill -> bridge -> solid -> sparse ---
    const int supportTool  = support_tool_of(p.support_filament);           // -1 = keep the object's tool
    const int interfaceTool = support_tool_of(p.support_interface_filament);
    if (!supI.empty() || !supB.empty()) {
      gw.raw("; support");
      if (!supI.empty()) { use_tool(gw, interfaceTool); emit_lines(gw, tp, supI, zE, 5.0f, fPrint, fTravel); }
      if (!supB.empty()) { use_tool(gw, supportTool);   emit_lines(gw, tp, supB, zE, 5.0f, fPrint, fTravel); }
      use_tool(gw, OBJECT_TOOL);
    }
    if (p.enable_support && !ld.supTree.empty()) {                    // stages 18/19: the real organic tree support (per-path width)
      gw.raw("; support (organic tree — real ported TreeSupport)");
      use_tool(gw, supportTool);                                       // branches are one body: the base filament covers them
      emit_lines_vw(gw, tp, ld.supTree, zE, ld.h, p, 5.0f, fPrint, fTravel);
      use_tool(gw, OBJECT_TOOL);
    }
    if (!flExtra.empty()) { gw.raw(brim ? "; skirt/brim" : "; skirt"); emit_loops(gw, tp, flExtra, zE, 4.0f, fPrint, fTravel, -1, seamCtx); }
    if (p.wall_generator=="arachne" && !ld.arachneWalls.empty()) {
      gw.raw("; walls (Arachne — real ported WallToolPaths, variable width)");
      emit_arachne_walls(gw, tp, ld.arachneWalls, zE, ld.h, p, fPrint, fTravel);
      gw.set_e_per_mm(ld.h, p); g_seg_w_cur=(float)w;   // restore the default width/flow (for the infill that follows)
    } else if (p.wall_generator != "arachne") {
      // The classic generator's walls in upstream's print order (classic_bridge.cpp): each loop at the width upstream
      //  gave it (BBS's narrow external loop is thinner than outer_wall_line_width), thin walls at their own width.
      for (const ClassicWall& wall : ld.classicWalls) {
        if (!wall.loop) {
          emit_lines_vw(gw, tp, std::vector<TreePath>{ { wall.pl, wall.w, 0, (float)ld.h, 0.0f } }, zE, ld.h, p, 8.0f, fPrint, fTravel);
          continue;
        }
        setW(wall.w);
        if (wall.inset == 0 && scarfOn) emit_scarf_loop(gw, tp, wall.pl, zE, ld.h, fPrint, fTravel, seamMode, seamCtx);
        else emit_loops(gw, tp, Paths{wall.pl}, zE, 1.0f, fPrint, fTravel, seamMode, seamCtx, wall.inset == 0);  // record the seam only for the outer wall
      }
    } else {
      for (size_t wi=0; wi<ld.walls.size(); ++wi) {
        setW(wi==0 ? wOuter : wInner);   // stage 21: outer wall (wi==0) = outer_wall_line_width, inner walls = inner_wall_line_width
        if (wi==0 && scarfOn) { for (Path wp : ld.walls[wi]) emit_scarf_loop(gw, tp, wp, zE, ld.h, fPrint, fTravel, seamMode, seamCtx); }
        else                    emit_loops(gw, tp, ld.walls[wi], zE, 1.0f, fPrint, fTravel, seamMode, seamCtx, wi==0);  // record the seam only for the outer wall (wi==0)
      }
    }
    if (!ld.classicGapFill.empty()) {
      gw.raw("; gap-fill");
      emit_lines_vw(gw, tp, ld.classicGapFill, zE, ld.h, p, 7.0f, fPrint, fTravel);
    }
    setW(firstL ? p.initial_layer_line_width : p.line_width);   // stage 21: gap/bridge use the default width
    if (!gapLines.empty()) { gw.raw("; gap-fill"); emit_lines(gw, tp, gapLines, zE, 7.0f, fPrint, fTravel); }
    if (!bridgeLines.empty()) {
      gw.raw("; bridge (unsupported bottom: fan 100% + bridge_speed)");
      int savedFan = gw.lastFan; gw.set_fan(255);
      emit_lines(gw, tp, bridgeLines, zE, 9.0f, fBridge, fTravel);
      gw.set_fan(savedFan < 0 ? 0 : savedFan);
    }
    if (!solidLines.empty()) { setW(wSolid); emit_lines(gw, tp, solidLines, zE, 3.0f, fPrint, fTravel); }   // stage 21: internal solid width
    if (!topLines.empty())   { setW(wTop);   emit_lines(gw, tp, topLines,   zE, 3.0f, fPrint, fTravel); }   // stage 21: top-surface width
    if (!sparseLines.empty()){ setW(wSparse);emit_lines(gw, tp, sparseLines,zE, 2.0f, fPrint, fTravel); }   // stage 21: sparse infill width

    // Ironing (type10): a low-flow second pass at the same z over exposed top solid (the lines come from compute_pre).
    {
      Paths& ironLines = pre.ironLines;
      if (!ironLines.empty()) {
        gw.raw("; ironing");
        gw.pe_reset();                               // low-flow ironing is excluded from PE flow matching
        int fIron = (int)std::llround(std::max(5.0, p.ironing_speed)*60);
        double saved = gw.e_per_mm; gw.e_per_mm = saved * std::max(0.0, p.ironing_flow/100.0);
        emit_lines(gw, tp, ironLines, zE, 10.0f, fIron, fTravel);
        gw.e_per_mm = saved; gw.pe_reset();
      }
    }

}

// G003 step 2: full emission of one layer (setup + the empty/normal branches) — a single implementation shared by the serial path and the parallel writer.
//  Spiral mode is inlined at the call site (guarded out of parallelism), and scarf/PE tags/PE-lite/arachne/real PE also fall back to serial via the parEmit guard.
void emit_layer_any(GW& gw, std::vector<float>& tp, std::vector<float>& widths,
                           int i, LayerData& ld, EmitPre& pre, const Params& p,
                           double zE, double w, int N, int nraft, int fTravel,
                           int seamMode, bool scarfOn, bool ironOn, SeamCtx& seamCtx) {
  gw.set_e_per_mm(ld.h, p);
  gw.z = zE;
  gw.pe_reset();
  if (!gw.dry) gw.island = g_keep_island ? ld.island : std::move(ld.island);   // G003: copy when the cache is kept
  seamCtx.rng = 2654435761u * (uint32_t)(i+1);
  g_seg_w = gw.dry ? nullptr : &widths; g_seg_w_cur = (float)w;
  char cm[72];
  if (ld.contour.empty()) {
    // Stage 33 [floating model fix] Support must be emitted even on layers with no model.
    std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f (no model)",i,zE); gw.layer_begin(cm);
    std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);
    gw.z = zE; gw.set_e_per_mm(ld.h, p); gw.pe_reset();
    gw.set_fan(fan_S(i, p));
    const int fSup = pre.fSup;
    Paths& eI = pre.supI;
    Paths& eB = pre.supB;
    const int supportTool  = support_tool_of(p.support_filament);
    const int interfaceTool = support_tool_of(p.support_interface_filament);
    if (!eI.empty() || !eB.empty()) {
      gw.raw("; support");
      if (!eI.empty()) { use_tool(gw, interfaceTool); emit_lines(gw, tp, eI, zE, 5.0f, fSup, fTravel); }
      if (!eB.empty()) { use_tool(gw, supportTool);   emit_lines(gw, tp, eB, zE, 5.0f, fSup, fTravel); }
      use_tool(gw, OBJECT_TOOL);
    }
    if (p.enable_support && !ld.supTree.empty()) {
      gw.raw("; support (organic tree — real ported TreeSupport)");
      use_tool(gw, supportTool);
      emit_lines_vw(gw, tp, ld.supTree, zE, ld.h, p, 5.0f, fSup, fTravel);
      use_tool(gw, OBJECT_TOOL);
    }
    return;
  }
  std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f",i,zE); gw.layer_begin(cm);
  gw.set_fan(fan_S(i, p));
  emit_layer_full(gw, tp, widths, i, ld, pre, p, zE, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, seamCtx);
}
