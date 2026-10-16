// Plain-data boundary between the kernel and the ported PrusaSlicer SLA support chain.
// Kernel-facing translation units include this file only; Prusa types stay in slasupport_bridge.cpp.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace slasupport_bridge {

struct Vec2 {
  double x = 0.0;
  double y = 0.0;
};

struct Vec3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

using Polygon = std::vector<Vec2>;

// Column-major affine matrix, matching the transforms used by the JS request boundary.
struct Transform {
  std::array<double, 16> matrix{{
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
  }};
};

struct PreparedObject {
  std::string id;
  std::vector<float> mesh; // local-space triangle soup, 9 floats per triangle
  Transform transform;
};

enum class ModifierKind : std::uint8_t { blocker = 0, enforcer = 1 };

struct ModifierMask {
  ModifierKind kind = ModifierKind::blocker;
  std::vector<Polygon> polygons;
};

struct PreparedLayer {
  std::string object_id;
  std::size_t index = 0;
  double slice_z = 0.0; // model-space slicing plane [mm]
  double print_z = 0.0; // top of the printed layer [mm]
  double height = 0.0;
  std::vector<Polygon> contours;
  std::vector<ModifierMask> modifier_masks;
};

// Plate-level SLA layers retain one contribution per object, including an empty contribution. Prusa's
// initialize_printer_input() inserts SliceRecords in object order into a print-Z ordered layer; dropping an
// empty record here would lose ownership needed by later support/pad assembly.
enum LayerRoleMask : std::uint8_t {
  layer_role_none    = 0,
  layer_role_model   = 1 << 0,
  layer_role_support = 1 << 1,
  layer_role_pad     = 1 << 2,
};

struct ObjectLayerInput {
  std::string object_id;
  std::size_t index = 0;
  double print_z = 0.0;
  double height = 0.0;
  std::vector<Polygon> model;
  std::vector<Polygon> support;
  std::vector<Polygon> pad;
};

struct LayerContribution {
  std::string object_id;
  std::size_t object_order = 0;
  std::size_t layer_index = 0;
  std::uint8_t role_mask = layer_role_none;
  std::vector<Polygon> model;
  std::vector<Polygon> support;
  std::vector<Polygon> pad;
};

struct AssembledLayer {
  double print_z = 0.0;
  double height = 0.0;
  std::vector<LayerContribution> contributions;
};

struct LayerAssemblyResult {
  std::vector<AssembledLayer> layers;
  std::string error;
  bool ok = false;
};

// Inputs are grouped by object in caller order. Output is ordered by print Z; contributions sharing an exact
// print Z retain object order. Empty object layers remain explicit contributions with layer_role_none.
LayerAssemblyResult assemble_object_layers(
  const std::vector<std::string>& object_order,
  const std::vector<ObjectLayerInput>& layers);

enum class CorrectionCapabilityStatus : std::uint8_t {
  supported = 0,
  dependency_unavailable = 1,
};

struct CorrectionCapability {
  CorrectionCapabilityStatus status = CorrectionCapabilityStatus::dependency_unavailable;
  const char* code = "SLA_PRINTER_Z_CORRECTION_DEPENDENCY_UNAVAILABLE";
  const char* missing_dependencies =
    "SLA/PrinterCorrections.cpp;SLA/ZCorrection.cpp;SLAPrint.hpp::SliceRecord;"
    "ElephantFootCompensation.hpp";
};

struct CorrectionRequest {
  double absolute_xy = 0.0;
  double elephant_foot = 0.0;
  double elephant_foot_min_width = 0.0;
  std::size_t faded_layers = 0;
  std::size_t z_correction_layers = 0;
};

struct CorrectionResult {
  CorrectionCapability capability;
  std::vector<ObjectLayerInput> layers;
  std::string error;
  bool ok = false;
};

CorrectionCapability correction_capability();

// A zero request is an omission-preserving no-op. Until the Prusa polygon/correction dependency group is
// linked, any non-zero request fails with the typed capability code and leaves every input layer unchanged.
CorrectionResult apply_model_corrections(
  const std::vector<ObjectLayerInput>& layers,
  const CorrectionRequest& request);

enum class PadCapabilityStatus : std::uint8_t {
  supported = 0,
  dependency_unavailable = 1,
};

struct PadCapability {
  PadCapabilityStatus status = PadCapabilityStatus::supported;
  const char* code = "SLA_PAD_SUPPORTED";
  const char* backend = "prusa_port";
  const char* missing_dependencies = "";
};

// The upstream pad group (Pad.cpp + ConcaveHull + Tesselate/glu-libtess) is linked; generate_pad below is
// the ported driver, embed (pad_around_object) included.
PadCapability pad_capability();

struct PadParams {
  double wall_thickness     = 2.0;  // pad_wall_thickness
  double wall_height        = 0.0;  // pad_wall_height (wing/cavity depth)
  double max_merge_distance = 50.0; // pad_max_merge_distance
  double wall_slope_deg     = 90.0; // pad_wall_slope [deg]
  double brim_size          = 1.6;  // pad_brim_size
  // pad_around_object (embed / zero elevation): the pad is built AROUND the object's bottom band with a
  // gap ring (upstream PadConfig::EmbedObject), the object itself stays unelevated, and the model
  // contours always join the blueprint. The caller must force elevation to 0 (upstream is_zero_elevation).
  bool   around_object      = false;
  bool   around_object_everywhere = false; // pad_around_object_everywhere
  double object_gap         = 1.0;  // pad_object_gap
  double stick_width        = 0.5;  // pad_object_connector_width
  double stick_stride       = 10.0; // pad_object_connector_stride
  double stick_penetration  = 0.3;  // pad_object_connector_penetration
};

struct PadResult {
  PadCapability capability;
  std::vector<float> mesh;   // triangle soup; z in [0, full_height] — the pad stands on the plate
  double full_height = 0.0;  // wall_thickness + wall_height
  std::string error;
  bool ok = false;
};

// Port of upstream SupportTree.cpp:71 create_pad: blueprint the support mesh (and the model when supports
// are off) over the foot band above the plate, then Pad.cpp create_pad. Inputs are in the print frame the
// TREE result uses (plate at z=0, support feet standing on it; the caller lifts the rest of the scene by
// full_height afterwards — upstream rebases the same way at slicing time).
PadResult generate_pad(const std::vector<float>& model_mesh,
                       const std::vector<float>& support_mesh,
                       bool supports_enabled,
                       const PadParams& params);

enum class PointType : std::uint8_t { manual_add = 0, island = 1, slope = 2 };

struct SupportPoint {
  std::uint64_t source_id = 0; // opaque caller id; output order follows input order
  std::string object_id;
  Vec3 position;               // object-local surface position [mm]
  PointType type = PointType::manual_add;
  double head_front_radius = 0.0;
  double elevation = 0.0;
  bool permanent = false;
  bool manual = false;
};

enum class ProgressPhase : std::uint8_t { validation = 0, prepare = 1, support_tree = 2, complete = 3 };

struct Progress {
  ProgressPhase phase = ProgressPhase::validation;
  std::size_t completed = 0;
  std::size_t total = 0;
};

struct Callbacks {
  std::function<bool()> is_canceled;
  std::function<void(const Progress&)> on_progress;
};

struct PreparedJob {
  std::vector<PreparedObject> objects;
  std::vector<PreparedLayer> layers;
  std::vector<SupportPoint> points;
  Callbacks callbacks;
  bool support_enforcers_only = false;
};

// ---- Automatic support-point generation (the ported Prusa SupportPointGenerator + SupportIslands) ----------
// Mirrors upstream SLAPrintSteps::support_points(): prepare_generator_data over the prepared layer contours,
// generate_support_points, move_on_mesh_surface against the object mesh, then the permanent/manual points are
// appended AFTER the move (upstream keeps their authored 3d position). Modifier masks are NOT applied here —
// generate() filters the final point set exactly as before (task-6 semantics).
struct PointGenerationConfig {
  double density_relative = 1.0;      // support_points_density_relative / 100
  double head_diameter = 0.4;         // [mm] support_head_front_diameter
  double slice_closing_radius = 0.049; // [mm] the generator's input slices are gap-closed like upstream
};

struct GeneratedPoints {
  const char* generator = "prusa_port";
  std::vector<SupportPoint> points; // object-local positions, output order = generation order per object
  std::string error;
  bool ok = false;
  // Phase timings accumulated over all objects (ms) — diagnostics only, summed into the kernel's stats.
  double t_weld_ms = 0;      // soup transform + its_merge_vertices + AABBMesh build
  double t_slice_ms = 0;     // slice_mesh_ex (the generator's input slices)
  double t_prepare_ms = 0;   // prepare_generator_data (the five per-layer clipper passes)
  double t_generate_ms = 0;  // generate_support_points proper (island sampling)
  double t_move_ms = 0;      // move_on_mesh_surface
};

GeneratedPoints generate_support_points(const PreparedJob& job, const PointGenerationConfig& point_config);

enum class SupportStrategy : std::uint8_t { default_tree = 0, branching = 1, organic = 2 };

enum class StrategyCapabilityStatus : std::uint8_t {
  supported = 0,
  dependency_unavailable = 1,
  unsupported_upstream = 2,
};

struct StrategyCapability {
  SupportStrategy strategy = SupportStrategy::default_tree;
  StrategyCapabilityStatus status = StrategyCapabilityStatus::supported;
  const char* code = "SLA_SUPPORT_STRATEGY_SUPPORTED";
};

StrategyCapability strategy_capability(SupportStrategy strategy);

struct ValidationResult {
  bool ok = false;
  std::string error;
  std::size_t object_count = 0;
  std::size_t layer_count = 0;
  std::size_t point_count = 0;
  std::size_t blocker_mask_count = 0;
  std::size_t enforcer_mask_count = 0;
  std::vector<std::uint64_t> point_order;
};

// Validation is deliberately dependency-free so callers can reject malformed jobs before entering Prusa code.
ValidationResult validate(const PreparedJob& job);

std::vector<SupportPoint> filter_support_points_by_modifiers(
  const std::vector<SupportPoint>& points,
  const std::vector<PreparedLayer>& layers,
  bool enforcers_only);

struct Config {
  SupportStrategy strategy      = SupportStrategy::default_tree;
  double head_front_radius   = 0.2;
  double head_back_radius    = 0.5;
  double head_width          = 1.0;
  double head_penetration    = 0.2;
  double base_radius         = 2.0;
  double base_height         = 1.0;
  double max_bridge_length   = 15.0;
  double max_pillar_link_distance = 10.0;
  double object_elevation    = 0.0;
  int    pillar_connection_mode = 2;
  int    mesh_steps          = 16;
  bool   buildplate_only     = false;
  // The rest of upstream make_support_cfg (SLAPrint.cpp:50). Defaults are the PROFILE defaults, not the
  // SupportTreeConfig struct's (they disagree: widening 0.0 vs 0.5, base safety 1.0 vs 0.5).
  double bridge_slope           = 0.7853981633974483; // [rad] support_critical_angle
  double head_fallback_radius   = 0.25;               // small_pillar_percent x pillar radius
  double pillar_widening_factor = 0.0;
  double pillar_base_safety_distance = 1.0;           // 0 = use the kernel's own safety distance
  double max_weight_on_model    = 10.0;
  int    max_bridges_on_pillar  = 3;
};

struct Result {
  StrategyCapability capability;
  std::vector<float> mesh;
  std::vector<std::uint64_t> point_order;
  std::size_t pillars = 0;
  std::string error;
  std::size_t heads = 0;
  bool ok = false;
};

Result generate(const PreparedJob& job, const Config& bridge_config);

enum class SupportSlicerCapabilityStatus : std::uint8_t {
  supported = 0,
  dependency_unavailable = 1,
};

struct SupportSlicerCapability {
  SupportSlicerCapabilityStatus status = SupportSlicerCapabilityStatus::dependency_unavailable;
  const char* code = "SLA_SUPPORT_ANALYTICAL_CACHE_DEPENDENCY_UNAVAILABLE";
  const char* backend = "generic_mesh_sweep_fallback";
  const char* missing_dependencies =
    "SLAPrint.hpp::SliceRecord;PrinterCorrections.hpp::apply_printer_corrections;"
    "PrinterCorrections.hpp::apply_absolute_correction";
};

struct SupportSliceCacheStats {
  std::size_t hits = 0;
  std::size_t misses = 0;
};

struct SupportSliceBatch {
  SupportSlicerCapability capability;
  std::vector<std::vector<Polygon>> slices;
  SupportSliceCacheStats cache;
  std::string error;
  bool ok = false;
};

SupportSlicerCapability support_slicer_capability();

SupportSliceBatch slice_support_mesh_fallback(
  const std::vector<float>& triangle_soup,
  const std::vector<double>& heights);

} // namespace slasupport_bridge
