// Stage-16 adapter driver: build a kernel-like overhang PrintObject (facade) and run the REAL
// organic TreeSupport, then report support-layer areas. Proves the ported pipeline links + runs.
#include <cstdio>
#include <vector>
#include "Print.hpp"
#include "Layer.hpp"
#include "I18N.hpp"
#include "Support/TreeSupport.hpp"

using namespace Slic3r;
namespace Slic3r { namespace I18N { translate_fn_type translate_fn = nullptr; } }

static ExPolygon square(double center_x, double center_y, double half) {
    ExPolygon polygon;
    auto scaled = [](double value){ return coord_t(scale_(value)); };
    polygon.contour.points = { Point(scaled(center_x-half),scaled(center_y-half)), Point(scaled(center_x+half),scaled(center_y-half)),
                               Point(scaled(center_x+half),scaled(center_y+half)), Point(scaled(center_x-half),scaled(center_y+half)) };
    return polygon;
}

int main() {
    Print facade_print;
    PrintRegion facade_region;
    PrintObject print_object;
    print_object.m_print = &facade_print;
    print_object.m_shared_regions.all_regions = { &facade_region };
    facade_print.m_objects = { &print_object };   // register the object: generate_tree_support_3D finds its index via print()->objects()
    print_object.m_model_object = new ModelObject();

    // config: organic tree support
    print_object.m_config.support_type.value      = stTreeAuto;   // auto: generate_overhangs scans all layers (manual+no-enforcers => 0 overhang layers)
    print_object.m_config.enable_support.value    = true;
    print_object.m_config.support_style.value     = smsTreeOrganic;
    print_object.m_config.layer_height.value      = 0.2;
    facade_print.m_config.printable_area.values   = { Vec2d(0,0), Vec2d(200,0), Vec2d(200,200), Vec2d(0,200) };
    facade_print.m_config.nozzle_diameter.values  = { 0.4 };

    PrintInstance instance;
    instance.print_object = &print_object;
    instance.shift = Point(0,0);
    print_object.m_instances.push_back(instance);

    // slicing params
    const double layer_height = 0.2;
    print_object.m_slicing_params.layer_height = layer_height;
    print_object.m_slicing_params.min_layer_height = layer_height;
    print_object.m_slicing_params.max_layer_height = layer_height;
    print_object.m_slicing_params.first_print_layer_height = layer_height;
    print_object.m_slicing_params.object_print_z_min = 0.0;

    // overhang model: a thin leg (layers 0..19, 10x10) then a wide table top (layers 20..29, 30x30).
    const int layer_count = 30;
    const int leg_layers = 20;
    Layer* previous_layer = nullptr;
    double z = 0;
    for (int i = 0; i < layer_count; ++i) {
        z += layer_height;
        Layer* layer = print_object.add_layer(i, layer_height, z, z - layer_height*0.5);   // PrintObject is friend of Layer
        layer->lower_layer = previous_layer;
        ExPolygon slice;
        if (i < leg_layers)
            slice = square(0,0,5);
        else
            slice = square(0,0,15);
        layer->lslices = { slice };
        layer->lslices_extrudable = { slice };
        previous_layer = layer;
    }
    print_object.m_bbox = BoundingBox(Point(scale_(-15),scale_(-15)), Point(scale_(15),scale_(15)));

    printf("driver: %zu layers (leg 10x10 x%d, top 30x30 x%d) -> organic tree support\n",
           print_object.m_layers.size(), leg_layers, layer_count - leg_layers);

    TreeSupport tree_support(print_object, print_object.m_slicing_params);
    tree_support.throw_on_cancel = [](){};   // real pipeline injects the cancel callback; empty => bad_function_call at first check
    tree_support.generate();

    int support_layer_count = (int)print_object.support_layers().size();
    int with_paths = print_object.count_support_layers_with_area();
    size_t toolpaths = print_object.total_support_toolpaths();
    printf("RESULT: support_layers=%d  layers_with_toolpaths=%d  total_support_toolpaths=%zu\n", support_layer_count, with_paths, toolpaths);
    const char* verdict = "FAIL";
    if (support_layer_count > 0 && with_paths > 0 && toolpaths > 0) verdict = "PASS";
    printf("CHECK support generated: %s\n", verdict);
    return 0;
}
