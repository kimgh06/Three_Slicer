// pass1.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  Model normalization (bbox -> center/seat -> over_bed) and PASS 1 (per-layer contours, walls, infill regions).
//  The two cancel sites inside PASS 1 return `false` instead of building the canceled em::val — slice() builds it
//  at the call site, so the observable result is unchanged.
#include "slice_ctx.h"
#include "contour_phase.h"

#include "arachne_bridge.h"
#include "classic_bridge.h"
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
#include <cstring>
#include <thread>
#include <vector>

// Model preparation — the bbox pass, the auto_center/Z-seat transform and the over_bed verdict.
ModelPrep prepare_model(std::vector<Triangle>& tris, const Params& params, bool reuseGeom) {
  // Move the model so XY is centered on the origin and minZ=0 (with reuseGeom the cached copy is already normalized)
  double minx=1e18,miny=1e18,minz=1e18,maxx=-1e18,maxy=-1e18,maxz=-1e18;
  if (reuseGeom) {
    minx=miny=minz=0;
    maxx=maxy=maxz=0;
  } else {
    for (auto& triangle:tris) for (int k=0;k<3;++k){
      minx=std::min(minx,(double)triangle.vertices[k].x);
      maxx=std::max(maxx,(double)triangle.vertices[k].x);
      miny=std::min(miny,(double)triangle.vertices[k].y);
      maxy=std::max(maxy,(double)triangle.vertices[k].y);
      minz=std::min(minz,(double)triangle.vertices[k].z);
      maxz=std::max(maxz,(double)triangle.vertices[k].z);
    }
  }
  double centerX=(minx+maxx)/2, centerY=(miny+maxy)/2;
  if (reuseGeom) {
    centerX = g_scache.centerX;
    centerY = g_scache.centerY;
  }
  // Stage 28 P2: with auto_center=true the combined bbox is realigned to the origin (legacy). false (default) = keep the viewer XY coordinates and only seat Z.
  //  G003: with reuseGeom the cached tris are already normalized — do not move again (avoids a double shift).
  if (!reuseGeom) {
    if (params.auto_center) {
      for (auto& triangle:tris) for (int k=0;k<3;++k){
        triangle.vertices[k].x-=centerX;
        triangle.vertices[k].y-=centerY;
        triangle.vertices[k].z-=minz;
      }
    } else {
      for (auto& triangle:tris) for (int k=0;k<3;++k){ triangle.vertices[k].z-=minz; }
    }
  }
  double height;
  if (reuseGeom) height = g_scache.height;
  else height = maxz - minz;
  double modelWidth = maxx - minx, modelDepth = maxy - miny;
  // over_bed: too large || (viewer coordinate mode) the G-code position (+bed/2) leaves the bed [0,bed] (i.e. outside [-bed/2,bed/2] in raw coordinates)
  //  bed_height is the printer's printable_height; 0 means the profile did not state one, so no ceiling is enforced
  bool over_bed = (modelWidth > params.bed_width) || (modelDepth > params.bed_depth) || (params.bed_height > 0 && height > params.bed_height);
  if (!params.auto_center) over_bed = over_bed || maxx > params.bed_width*0.5 || minx < -params.bed_width*0.5
                                          || maxy > params.bed_depth*0.5 || miny < -params.bed_depth*0.5;
  if (reuseGeom) over_bed = g_scache.over_bed;
  return { centerX, centerY, height, over_bed };
}

// The classic wall generator: the port of upstream PerimeterGenerator::process_classic (classic_bridge.cpp). It fills
//  layer.classicWalls (loops and thin walls in print order), layer.walls (the same loops by depth), layer.classicGapFill and
//  layer.fill (upstream's fill_surfaces, the infill area with the wall overlap applied).
static void classic_walls(LayerData& layer, const Params& params, int i, int layerCount) {
  const int raftLayers = std::max(0, params.raft_layers);
  const bool firstLayer = (i == 0 && raftLayers == 0);   // the same first-layer rule the emission applies to its widths
  classic_bridge::Config config;
  config.ext_perimeter_width = params.outer_wall_line_width;
  config.perimeter_width     = params.inner_wall_line_width;
  config.solid_infill_width  = params.internal_solid_infill_line_width;
  if (firstLayer) {
    config.ext_perimeter_width = params.initial_layer_line_width;
    config.perimeter_width     = params.initial_layer_line_width;
    config.solid_infill_width  = params.initial_layer_line_width;
  }
  config.layer_height              = layer.thickness;
  config.nozzle_diameter           = params.nozzle_diameter;
  config.wall_loops                = params.wall_loops;
  config.layer_id                  = i + raftLayers;      // upstream numbers object layers after the raft
  config.raft_layers               = raftLayers;
  config.detect_thin_wall          = params.detect_thin_wall;
  config.has_gap_fill              = params.has_gap_fill();
  config.filter_out_gap_fill       = params.filter_out_gap_fill;
  config.wall_sequence             = classic_bridge::InnerOuter;
  if (params.wall_sequence == "outer wall/inner wall")  config.wall_sequence = classic_bridge::OuterInner;
  if (params.wall_sequence == "inner-outer-inner wall") config.wall_sequence = classic_bridge::InnerOuterInner;
  config.wall_counter_clockwise    = (params.wall_direction != "cw");
  config.precise_outer_wall        = params.precise_outer_wall;
  config.only_one_wall_first_layer = params.only_one_wall_first_layer;
  config.alternate_extra_wall      = params.alternate_extra_wall;
  config.sparse_infill_density     = params.infill_density * 100.0;
  config.spiral_vase               = params.spiral_mode;
  config.resolution                = params.gcode_resolution;
  config.arc_fitting               = params.enable_arc_fitting;
  config.infill_wall_overlap       = params.infill_wall_overlap;
  config.top_bottom_infill_wall_overlap = params.top_bottom_infill_wall_overlap;
  config.is_top_layer              = (i == layerCount - 1);

  std::vector<classic_bridge::IntegerPath> contour;
  contour.reserve(layer.contour.size());
  for (const Path& path : layer.contour) {
    classic_bridge::IntegerPath points;
    points.reserve(path.size());
    for (const IntPoint& point : path) points.emplace_back(point.x(), point.y());
    contour.push_back(std::move(points));
  }
  classic_bridge::Result result = classic_bridge::generate(contour, config);

  auto to_path = [](const classic_bridge::IntegerPath& points) {
    Path path;
    path.reserve(points.size());
    for (const classic_bridge::IntegerPoint& point : points) path.push_back(IntPoint((cInt)point.first, (cInt)point.second));
    return path;
  };
  for (const classic_bridge::Extrusion& extrusion : result.walls) {
    layer.classicWalls.push_back({ to_path(extrusion.points), extrusion.closed, extrusion.inset, (float)extrusion.width });
    if (!extrusion.closed) continue;
    if ((int)layer.walls.size() <= extrusion.inset) layer.walls.resize(extrusion.inset + 1);
    layer.walls[extrusion.inset].push_back(layer.classicWalls.back().path);
  }
  for (const classic_bridge::Extrusion& extrusion : result.gap_fill)
    layer.classicGapFill.push_back({ to_path(extrusion.points), (float)extrusion.width, 0, (float)layer.thickness, 0.0f });
  for (const classic_bridge::IntegerPath& points : result.fill) layer.fill.push_back(to_path(points));
}

bool pass1_run(SliceContext& context) {
  const Params& params = *context.params;
  std::vector<Triangle>& tris = *context.triangles;
  std::vector<LayerData>& layers = *context.layers;
  auto& isCanceled = context.isCanceled;
  auto& report = context.report;
  const int layerCount = context.layerCount;
  const int total = context.total;
  const double height = context.height;
  const double lineWidth = context.lineWidth;
  { const LayerPlan layerPlan = plan_layers(params.first_layer_height, params.layer_height, height);
    const std::vector<double>& planes = layerPlan.plane;   // the cutting planes; a layer's print z is layerPlan.top
    // [facet-major segment collection — matching upstream] Like the upstream slice_facet_at_zs (TriangleMeshSlicer.cpp:476),
    //  each triangle binary-searches and visits "only the layers it spans" (work = the number of real intersections). The old layer x full-scan was 657 x 775k
    //  ≈ 500M visits. The inclusion condition is unchanged (zmin<=z<zmax -> lower_bound + *it<zmax) and the intersect_triangle_with_plane
    //  input is identical -> segment values are unchanged. Per-thread 'contiguous triangle ranges' merged in range order keep the in-layer segment
    //  order in ascending triangle index (same as the old full scan) -> the chain_polygons input is unchanged = byte-identical.
    // MESH (contour_phase.h): the GPU cuts and chains the layers; hand it the triangles as seated and the planes as cut
    if (contour_phase::mode == contour_phase::MESH) {
      static_assert(sizeof(Triangle) == 9 * sizeof(float), "mesh_tris copies Triangle as 9 packed floats");
      contour_phase::mesh_planes = planes;
      contour_phase::mesh_tris.resize(tris.size() * 9);
      if (!tris.empty()) std::memcpy(contour_phase::mesh_tris.data(), tris.data(), tris.size() * sizeof(Triangle));
      contour_phase::captured = true;
      return false;
    }
    std::vector<std::vector<SliceSegment>> layerSegs(layerCount);
    // The union done outside the kernel (contour_phase.h). OFF leaves every line below as it was.
    const bool captureLoops = contour_phase::mode == contour_phase::CAPTURE;
    const bool injectContours = contour_phase::mode == contour_phase::INJECT && (int)contour_phase::contours.size() == layerCount;
    if (captureLoops) contour_phase::loops.assign(layerCount, Paths());
    if (layerCount > 0 && !injectContours) {
      auto collect = [&](size_t firstTriangle, size_t endTriangle, std::vector<std::vector<SliceSegment>>& out){
        SliceSegment segment;
        for (size_t triangleIndex = firstTriangle; triangleIndex < endTriangle; ++triangleIndex) {
          const Triangle& triangle = tris[triangleIndex];
          double zmin=std::min({triangle.vertices[0].z,triangle.vertices[1].z,triangle.vertices[2].z}), zmax=std::max({triangle.vertices[0].z,triangle.vertices[1].z,triangle.vertices[2].z});
          for (auto it = std::lower_bound(planes.begin(), planes.end(), zmin); it != planes.end() && *it < zmax; ++it)
            if (intersect_triangle_with_plane(triangle, *it, segment)) out[(size_t)(it - planes.begin())].push_back(segment);
        }
      };
#ifdef __EMSCRIPTEN_PTHREADS__
      unsigned hardwareThreads = std::thread::hardware_concurrency();
      if (!hardwareThreads) hardwareThreads = 4;
      unsigned threadCount = (unsigned)std::min<size_t>(hardwareThreads, std::max<size_t>(1, tris.size() / 4096));
      if (threadCount > 1) {
        std::vector<std::vector<std::vector<SliceSegment>>> threadBuckets(threadCount, std::vector<std::vector<SliceSegment>>(layerCount));
        size_t chunkSize = (tris.size() + threadCount - 1) / threadCount;
        std::vector<std::thread> threads;
        threads.reserve(threadCount);
        for (unsigned threadIndex = 0; threadIndex < threadCount; ++threadIndex) {
          size_t rangeBegin = threadIndex*chunkSize, rangeEnd = std::min(tris.size(), rangeBegin+chunkSize);
          if (rangeBegin >= rangeEnd) break;
          // an empty pthread pool refuses the thread (PTHREAD_POOL_SIZE_STRICT=2): the caller sweeps the range itself,
          //  into the same bucket, so the segment order is unchanged
          try {
            threads.emplace_back([&, rangeBegin, rangeEnd, threadIndex]{ collect(rangeBegin, rangeEnd, threadBuckets[threadIndex]); });
          }
          catch (...) { collect(rangeBegin, rangeEnd, threadBuckets[threadIndex]); }
        }
        for (auto& thread : threads) thread.join();
        for (int layerIndex = 0; layerIndex < layerCount; ++layerIndex) {
          size_t segmentTotal = 0;
          for (auto& bucket : threadBuckets) segmentTotal += bucket[layerIndex].size();
          layerSegs[layerIndex].reserve(segmentTotal);
          for (auto& bucket : threadBuckets) {
            layerSegs[layerIndex].insert(layerSegs[layerIndex].end(), bucket[layerIndex].begin(), bucket[layerIndex].end());
            std::vector<SliceSegment>().swap(bucket[layerIndex]);
          }
        }
      } else
#endif
      collect(0, tris.size(), layerSegs);
    }
    auto computeLayer = [&](int i) {
      const double z = layerPlan.top[i];
      LayerData layer;
      layer.z=z;
      layer.index=i;
      if (i==0) layer.thickness=params.first_layer_height;
      else layer.thickness=params.layer_height;
      std::vector<SliceSegment> segments;
      segments.swap(layerSegs[i]);
      if (captureLoops) {
        contour_phase::loops[i] = chain_polygons(segments);
        contour_phase::cancel_coincident(contour_phase::loops[i]);
        return;
      }
      if (injectContours) layer.contour = contour_phase::contours[i];
      else {
      Paths loops = chain_polygons(segments);
      layer.contour = SimplifyPolygons(loops, pftNonZero);
      }   // NonZero on oriented loops (slice_planes.h): upstream's Regular mode; coincident shells union instead of cancelling
      // [early simplification — matching upstream] Upstream simplifies every contour to resolution right after slicing the mesh
      //  (TriangleMeshSlicer.cpp:2042 ex.simplify). The kernel passed raw contours straight through, so everything downstream (walls, infill,
      //  support, emission clipping) paid for high-density polygons. CleanPolygons (removal by perpendicular distance) gives an equivalent reduction —
      //  a different algorithm from DP but the same purpose. Low-density fixtures (golden) have corner spacing >> resolution, so nothing changes.
      if (params.gcode_resolution > 1e-9) {
        CleanPolygons(layer.contour, SCALE * params.gcode_resolution);
        layer.contour.erase(std::remove_if(layer.contour.begin(), layer.contour.end(),
                                        [](const Path& path){ return path.size() < 3; }), layer.contour.end());
      }
      if (!layer.contour.empty()) {
        layer.island = offset_paths(layer.contour, -lineWidth*0.5);   // travel guard region — moved here (parallel) from the serial offset in the emission loop
        if (params.wall_generator != "arachne") {
          classic_walls(layer, params, i, layerCount);
        } else {
        // Arachne mode keeps the walls and fill it had before the classic port: the fill comes from these offsets, and
        //  layer.walls is the emission fallback for a layer Arachne returns nothing for. The thick core (morph_open, width
        //  >= 2w) is what the offsets start from, so a region narrower than 2w leaves no hole in the fill.
        Paths wallBase = layer.contour;
        Paths core = morph_open(layer.contour, lineWidth);
        Paths thin = clip_paths(layer.contour, core, ctDifference);
        thin = offset_paths(offset_paths(thin, -lineWidth*0.15), lineWidth*0.15);   // remove sliver noise below 0.3w
        if (!thin.empty() && paths_area(thin) > lineWidth*lineWidth) wallBase = core;
        Paths last = wallBase;
        for (int wallIndex=0; wallIndex<params.wall_loops; ++wallIndex) {
          Paths wallPaths = offset_paths(wallBase, -(lineWidth*0.5 + wallIndex*lineWidth));
          if (wallPaths.empty()) break;
          layer.walls.push_back(wallPaths);
          last = wallPaths;
        }
        if (!last.empty()) layer.fill = offset_paths(last, -(lineWidth*0.5));
        // Stage 7: in arachne mode -> generate variable-width walls with the real ported WallToolPaths (walls only; fill stays classic).
        {
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
          Paths arachneSrc = layer.contour;
          CleanPolygons(arachneSrc, SCALE * 0.01);
          arachneSrc = SimplifyPolygons(arachneSrc, pftEvenOdd);
          {
            const double minArea = 0.02 * SCALE * SCALE;
            arachneSrc.erase(std::remove_if(arachneSrc.begin(), arachneSrc.end(),
              [&](const Path& path){ return path.size() < 3 || std::fabs(Area(path)) < minArea; }), arachneSrc.end());
          }
          std::vector<std::vector<std::pair<double,double>>> polys;
          for (const Path& path : arachneSrc) {
            std::vector<std::pair<double,double>> poly;
            poly.reserve(path.size());
            for (const IntPoint& point : path) poly.push_back({point.x()*INV, point.y()*INV});
            if (poly.size() >= 3) polys.push_back(std::move(poly));
          }
          if (params.arachne_dump) {   // temporary diagnostic: capture the input right before a crash (the last output = the dying layer)
            fprintf(stderr, "ARACHNE_IN L=%d npolys=%d\n", i, (int)polys.size());
            for (size_t polyIndex=0; polyIndex<polys.size(); ++polyIndex) {
              fprintf(stderr, "P%d[%d]:", (int)polyIndex, (int)polys[polyIndex].size());
              for (auto& point : polys[polyIndex]) fprintf(stderr, " %.6f,%.6f", point.first, point.second);
              fprintf(stderr, "\n");
            }
            fflush(stderr);
          }
          layer.arachneWalls = arachne_bridge::generate_walls(polys, lineWidth, params.wall_loops, layer.thickness);
        }
        }
      }
      layers[i] = std::move(layer);
    };
#ifdef __EMSCRIPTEN_PTHREADS__
    {
      unsigned hardwareThreads = std::thread::hardware_concurrency();
      if (hardwareThreads == 0) hardwareThreads = 4;
      unsigned threadCount = std::max(1u, std::min<unsigned>(hardwareThreads, (unsigned)layerCount));
      std::atomic<int> nextLayer{0};
      // [Real PASS1 progress] mt reported PASS1 in one go, so the browser sat at 0% for a measured 2.8s.
      //  The worker updates the same SAB counter as support (progress per mille, 0..1000) -> the UI thread polls it and shows the 0 -> 35% band.
      std::atomic<unsigned> layersDone{0};
      auto* progress = (std::atomic<unsigned>*)(uintptr_t)treesupport_bridge::progress_addr();
      progress->store(0);
      auto worker = [&]{
        int i;
        while (!isCanceled() && (i = nextLayer.fetch_add(1)) < layerCount) {
          computeLayer(i);
          unsigned doneCount = layersDone.fetch_add(1) + 1;
          progress->store((unsigned)((unsigned long long)doneCount * 1000u / (unsigned)layerCount));
        }
      };
      std::vector<std::thread> threads;
      threads.reserve(threadCount-1);
      for (unsigned threadIndex=1; threadIndex<threadCount; ++threadIndex) {   // the threads that started take the rest
        try { threads.emplace_back(worker); } catch (...) { break; }
      }
      worker();                                  // the main thread joins in too
      for (auto& thread : threads) thread.join();
      progress->store(0);                          // avoid polluting the support band (clear the leftover value before ParallelScope resets it)
      if (isCanceled()) { return false; }   // G002
      if (captureLoops) {
        contour_phase::captured = true;
        return false;
      }
      report(layerCount, total);                          // JS callbacks are main-thread only -> report at coarse granularity
    }
#else
    for (int i=0;i<layerCount;++i){
      if (isCanceled()) { return false; }
      computeLayer(i);
      report(i+1, total);
    }
    if (captureLoops) {
      contour_phase::captured = true;
      return false;
    }
#endif
  }
  return true;
}
