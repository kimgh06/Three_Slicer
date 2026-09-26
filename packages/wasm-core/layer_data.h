// layer_data.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  Also declares slice_multimaterial(), whose definition (with its comments) lives in slice_mm.cpp.
#pragma once
#include "arachne_bridge.h"
#include "clip_util.h"
#include "emit.h"
#include "params.h"
#include "stl_parse.h"

#include <emscripten/val.h>
#include <vector>

// One extrusion of the classic wall generator (classic_bridge.cpp): a perimeter loop, or an open thin-wall path.
struct ClassicWall { Path pl; bool loop; int inset; float w; };

// Layer data (2-pass)
struct LayerData {
  double z=0; int idx=0; double h=0;
  Paths contour;                 // outer contour (holes included)
  std::vector<Paths> walls;      // wall loops (outermost to innermost)
  Paths fill;                    // infill region (innermost wall -w/2)
  Paths topSurf, botSurf;        // exposed surfaces (difference with the neighbors)
  Paths supBase, supIface;       // support body (sparse) / interface (solid)
  // Stages 18/19 -> WP3: real tree support toolpaths (TreePath: width + the upstream role/height/mm3_per_mm)
  std::vector<TreePath> supTree;
  // Classic wall generator (the port of upstream process_classic): loops and thin walls in upstream's print order, and
  //  the variable-width gap fill. `walls` above holds the same loops grouped by depth, for spiral mode and the layer length.
  std::vector<ClassicWall> classicWalls;
  std::vector<TreePath> classicGapFill;
  Paths island;                  // region travels stay inside (contour −w/2) — precomputed in PASS1 (parallel), moved at emission
  std::vector<arachne_bridge::WLine> arachneWalls;  // stage 7: the real Arachne variable-width walls (arachne mode)
};

em::val slice_multimaterial(std::vector<Tri>& tris, const Params& p, em::val onProgress,
                            double height, bool over_bed);
