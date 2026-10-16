// WP2 (normal support port): a minimal TU containing only LayerRegion's 3 flow-related methods.
// The full LayerRegion.cpp (1,130 lines) drags in the whole perimeter generation stack (BridgeDetector, PerimeterGenerator, …),
// while all SupportMaterial.cpp actually needs to link is flow/bridging_flow.
// The bodies are copied verbatim from LayerRegion.cpp:21~60 (zero edits) — when upstream changes, just re-copy.
// ponytail: a minimal excerpt TU. If SupportMaterial ever needs other LayerRegion methods, promote this to compiling
//  LayerRegion.cpp itself instead.
#include "Layer.hpp"
#include "Print.hpp"
#include "Flow.hpp"

namespace Slic3r {

Flow LayerRegion::flow(FlowRole role) const
{
    return this->flow(role, m_layer->height);
}

Flow LayerRegion::flow(FlowRole role, double layer_height) const
{
    return m_region->flow(*m_layer->object(), role, layer_height, m_layer->id() == 0);
}

Flow LayerRegion::bridging_flow(FlowRole role, bool thick_bridge) const
{
    const PrintRegion       &region         = this->region();
    const PrintRegionConfig &region_config  = region.config();
    const PrintObject       &print_object   = *this->layer()->object();
    Flow bridge_flow;
    // Here this->extruder(role) - 1 may underflow to MAX_INT, but then the get_at() will fall back to zero'th element, so everything is all right.
    auto nozzle_diameter = float(print_object.print()->config().nozzle_diameter.get_at(region.extruder(role) - 1));
    const ConfigOptionFloatOrPercent& bridge_width_opt = region_config.bridge_line_width;
    const double                      bridge_width      = bridge_width_opt.get_abs_value(nozzle_diameter);
    const bool                        has_bridge_width  = bridge_width > 0.;
    const double                      bridge_flow_ratio = region_config.bridge_flow;

    if (thick_bridge) {
        // The old Slic3r way (different from all other slicers): Use rounded extrusions.
        // Get the configured nozzle_diameter for the extruder associated to the flow role requested.
        float thread_diameter = nozzle_diameter;
        if (has_bridge_width)
            thread_diameter = float(bridge_width);
        if (bridge_flow_ratio > 0.)
            thread_diameter *= float(sqrt(bridge_flow_ratio));
        bridge_flow = Flow::bridging_flow(thread_diameter, nozzle_diameter);
    } else {
        // The same way as other slicers: Use normal extrusions. Apply bridge_flow while maintaining the original spacing.
        Flow base_flow = this->flow(role);
        if (has_bridge_width)
            base_flow = Flow(float(bridge_width), base_flow.height(), nozzle_diameter);
        bridge_flow = base_flow.with_flow_ratio(bridge_flow_ratio);
    }
    return bridge_flow;

}

} // namespace Slic3r
