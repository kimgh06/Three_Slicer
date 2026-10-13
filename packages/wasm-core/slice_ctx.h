// slice_ctx.h — the shared slice() phase context and the phase-function declarations.
//  Wave 2 of the slicer_core.cpp split: slice() became an orchestrator and each phase moved into its own
//  translation unit. SliceCtx carries exactly the slice()-scope state the phases used to capture by reference,
//  so every moved body is verbatim — each phase function opens with alias declarations that rebind the same names.
#pragma once
#include "emit_layer.h"
#include "gcode_time.h"
#include "gcode_writer.h"
#include "gcodeproc_bridge.h"
#include "geom_helpers.h"
#include "layer_data.h"
#include "params.h"
#include "stl_parse.h"

#include <emscripten/val.h>
#include <functional>
#include <string>
#include <vector>

namespace em = emscripten;

// The slice()-scope state shared by the phases. Pointers (not references) so slice() can fill it field by
// field, in the order the values become available — raftLayerCount/zShift/ironOn are only known after the raft phase.
struct SliceCtx {
  const Params* params = nullptr;
  std::vector<Tri>* triangles = nullptr;
  std::vector<LayerData>* layers = nullptr;
  double* treeZMaxResid = nullptr;   // support_run writes slice()'s own diagnostics locals
  int*    treeSupLayers = nullptr;
  std::function<bool()> isCanceled;         // G002 cancel poll
  std::function<void(int,int)> report;      // worker progress callback
  int layerCount = 0, total = 0, raftLayerCount = 0;
  double height = 0, lineWidth = 0, centerX = 0, centerY = 0;
  double sparse_spacing = 0, solid_spacing = 0, support_spacing = 0;
  double zShift = 0;
  bool ironOn = false;
  // Upstream's cooling filter runs on the layers (cooling_bridge.h): it then owns the layer-time slowdown and the
  //  fan, and the kernel's own approximations of both stand down.
  bool cooling = false;
  // The per-layer regions the writer checks (EmitPre overhangArea / internalArea): the overhang fan's overlap
  //  threshold (cooling_bridge Markers, -1 = off) and whether reduce_infill_retraction applies.
  double overhangOverlap = -1.0;
  bool reduceInfillRetraction = false;
};

// The per-layer flush callback (batch push / streamed sink) that raft emission borrows from slice().
using FlushFn = std::function<void(double, int, std::vector<float>&, std::vector<float>&)>;

// ---- Model preparation + PASS 1 -> pass1.cpp -----------------------------------
struct ModelPrep { double centerX, centerY, height; bool over_bed; };
ModelPrep prepare_model(std::vector<Tri>& tris, const Params& params, bool reuseGeom);
bool pass1_run(SliceCtx& context);              // false = canceled (G002)

// ---- PASS 1.5 surface detection -> surfaces.cpp --------------------------------
void surfaces_run(SliceCtx& context);

// ---- PASS 1.6 support -> support.cpp ------------------------------------------
void support_run(SliceCtx& context);

// ---- Preamble -> preamble.cpp -------------------------------------------------
struct EmitFlags { bool realPE, ironOn, scarfOn; int seamMode; };
struct CustomStart;
// `start` is the expanded custom start block (custom_gcode.h), or null for the raw path.
EmitFlags gw_setup_preamble(GW& writer, const Params& params, int treeSupLayers, double treeZMaxResid, const CustomStart* start = nullptr);
// The temperatures of the first layer (the host's _initial_layer values, else the print's own) and the switch to
//  the print's own at the second printed layer (preamble.cpp).
// The writer's machine state from the profile (flavor, E mode, firmware retraction, z_offset), and the modes block
//  the G-code switches to after the start G-code (preamble.cpp). Shared by the single- and multi-material paths.
void gw_setup_machine(GW& writer, const Params& params);
void gw_write_modes(GW& writer, const Params& params, bool is_bbl);
double first_layer_bed(const Params& params);
double first_layer_nozzle(const Params& params, int tool);
std::string second_layer_temperatures(const Params& params, const std::vector<int>& tools, bool multiple_extruders, int bed_set);
void setup_time_limits(const Params& params, gcode_time::Limits& timeLimits, gcodeproc_bridge::Limits& processorLimits);

// ---- Raft -> raft.cpp ---------------------------------------------------------
double raft_emit(GW& writer, const Params& params, std::vector<LayerData>& layers, double lineWidth, int raftLayerCount,
                 int travelFeed, int firstLayerFeed, SeamCtx& seamCtx, const FlushFn& flush_layer);

// ---- PASS 2 precomputation -> pass2.cpp ---------------------------------------
EmitPre compute_pre_layer(const SliceCtx& context, int layerIndex);

// ---- Finish: stats object -> finish.cpp ---------------------------------------
em::val build_stats(const SliceCtx& context, const GW& writer, const gcode_time::Result& timeEstimate,
                    const std::string& engine_used, const gcode_time::Limits& timeLimits,
                    bool over_bed, bool streaming, bool economy,
                    double phaseStartMs, double pass1EndMs, double surfaceEndMs, double supportEndMs, double flushMs);
