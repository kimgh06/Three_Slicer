// emit.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  Declarations only; the definitions (with their comments) live in emit.cpp, which also holds the single
//  definition of the file-scope width/island state (g_segment_widths / g_current_segment_width / g_keep_island).
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
extern thread_local std::vector<float>* g_segment_widths;
extern thread_local float g_current_segment_width;
// Printing extruder of the segments being emitted right now. push_toolpath_segment folds it into the stride-8 role field
//  (value = role + tool*16) so the viewer can colour by filament — see the encoding note in emit.cpp.
//  Whoever changes the tool sets this; 0 is the untooled default, which leaves the field equal to the bare role.
extern thread_local int g_segment_tool;

em::val to_f32(const std::vector<float>& values);
// Upstream's G-code footer blocks (GCode.cpp:2646-2680 and :3987-4003), shared by both slice paths so a
// single-material and a multi-material export describe themselves the same way. Both are opt-in through Params —
// see gcode_stats_block / gcode_config_block for why. `filamentByTool` is millimetres of filament per tool and may
// be empty, in which case the whole print is charged to tool 0.
void emit_gcode_footer_blocks(GcodeWriter& writer, const Params& params, const std::vector<double>& filamentByTool, int toolChanges);
void emit_loops(GcodeWriter& writer, std::vector<float>& toolpaths, Paths loops, double z, float type, int printFeed, int travelFeed,
                int seamMode, SeamContext& seamContext, bool updateSeam=false);
void emit_lines(GcodeWriter& writer, std::vector<float>& toolpaths, const Paths& lines, double z, float type, int printFeed, int travelFeed);
// Stage 19 -> WP3: one real tree support toolpath — per-path width plus the upstream ExtrusionPath's role/height/mm3_per_mm.
struct TreePath {
  Path path;
  float width;
  int role;
  float height;
  float mm3_per_mm;
};
// The upstream path roles its flow multipliers key on (GCode.cpp:7350-7382), as the kernel's features map onto
//  them. Thin walls are OuterWall (upstream prints them as erExternalPerimeter, PerimeterGenerator.cpp:232); a raft
//  is Support. Upstream's internal bridge and overhang wall have no kernel feature, so internal_bridge_flow and
//  overhang_flow_ratio are not read.
enum class FlowRole { OuterWall, InnerWall, SparseInfill, InternalSolid, TopSurface, BottomSurface, Bridge, GapFill,
                      Support, SupportInterface, Skirt, Brim, Ironing, Other };
double role_flow_ratio(const Params& params, FlowRole role, bool firstLayer);
constexpr int FLOW_ROLE_COUNT = (int)FlowRole::Other + 1;
// The feedrate (mm/min) each role prints at on one layer: upstream GCode::_extrude's speed rule (GCode.cpp:7393-7479).
//  Without any per-role speed from the host, every role gets `legacy` and the bridge `legacyBridge` — the speeds the
//  kernel used before they were mapped, so its G-code is unchanged. `capSpeed` > 0 is the layer-time slowdown's cap
//  (pass2.cpp) applied to every role but the bridge, as the legacy feed already carries it.
struct RoleFeeds {
  int feedByRole[FLOW_ROLE_COUNT] = {};
  int of(FlowRole role) const { return feedByRole[(int)role]; }
};
RoleFeeds role_feeds(const Params& params, bool firstLayer, int printedLayer, int raftLayerCount, int legacy, int legacyBridge, double capSpeed);
// Resolves the writer's per-role acceleration and jerk tables from the profile (GcodeWriter::apply_motion).
void gcode_writer_setup_motion(GcodeWriter& writer, const Params& params, bool is_bbl);
// The mm³/mm of a thick bridge (thick_bridges): upstream's round thread of nozzle * sqrt(bridge_flow)
//  (LayerRegion::bridging_flow). bridge_line_width is not wired, so the thread starts from the nozzle as upstream's
//  default (100%) does.
double thick_bridge_mm3_per_mm(const Params& params);
void emit_lines_variable_width(GcodeWriter& writer, std::vector<float>& toolpaths, const std::vector<TreePath>& lines,
                   double z, double layerHeight, const Params& params, float type, int printFeed, int travelFeed);
void emit_arachne_walls(GcodeWriter& writer, std::vector<float>& toolpaths, const std::vector<arachne_bridge::WallLine>& walls,
                        double z, double layerHeight, const Params& params, const RoleFeeds& feeds, int travelFeed);
void emit_spiral(GcodeWriter& writer, std::vector<float>& toolpaths, const Paths& outerWall, double z0, double layerHeight, int printFeed, int travelFeed);
void emit_scarf_loop(GcodeWriter& writer, std::vector<float>& toolpaths, Path loop, double z, double layerHeight,
                     int printFeed, int travelFeed, int seamMode, SeamContext& seamContext);
