// Stage-17 bridge: plain-type interface to the REAL organic TreeSupport pipeline (stage-16 port).
// slicer_core.cpp includes ONLY this header (no Slic3r/facade types), so the kernel's world and the
// treesupport_port world meet in exactly one translation unit (treesupport_bridge.cpp), keeping their
// (ABI-identical but separately compiled) Slic3r symbols from leaking type definitions into the kernel.
#pragma once
#include <vector>
#include <utility>
#include <string>

namespace treesupport_bridge {

// One closed ring in mm (kernel-centered coords). Winding is preserved; holes are inferred by union.
using Ring = std::vector<std::pair<double,double>>;

// One support extrusion polyline (mm) with its extrusion width (mm).
// WP3: preserves role/height/mm3_per_mm of the upstream ExtrusionPath — previously only XY+width survived, losing
//  the base/interface distinction and the basis for the upstream E calculation. role is the raw ExtrusionRole integer
//  (erSupportMaterial=14, erSupportMaterialInterface=15, erIroning=8, …).
struct Line {
    std::vector<std::pair<double,double>> points;
    double width       = 0.0;
    int    role        = 14;   // erSupportMaterial
    double height      = 0.0;  // layer height (mm, ExtrusionPath::height)
    double mm3_per_mm  = 0.0;  // upstream volumetric flow — usable instead of recomputing E in the kernel
};

// Support toolpaths at one support layer (its print_z in mm + the polylines).
struct LayerOut { double print_z_mm; std::vector<Line> lines; };

struct Params {
    double layer_height_mm      = 0.2;
    double first_layer_height_mm = 0.0;    // WP1: first layer height (mm). 0 => layer_height. Matches the upstream initial_layer_print_height
    double nozzle_mm            = 0.4;
    double line_width_mm        = 0.0;     // WP1: the object's line_width. Used by TreeSupport3D's lslices_extrudable filter and the auto-threshold flow fallback
    double support_threshold_angle = 30.0; // deg (0 => auto)
    double support_top_z_distance  = 0.2;  // mm  (WP1: -> SlicingParameters::gap_support_object, upstream formula)
    double support_bottom_z_distance = 0.2;// mm  (WP1: → gap_object_support)
    double support_xy_distance     = 0.35; // mm  (WP1: → support_object_xy_distance config)
    double first_layer_gap_mm      = 0.2;  // WP1: support_object_first_layer_gap (upstream default 0.2)
    int    interface_top_layers    = 2;
    int    interface_bottom_layers = 0;    // WP1: -1 => same as top (upstream convention), default 0
    bool   independent_support_layer_height = false; // WP1: false by default because of the kernel z grid constraint (the gap is quantized to layer multiples — same formula as upstream)
    bool   support_auto            = true; // true=auto overhang detect (stTreeAuto); false=manual (only painted enforcers)
    double support_line_width_mm   = 0.0;  // 0 => auto (line_width); >0 => explicit support extrusion width
    double support_angle_deg       = 0.0;  // WP1: base angle for support infill (SupportParameters::base_angle)
    bool   on_build_plate_only     = false;// WP1: support_on_build_plate_only
    // WP1: tree shape keys (defaults identical to the upstream config defaults — unset keys keep the previous/upstream behavior)
    std::string tree_style         = "organic"; // organic|slim|strong|hybrid → smsTree*
    double branch_angle_deg        = 40.0; // tree_support_branch_angle_organic
    double angle_slow_deg          = 25.0; // tree_support_angle_slow
    double branch_diameter_mm      = 2.0;  // tree_support_branch_diameter_organic
    double branch_distance_mm      = 1.0;  // tree_support_branch_distance_organic
    double branch_diameter_angle_deg = 5.0;// tree_support_branch_diameter_angle
    double tip_diameter_mm         = 0.8;  // tree_support_tip_diameter
    double top_rate_percent        = 30.0; // tree_support_top_rate (%)
    int    wall_count              = 0;    // tree_support_wall_count (organic applies max(1,·) internally)
    std::string interface_pattern  = "auto";    // auto|rectilinear|concentric|rectilinear_interlaced|grid
    std::string base_pattern       = "default"; // default|rectilinear|rectilinear-grid|honeycomb|lightning|none
    double interface_spacing_mm    = 0.5;  // support_interface_spacing
    double base_pattern_spacing_mm = 2.5;  // support_base_pattern_spacing
    double bed_width_mm            = 200.0;
    double bed_depth_mm            = 200.0;
    // How far the caller shifted the model to bring it near the origin (support.cpp's tcx/tcy). The bed has to make
    //  the SAME move, or the border the branches are clipped against follows the model instead of staying put.
    //  Upstream does exactly this: m_machine_border.translate(plate_offset - instance.shift) (TreeSupport.cpp:657).
    double model_shift_x_mm        = 0.0;
    double model_shift_y_mm        = 0.0;
    double printable_height_mm     = 250.0; // WP1: -> PrintConfig::printable_height (BuildVolume height)
    // WP2: keys used only by the normal (grid/snug) support port — defaults identical to the upstream config defaults
    std::string normal_style       = "grid";  // grid|snug → smsGrid|smsSnug
    double support_expansion_mm    = 0.0;     // support_expansion (detect_overhangs xy_expansion)
    bool   bridge_no_support       = false;   // bridge_no_support (effectively a no-op while perimeters are not supplied — documented)
    bool   remove_small_overhang   = true;    // support_remove_small_overhang
    double threshold_overlap_percent = 50.0;  // support_threshold_overlap (%, the overlap criterion when θ=0)
    // Stage 33: print_config "resolution" (path simplification tolerance, mm). Upstream TreeSupportCommon.hpp:56 takes
    //  TreeSupportSettings::resolution from here and uses it in TreeSupport3D's polygons_simplify.
    //  If the bridge does not pass it, the PrintConfig default (0.01) applies — a chord length of ≈0.4mm on curved branches.
    //  Raising it means fewer segments and smaller G-code (traded against detail).
    double resolution_mm           = 0.01;
};

// object_slices_mm[layer] = the object's slice rings at that layer (mm). layer_print_z_mm[layer] = its print_z.
// Runs TreeSupport::generate() (smsTreeOrganic / stTreeAuto) on a facade PrintObject built from these slices
// and returns the generated support extrusion toolpaths per support layer. Empty vector => no support.
//
// The treesupport group is compiled fully self-contained with -fvisibility=hidden and then run through
// llvm-objcopy --localize-hidden, so every internal Slic3r symbol becomes local and cannot collide with
// (or borrow the trimmed behavior of) the main build's stubbed copies. This ONE entry point must stay
// exported (default visibility) so slicer_core.cpp can call across the boundary.
__attribute__((visibility("default")))
std::vector<LayerOut> generate(const std::vector<std::vector<Ring>>& object_slices_mm,
                               const std::vector<double>&            layer_print_z_mm,
                               const Params&                         params);

// WP2: per-layer surface data (mm) — supplies stTop/stBottom surfaces to the normal support port.
//  top = faces exposed upward (upstream stTop, the kernel's topSurface), bottom = faces exposed downward (stBottom, the kernel's bottomSurface).
struct LayerSurfaces { std::vector<Ring> top, bottom; };

// WP2: the upstream normal (grid/snug) support — PrintObjectSupportMaterial::generate() (a port of the upstream
//  SupportMaterial.cpp; the stage-11 pipeline: top/bottom contact -> intermediate layers -> SupportGridPattern (AGG) -> interfaces -> toolpaths).
//  layer_surfaces has the same length as the slices (when empty it runs without stTop/stBottom — no bottom contact is generated).
//  The output is the same LayerOut as generate() (toolpaths preserving role/height/mm3).
__attribute__((visibility("default")))
std::vector<LayerOut> generate_normal(const std::vector<std::vector<Ring>>& object_slices_mm,
                                      const std::vector<double>&            layer_print_z_mm,
                                      const std::vector<LayerSurfaces>&     layer_surfaces,
                                      const Params&                         params);

// wasm heap address of the real support progress counter (a tbb stub atomic) — under mt the UI thread polls it directly via SAB.
//  Reset to 0 when generate_normal is entered, incremented per parallel_for index / completed task_group run (≈ one layer of work).
__attribute__((visibility("default")))
unsigned long progress_addr();

// Address of the cancel flag (u32) — reset to 0 when slice() is entered; when the UI writes 1 via SAB, the kernel and ports abort early.
__attribute__((visibility("default")))
unsigned long cancel_addr();

} // namespace treesupport_bridge
