// pass1.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  Model normalization (bbox -> center/seat -> over_bed) and PASS 1 (per-layer contours, walls, infill regions).
//  The two cancel sites inside PASS 1 return `false` instead of building the canceled em::val — slice() builds it
//  at the call site, so the observable result is unchanged.
#include "slice_ctx.h"

#include "arachne_bridge.h"
#include "clip_util.h"
#include "emit.h"
#include "slice_planes.h"
#include "stage_cache.h"
#include "treesupport_bridge.h"

#include <emscripten/val.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <thread>
#include <vector>

// Model preparation — the bbox pass, the auto_center/Z-seat transform and the over_bed verdict.
ModelPrep prepare_model(std::vector<Tri>& tris, const Params& p, bool reuseGeom) {
  // Move the model so XY is centered on the origin and minZ=0 (with reuseGeom the cached copy is already normalized)
  double minx=1e18,miny=1e18,minz=1e18,maxx=-1e18,maxy=-1e18,maxz=-1e18;
  if (reuseGeom) { minx=miny=minz=0; maxx=maxy=maxz=0; }
  else
  for (auto& t:tris) for (int k=0;k<3;++k){
    minx=std::min(minx,(double)t.v[k].x);maxx=std::max(maxx,(double)t.v[k].x);
    miny=std::min(miny,(double)t.v[k].y);maxy=std::max(maxy,(double)t.v[k].y);
    minz=std::min(minz,(double)t.v[k].z);maxz=std::max(maxz,(double)t.v[k].z); }
  double cx=(minx+maxx)/2, cy=(miny+maxy)/2;
  if (reuseGeom) { cx = g_scache.cx; cy = g_scache.cy; }
  // Stage 28 P2: with auto_center=true the combined bbox is realigned to the origin (legacy). false (default) = keep the viewer XY coordinates and only seat Z.
  //  G003: with reuseGeom the cached tris are already normalized — do not move again (avoids a double shift).
  if (!reuseGeom) {
    if (p.auto_center) { for (auto& t:tris) for (int k=0;k<3;++k){ t.v[k].x-=cx; t.v[k].y-=cy; t.v[k].z-=minz; } }
    else               { for (auto& t:tris) for (int k=0;k<3;++k){ t.v[k].z-=minz; } }
  }
  double height = reuseGeom ? g_scache.height : (maxz - minz);
  double modelW = maxx - minx, modelD = maxy - miny;
  // over_bed: too large || (viewer coordinate mode) the G-code position (+bed/2) leaves the bed [0,bed] (i.e. outside [-bed/2,bed/2] in raw coordinates)
  //  bed_height is the printer's printable_height; 0 means the profile did not state one, so no ceiling is enforced
  bool over_bed = (modelW > p.bed_width) || (modelD > p.bed_depth) || (p.bed_height > 0 && height > p.bed_height);
  if (!p.auto_center) over_bed = over_bed || maxx > p.bed_width*0.5 || minx < -p.bed_width*0.5
                                          || maxy > p.bed_depth*0.5 || miny < -p.bed_depth*0.5;
  if (reuseGeom) over_bed = g_scache.over_bed;
  return { cx, cy, height, over_bed };
}

bool pass1_run(SliceCtx& C) {
  const Params& p = *C.p;
  std::vector<Tri>& tris = *C.tris;
  std::vector<LayerData>& L = *C.L;
  auto& CX = C.CX; auto& report = C.report;
  const int N = C.N, total = C.total;
  const double height = C.height, w = C.w;
  { std::vector<double> zsv; zsv.reserve(N);
    for (double z=p.first_layer_height; z<height-1e-4; z+=p.layer_height) zsv.push_back(z);
    // [facet-major segment collection — matching upstream] Like the upstream slice_facet_at_zs (TriangleMeshSlicer.cpp:476),
    //  each triangle binary-searches and visits "only the layers it spans" (work = the number of real intersections). The old layer x full-scan was 657 x 775k
    //  ≈ 500M visits. The inclusion condition is unchanged (zmin<=z<zmax -> lower_bound + *it<zmax) and the tri_plane
    //  input is identical -> segment values are unchanged. Per-thread 'contiguous triangle ranges' merged in range order keep the in-layer segment
    //  order in ascending triangle index (same as the old full scan) -> the chain_polys input is unchanged = byte-identical.
    std::vector<std::vector<Seg>> layerSegs(N);
    if (N > 0) {
      auto collect = [&](size_t a, size_t b, std::vector<std::vector<Seg>>& out){
        Seg sg;
        for (size_t ti = a; ti < b; ++ti) {
          const Tri& t = tris[ti];
          double zmin=std::min({t.v[0].z,t.v[1].z,t.v[2].z}), zmax=std::max({t.v[0].z,t.v[1].z,t.v[2].z});
          for (auto it = std::lower_bound(zsv.begin(), zsv.end(), zmin); it != zsv.end() && *it < zmax; ++it)
            if (tri_plane(t, *it, sg)) out[(size_t)(it - zsv.begin())].push_back(sg);
        }
      };
#ifdef __EMSCRIPTEN_PTHREADS__
      unsigned shw = std::thread::hardware_concurrency(); if (!shw) shw = 4;
      unsigned snt = (unsigned)std::min<size_t>(shw, std::max<size_t>(1, tris.size() / 4096));
      if (snt > 1) {
        std::vector<std::vector<std::vector<Seg>>> tb(snt, std::vector<std::vector<Seg>>(N));
        size_t schunk = (tris.size() + snt - 1) / snt;
        std::vector<std::thread> sths; sths.reserve(snt);
        for (unsigned t2 = 0; t2 < snt; ++t2) {
          size_t a = t2*schunk, b = std::min(tris.size(), a+schunk);
          if (a >= b) break;
          sths.emplace_back([&, a, b, t2]{ collect(a, b, tb[t2]); });
        }
        for (auto& th : sths) th.join();
        for (int li = 0; li < N; ++li) {
          size_t tot = 0; for (auto& tbt : tb) tot += tbt[li].size();
          layerSegs[li].reserve(tot);
          for (auto& tbt : tb) { layerSegs[li].insert(layerSegs[li].end(), tbt[li].begin(), tbt[li].end()); std::vector<Seg>().swap(tbt[li]); }
        }
      } else
#endif
      collect(0, tris.size(), layerSegs);
    }
    auto computeLayer = [&](int i) {
      const double z = zsv[i];
      LayerData ld; ld.z=z; ld.idx=i; ld.h=(i==0)?p.first_layer_height:p.layer_height;
      std::vector<Seg> segs; segs.swap(layerSegs[i]);
      Paths loops = chain_polys(segs);
      ld.contour = SimplifyPolygons(loops, pftNonZero);   // NonZero on oriented loops (slice_planes.h): upstream's Regular mode; coincident shells union instead of cancelling
      // [early simplification — matching upstream] Upstream simplifies every contour to resolution right after slicing the mesh
      //  (TriangleMeshSlicer.cpp:2042 ex.simplify). The kernel passed raw contours straight through, so everything downstream (walls, infill,
      //  support, emission clipping) paid for high-density polygons. CleanPolygons (removal by perpendicular distance) gives an equivalent reduction —
      //  a different algorithm from DP but the same purpose. Low-density fixtures (golden) have corner spacing >> resolution, so nothing changes.
      if (p.gcode_resolution > 1e-9) {
        CleanPolygons(ld.contour, SCALE * p.gcode_resolution);
        ld.contour.erase(std::remove_if(ld.contour.begin(), ld.contour.end(),
                                        [](const Path& q){ return q.size() < 3; }), ld.contour.end());
      }
      if (!ld.contour.empty()) {
        ld.island = offset_paths(ld.contour, -w*0.5);   // travel guard region — moved here (parallel) from the serial offset in the emission loop
        // Thin wall (Arachne-lite): detect regions narrower than 2w where the wall offset would vanish -> one center line instead of walls.
        //  Walls are generated only from the thick core (morph_open, width >= 2w) -> prevents double extrusion on thin parts.
        //  ⚠ Not full Arachne (a variable-width skeleton) — a single center line approximation.
        Paths wallBase = ld.contour;
        Paths core = morph_open(ld.contour, w);
        Paths thin = clip_paths(ld.contour, core, ctDifference);
        thin = offset_paths(offset_paths(thin, -w*0.15), w*0.15);   // remove sliver noise below 0.3w
        if (!thin.empty() && paths_area(thin) > w*w) { ld.thin = thin; wallBase = core; }
        Paths last = wallBase;
        for (int wl=0; wl<p.wall_loops; ++wl) {
          Paths wpaths = offset_paths(wallBase, -(w*0.5 + wl*w));
          if (wpaths.empty()) break;
          ld.walls.push_back(wpaths); last = wpaths;
        }
        if (!last.empty()) ld.fill = offset_paths(last, -(w*0.5));
        // Stage 7: in arachne mode -> generate variable-width walls with the real ported WallToolPaths (walls only; fill stays classic).
        if (p.wall_generator == "arachne") {
          // [Ultra-dense contour guard] Feeding the raw slice contours of a 3M-triangle model (tens of thousands of points per layer) directly
          //  kills the ported Arachne (SkeletalTrapezoidation) with a wild pointer trap (measured: immediately on layer 0,
          //  a raw OOB with no ASAN report; classic finishes the same model). Upstream OrcaSlicer passes contours that went through resolution
          //  simplification, but the kernel's PASS1 skips it, so a 5µm tolerance reduction is applied only above a point-count threshold.
          //  Below the threshold (including the golden fixtures) nothing changes -> golden stays byte-identical.
          // [Arachne input hygiene] Upstream feeds strictly-simple contours simplified to resolution (0.012mm), but
          //  the kernel's PASS1 passes raw slice contours straight through. On non-manifold models (overlapping shells, self-contact),
          //  layers retain µm edges, self-intersections and slivers, and the ported SkeletalTrapezoidation dies instantly on a wild pointer
          //  (measured: a 3M-triangle model, whose crashing layer's input had 10 edges of 1µm plus a self-intersecting polygon).
          //  Matching the upstream rules, hygiene runs in 3 steps: (1) a 10µm Clean (collapsing µm edges) (2) a re-Simplify (resolving
          //  self-intersections Clean can create, re-establishing strict simplicity) (3) removal of sub-nozzle slivers (<0.02mm²).
          //  Normal contours (including the golden fixtures) pass all 3 steps unchanged.
          Paths arachneSrc = ld.contour;
          CleanPolygons(arachneSrc, SCALE * 0.01);
          arachneSrc = SimplifyPolygons(arachneSrc, pftEvenOdd);
          { const double minA = 0.02 * SCALE * SCALE;
            arachneSrc.erase(std::remove_if(arachneSrc.begin(), arachneSrc.end(),
              [&](const Path& q){ return q.size() < 3 || std::fabs(Area(q)) < minA; }), arachneSrc.end()); }
          std::vector<std::vector<std::pair<double,double>>> polys;
          for (const Path& pth : arachneSrc) {
            std::vector<std::pair<double,double>> poly; poly.reserve(pth.size());
            for (const IntPoint& q : pth) poly.push_back({q.x()*INV, q.y()*INV});
            if (poly.size() >= 3) polys.push_back(std::move(poly));
          }
          if (p.arachne_dump) {   // temporary diagnostic: capture the input right before a crash (the last output = the dying layer)
            fprintf(stderr, "ARACHNE_IN L=%d npolys=%d\n", i, (int)polys.size());
            for (size_t pi=0; pi<polys.size(); ++pi) {
              fprintf(stderr, "P%d[%d]:", (int)pi, (int)polys[pi].size());
              for (auto& q : polys[pi]) fprintf(stderr, " %.6f,%.6f", q.first, q.second);
              fprintf(stderr, "\n");
            }
            fflush(stderr);
          }
          ld.arachneWalls = arachne_bridge::generate_walls(polys, w, p.wall_loops, ld.h);
          ld.thin.clear();   // arachne handles thin regions directly as variable-width walls -> the classic thin-wall path is disabled
        }
      }
      L[i] = std::move(ld);
    };
#ifdef __EMSCRIPTEN_PTHREADS__
    { unsigned hw = std::thread::hardware_concurrency();
      unsigned nt = std::max(1u, std::min<unsigned>(hw ? hw : 4, (unsigned)N));
      std::atomic<int> nextIdx{0};
      // [Real PASS1 progress] mt reported PASS1 in one go, so the browser sat at 0% for a measured 2.8s.
      //  The worker updates the same SAB counter as support (progress per mille, 0..1000) -> the UI thread polls it and shows the 0 -> 35% band.
      std::atomic<unsigned> p1done{0};
      auto* p1prog = (std::atomic<unsigned>*)(uintptr_t)treesupport_bridge::progress_addr();
      p1prog->store(0);
      auto workfn = [&]{ int i; while (!CX() && (i = nextIdx.fetch_add(1)) < N) { computeLayer(i);
        unsigned d = p1done.fetch_add(1) + 1; p1prog->store((unsigned)((unsigned long long)d * 1000u / (unsigned)N)); } };
      std::vector<std::thread> ths; ths.reserve(nt-1);
      for (unsigned t=1; t<nt; ++t) ths.emplace_back(workfn);
      workfn();                                  // the main thread joins in too
      for (auto& th : ths) th.join();
      p1prog->store(0);                          // avoid polluting the support band (clear the leftover value before ParallelScope resets it)
      if (CX()) { return false; }   // G002
      report(N, total);                          // JS callbacks are main-thread only -> report at coarse granularity
    }
#else
    for (int i=0;i<N;++i){ if (CX()) { return false; } computeLayer(i); report(i+1, total); }
#endif
  }
  return true;
}
