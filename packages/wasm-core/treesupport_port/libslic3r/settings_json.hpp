// The host's settings (a project_settings.config's JSON form, every value an upstream option string) loaded into a
// DynamicPrintConfig holding every option of print_config_def, the way upstream's flattened preset holds them. One
// loader for every bridge that reads the settings: the custom G-code expansion (custom_gcode_bridge_impl.cpp) and the
// cooling filter (cooling_bridge_impl.cpp).
#pragma once
#include "PrintConfig.hpp"

#include <string>
#include <utility>
#include <vector>

namespace Slic3r {

// Returns "" or the reason. Keys starting with '$' are not settings: the string ones come back in `extras`, and
//  `$object_names` (a list) in `object_names`.
std::string load_settings_json(const std::string& settings_json, DynamicPrintConfig& config,
                               std::vector<std::pair<std::string, std::string>>& extras, std::vector<std::string>& object_names);

} // namespace Slic3r
