// slice_mm.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  slice_group stays `static` (used only here); slice_multimaterial is declared in layer_data.h.
#include "layer_data.h"

#include "config_bridge.h"
#include "gcode_writer.h"
#include "geom_helpers.h"
#include "selector_bridge.h"
#include "slice_planes.h"
#include "slice_ctx.h"          // support_run: the same support pass the single-material path uses

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <set>

// Slice the triangle subset [lo,hi) at a z plane -> contour
static Paths slice_group(const std::vector<Tri>& tris, int lo, int hi, double z){
  std::vector<Seg> segs; Seg sg;
  for (int ti=lo; ti<hi; ++ti){ const Tri& t=tris[ti];
    double zmin=std::min({t.v[0].z,t.v[1].z,t.v[2].z}), zmax=std::max({t.v[0].z,t.v[1].z,t.v[2].z});
    if (z<zmin||z>=zmax) continue; if (tri_plane(t,z,sg)) segs.push_back(sg); }
  return SimplifyPolygons(chain_polys(segs), pftNonZero);   // NonZero on oriented loops (slice_planes.h): upstream's Regular mode; coincident shells union instead of cancelling
}
// =============================================================================
// Multi-material basics (a stretch goal): two triangle groups (mm_group_split) are sliced separately within a layer,
//  and a group switch emits T0/T1 plus a simple prime tower (a 15x15 square ring in the bed corner, only on switching layers).
//  ⚠ Not a proper wipe tower — no purge/ramming/wipe volume calculation and no tower density optimization. Walls + sparse infill only.
// =============================================================================
em::val slice_multimaterial(std::vector<Tri>& tris, const Params& p, em::val onProgress,
                                   double height, bool over_bed){
  auto report=[&](int d,int t){ if(!onProgress.isUndefined()&&!onProgress.isNull()) onProgress(d,t); };
  const double w=p.line_width;
  int split=p.mm_group_split, NT=(int)tris.size();
  // Group boundaries in triangle order: [bounds[g], bounds[g+1]) is group g. A host that only sends the scalar
  //  mm_group_split still gets the two-group split it always did.
  std::vector<int> bounds{0};
  for (double b : p.mm_group_splits) { int v=(int)b; if (v>bounds.back() && v<NT) bounds.push_back(v); }
  if (bounds.size()==1 && split>0 && split<NT) bounds.push_back(split);
  bounds.push_back(NT);
  const int nGroups=(int)bounds.size()-1;
  auto toolOf=[&](int g){ return g<(int)p.mm_group_tools.size() ? (int)p.mm_group_tools[g] : g; };
  // Upstream branches on the material name in exactly two places, and both are reproduced here rather than being
  //  left as "the type is only temperatures and flow":
  //   · PETG oozes on a tool change, so it unretracts 2mm extra (GCode.cpp:1321);
  //   · TPU on the first layer is surfaced as a flag for the machine's start G-code (GCode.cpp:3458). There is no
  //     placeholder parser here, so it becomes a comment — the one form a downstream reader can still act on.
  auto filamentTypeOf=[&](int tool){
    return tool>=0 && tool<(int)p.filament_type.size() ? p.filament_type[tool] : std::string();
  };
  int N=0; for (double z=p.first_layer_height; z<height-1e-4; z+=p.layer_height) ++N;

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
    if (state-1 >= p.extruder_count) break;
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
  std::vector<double> layerZs(N);
  for (int i=0;i<N;++i) layerZs[i] = p.first_layer_height + (i>0? i*p.layer_height : 0.0);
  preSliced.assign(N, std::vector<Paths>(nGroups));
  for (int i=0;i<N;++i) for (int g=0; g<nGroups; ++g)
    preSliced[i][g] = slice_group(tris, bounds[g], bounds[g+1], layerZs[i]);
  if (paintedMM) {
    // The segmentation planes are exactly the planes slice_group cuts at. Any offset between the two would move the
    //  material boundary by up to half a layer relative to the geometry it is supposed to divide.
    selector_bridge::LayerRings layerRings(N);
    for (int i=0;i<N;++i) {
      Paths contour;
      for (int g=0; g<nGroups; ++g) for (const auto& path : preSliced[i][g]) contour.push_back(path);
      layerRings[i].reserve(contour.size());
      for (const auto& path : contour) {
        std::vector<std::pair<double,double>> ring; ring.reserve(path.size());
        for (const auto& pt : path) ring.emplace_back((double)pt.x()/SCALE, (double)pt.y()/SCALE);
        if (ring.size()>=3) layerRings[i].push_back(std::move(ring));
      }
    }
    // The outer wall is the width the segmentation measures its "too thin to print" threshold against; params.cpp
    //  resolves the 0-means-auto case, but the fallback keeps this honest if it ever stops doing so.
    const double outerWallWidth = p.outer_wall_line_width > 0 ? p.outer_wall_line_width : p.line_width;
    // segmented_region_max_width is upstream's option for clipping a colour band to a maximum width; the kernel does
    //  not expose it, and 0 is upstream's own default meaning "do not clip".
    paintedMM = selector_bridge::segment_prepare(layerZs, layerRings, p.extruder_count,
                                                 p.top_shell_layers, p.bottom_shell_layers,
                                                 p.layer_height, outerWallWidth, /*segmented_region_max_width*/0.0);
    if (paintedMM) {
      const int nStates=(int)paintedStates.size();
      paintRegion.assign(nStates, std::vector<Paths>(N));
      for (int s=0;s<nStates;++s) {
        auto regions = selector_bridge::segment_regions(paintedStates[s]);
        for (int i=0;i<N && i<(int)regions.size();++i) for (const auto& ring : regions[i]) {
          Path poly; poly.reserve(ring.size());
          for (const auto& xy : ring)
            poly.push_back(IntPoint((cInt)std::llround(xy.first*SCALE),(cInt)std::llround(xy.second*SCALE)));
          if (poly.size()>=3) paintRegion[s][i].push_back(std::move(poly));
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
  for (int i=0;i<N;++i) {
    std::set<int> layerTools;
    for (int g=0; g<nGroups; ++g) if (!preSliced[i][g].empty()) layerTools.insert(toolOf(g));
    if (paintedMM && !layerTools.empty())
      for (size_t s=0;s<paintedStates.size();++s) if (!paintRegion[s][i].empty()) layerTools.insert(paintedStates[s]-1);
    if (!layerTools.empty()) {                        // a per-feature id adds its tool wherever the layer prints
      if (p.outer_wall_filament_id    > 0) layerTools.insert(p.outer_wall_filament_id - 1);
      if (p.inner_wall_filament_id    > 0) layerTools.insert(p.inner_wall_filament_id - 1);
      if (p.sparse_infill_filament_id > 0) layerTools.insert(p.sparse_infill_filament_id - 1);
    }
    if (layerTools.size() < 2) continue;
    // Only pairs sharing a physical extruder purge; two nozzles never mix (filament_map). SAME rule as the
    //  emission loop's crossNozzle: an absent map means one nozzle for everything — the identity fallback of
    //  physicalExtruderOf is for T-numbering, not for this test, and using it here once made every pair look
    //  cross-nozzle and silently disabled the sustain rings entirely.
    bool purgeable = false;
    for (auto a=layerTools.begin(); a!=layerTools.end() && !purgeable; ++a)
      for (auto b=std::next(a); b!=layerTools.end() && !purgeable; ++b)
        if (p.filament_map.empty() || p.physicalExtruderOf(*a) == p.physicalExtruderOf(*b)) purgeable = true;
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
  const double solid_spacing = w;                        // solid = 100% fill, as slicer_core.cpp defines it
  const double sparse_sp  = (p.infill_density>1e-4) ? (w/p.infill_density) : (w*3.0);
  const double support_sp = (p.support_density>1e-4) ? (w/p.support_density) : (w*3.0);
  std::vector<Paths> layerContour(N), layerFill(N);
  std::vector<std::vector<Paths>> layerWalls(N);         // [layer][loop level], so the emitter re-uses these offsets
  for (int i=0;i<N;++i) {
    Paths contour;
    for (int g=0; g<nGroups; ++g) for (const auto& path : preSliced[i][g]) contour.push_back(path);
    layerContour[i] = contour;
    if (contour.empty()) continue;
    Paths last = contour;
    for (int wl=0; wl<p.wall_loops; ++wl) {
      Paths wp = offset_paths(contour, -(w*0.5 + wl*w)); if (wp.empty()) break;
      layerWalls[i].push_back(wp); last = wp;
    }
    layerFill[i] = last.empty() ? Paths{} : offset_paths(last, -w*0.5);
  }
  // fill minus the neighbouring CONTOUR: exactly surfaces.cpp's surfOne.
  std::vector<Paths> topSurf(N), botSurf(N);
  for (int i=0;i<N;++i) {
    if (layerFill[i].empty()) continue;
    topSurf[i] = clip_paths(layerFill[i], (i+1<N) ? layerContour[i+1] : Paths{}, ctDifference);
    botSurf[i] = clip_paths(layerFill[i], (i-1>=0) ? layerContour[i-1] : Paths{}, ctDifference);
  }
  // …thickened over the shell counts, then intersected back with this layer's own fill (pass2.cpp:59-70).
  std::vector<Paths> layerSolid(N), layerSparse(N);
  for (int i=0;i<N;++i) {
    if (layerFill[i].empty()) continue;
    Paths topSolid, botSolid;
    for (int j=i; j<=std::min(N-1, i + p.top_shell_layers - 1); ++j) topSolid = union_paths(topSolid, topSurf[j]);
    for (int j=std::max(0, i - p.bottom_shell_layers + 1); j<=i; ++j) botSolid = union_paths(botSolid, botSurf[j]);
    layerSolid[i]  = clip_paths(union_paths(topSolid, botSolid), layerFill[i], ctIntersection);
    layerSparse[i] = clip_paths(layerFill[i], layerSolid[i], ctDifference);
  }

  // ---- Support -------------------------------------------------------------------------------------------
  //  This path used to emit none at all, so routing a model here silently dropped it — measured on a table
  //  fixture: 1848 support segments on the single-material path, 0 here, with no warning. support_run reads only
  //  the contour, z and the two surface sets, all of which are already computed above, so the same pass runs here
  //  over a LayerData view of this path's geometry rather than being reimplemented.
  std::vector<LayerData> supportLayers;
  double treeZMaxResid = 0; int treeSupLayers = 0;
  if (p.enable_support) {
    supportLayers.resize(N);
    for (int i=0;i<N;++i) {
      LayerData& ld = supportLayers[i];
      ld.z = p.first_layer_height + (i>0? i*p.layer_height : 0.0);
      ld.idx = i; ld.h = (i==0)?p.first_layer_height:p.layer_height;
      ld.contour = layerContour[i]; ld.fill = layerFill[i];
      ld.topSurf = topSurf[i];      ld.botSurf = botSurf[i];
    }
    SliceCtx sc;
    sc.p = &p; sc.tris = &tris; sc.L = &supportLayers;
    sc.treeZMaxResid = &treeZMaxResid; sc.treeSupLayers = &treeSupLayers;
    sc.CX = [](){ return false; };                 // the MM path has no cancel poll of its own yet
    sc.report = [](int,int){};
    sc.N = N; sc.total = N; sc.height = height;
    sc.w = w; sc.cx = 0; sc.cy = 0;                // the merged mesh is already centred by the caller
    sc.sparse_spacing = sparse_sp; sc.solid_spacing = solid_spacing;
    sc.support_spacing = (p.support_density > 1e-4) ? (w / p.support_density) : (w * 3.0);
    support_run(sc);
  }

  GW gw; gw.s.reserve(1<<16);
  // Per-tool filament: two materials mean two temperatures, two flow ratios and two retraction settings, so
  //  everything the writer holds about "the loaded filament" is (re)loaded here and again on every tool change.
  //  Params::forTool falls back to the scalar, so a caller that sends no per-extruder arrays gets the old G-code.
  auto loadTool=[&](int t){
    gw.tool_filament_diameter = Params::forTool(p.extruder_filament_diameter, t, p.filament_diameter);
    gw.tool_flow_ratio        = Params::forTool(p.extruder_flow_ratio,        t, p.flow_ratio);
    gw.filament_area          = PI*gw.tool_filament_diameter*gw.tool_filament_diameter/4.0;
    gw.retract_len            = Params::forTool(p.extruder_retract_length,    t, p.retract_length);
    gw.retractF               = (int)std::llround(Params::forTool(p.extruder_retract_speed, t, p.retract_speed)*60);
    gw.z_hop                  = Params::forTool(p.extruder_z_hop,             t, p.z_hop);
  };
  auto toolTemp=[&](int t){ return Params::forTool(p.extruder_nozzle_temp, t, p.nozzle_temp); };
  loadTool(0);
  gw.retract_min_travel=p.retraction_minimum_travel;
  gw.offX=p.bed_width*0.5; gw.offY=p.bed_depth*0.5;
  gw.emit_role_tags = p.gcode_role_tags;
  SeamCtx seamCtx;
  gw.raw("; OrcaSlicer RE mini-kernel (Track C stage 6) — MULTIMATERIAL (basic, NOT a real wipe tower)");
  { char h[200];
    std::snprintf(h,sizeof h,"; MM extruders=%d group_split=%d/%d  lh=%.3f lw=%.3f walls=%d infill=%.2f",
      p.extruder_count,split,NT,p.layer_height,w,p.wall_loops,p.infill_density); gw.raw(h);
    if (p.outer_wall_filament_id || p.inner_wall_filament_id || p.sparse_infill_filament_id) {
      std::snprintf(h,sizeof h,"; MM per-feature filament: outer_wall=%d inner_wall=%d sparse_infill=%d (0=default)",
        p.outer_wall_filament_id,p.inner_wall_filament_id,p.sparse_infill_filament_id); gw.raw(h);
    }
    if (!p.filament_map.empty()) {
      std::string fm="; MM filament_map (filament -> physical extruder):";
      for (size_t k=0;k<p.filament_map.size();++k){ char b[32]; std::snprintf(b,sizeof b," T%zu=E%d",k,(int)p.filament_map[k]); fm+=b; }
      gw.raw(fm.c_str());
    }
    // Paint that reached the selector but produced no segmentation would otherwise leave a single-material export
    //  with nothing to explain it. Said in the G-code because that is the artifact the user keeps.
    // What this path still does NOT generate, said plainly: everything else about it now matches the
    //  single-material path (walls, shells, sparse infill, support), so the remaining gaps are the ones worth naming.
    gw.raw("; NOTE: multi-material path — bridge detection and ironing are not generated here");
    if (!p.enable_prime_tower)
      gw.raw(p.flush_into_infill
        ? "; prime tower disabled — the purge goes into the model's sparse infill"
        : "; WARNING: prime tower disabled and no flush destination — a tool change carries the previous colour "
          "into the model");
    if (selector_bridge::painted_count(selector_bridge::STATE_BLOCKER) > 0 && p.enable_support)
      gw.raw("; WARNING: one selector serves both brushes, so a support BLOCKER paint and an Extruder2 paint are "
             "the same mark — the Extruder2 reading was used");
    if (!paintedStates.empty() && !paintedMM)
      gw.raw("; WARNING: painted facets found but the layer segmentation produced no regions — sliced single-material");
    if (nGroups>2) {                                  // only the N-way case adds a line, so ≤2 groups stay identical
      std::string gl="; MM groups:"; for (int g=0;g<nGroups;++g){
        char b[48]; std::snprintf(b,sizeof b," T%d[%d,%d)",toolOf(g),bounds[g],bounds[g+1]); gl+=b; }
      gw.raw(gl.c_str());
    }
    std::snprintf(h,sizeof h,"M140 S%.0f",p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M104 S%.0f",toolTemp(0)); gw.raw(h);
    std::snprintf(h,sizeof h,"M190 S%.0f",p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M109 S%.0f",toolTemp(0)); gw.raw(h); }
  // TPU on the first layer changes how a machine should start (upstream hands it to the start-G-code template as
  //  has_tpu_in_first_layer). No template engine here, so it is stated where a reader or a post-processor can act.
  for (int g=0; g<nGroups; ++g)
    if (filamentTypeOf(toolOf(g)) == "TPU") { gw.raw("; has_tpu_in_first_layer = 1"); break; }
  gw.raw("G21 ; mm"); gw.raw("G90 ; absolute XYZ"); gw.raw("M83 ; relative E");
  gw.raw("T0 ; start extruder"); gw.raw("G92 E0");

  int fTravel=(int)std::llround(p.travel_speed*60);

  // Prime tower fallback (square ring). Stage 33: position (10,10) and size 15 were hardcoded -> now wired to prime_tower_x/y/ring_size.
  //  Note: the default path is wipe_tower_real (the real WipeTower) and this ring is the fallback when that fails.
  double ptx=p.prime_tower_x-gw.offX, pty=p.prime_tower_y-gw.offY;
  const double ptSize=p.prime_tower_ring_size;
  // Three loops was a fixed guess. With a purge table the count comes from the volume the pair actually needs:
  //  one loop of side S extrudes 4*S*e_per_mm millimetres of filament, i.e. 4*S*w*h mm³ of plastic.
  auto ringLoopsFor=[&](double volume_mm3, double side, double h){
    if (volume_mm3 <= 0) return 3;                        // no table -> the tower this path always printed
    const double perLoop = 4.0 * side * w * h;            // mm³ laid down by one loop
    if (perLoop <= 1e-9) return 3;
    // Clamped: one loop is the least that can be a tower, and the ring must not swallow the layer if a table asks
    //  for a volume this footprint cannot hold — that is a sign the tower is too small, not a reason to spiral.
    return std::max(1, std::min(60, (int)std::ceil(volume_mm3 / perLoop)));
  };
  auto primeRings=[&](double side, int loops){ Paths ps; for(int k=0;k<loops;++k){ double o=k*w; double x0=ptx+o,y0=pty+o,x1=ptx+side-o,y1=pty+side-o;
    if (x1-x0 <= w || y1-y0 <= w) break;                  // the ring has closed on itself — no room for another loop
    Path r; r.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y0*SCALE)));
    r.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y0*SCALE)));
    r.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y1*SCALE)));
    r.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y1*SCALE))); ps.push_back(r);} return ps; };

  em::val layersArr=em::val::array();
  int curTool=0, toolChanges=0;
  // Per-tool filament: one total cannot answer "how much ABS and how much PLA", and the filament profiles carry
  //  cost/density per material — so the split is what makes a cost estimate possible at all. gw.filament stays the
  //  single source of truth: everything it gains since the last checkpoint is charged to whichever tool is loaded,
  //  which keeps the per-tool figures summing to the unchanged filament_mm total by construction.
  std::vector<double> filamentByTool;
  double filamentCharged=0.0;
  auto chargeCurrentTool=[&](){
    double spent = gw.filament - filamentCharged; filamentCharged = gw.filament;
    if ((int)filamentByTool.size() <= curTool) filamentByTool.resize(curTool+1, 0.0);
    filamentByTool[curTool] += spent;
  };
  // Prime/wipe tower consumption, tracked separately: painting multiplies tool changes and each one purges, so the
  //  purge total is the one figure a user can actually act on (fewer changes / a narrower tower). It is a subset of
  //  the per-tool figures above (charged to the tool doing the purging), not an extra term of the total.
  double filamentPurge=0.0;
  std::vector<double> filamentPurgeByTool;
  double lastTemp=toolTemp(0);   // the preamble already heated to T0's material
  double zShift=0.0;
  for (int i=0;i<N;++i){
    double z=p.first_layer_height + (i>0? i*p.layer_height : 0.0);   // approximate z
    double zE=z+zShift, h=(i==0)?p.first_layer_height:p.layer_height;
    gw.set_e_per_mm(h,p); gw.z=zE; gw.pe_reset();
    std::vector<float> tp, widths; g_seg_w = &widths; g_seg_w_cur = (float)p.line_width;   // stage 21: record MM widths
    char cm[64]; std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f",i,zE); gw.layer_begin(cm);
    std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);
    int fPr=(int)std::llround(((i==0)?p.first_layer_speed:p.print_speed)*60);

    std::vector<Paths> groups(nGroups);
    if (!preSliced.empty()) groups = preSliced[i];      // already cut above for the segmentation — do not cut twice
    else for (int g=0; g<nGroups; ++g) groups[g]=slice_group(tris,bounds[g],bounds[g+1],z);
    gw.island = Paths{};
    // One region's geometry, kept split by FEATURE so a per-feature filament id has something to address. The wall
    //  loops stay a list of one Paths per loop level rather than being merged: emit_loops is called once per level
    //  and its seam handling is per call, so merging them would move seams even when no feature id is set.
    struct FeatureGeom { Paths outer; std::vector<Paths> inner; Paths fillLines; Paths solidLines; };
    auto buildGeom=[&](const Paths& contour) -> FeatureGeom {
      FeatureGeom geom;
      if (contour.empty()) return geom;
      Paths last=contour;
      for (int wl=0; wl<p.wall_loops; ++wl){
        Paths wp=offset_paths(contour,-(w*0.5+wl*w)); if(wp.empty())break;
        if (wl==0) geom.outer=wp; else geom.inner.push_back(wp);   // loop 0 is what upstream calls the outer wall
        last=wp;
      }
      Paths fillArea = last.empty()?Paths{}:offset_paths(last,-w*0.5);
      if (fillArea.empty()) return geom;
      // The layer's shells were resolved above against its neighbours; this region takes its share of them.
      Paths solidHere  = clip_paths(fillArea, layerSolid[i],  ctIntersection);
      Paths sparseHere = clip_paths(fillArea, layerSparse[i], ctIntersection);
      if (!sparseHere.empty()) geom.fillLines  = infill_clipped(sparseHere,(i%2?135.0:45.0),sparse_sp);
      if (!solidHere.empty())  geom.solidLines = infill_clipped(solidHere, (i%2?135.0:45.0),solid_spacing);
      return geom;
    };
    enum : int { FEAT_OUTER=0, FEAT_INNER=1, FEAT_FILL=2, FEAT_SOLID=3 };
    auto emitFeature=[&](const FeatureGeom& geom, int feature){
      if (feature==FEAT_OUTER) { if (!geom.outer.empty()) emit_loops(gw,tp,geom.outer,zE,1.0f,fPr,fTravel,-1,seamCtx); return; }
      if (feature==FEAT_INNER) { for (const auto& loops : geom.inner) emit_loops(gw,tp,loops,zE,1.0f,fPr,fTravel,-1,seamCtx); return; }
      // Solid before sparse, the order emit_layer.cpp uses — the skin is what the sparse fill anchors against.
      if (feature==FEAT_SOLID) { if (!geom.solidLines.empty()) emit_lines(gw,tp,geom.solidLines,zE,3.0f,fPr,fTravel); return; }
      if (!geom.fillLines.empty()) emit_lines(gw,tp,geom.fillLines,zE,2.0f,fPr,fTravel);
    };
    // ponytail: M109 (wait) right at the switch. A real slicer pre-heats the idle tool a few layers early to hide
    //  the stall; do that when the wipe tower knows the upcoming tool per layer.
    auto toolTo=[&](int t){
      if (curTool==t) return;
      chargeCurrentTool();                           // close the outgoing tool's account before the switch
      char tc[16]; std::snprintf(tc,sizeof tc,"T%d",t); gw.raw(tc); curTool=t; loadTool(t); ++toolChanges;
      if (filamentTypeOf(t) == "PETG") {                 // upstream's extra unretract for a material that oozes
        char pe[48]; std::snprintf(pe,sizeof pe,"G1 E%.4f F%d ; PETG extra unretract",2.0,gw.retractF); gw.raw(pe);
      }
      g_seg_tool = t;                                // the preview's tool channel follows the T command
      if (toolTemp(t) != lastTemp) {                 // only when the materials actually disagree
        char h[48]; std::snprintf(h,sizeof h,"M109 S%.0f",toolTemp(t)); gw.raw(h); lastTemp=toolTemp(t);
      }
    };
    g_seg_tool = curTool;                            // a layer starts on whatever tool the previous one left loaded

    // What this layer emits, in emission order: (tool, contour).
    //  Without paint this is literally "every group in turn" — the same contours, in the same order, with the same
    //  tools — so the no-paint G-code is unchanged by construction.
    std::vector<std::pair<int,Paths>> units;
    if (!paintedMM) {
      for (int g=0; g<nGroups; ++g) if (!groups[g].empty()) units.emplace_back(toolOf(g), groups[g]);
    } else {
      // One bucket per tool. Emitting the painted regions in geometric order instead would purge through the prime
      //  tower at every region boundary, and a purge is real filament — the measured wipe-tower share is what
      //  stats.filament_mm_purge reports — so this is correctness, not tidiness: each tool is entered once a layer.
      std::map<int,Paths> byTool;
      for (int g=0; g<nGroups; ++g){
        if (groups[g].empty()) continue;
        Paths unpainted = groups[g];
        for (int s=0; s<(int)paintedStates.size(); ++s){
          const Paths& region = paintRegion[s][i];
          if (region.empty()) continue;
          Paths painted = clip_paths(groups[g], region, ctIntersection);
          if (painted.empty()) continue;
          const int tool = paintedStates[s]-1;
          byTool[tool] = union_paths(byTool[tool], painted);
          unpainted = clip_paths(unpainted, region, ctDifference);
        }
        // Whatever nobody painted keeps the group's own tool — the default the user did not override.
        if (!unpainted.empty()) byTool[toolOf(g)] = union_paths(byTool[toolOf(g)], unpainted);
      }
      // Order: the tool already loaded goes first (that alone removes one purge per layer), then the rest ascending.
      //  Fixed and total, so the same paint always produces the same G-code.
      auto take=[&](int tool){
        auto it=byTool.find(tool); if (it==byTool.end()) return;
        if (!it->second.empty()) units.emplace_back(tool, it->second);
        byTool.erase(it);                            // erased either way, or the ascending drain below never ends
      };
      take(curTool);
      while (!byTool.empty()) take(byTool.begin()->first);
    }

    // Each region's geometry, built once — the per-feature buckets below reference it rather than re-offsetting.
    std::vector<FeatureGeom> unitGeom(units.size());
    for (size_t u=0; u<units.size(); ++u) unitGeom[u]=buildGeom(units[u].second);
    // Which tool a feature resolves to: its own filament id when set, otherwise the region's. Bucketing by that
    //  instead of by the region keeps the "a tool is entered once per layer" property when a feature id splits a
    //  region across two tools — the alternative purges at every feature boundary.
    auto featureTool=[&](int regionTool, int featureId){ return featureId>0 ? featureId-1 : regionTool; };
    std::map<int, std::vector<std::pair<size_t,int>>> byToolFeature;   // tool -> [(unit, feature)] in emission order
    for (size_t u=0; u<units.size(); ++u) {
      const int base = units[u].first;
      byToolFeature[featureTool(base, p.outer_wall_filament_id)].push_back({u, FEAT_OUTER});
      byToolFeature[featureTool(base, p.inner_wall_filament_id)].push_back({u, FEAT_INNER});
      // A solid region is top, bottom or internal; the kernel does not separate the three, so the surface ids
      //  resolve in upstream's own precedence — an explicit top id wins, then bottom, then internal solid.
      const int solidId = p.top_surface_filament_id    > 0 ? p.top_surface_filament_id
                        : p.bottom_surface_filament_id > 0 ? p.bottom_surface_filament_id
                        : p.internal_solid_filament_id;
      byToolFeature[featureTool(base, solidId)].push_back({u, FEAT_SOLID});
      byToolFeature[featureTool(base, p.sparse_infill_filament_id)].push_back({u, FEAT_FILL});
    }
    // Same order rule as the regions had: the loaded tool first, then ascending. With no feature ids set every
    //  feature lands in its own region's bucket in outer/inner/fill order, which is the sequence emitGroup used to
    //  produce — that is what keeps a slice without feature ids byte-identical.
    std::vector<int> toolOrder;
    if (byToolFeature.count(curTool)) toolOrder.push_back(curTool);
    for (const auto& entry : byToolFeature) if (entry.first != curTool) toolOrder.push_back(entry.first);

    bool printedThisLayer=false;
    // Purge into the model (upstream flush_into_infill). Instead of building a tower, the tool that just took over
    //  prints part of THIS layer's sparse infill — material that had to be laid anyway, inside the part where its
    //  colour cannot be seen. Harvested before emission because it moves lines out of the units' own fill, and a
    //  line must not be printed twice.
    std::map<int, Paths> flushInfill;                 // tool -> the lines it takes over to absorb its purge
    if (p.flush_into_infill && toolOrder.size() > 1) {
      for (size_t k=1;k<toolOrder.size();++k) {
        const int from=toolOrder[k-1], to=toolOrder[k];
        const bool crossNozzle = !p.filament_map.empty() && p.physicalExtruderOf(from) != p.physicalExtruderOf(to);
        if (crossNozzle) continue;
        const double vol = p.flushVolume(from, to, p.extruder_count);
        // mm³ -> millimetres of extruded line at this layer's cross-section. No table means no number to satisfy,
        //  so nothing is diverted and the tower (if any) keeps its fixed size.
        double need = vol > 0 ? vol / (w * h) : 0.0;
        for (size_t u=0; u<unitGeom.size() && need > 1e-6; ++u) {
          Paths& lines = unitGeom[u].fillLines;
          while (!lines.empty() && need > 1e-6) {
            const Path& line = lines.back();
            double len = 0;
            for (size_t q=1;q<line.size();++q) {
              const double dx=(double)(line[q].x()-line[q-1].x())/SCALE, dy=(double)(line[q].y()-line[q-1].y())/SCALE;
              len += std::sqrt(dx*dx+dy*dy);
            }
            flushInfill[to].push_back(line);
            lines.pop_back();
            need -= len;
          }
        }
      }
    }

    // Support first on the layer, the order emit_layer.cpp uses. It prints with support_filament when one is set
    //  (1-based, 0 = "keep the loaded tool"), which is the same contract the single-material path honours.
    if (p.enable_support && i < (int)supportLayers.size()) {
      const LayerData& sl = supportLayers[i];
      const bool anySupport = !sl.supBase.empty() || !sl.supIface.empty() || !sl.supTree.empty();
      if (anySupport) {
        const int supTool = p.support_filament > 0 ? p.support_filament - 1 : curTool;
        const int ifaceTool = p.support_interface_filament > 0 ? p.support_interface_filament - 1 : supTool;
        if (supTool != curTool) toolTo(supTool);
        if (!sl.supBase.empty()) { Paths lines = infill_clipped(sl.supBase, 45.0, support_sp);
          if (!lines.empty()) emit_lines(gw,tp,lines,zE,5.0f,fPr,fTravel); }
        if (!sl.supTree.empty()) emit_lines_vw(gw,tp,sl.supTree,zE,h,p,5.0f,fPr,fTravel);
        if (!sl.supIface.empty()) {
          if (ifaceTool != curTool) toolTo(ifaceTool);
          Paths lines = infill_clipped(sl.supIface, 45.0, solid_spacing);
          if (!lines.empty()) emit_lines(gw,tp,lines,zE,5.0f,fPr,fTravel);
        }
        printedThisLayer = true;      // the layer has extruded, so a later tool change purges
      }
    }

    // Grounding: a layer below the tower's top that will NOT purge still prints a sustain ring, so the purge
    //  blocks above it have something to stand on. Decided before the units run because the ring belongs at the
    //  start of the layer, not after the model. Charged to the purge account — it is tower material.
    bool willPurge=false;
    for (size_t k=1;k<toolOrder.size();++k)
      if (p.filament_map.empty() || p.physicalExtruderOf(toolOrder[k-1]) == p.physicalExtruderOf(toolOrder[k])) { willPurge=true; break; }
    if (p.enable_prime_tower && i<=lastTowerLayer && !willPurge) {
      const double sustainStart = gw.filament;
      const double side = p.wipe_tower_real ? p.prime_tower_width : ptSize;   // match the footprint printed above it
      gw.raw("; prime tower (sustain — keeps the tower grounded under the purges above)");
      emit_loops(gw,tp,primeRings(side,3),zE,11.0f,fPr,fTravel,-1,seamCtx);   // sustain: shape only, no purge to size
      const double spent = gw.filament - sustainStart;
      filamentPurge += spent;
      if ((int)filamentPurgeByTool.size() <= curTool) filamentPurgeByTool.resize(curTool+1, 0.0);
      filamentPurgeByTool[curTool] += spent;
    }

    // Every tool in turn; each change of tool *within* a layer purges through the prime tower first.
    for (const int to : toolOrder){
      const int from=curTool;
      // Two filaments loaded into DIFFERENT physical extruders never share a melt zone, so a change between them
      //  has nothing to purge. Only asked when the host actually sent a filament_map — without one the kernel has
      //  no reason to believe there is a second nozzle, and every change purges exactly as it always did.
      const bool crossNozzle = !p.filament_map.empty() && p.physicalExtruderOf(from) != p.physicalExtruderOf(to);
      const bool purge = printedThisLayer && from!=to && !crossNozzle && p.enable_prime_tower;
      toolTo(to);
      // Whatever this tool diverted into the model is printed right after the change, which is where a purge
      //  belongs: the first material out of the nozzle is the mixed one.
      if (!flushInfill[to].empty()) {
        emit_lines(gw,tp,flushInfill[to],zE,2.0f,fPr,fTravel);
        printedThisLayer = true;
      }
      if (purge) {
        const double purgeStart = gw.filament;            // whatever the tower costs, real or fallback ring
        const double flushVol = p.flushVolume(from, to, p.extruder_count);   // mm³ this pair needs, <0 = no table
        if (p.wipe_tower_real) {                          // stage 12: the real WipeTower.generate()
          auto wt = config_bridge::wipe_tower_block(p.bed_width,p.bed_depth,p.first_layer_height,
                        p.layer_height, zE, i==0, from, to, p.prime_tower_x, p.prime_tower_y,   // stage 33: the 10,10 constants -> wipe_tower_x/y
                        p.prime_tower_width, gw.tool_filament_diameter,
                        flushVol);                        // the pair's own purge volume, not a fixed guess
          if (wt.ok) {
            gw.raw("; wipe_tower_real: real ported WipeTower.generate()");
            gw.raw(wt.gcode.c_str());
            gw.role_tag_unknown();                        // the tower wrote its own ;TYPE: — the next run re-states ours
            gw.filament += wt.filament_mm;
            // The real WipeTower builds its own stride-8 segments, so it never passes through push_seg — the tool
            //  channel is folded in here instead. The purge is extruded by the tool just switched to (curTool), and
            //  with T0 the term is 0, which leaves the stream exactly as the tower emitted it.
            for (size_t k=0; k<wt.toolpath.size(); ++k)
              tp.push_back((k%8==3) ? wt.toolpath[k] + (float)(curTool*16) : wt.toolpath[k]);
          } else {                                        // square ring fallback on failure
            gw.raw("; prime tower (fallback square ring)");
            emit_loops(gw,tp,primeRings(ptSize,ringLoopsFor(flushVol,ptSize,h)),zE,11.0f,fPr,fTravel,-1,seamCtx);
          }
        } else {
          { const int loops = ringLoopsFor(flushVol, ptSize, h);
            char rc[128]; std::snprintf(rc,sizeof rc,"; prime tower (ring, %d loops%s)", loops,
              flushVol > 0 ? "" : " — no purge table, fixed size"); gw.raw(rc);
            const Paths rings = primeRings(ptSize, loops);
            // A ring closes on itself once its loops meet in the middle, so a footprint this small cannot absorb
            //  an arbitrarily large purge. Reported rather than quietly under-purging: the answer is a wider tower.
            if (flushVol > 0 && (int)rings.size() < loops)
              gw.raw("; WARNING: the tower footprint is too small for the requested purging volume — widen it");
            emit_loops(gw,tp,rings,zE,11.0f,fPr,fTravel,-1,seamCtx); }
        }
        const double spent = gw.filament - purgeStart;
        filamentPurge += spent;
        // Charged to the tool doing the purging, so the stats can separate what went into the model from what the
        //  tower ate — one scalar cannot answer "which colour is this tower costing me".
        if ((int)filamentPurgeByTool.size() <= curTool) filamentPurgeByTool.resize(curTool+1, 0.0);
        filamentPurgeByTool[curTool] += spent;
      }
      for (const auto& item : byToolFeature[to]) emitFeature(unitGeom[item.first], item.second);
      printedThisLayer=true;
    }
    em::val Lo=em::val::object(); Lo.set("z",zE); Lo.set("paths",to_f32(tp)); Lo.set("widths",to_f32(widths)); layersArr.call<void>("push",Lo);
    report(i+1,N);
  }
  g_seg_w = nullptr;   // stage 21: the local MM widths goes out of scope here
  g_seg_tool = 0;      // thread_local and shared with the single-material path — a leaked tool would tag its segments
  chargeCurrentTool();  // flush the last tool's remainder -> sum(filamentByTool) == gw.filament
  // One slot per extruder even when a tool never printed, so a caller can index the array by tool number
  //  (the material names it shows come from the same per-extruder lists).
  if ((int)filamentByTool.size() < p.extruder_count) filamentByTool.resize(p.extruder_count, 0.0);
  gw.raw("; end"); gw.raw("M104 S0"); gw.raw("M140 S0"); gw.raw("M107");
  { char h[64]; std::snprintf(h,sizeof h,"; filament used: %.2f mm",gw.filament); gw.raw(h); }
  emit_gcode_footer_blocks(gw, p, filamentByTool, toolChanges);
  em::val result=em::val::object(), stats=em::val::object();
  stats.set("layers",N); stats.set("model_layers",N); stats.set("raft_layers",0);
  stats.set("path_segments",(double)gw.segments); stats.set("filament_mm",gw.filament);
  { em::val byTool=em::val::array();
    for (double f : filamentByTool) byTool.call<void>("push", f);
    stats.set("filament_mm_by_tool", byTool);      // indexed by tool number; sums to filament_mm
    stats.set("filament_mm_purge", filamentPurge);     // prime/wipe tower share (already included in the above)
    // The same figure split per tool, so a caller can show upstream's Model/Tower/Total columns: model = by_tool
    //  minus purge_by_tool. One slot per extruder for the same reason by_tool has one — the caller indexes it.
    if ((int)filamentPurgeByTool.size() < p.extruder_count) filamentPurgeByTool.resize(p.extruder_count, 0.0);
    em::val purgeByTool=em::val::array();
    for (double f : filamentPurgeByTool) purgeByTool.call<void>("push", f);
    stats.set("filament_mm_purge_by_tool", purgeByTool); }
  // Same widening as the single-material path (finish.cpp): the model verdict cannot see support/skirt/brim/tower.
  { const GWBedOverflow over = extrusion_bed_overflow(gw, p);
    stats.set("over_bed", over_bed || over.any());
    stats.set("over_bed_model", over_bed);
    stats.set("over_bed_x", over.x); stats.set("over_bed_y", over.y); stats.set("over_bed_z", over.z); }
  stats.set("wall_crossings",(double)gw.wall_crossings);
  stats.set("extruders",p.extruder_count);
  result.set("gcode",gw.s); result.set("stats",stats); result.set("layers",layersArr);
  return result;
}
