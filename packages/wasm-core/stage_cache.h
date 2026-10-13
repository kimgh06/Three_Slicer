// stage_cache.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#pragma once
#include "layer_data.h"
#include "params.h"
#include "stl_parse.h"

#include <string>
#include <vector>

// G003 incremental re-slice: a stage cache between slices. Filled via keep_stages and reused via reuse_stages.
//  Validity is decided first by the viewer (geometry digest + invalidation-map); the kernel adds layerKey (layering/support
//  parameter snapshot) as a second line of defense, refusing reuse on a mismatch. Keeping the cache resident is a memory trade-off (tens of MB after the simplification).
struct StageCache {
  bool valid = false;
  std::vector<Tri> tris;
  double height = 0, cx = 0, cy = 0;
  bool over_bed = false;
  int N = 0;
  std::string layerKey;
  int treeSupLayers = 0;
  double treeZMaxResid = -1.0;   // for reproducing the preamble diagnostic lines
  std::vector<LayerData> L;
};
extern StageCache g_scache;
std::string make_layer_key(const Params& params);
