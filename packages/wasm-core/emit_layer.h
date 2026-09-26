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
struct EmitPre {
  Paths gapLines, solidLines, topLines, bridgeLines, sparseLines, supI, supB, flExtra, ironLines;
  bool brim=false; int fPrint=0, fBridge=0, fSup=0;
};

void emit_layer_any(GW& gw, std::vector<float>& tp, std::vector<float>& widths,
                    int i, LayerData& ld, EmitPre& pre, const Params& p,
                    double zE, double w, int N, int nraft, int fTravel,
                    int seamMode, bool scarfOn, bool ironOn, SeamCtx& seamCtx);
