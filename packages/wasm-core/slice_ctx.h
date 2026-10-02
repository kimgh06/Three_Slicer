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
// field, in the order the values become available — nraft/zShift/ironOn are only known after the raft phase.
struct SliceCtx {
  const Params* p = nullptr;
  std::vector<Tri>* tris = nullptr;
  std::vector<LayerData>* L = nullptr;
  double* treeZMaxResid = nullptr;   // support_run writes slice()'s own diagnostics locals
  int*    treeSupLayers = nullptr;
  std::function<bool()> CX;                 // G002 cancel poll
  std::function<void(int,int)> report;      // worker progress callback
  int N = 0, total = 0, nraft = 0;
  double height = 0, w = 0, cx = 0, cy = 0;
  double sparse_spacing = 0, solid_spacing = 0, support_spacing = 0;
  double zShift = 0;
  bool ironOn = false;
  // Upstream's cooling filter runs on the layers (cooling_bridge.h): it then owns the layer-time slowdown and the
  //  fan, and the kernel's own approximations of both stand down.
  bool cooling = false;
};

// The per-layer flush callback (batch push / streamed sink) that raft emission borrows from slice().
using FlushFn = std::function<void(double, int, std::vector<float>&, std::vector<float>&)>;

// ---- Model preparation + PASS 1 -> pass1.cpp -----------------------------------
struct ModelPrep { double cx, cy, height; bool over_bed; };
ModelPrep prepare_model(std::vector<Tri>& tris, const Params& p, bool reuseGeom);
bool pass1_run(SliceCtx& C);              // false = canceled (G002)

// ---- PASS 1.5 surface detection -> surfaces.cpp --------------------------------
void surfaces_run(SliceCtx& C);

// ---- PASS 1.6 support -> support.cpp ------------------------------------------
void support_run(SliceCtx& C);

// ---- Preamble -> preamble.cpp -------------------------------------------------
struct EmitFlags { bool realPE, ironOn, scarfOn; int seamMode; };
struct CustomStart;
// `start` is the expanded custom start block (custom_gcode.h), or null for the raw path.
EmitFlags gw_setup_preamble(GW& gw, const Params& p, int treeSupLayers, double treeZMaxResid, const CustomStart* start = nullptr);
// The temperatures of the first layer (the host's _initial_layer values, else the print's own) and the switch to
//  the print's own at the second printed layer (preamble.cpp).
// The writer's machine state from the profile (flavor, E mode, firmware retraction, z_offset), and the modes block
//  the G-code switches to after the start G-code (preamble.cpp). Shared by the single- and multi-material paths.
void gw_setup_machine(GW& gw, const Params& p);
void gw_write_modes(GW& gw, const Params& p, bool is_bbl);
double first_layer_bed(const Params& p);
double first_layer_nozzle(const Params& p, int tool);
std::string second_layer_temperatures(const Params& p, const std::vector<int>& tools, bool multiple_extruders, int bed_set);
void setup_time_limits(const Params& p, gcode_time::Limits& glim, gcodeproc_bridge::Limits& gl);

// ---- Raft -> raft.cpp ---------------------------------------------------------
double raft_emit(GW& gw, const Params& p, std::vector<LayerData>& L, double w, int nraft,
                 int fTravel, int fFirst, SeamCtx& seamCtx, const FlushFn& flush_layer);

// ---- PASS 2 precomputation -> pass2.cpp ---------------------------------------
EmitPre compute_pre_layer(const SliceCtx& C, int i);

// ---- Finish: stats object -> finish.cpp ---------------------------------------
em::val build_stats(const SliceCtx& C, const GW& gw, const gcode_time::Result& te,
                    const std::string& engine_used, const gcode_time::Limits& glim,
                    bool over_bed, bool streaming, bool economy,
                    double tw0, double tw_p1, double tw_p15, double tw_sup, double t_flush);
