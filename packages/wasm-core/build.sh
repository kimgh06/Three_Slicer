#!/usr/bin/env bash
# Build of the browser-only slicing mini kernel (track C)
# Output: ../engine/src/slicer_core.js  (SINGLE_FILE=1 -> the wasm is inlined as base64,
#         no external .wasm fetch -> self-contained on any static server or vite preview)
#
# Stage 7: the real OrcaSlicer Arachne (WallToolPaths) port is linked in as well.
#  - The kernel's own clipper (global ClipperLib) and the Arachne port's clipper (Slic3r::ClipperLib / ClipperLib_Z) live in
#    different namespaces, so they coexist. Only arachne_bridge.cpp bridges the two worlds.
#  - Requires: brew boost (header-only voronoi) + brew eigen. Stubbed: tbb/boost-log/cereal/SVG/Flow/Config, etc.
set -euo pipefail

export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
# ccache wrapping: unchanged TUs are reused -> a single-file rebuild goes from minutes to tens of seconds. (brew install ccache)
command -v ccache >/dev/null && export EM_COMPILER_WRAPPER=ccache

cd "$(dirname "$0")"
# Stage 34: copy the deps into third_party/ -> removes the dependency on slicer/ (REPO can be deleted)
AP=arachne_port/libslic3r

# --- Arachne port sources (upstream verbatim + documented minimal edits) ---
#  classic_bridge.cpp is the classic wall generator (a port of PerimeterGenerator::process_classic); it needs the medial
#  axis (MedialAxis.cpp, verbatim) for thin walls and gap fill. MedialAxis calls Voronoi::annotate_inside_outside, which
#  VoronoiOffset.cpp provides from the tree support group (same header, identical in both ports).
ARACHNE_SRC="
  arachne_bridge.cpp
  $AP/Arachne/WallToolPaths.cpp
  $AP/Arachne/SkeletalTrapezoidation.cpp
  $AP/Arachne/SkeletalTrapezoidationGraph.cpp
  $AP/Arachne/utils/ExtrusionLine.cpp
  $AP/Arachne/utils/PolylineStitcher.cpp
  $AP/Arachne/utils/SquareGrid.cpp
  $AP/Arachne/BeadingStrategy/BeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/BeadingStrategyFactory.cpp
  $AP/Arachne/BeadingStrategy/DistributedBeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/LimitedBeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/OuterWallInsetBeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/RedistributeBeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/WideningBeadingStrategy.cpp
  $AP/Point.cpp $AP/Line.cpp $AP/Polygon.cpp $AP/Polyline.cpp $AP/MultiPoint.cpp
  $AP/BoundingBox.cpp $AP/ExPolygon.cpp $AP/ClipperUtils.cpp $AP/EdgeGrid.cpp
  $AP/Surface.cpp $AP/ArcFitter.cpp $AP/libslic3r.cpp $AP/Geometry.cpp
  $AP/Geometry/VoronoiUtils.cpp $AP/Geometry/Voronoi.cpp
  $AP/Geometry/VoronoiUtilsCgal.cpp
  classic_bridge.cpp
  arcfit_bridge.cpp
  $AP/Geometry/MedialAxis.cpp

  $AP/clipper.cpp
  third_party/deps_src/clipper/clipper_z.cpp
"
# --- Stage 8: the ported real OrcaSlicer Fill patterns (gyroid TPMS/honeycomb/3dhoneycomb/crosshatch/concentric) ---
C2=third_party/deps_src/clipper2/Clipper2Lib
FILL_SRC="
  fill_bridge.cpp
  $AP/Fill/FillBase.cpp $AP/Fill/FillGyroid.cpp $AP/Fill/FillHoneycomb.cpp
  $AP/Fill/Fill3DHoneycomb.cpp $AP/Fill/FillCrossHatch.cpp $AP/Fill/FillConcentric.cpp
  $AP/Fill/FillRectilinear.cpp
  $AP/ShortestPath.cpp $AP/ExtrusionEntityCollection.cpp $AP/Circle.cpp $AP/Clipper2Utils.cpp
  $C2/src/clipper.engine.cpp $C2/src/clipper.offset.cpp $C2/src/clipper.rectclip.cpp
"
# --- Stage 8: the ported real PressureEqualizer ---
PE_SRC="pe_bridge.cpp $AP/GCode/PressureEqualizer.cpp $AP/GCodeFormatter_impl.cpp"
# --- Stage 10: the ported GCodeProcessor time estimation algorithm ---
TIME_SRC="gcode_time.cpp"
# --- Stage 12: merge the real config subsystem (Config.cpp + PrintConfig.cpp) into the main build ---
#  Only config_bridge.cpp sits on the kernel <-> real PrintConfig boundary (same isolation as arachne_bridge). The config sources pull
#  the real headers from their own directory via "" relative includes, while Arachne/Fill/PE keep using the stub PrintConfig.hpp
#  (the enums are verbatim identical -> ODR-safe). No main TU includes boost/thread, so the empty boost/thread stubs under config/stubs
#  affect PrintConfig.cpp only.
CP=arachne_port/config/libslic3r
CONFIG_SRC="config_bridge.cpp $CP/Config.cpp $CP/PrintConfig.cpp $CP/MaterialType.cpp"
CONFIG_INC="-Iarachne_port/config/stubs"
# --- Stage 12 item 2: link the real WipeTower into the main build (wipe_tower_real). WipeTower.cpp uses the
#  GCodeProcessor stub in its own directory (-> real PrintConfig) and the TriangleMesh/Triangulation stubs in wipetower/inc.
#  role_to_string/localesutils_wasm are single-function/unity wrappers (avoiding the whole TU's Flow/PCH dependency). Arachne/Fill/PE
#  still use the stub PrintConfig — wipetower/inc only shadows libslic3r/TriangleMesh (prefix) and Triangulation, and no compiled TU in
#  the main build includes them (measured). Circle/ArcFitter/geometry are already linked.
WT=arachne_port/wipetower
WIPETOWER_SRC="$WT/GCode/WipeTower.cpp $WT/role_to_string.cpp $WT/localesutils_wasm.cpp"
CONFIG_INC="$CONFIG_INC -Iarachne_port/wipetower/inc"
# --- Stage 13: the real ported GCodeProcessor itself (time_engine=full). gcodeproc_bridge.cpp is the kernel <-> GCodeProcessor
#  boundary. GCodeProcessor.cpp uses the Print stub in gcodeproc/inc (2 symbols) and the boost::nowide/filesystem stubs in gcodeproc/stubs,
#  with PrintConfig going forwarder -> real. GCodeReader/MultiNozzleUtils/ArcWelder/Elegoo are ported and string_to_role is extracted as a
#  single function. ProjectTask uses a FilamentInfo stub. No pre-existing TU in the main build includes these stubs (measured).
GP=arachne_port/gcodeproc
GCODEPROC_SRC="gcodeproc_bridge.cpp $GP/GCode/GCodeProcessor.cpp $GP/GCode/ElegooGCodeProcessorHelper.cpp $GP/extrusion_role_helper.cpp $AP/GCodeReader.cpp $AP/MultiNozzleUtils.cpp $AP/Geometry/ArcWelder.cpp"
CONFIG_INC="$CONFIG_INC -Iarachne_port/gcodeproc/inc -Iarachne_port/gcodeproc/stubs"
# Includes for the Arachne/Fill ports (no effect on kernel sources — the kernel only includes arachne_bridge.h/fill_bridge.h)
# Stage 14: the real CGAL planarity check (VoronoiUtilsCgal). cgal_stubs overrides boost's wasm.hpp (dropping BOOST_NO_FENV_H
#  -> Boost.Multiprecision interval c99 rounding). CGAL 6.x is header-only (brew), with no GMP/MPFR linkage.
# --- Stage 18: integrate the real organic TreeSupport into the main build (treesupport_bridge, option (a) approved) ---
#  Stage-17 ODR findings: the shared-symbol approach already achieved an ODR-clean link and 120 green, and the only runtime wall was the
#  main build's FillBase factory STAGE-8 trim (new_from_type -> nullptr for ipSupportBase/ipRectilinear). Stage 18 restores that trim
#  additively (the STAGE-18 UNTRIM in FillBase.cpp above + adding FillRectilinear.cpp to FILL_SRC; a byte-diff of 0 against golden proves
#  the default path is unaffected), so the tree path also gets the real fillers. Only tree-specific sources are compiled in isolation into
#  separate relocatable objects (port headers resolved via file-relative includes) before joining the main link. Shared sources (Point/Polygon/
#  PrintConfig/Arachne/Fill*/Geometry/Voronoi/clipper, …) are not recompiled (header ABI verified identical; FillRectilinear/SupportBase are now
#  provided by the main build). The 2 conflicting symbols (ExtrusionEntity::role_to_string/string_to_role) are guarded with
#  -DTS_BRIDGE_EXCLUDE_ROLE_FNS (the main build provides role_to_string.cpp + extrusion_role_helper.cpp). The kernel <-> bridge boundary uses plain types only. -DNDEBUG applies to the tree group only.
TS=treesupport_port; TL=$TS/libslic3r
TS_UNIQUE_SRC="
  $TL/treesupport_bridge_impl.cpp $TL/selector_bridge_impl.cpp $TL/TriangleSelector.cpp
  $TL/MultiMaterialSegmentation.cpp
  $TL/Support/SupportCommon.cpp $TL/Support/TreeModelVolumes.cpp $TL/Support/TreeSupport3D.cpp $TL/Support/TreeSupport.cpp
  $TL/Support/SupportMaterial.cpp $TL/layerregion_flow_impl.cpp
  $TL/Flow.cpp $TL/Layer.cpp $TL/MutablePolygon.cpp $TL/BuildVolume.cpp $TL/SurfaceCollection.cpp
  $TL/TriangleMesh.cpp $TL/TriangleMeshSlicer.cpp
  $TL/Fill/FillLightning.cpp $TL/MinimumSpanningTree.cpp $TL/ExtrusionEntity.cpp
  $TL/Geometry/ConvexHull.cpp $TL/Geometry/Circle.cpp
  $TL/Geometry/VoronoiOffset.cpp $TL/ExPolygonsIndex.cpp
  $TL/Fill/Lightning/DistanceField.cpp $TL/Fill/Lightning/Generator.cpp $TL/Fill/Lightning/Layer.cpp $TL/Fill/Lightning/TreeNode.cpp
"
TS_INC="-Iarachne_port/cgal_stubs -I$TS -I$TL -I$TL/Support -Ithird_party/deps_src -Ithird_party/deps_src/libnest2d/include -Ithird_party/deps_src/libigl -Ithird_party/deps_src/clipper2/Clipper2Lib/include -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"
# ---- Parallel compile helper: compile one .o per source, as many at a time as there are cores (previously: a single em++ call = sequential compilation) ----
#  ccache (EM_COMPILER_WRAPPER) handles caching including header dependencies, so everything is invoked every time with no mtime-based incremental logic
#  — unchanged TUs hit the cache in ~0.1s. The link passes the .o files in source order to stay deterministic (golden).
NCPU=$(sysctl -n hw.ncpu 2>/dev/null || echo 8)
pcompile() {  # $1=objdir  $2=compile flags (string)  rest=source list
  local objdir="$1" flags="$2"; shift 2
  mkdir -p "$objdir"
  printf '%s\n' "$@" | OBJDIR="$objdir" CFLAGS="$flags" xargs -P "$NCPU" -I SRC bash -c '
    em++ $CFLAGS -c "SRC" -o "$OBJDIR/$(printf "%s" "SRC" | tr "/" "_").o"'
}
objs() {  # $1=objdir  rest=source list -> prints .o paths in source order
  local objdir="$1"; shift; local s
  for s in "$@"; do printf '%s/%s.o ' "$objdir" "$(printf '%s' "$s" | tr '/' '_')"; done
}

TS_GROUP_OBJ=/tmp/ts_group.o
TS_CFLAGS="-O2 -std=c++17 -DNDEBUG -DTS_BRIDGE_EXCLUDE_ROLE_FNS -DCGAL_DISABLE_ROUNDING_MATH_CHECK -DCGAL_DISABLE_GMP=1 $TS_INC"
echo "compiling treesupport group (isolated, parallel x$NCPU) -> $TS_GROUP_OBJ"
pcompile /tmp/ws_obj/ts_st "$TS_CFLAGS" $TS_UNIQUE_SRC
em++ -O2 -r $(objs /tmp/ws_obj/ts_st $TS_UNIQUE_SRC) -o $TS_GROUP_OBJ

# ---- SLA support chain (PrusaSlicer port, its own include universe — see slasupport_port/PORT_NOTES.md) ----
#  Prusa-generation headers (slasupport_port) and Prusa's own libigl (untemplated igl::Hit) win the include
#  order; everything they do not carry falls through to the Orca-generation treesupport core (TriangleMesh,
#  Execution, admesh). The bridge TU is the only file both universes may name — its header is plain std types.
SLA_SRC="slasupport_bridge_validate.cpp slasupport_slicer_fallback.cpp slasupport_bridge.cpp slasupport_port/libslic3r/AABBMesh.cpp slasupport_port/libslic3r/MeshNormals.cpp slasupport_port/libslic3r/SLA/SpatIndex.cpp slasupport_port/libslic3r/SLA/Clustering.cpp slasupport_port/libslic3r/SLA/SupportTreeMesher.cpp slasupport_port/libslic3r/SLA/SupportTreeBuilder.cpp slasupport_port/libslic3r/SLA/DefaultSupportTree.cpp slasupport_port/libslic3r/SLA/SupportIslands/EvaluateNeighbor.cpp slasupport_port/libslic3r/SLA/SupportIslands/ExpandNeighbor.cpp slasupport_port/libslic3r/SLA/SupportIslands/LineUtils.cpp slasupport_port/libslic3r/SLA/SupportIslands/ParabolaUtils.cpp slasupport_port/libslic3r/SLA/SupportIslands/PointUtils.cpp slasupport_port/libslic3r/SLA/SupportIslands/PolygonUtils.cpp slasupport_port/libslic3r/SLA/SupportIslands/PostProcessNeighbor.cpp slasupport_port/libslic3r/SLA/SupportIslands/PostProcessNeighbors.cpp slasupport_port/libslic3r/SLA/SupportIslands/SampleConfigFactory.cpp slasupport_port/libslic3r/SLA/SupportIslands/SupportIslandPoint.cpp slasupport_port/libslic3r/SLA/SupportIslands/UniformSupportIsland.cpp slasupport_port/libslic3r/SLA/SupportIslands/VoronoiDiagramCGAL.cpp slasupport_port/libslic3r/SLA/SupportIslands/VoronoiGraphUtils.cpp slasupport_port/libslic3r/SLA/SupportPointGenerator.cpp slasupport_port/libslic3r/Tesselate.cpp slasupport_port/libslic3r/SLA/ConcaveHull.cpp slasupport_port/libslic3r/SLA/Pad.cpp"
SLA_INC="-Islasupport_port -Islasupport_port/libslic3r -Islasupport_port/libslic3r/SLA -Ithird_party/deps_src/libigl_prusa $TS_INC -Ithird_party/deps_src/libigl -Ithird_party/deps_src/glu-libtess/include -Ithird_party/deps_src/nlopt/api"
# CGAL (brew headers, header-only use): the SupportIslands Voronoi/Delaunay sampling includes real CGAL —
#  the arachne cgal_stubs dir carries no CGAL headers, so <CGAL/...> falls through to /opt/homebrew/include.
#  CGAL_DISABLE_GMP is REQUIRED everywhere CGAL is compiled: CGAL 6 auto-detects brew's gmp.h via
#  __has_include and its exact number types then reference __gmpn_* symbols no wasm library provides —
#  disabling it selects the header-only boost::multiprecision backend instead (exact either way).
SLA_CFLAGS="-O2 -std=c++17 -DNDEBUG -DCGAL_DISABLE_ROUNDING_MATH_CHECK -DCGAL_DISABLE_GMP=1 $SLA_INC"
SLA_GROUP_OBJ=/tmp/sla_group.o
# NLopt 2.5.0 (the exact version PrusaSlicer's deps pin, SHA-verified) — the REAL optimizer behind
#  Optimize/NLoptOptimizer.hpp (ESCH pose/route searches). C sources, canonical list from its CMakeLists,
#  minus the C++-gated stogo/ags and the fortran API. Config is hand-written (nlopt_config.h).
NL=third_party/deps_src/nlopt
NLOPT_SRC="$NL/algs/direct/DIRect.c $NL/algs/direct/direct_wrap.c $NL/algs/direct/DIRserial.c $NL/algs/direct/DIRsubrout.c
  $NL/algs/cdirect/cdirect.c $NL/algs/cdirect/hybrid.c $NL/algs/praxis/praxis.c
  $NL/algs/luksan/plis.c $NL/algs/luksan/plip.c $NL/algs/luksan/pnet.c $NL/algs/luksan/mssubs.c $NL/algs/luksan/pssubs.c
  $NL/algs/crs/crs.c $NL/algs/mlsl/mlsl.c $NL/algs/mma/mma.c $NL/algs/mma/ccsa_quadratic.c
  $NL/algs/cobyla/cobyla.c $NL/algs/newuoa/newuoa.c $NL/algs/neldermead/nldrmd.c $NL/algs/neldermead/sbplx.c
  $NL/algs/auglag/auglag.c $NL/algs/bobyqa/bobyqa.c $NL/algs/isres/isres.c $NL/algs/slsqp/slsqp.c
  $NL/algs/esch/esch.c
  $NL/api/general.c $NL/api/options.c $NL/api/optimize.c $NL/api/deprecated.c
  $NL/util/mt19937ar.c $NL/util/sobolseq.c $NL/util/timer.c $NL/util/stop.c $NL/util/redblack.c $NL/util/qsort_r.c $NL/util/rescale.c"
NLOPT_INC="-I$NL -I$NL/api -I$NL/util -I$NL/algs/direct -I$NL/algs/cdirect -I$NL/algs/praxis -I$NL/algs/luksan -I$NL/algs/crs -I$NL/algs/mlsl -I$NL/algs/mma -I$NL/algs/cobyla -I$NL/algs/newuoa -I$NL/algs/neldermead -I$NL/algs/auglag -I$NL/algs/bobyqa -I$NL/algs/isres -I$NL/algs/slsqp -I$NL/algs/esch"
NLOPT_CFLAGS="-O2 -DNDEBUG $NLOPT_INC"
nlopt_objs() {  # $1=objdir $2=extra flags — compile (cached) and print the .o list in source order
  local objdir="$1" flags="$2"; mkdir -p "$objdir"
  printf '%s\n' $NLOPT_SRC | OBJDIR="$objdir" CFLAGS="$NLOPT_CFLAGS $flags" xargs -P "$NCPU" -I SRC bash -c '
    emcc $CFLAGS -c "SRC" -o "$OBJDIR/$(printf "%s" "SRC" | tr "/" "_").o"'
  objs "$objdir" $NLOPT_SRC
}

# glu-libtess (SGI tessellator, C with extern "C" linkage — must compile as C, hence emcc not em++).
#  Backend of Prusa's Tesselate.cpp, which triangulates the pad's top/bottom sheets. Source list is upstream's
#  own CMake list; -include limits.h because priorityq-heap.c uses LONG_MAX without including it.
LT=third_party/deps_src/glu-libtess/src
LIBTESS_SRC="$LT/dict.c $LT/geom.c $LT/memalloc.c $LT/mesh.c $LT/normal.c $LT/priorityq.c $LT/render.c $LT/sweep.c $LT/tess.c $LT/tessmono.c"
LIBTESS_CFLAGS="-O2 -DNDEBUG -include limits.h -Ithird_party/deps_src/glu-libtess/include -I$LT"
libtess_objs() {  # $1=objdir — compile (cached like everything else) and print the .o list in source order
  local objdir="$1" flags="$2"; mkdir -p "$objdir"
  printf '%s\n' $LIBTESS_SRC | OBJDIR="$objdir" CFLAGS="$flags" xargs -P "$NCPU" -I SRC bash -c '
    emcc $CFLAGS -c "SRC" -o "$OBJDIR/$(printf "%s" "SRC" | tr "/" "_").o"'
  objs "$objdir" $LIBTESS_SRC
}
echo "compiling glu-libtess (C, parallel x$NCPU)"
LIBTESS_OBJ_ST=$(libtess_objs /tmp/ws_obj/libtess_st "$LIBTESS_CFLAGS")
echo "compiling nlopt 2.5.0 (C, parallel x$NCPU)"
NLOPT_OBJ_ST=$(nlopt_objs /tmp/ws_obj/nlopt_st "")

echo "compiling SLA support chain (isolated, parallel x$NCPU) -> $SLA_GROUP_OBJ"
pcompile /tmp/ws_obj/sla_st "$SLA_CFLAGS" $SLA_SRC
em++ -O2 -r $(objs /tmp/ws_obj/sla_st $SLA_SRC) $LIBTESS_OBJ_ST $NLOPT_OBJ_ST -o $SLA_GROUP_OBJ

ARACHNE_INC="-Iarachne_port/cgal_stubs $CONFIG_INC -Iarachne_port/stubs -Iarachne_port -I$AP -Ithird_party/deps_src -I$C2/include -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"

# Speed flags, measured (2026-07-29, big_cyl arachne+support): -O3 -msimd128 gives 5183ms vs -O2 5149ms —
#  a 0.7% (noise-level) gain for +9% size (3.43 -> 3.74MB), so -O2 stays. -flto hits a wasm-ld SIGSEGV (conflict with -r partial linking).
#  -ffast-math is forbidden (breaks golden byte-identity). The bottleneck is scalar integer polygon math — the real lever is threading.
# params/stl_parse/geom_helpers/emit/slice_mm/stream_sink/emit_layer/bindings were split out of slicer_core.cpp (pure code
#  move). The link takes the .o files in source-list order (determinism -> golden), so they are listed immediately after
#  slicer_core.cpp, in the same order their sections had inside it: Parameters -> STL parser -> Stage 5 helpers ->
#  toolpath emit helpers -> multi-material slice -> layer sink/PE strip -> PASS2 emission body -> embind block.
#  Wave 2 did the same to slice() itself: stage cache -> model prep/PASS1 -> PASS1.5 surfaces -> PASS1.6 support ->
#  preamble -> raft -> PASS2 precompute -> finish stats, leaving slice() as the orchestrator. Same rule — listed in
#  the order their code had inside slicer_core.cpp.
#  (clip_util.h / slice_planes.h / gcode_writer.h / layer_data.h / slice_api.h / slice_ctx.h are header-only.)
MAIN_SRC="slicer_core.cpp slice_sla.cpp params.cpp stl_parse.cpp geom_helpers.cpp emit.cpp slice_mm.cpp stream_sink.cpp emit_layer.cpp stage_cache.cpp pass1.cpp surfaces.cpp support.cpp preamble.cpp raft.cpp pass2.cpp finish.cpp bindings.cpp clipper.cpp $ARACHNE_SRC $FILL_SRC $PE_SRC $TIME_SRC $CONFIG_SRC $WIPETOWER_SRC $GCODEPROC_SRC"
# -DNDEBUG: turns off assert() exactly like an upstream OrcaSlicer release build (CMAKE_BUILD_TYPE=Release).
#  Without it, asserts upstream treats as "debug-only invariants" kill the worker in a shipped build — e.g. meshes with unwelded vertices and
#  sliver triangles, such as OCCT tessellations (STEP import), hit Voronoi.cpp:334 (*inside* the recovery routine),
#  VoronoiUtils.cpp:322 and FillBase.cpp:1407 (zero-length closed edge). Upstream has recovery paths for all of them, so they
#  slice fine in release. The tree support group (TS_CFLAGS) already had -DNDEBUG.
MAIN_CFLAGS="-O2 --bind -std=c++17 -DNDEBUG -DCGAL_DISABLE_ROUNDING_MATH_CHECK -DCGAL_DISABLE_GMP=1 $ARACHNE_INC"
echo "compiling main sources (st, parallel x$NCPU)"
pcompile /tmp/ws_obj/st "$MAIN_CFLAGS" $MAIN_SRC
em++ -O2 --bind -std=c++17 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s SINGLE_FILE=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MAXIMUM_MEMORY=4GB \
  -s STACK_SIZE=2MB \
  -s EXPORT_NAME=createSlicer \
  -s ENVIRONMENT=web,worker,node \
  -o ../engine/src/slicer_core.js \
  $(objs /tmp/ws_obj/st $MAIN_SRC) $TS_GROUP_OBJ $SLA_GROUP_OBJ

# webpack compatibility: webpack tries to statically resolve the dynamic import("node:module") inside the ENVIRONMENT_IS_NODE guard
# and fails (node: scheme) -> excluded with a webpackIgnore magic comment. Runtime behavior is unchanged (no effect on Vite/Node).
sed -i '' 's|await import("node:module")|await import(/* webpackIgnore: true */ "node:module")|' ../engine/src/slicer_core.js

echo "built -> ../engine/src/slicer_core.js"
ls -la ../engine/src/slicer_core.js

# ---- Multithreaded (mt) build: PASS 1 layers in parallel (__EMSCRIPTEN_PTHREADS__) ----
#  A separate artifact — the default (st) stays zero-config, while mt needs COOP/COEP (crossOriginIsolated) in the browser.
#  emscripten warns about the ALLOW_MEMORY_GROWTH + pthreads combination, but it is functionally valid (judged by measurement).
echo "compiling treesupport group (mt, parallel x$NCPU) -> /tmp/ts_group_mt.o"
pcompile /tmp/ws_obj/ts_mt "-pthread $TS_CFLAGS" $TS_UNIQUE_SRC
em++ -O2 -pthread -r $(objs /tmp/ws_obj/ts_mt $TS_UNIQUE_SRC) -o /tmp/ts_group_mt.o

echo "compiling glu-libtess (mt, parallel x$NCPU)"
LIBTESS_OBJ_MT=$(libtess_objs /tmp/ws_obj/libtess_mt "-pthread $LIBTESS_CFLAGS")
echo "compiling nlopt (mt, parallel x$NCPU)"
NLOPT_OBJ_MT=$(nlopt_objs /tmp/ws_obj/nlopt_mt "-pthread")

echo "compiling SLA support chain (mt, parallel x$NCPU) -> /tmp/sla_group_mt.o"
pcompile /tmp/ws_obj/sla_mt "-pthread $SLA_CFLAGS" $SLA_SRC
em++ -O2 -pthread -r $(objs /tmp/ws_obj/sla_mt $SLA_SRC) $LIBTESS_OBJ_MT $NLOPT_OBJ_MT -o /tmp/sla_group_mt.o

echo "compiling main sources (mt, parallel x$NCPU)"
pcompile /tmp/ws_obj/mt "-pthread $MAIN_CFLAGS" $MAIN_SRC
em++ -O2 -pthread --bind -std=c++17 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s SINGLE_FILE=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MAXIMUM_MEMORY=4GB \
  -s STACK_SIZE=2MB \
  -s DEFAULT_PTHREAD_STACK_SIZE=2MB \
  -s MALLOC=mimalloc \
  -s PTHREAD_POOL_SIZE='(typeof navigator!=="undefined"&&navigator.hardwareConcurrency)||4' \
  -s EXPORT_NAME=createSlicer \
  -s ENVIRONMENT=web,worker,node \
  -o ../engine/src/slicer_core.mt.js \
  $(objs /tmp/ws_obj/mt $MAIN_SRC) /tmp/ts_group_mt.o /tmp/sla_group_mt.o

sed -i '' 's|await import("node:module")|await import(/* webpackIgnore: true */ "node:module")|' ../engine/src/slicer_core.mt.js
# The same case applies to the pthread bootstrap in the mt glue: the dynamic import("node:worker_threads") inside the Node guard
sed -i '' 's|await import("node:worker_threads")|await import(/* webpackIgnore: true */ "node:worker_threads")|' ../engine/src/slicer_core.mt.js

echo "built -> ../engine/src/slicer_core.mt.js"
ls -la ../engine/src/slicer_core.mt.js
