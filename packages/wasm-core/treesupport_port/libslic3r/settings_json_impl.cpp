// See settings_json.hpp. Moved here unchanged from custom_gcode_bridge_impl.cpp's begin().
#include "settings_json.hpp"

#include "nlohmann/json.hpp"

namespace Slic3r {

namespace {

// parse_str_arr, verbatim from the lambda in ConfigBase::load_from_json (Config.cpp:858).
bool parse_str_arr(const nlohmann::json::const_iterator& it, const char single_sep,const char array_sep,const bool escape_string_style,std::string& value_str) {
        // must have consistent type name
        std::string consistent_type;
        for (auto iter = it.value().begin(); iter != it.value().end(); ++iter) {
            if (consistent_type.empty())
                consistent_type = iter.value().type_name();
            else {
                if (consistent_type != iter.value().type_name())
                    return false;
            }
        }

        bool first = true;
        for (auto iter = it.value().begin(); iter != it.value().end(); iter++) {
            if (iter.value().is_array()) {
                if (!first)
                    value_str += array_sep;
                else
                    first = false;
                bool success = parse_str_arr(iter, single_sep, array_sep,escape_string_style, value_str);
                if (!success)
                    return false;
            }
            else if (iter.value().is_string()) {
                if (!first)
                    value_str += single_sep;
                else
                    first = false;
                if (!escape_string_style)
                    value_str += iter.value();
                else {
                    value_str += "\"";
                    value_str += escape_string_cstyle(iter.value());
                    value_str += "\"";
                }
            }
            else {
                //should not happen
                return false;
            }
        }
        return true;
}

}  // namespace

std::string load_settings_json(const std::string& settings_json, DynamicPrintConfig& config,
                               std::vector<std::pair<std::string, std::string>>& extras, std::vector<std::string>& object_names) {
  std::map<std::string, std::string> key_values;
  try {
    const nlohmann::json parsed = nlohmann::json::parse(settings_json);
    if (!parsed.is_object())
      return "settings are not a JSON object";
    // The values are what serializeProjectSettings writes for a project_settings.config: a string, or for a vector
    //  option an array of strings. Arrays are joined the way ConfigBase::load_from_json does it (Config.cpp:858 and
    //  :997), since load_from_json itself stops at the first key this port's (older) definition does not know, and
    //  load_string_map skips those instead.
    const ConfigDef* config_def = &print_config_def;
    for (auto item = parsed.begin(); item != parsed.end(); ++item) {
      if (!item.key().empty() && item.key()[0] == '$') {
        if (item.value().is_string())
          extras.emplace_back(item.key(), item.value().get<std::string>());
        if (item.key() == "$object_names" && item.value().is_array())
          for (const auto& name : item.value())
            if (name.is_string())
              object_names.push_back(name.get<std::string>());
        continue;
      }
      if (item.value().is_string()) {
        key_values[item.key()] = item.value().get<std::string>();
        continue;
      }
      if (!item.value().is_array())
        return "setting " + item.key() + " is neither a string nor an array";
      const ConfigOptionDef* optdef = config_def->get(item.key());
      if (optdef == nullptr)
        continue;
      char single_sep = ',';
      char array_sep = '#';  // currenty not used
      bool escape_string_type = false;
      switch (optdef->type)
      {
      case coStrings:
          escape_string_type = true;
          single_sep = ';';
          break;
      case coPointsGroups:
          single_sep = '#';
          break;
      default:
          break;
      }
      std::string value_str;
      if (!parse_str_arr(item, single_sep, array_sep, escape_string_type, value_str))
        return "setting " + item.key() + " is not an array of strings";
      key_values[item.key()] = value_str;
    }
    config = DynamicPrintConfig::full_print_config();
    // A preset upstream flattens holds EVERY option of print_config_def, not only the ones FullPrintConfig has a
    //  member for, so a template can read print_settings_id or filament_ids even when the preset left them at the
    //  default. full_print_config() leaves those out, and a template reading one stopped with "Not a variable name"
    //  (Prusa MK3S 0.25/0.8 end G-code on print_settings_id).
    for (const auto& [key, definition] : print_config_def.options)
      if (definition.default_value && !config.has(key))
        config.set_key_value(key, definition.default_value->clone());
    // A vector enum cloned from a default carries no name table (ConfigOptionDef::create_default_option is what sets
    //  it), so deserializing "50%" into overhang_fan_threshold found no name, cleared the list and the template path
    //  ran on the 95% default (measured: [overhang_fan_threshold] expanded to nothing for 0%, 25% and 50%).
    for (const auto& [key, definition] : print_config_def.options) {
      if (definition.type != coEnums || definition.enum_keys_map == nullptr) continue;
      ConfigOption* option = config.optptr(key);
      if (auto* enums = dynamic_cast<ConfigOptionEnumsGeneric*>(option)) enums->keys_map = definition.enum_keys_map;
      if (auto* nullableEnums = dynamic_cast<ConfigOptionEnumsGenericNullable*>(option)) nullableEnums->keys_map = definition.enum_keys_map;
    }
    config.load_string_map(key_values, ForwardCompatibilitySubstitutionRule::EnableSilent);
  } catch (const std::exception& error) {
    return std::string("settings could not be loaded: ") + error.what();
  }
  return std::string();
}

} // namespace Slic3r
