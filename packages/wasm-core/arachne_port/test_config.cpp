// Stage-11 standalone probe: does the real Config.cpp + PrintConfig.cpp subsystem compile, link,
// and run under emscripten? Prints option count + a few spot-checks (no embind yet).
#include <cstdio>
#include "config/libslic3r/PrintConfig.hpp"

using namespace Slic3r;

int main() {
    // print_config_def is the one global built by PrintConfigDef::PrintConfigDef().
    printf("option_count=%zu\n", (size_t)print_config_def.options.size());

    // FullPrintConfig instantiation (exercises the StaticPrintConfig cache machinery).
    FullPrintConfig full_config;
    printf("fullprintconfig_keys=%zu\n", (size_t)full_config.keys().size());

    // Spot checks against known defaults.
    auto layer_height_def = print_config_def.get("layer_height");
    if (layer_height_def && layer_height_def->default_value) printf("layer_height_default=%s\n", layer_height_def->default_value->serialize().c_str());
    auto seam_position_def = print_config_def.get("seam_position");
    if (seam_position_def && seam_position_def->default_value) printf("seam_position_default=%s\n", seam_position_def->default_value->serialize().c_str());
    auto infill_pattern_def = print_config_def.get("sparse_infill_pattern");
    if (infill_pattern_def) printf("sparse_infill_pattern_enum_count=%zu\n", (size_t)infill_pattern_def->enum_values.size());
    return 0;
}
