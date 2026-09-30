// FACADE (stage 15 TreeSupport port): the real Print.hpp (1376L) pulls PrintBase/Model/SLA
// (SupportPoint.hpp) — the whole pipeline. TreeSupport only needs a PrintObject/Print/ModelObject
// facade over a Layer/SupportLayer graph the kernel adapter fills. This provides exactly the measured
// surface (get_layer/layers/support_layers/config/print/slicing_parameters/bounding_box/... + the 3
// mesh ops as EMPTY stubs — the kernel has no 3D model mesh / support painting, so enforcers/blockers/
// custom-facets are legitimately empty, documented). Real heavy header kept as Print_real.hpp.bak.
#ifndef slic3r_Print_facade_hpp_
#define slic3r_Print_facade_hpp_
#include <tbb/stub_parallel.h>   // G002: the cancel flag (wiring canceled())

#include "libslic3r.h"
#include "Point.hpp"
#include "BoundingBox.hpp"
#include "Layer.hpp"          // Layer, SupportLayer, LayerPtrs
#include "PrintConfig.hpp"    // PrintConfig, PrintObjectConfig (real)
#include "Slicing.hpp"        // SlicingParameters
#include "BuildVolume.hpp"
#include "Flow.hpp"
#include "Geometry.hpp"       // Geometry::deg2rad (used by SupportParameters via this header)
#include "TriangleMesh.hpp"
#include "custom_facet_project.hpp"  // (stage 20) project painted enforcer/blocker facets to per-layer footprint
#include "enum_bitmask.hpp"
#include <boost/date_time/posix_time/posix_time.hpp>   // TreeSupport.cpp profiler (stubbed in port)
#include <vector>
#include <string>
#include <memory>
#include <cmath>
#include <functional>

namespace Slic3r {

class Print;
class PrintObject;
class ModelInstance;
class Fill;         // SupportCommon.hpp uses Fill* (pointer) only
class TreeSupport;  // TreeSupport3D.hpp generate_tree_support_3D(...) takes TreeSupport* (pointer)
class TreeSupportData;  // PrintObject preview-cache (shared_ptr, kept empty in the adapter)
using SupportLayerPtrs = std::vector<SupportLayer*>;
using PrintObjectPtrs  = std::vector<PrintObject*>;

// EnforcerBlockerType (verbatim from TriangleSelector.hpp) — project_and_append_custom_facets arg.
enum class EnforcerBlockerType : int8_t {
    NONE = 0, ENFORCER = 1, BLOCKER = 2, FUZZY_SKIN = ENFORCER,
    Extruder1 = ENFORCER, Extruder2 = BLOCKER, Extruder3, Extruder4, Extruder5, Extruder6, Extruder7,
    Extruder8, Extruder9, Extruder10, Extruder11, Extruder12, Extruder13, Extruder14, Extruder15,
    Extruder16, ExtruderMax = Extruder16
};
enum class ModelVolumeType : int { INVALID = -1, MODEL_PART, NEGATIVE_VOLUME, PARAMETER_MODIFIER, SUPPORT_BLOCKER, SUPPORT_ENFORCER };

// Minimal ModelObject facade — TreeSupport uses name (logging) + raw_mesh/is_*_painted (dead OpenVDB
// branch guarded out by TREE_SUPPORT_ORGANIC_NUDGE_NEW; painting unsupported in the kernel).
class ModelObject {
public:
    std::string name;
    Points      brim_points;
    const TriangleMesh& raw_mesh() const { return m_raw_mesh; }
    bool is_mm_painted()        const { return false; }
    bool is_fuzzy_skin_painted() const { return false; }
private:
    TriangleMesh m_raw_mesh;
};

struct PrintInstance { PrintObject *print_object = nullptr; const ModelInstance *model_instance = nullptr; Point shift; };
using PrintInstances = std::vector<PrintInstance>;

// Minimal PrintRegion facade. TreeSupport reads per-region flows to size support (num_printing_regions/
// printing_region/flow/config). The kernel is single-region; flow() derives from region line-width
// config (documented approximation of the real per-region extrusion-width computation).
class PrintRegion {
public:
    const PrintRegionConfig& config() const { return m_config; }
    // flow() body verbatim from PrintRegion.cpp:25 (defined out-of-line below, after PrintObject).
    Flow flow(const PrintObject& object, FlowRole role, double layer_height, bool first_layer = false) const;
    int  extruder(FlowRole /*role*/) const { return 1; }  // single-extruder kernel
    // bridging_height_avg verbatim from PrintRegion.cpp:66 (nozzle_dmr_avg -> nozzle_diameter[0]).
    coordf_t bridging_height_avg(const PrintConfig& print_config) const {
        double nd = print_config.nozzle_diameter.values.empty() ? 0.4 : print_config.nozzle_diameter.get_at(0);
        return nd * std::sqrt(m_config.bridge_flow.value);
    }
    PrintRegionConfig m_config;
};

// Minimal PrintObjectRegions facade. The real struct groups per-layer-range regions; the kernel is
// single-region, so all_regions is just the object's region list. FillLightning::Generator reads
// all_regions.front()->config() for infill sizing. front()->config() works with raw PrintRegion*.
struct PrintObjectRegions { std::vector<PrintRegion*> all_regions; };

// Minimal Print facade.
class Print {
public:
    const PrintConfig& config() const { return m_config; }
    bool  canceled() const { return tbb_stub::cancel().load(std::memory_order_relaxed) != 0; }   // G002: wired to the SAB cancel flag
    void  set_status(int /*percent*/, const std::string& /*msg*/, unsigned /*flags*/ = 0) const {}
    const Vec3d get_plate_origin() const { return m_origin; }
    Flow  brim_flow() const { return Flow(0.45f, 0.2f, 0.4f); }   // used only for brim width; kernel does brim separately
    const PrintObjectPtrs& objects() const { return m_objects; }
    PrintObject*       get_object(size_t idx)       { return m_objects[idx]; }
    const PrintObject* get_object(size_t idx) const { return m_objects[idx]; }
    bool  has_brim() const { return false; }
    bool  has_infinite_skirt() const { return false; }
    size_t get_extruder_id(unsigned int /*filament_id*/) const { return 0; }  // single-extruder kernel
    PrintConfig      m_config;
    Vec3d            m_origin { Vec3d::Zero() };
    PrintObjectPtrs  m_objects;
};

// PrintObject facade over a kernel-filled Layer/SupportLayer graph.
class PrintObject {
public:
    // ---- layers ----
    size_t         layer_count() const { return m_layers.size(); }
    size_t         support_layer_count() const { return m_support_layers.size(); }
    // WP2: upstream Print.hpp:387 verbatim — SupportMaterial.cpp uses it to size arrays
    size_t         total_layer_count() const { return this->layer_count() + this->support_layer_count(); }
    const Layer*   get_layer(int idx) const { return m_layers[idx]; }
    Layer*         get_layer(int idx)       { return m_layers[idx]; }
    SupportLayer*  get_support_layer(int idx) { return idx < (int)m_support_layers.size() ? m_support_layers[idx] : nullptr; }
    LayerPtrs&        layers()         { return m_layers; }
    const LayerPtrs&  layers() const   { return m_layers; }
    SupportLayerPtrs& support_layers() { return m_support_layers; }
    const SupportLayerPtrs& support_layers() const { return m_support_layers; }
    void clear_support_layers() { for (SupportLayer* l : m_support_layers) delete l; m_support_layers.clear(); }
    SupportLayer* add_tree_support_layer(int id, coordf_t height, coordf_t print_z, coordf_t slice_z) {
        m_support_layers.emplace_back(new SupportLayer(size_t(id), size_t(-1), this, height, print_z, slice_z));
        return m_support_layers.back();
    }
    SupportLayer* add_support_layer(int id, int interface_id, coordf_t height, coordf_t print_z) {
        m_support_layers.emplace_back(new SupportLayer(size_t(id), size_t(interface_id), this, height, print_z, /*slice_z*/print_z));
        return m_support_layers.back();
    }
    // has_brim: kernel does brim separately and tree support does not need it here -> false (documented).
    bool has_brim() const { return false; }
    // The tree-support data cache (upstream PrintObject.cpp:1133). It is not only a GUI preview: the non-organic TreeSupport
    //  (slim / strong / hybrid) builds its layer outlines and collision cache in it (TreeSupport.cpp:1742) and reads them in
    //  generate_contact_points (m_ts_data->m_layer_outlines). Returning an empty pointer here made every non-organic tree
    //  slice dereference null: a std::length_error on st, "memory access out of bounds" on mt, on any model.
    std::shared_ptr<TreeSupportData> alloc_tree_support_preview_cache();   // defined in Support/TreeSupport.cpp
    void clear_tree_support_preview_cache() { m_tree_support_preview_cache.reset(); }
    // adapter helpers (PrintObject is a friend of Layer/SupportLayer -> can build & read them).
    Layer* add_layer(int id, coordf_t height, coordf_t print_z, coordf_t slice_z) {
        m_layers.push_back(new Layer(size_t(id), this, height, print_z, slice_z));
        return m_layers.back();
    }
    // Organic tree support exports EXTRUSION TOOLPATHS into SupportLayer::support_fills (via
    // generate_support_toolpaths) — not the classic BBS base/roof/floor_areas. Count layers that carry
    // support toolpaths, plus the total extrusion-entity count (the type-5 support toolpaths).
    int    count_support_layers_with_area() const {
        int n = 0; for (const SupportLayer* sl : m_support_layers)
            if (!sl->support_fills.entities.empty() ||
                !sl->base_areas.empty() || !sl->roof_areas.empty() || !sl->floor_areas.empty()) ++n;
        return n;
    }
    size_t total_support_toolpaths() const {
        size_t c = 0; for (const SupportLayer* sl : m_support_layers) c += sl->support_fills.entities.size();
        return c;
    }

    // ---- config / print / params ----
    const PrintObjectConfig& config() const { return m_config; }
    Print*                   print()  { return m_print; }
    const Print*             print() const { return m_print; }
    const SlicingParameters& slicing_parameters() const { return m_slicing_params; }
    ModelObject*             model_object() { return m_model_object; }
    const ModelObject*       model_object() const { return m_model_object; }
    const PrintInstances&    instances() const { return m_instances; }
    const Transform3d&       trafo_centered() const { return m_trafo_centered; }
    BoundingBox              bounding_box() const { return m_bbox; }

    bool has_support()          const { return m_config.enable_support || m_config.enforce_support_layers > 0; }
    bool has_raft()             const { return m_config.raft_layers > 0; }
    bool has_support_material()  const { return has_support() || has_raft(); }

    // ---- regions (adapter fills one region per object) ----
    size_t             num_printing_regions() const { return m_shared_regions.all_regions.size(); }
    const PrintRegion& printing_region(size_t idx) const { return *m_shared_regions.all_regions[idx]; }
    const PrintObjectRegions* shared_regions() const { return &m_shared_regions; }
    std::vector<unsigned int> object_extruders() const { return { 0 }; }

    // ---- mesh ops: EMPTY stubs. The kernel has no 3D model mesh nor support-painting data, so
    // enforcers/blockers/custom-facets are legitimately empty (no manual support painting). Documented.
    std::vector<Polygons> slice_support_blockers()  const { return {}; }
    std::vector<Polygons> slice_support_enforcers() const { return {}; }
    // Stage-20: manual support painting. The painted enforcer/blocker its (from the ported TriangleSelector,
    // set by the adapter) are projected to per-layer polygons via slice_mesh_slabs — verbatim semantics of
    // upstream PrintObject::project_and_append_custom_facets. Empty its => no-op (backward compatible).
    void set_custom_facets(const indexed_triangle_set& enforcer, const indexed_triangle_set& blocker) {
        m_enforcer_its = enforcer; m_blocker_its = blocker;
    }
    void project_and_append_custom_facets(bool /*seam*/, EnforcerBlockerType type, std::vector<Polygons>& out,
                                          std::vector<std::pair<Vec3f,Vec3f>>* = nullptr) const {
        const indexed_triangle_set& its = (type == EnforcerBlockerType::ENFORCER) ? m_enforcer_its : m_blocker_its;
        if (its.indices.empty()) return;
        std::vector<float> zs = zs_from_layers(m_layers);
        std::vector<Polygons> projected = project_custom_facets_footprint(its, zs);
        if (out.empty()) out = std::move(projected);
        else for (size_t i = 0; i < out.size() && i < projected.size(); ++i)
            out[i].insert(out[i].end(), std::make_move_iterator(projected[i].begin()),
                          std::make_move_iterator(projected[i].end()));
    }
    template<typename PolysType>
    static void remove_bridges_from_contacts(const Layer*, const Layer*, float, PolysType*,
                                             float = scale_(10), bool = false) {}

    // ---- adapter-filled members ----
    indexed_triangle_set m_enforcer_its, m_blocker_its;   // (stage 20) painted support facets (kernel coords)
    LayerPtrs        m_layers;
    SupportLayerPtrs m_support_layers;
    PrintObjectConfig m_config;
    std::shared_ptr<TreeSupportData> m_tree_support_preview_cache;
    Print*           m_print = nullptr;
    ModelObject*     m_model_object = nullptr;
    SlicingParameters m_slicing_params;
    PrintInstances   m_instances;
    Transform3d      m_trafo_centered { Transform3d::Identity() };
    BoundingBox      m_bbox;
    PrintObjectRegions m_shared_regions;   // .all_regions = the object's PrintRegion* list
};

// PrintRegion::flow — verbatim from PrintRegion.cpp:25 (uses the real Flow.hpp formula). extruder(role)
// returns 1 (single-extruder kernel); everything else is the original per-role line-width selection.
inline Flow PrintRegion::flow(const PrintObject& object, FlowRole role, double layer_height, bool first_layer) const
{
    const PrintConfig& print_config = object.print()->config();
    ConfigOptionFloatOrPercent config_width;
    if (first_layer && print_config.initial_layer_line_width.value > 0) {
        config_width = print_config.initial_layer_line_width;
    } else if (role == frExternalPerimeter) { config_width = m_config.outer_wall_line_width;
    } else if (role == frPerimeter)         { config_width = m_config.inner_wall_line_width;
    } else if (role == frInfill)            { config_width = m_config.sparse_infill_line_width;
    } else if (role == frSolidInfill)       { config_width = m_config.internal_solid_infill_line_width;
    } else if (role == frTopSolidInfill)    { config_width = m_config.top_surface_line_width;
    } else { throw Slic3r::InvalidArgument("Unknown role"); }
    if (config_width.value == 0)
        config_width = object.config().line_width;
    auto nozzle_diameter = float(print_config.nozzle_diameter.get_at(this->extruder(role) - 1));
    return Flow::new_from_config_width(role, config_width, nozzle_diameter, float(layer_height));
}

} // namespace Slic3r
#endif
