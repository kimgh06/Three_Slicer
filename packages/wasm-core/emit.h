// emit.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  Declarations only; the definitions (with their comments) live in emit.cpp, which also holds the single
//  definition of the file-scope width/island state (g_seg_w / g_seg_w_cur / g_keep_island).
#pragma once
#include "arachne_bridge.h"
#include "clip_util.h"
#include "gcode_writer.h"
#include "geom_helpers.h"
#include "params.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <vector>

namespace em = emscripten;

// Per-segment width tracking / island-keeping state — defined once in emit.cpp.
extern bool g_keep_island;
extern thread_local std::vector<float>* g_seg_w;
extern thread_local float g_seg_w_cur;
// Printing extruder of the segments being emitted right now. push_seg folds it into the stride-8 role field
//  (value = role + tool*16) so the viewer can colour by filament — see the encoding note in emit.cpp.
//  Whoever changes the tool sets this; 0 is the untooled default, which leaves the field equal to the bare role.
extern thread_local int g_seg_tool;

em::val to_f32(const std::vector<float>& v);
// Upstream's G-code footer blocks (GCode.cpp:2646-2680 and :3987-4003), shared by both slice paths so a
// single-material and a multi-material export describe themselves the same way. Both are opt-in through Params —
// see gcode_stats_block / gcode_config_block for why. `filamentByTool` is millimetres of filament per tool and may
// be empty, in which case the whole print is charged to tool 0.
void emit_gcode_footer_blocks(GW& gw, const Params& p, const std::vector<double>& filamentByTool, int toolChanges);
void emit_loops(GW& gw, std::vector<float>& tp, Paths loops, double z, float type, int fPrint, int fTravel,
                int seamMode, SeamCtx& sc, bool updateSeam=false);
void emit_lines(GW& gw, std::vector<float>& tp, const Paths& lines, double z, float type, int fPrint, int fTravel);
// Stage 19 -> WP3: one real tree support toolpath — per-path width plus the upstream ExtrusionPath's role/height/mm3_per_mm.
struct TreePath { Path pl; float w; int role; float h; float mm3; };
// The upstream path roles its flow multipliers key on (GCode.cpp:7350-7382), as the kernel's features map onto
//  them. Thin walls are OuterWall (upstream prints them as erExternalPerimeter, PerimeterGenerator.cpp:232); a raft
//  is Support. Upstream's internal bridge and overhang wall have no kernel feature, so internal_bridge_flow and
//  overhang_flow_ratio are not read.
enum class FlowRole { OuterWall, InnerWall, SparseInfill, InternalSolid, TopSurface, BottomSurface, Bridge, GapFill,
                      Support, SupportInterface, Skirt, Brim, Other };
double role_flow_ratio(const Params& p, FlowRole role, bool firstLayer);
// The mm³/mm of a thick bridge (thick_bridges): upstream's round thread of nozzle * sqrt(bridge_flow)
//  (LayerRegion::bridging_flow). bridge_line_width is not wired, so the thread starts from the nozzle as upstream's
//  default (100%) does.
double thick_bridge_mm3_per_mm(const Params& p);
void emit_lines_vw(GW& gw, std::vector<float>& tp, const std::vector<TreePath>& lines,
                   double z, double h, const Params& p, float type, int fPrint, int fTravel);
void emit_arachne_walls(GW& gw, std::vector<float>& tp, const std::vector<arachne_bridge::WLine>& walls,
                        double z, double h, const Params& p, int fPrint, int fTravel);
void emit_spiral(GW& gw, std::vector<float>& tp, const Paths& outerWall, double z0, double h, int fPrint, int fTravel);
void emit_scarf_loop(GW& gw, std::vector<float>& tp, Path wp, double z, double h,
                     int fPrint, int fTravel, int seamMode, SeamCtx& sc);
