// emit_layer.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  The PASS2 per-layer precompute result types stay here; the emission bodies live in emit_layer.cpp.
#pragma once
#include "clip_util.h"
#include "emit.h"
#include "gcode_writer.h"
#include "geom_helpers.h"
#include "layer_data.h"
#include "params.h"

#include <vector>

// Per-layer precomputation for PASS2 (geometry separation, infill line generation) — kept apart from emission (serial, gw/seam state).
//  It holds only deterministic per-layer independent work, so mt builds can precompute it on workers (identical results, verified with golden).
struct EmitPrecompute {
  Paths gapLines, solidLines, topLines, bridgeLines, sparseLines, supportInterfaceLines, supportBaseLines, skirtBrimLoops, ironLines;
  // Split out only when their flow ratio is not 1 (issue 63 round 1): upstream's exposed top (erTopSolidInfill) and
  //  bottom (erBottomSurface) of the current layer, and the brim rings, which otherwise ride in skirtBrimLoops with the skirt.
  Paths topExposedLines, bottomLines, brimLoops;
  bool brim=false;
  int printFeed=0, bridgeFeed=0, supportFeed=0;
  RoleFeeds feeds;   // the feed per role on this layer (emit.cpp role_feeds); every role at printFeed without per-role speeds
  // The writer's per-layer regions (GcodeWriter overhang_area / internal_area), empty when not checked.
  Paths overhangArea, internalArea;
};

void emit_layer_any(GcodeWriter& writer, std::vector<float>& toolpath, std::vector<float>& widths,
                    int layerIndex, LayerData& layerData, EmitPrecompute& precompute, const Params& params,
                    double layerZ, double defaultWidth, int layerCount, int raftLayers, int travelFeed,
                    int seamMode, bool scarfOn, bool ironOn, SeamContext& seamContext);
