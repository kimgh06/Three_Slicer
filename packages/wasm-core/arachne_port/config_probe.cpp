// Stage-11 embind probe: exposes the ported real Config/PrintConfig subsystem to node.
//  - option_count()            : print_config_def.options.size()  (build-based ground truth)
//  - full_print_config_keys()  : FullPrintConfig instance key count
//  - default_of(key)           : serialized default of one option
//  - enum_count(key)           : enum_values size of one option
//  - dump_schema_json()        : full print_config_def -> JSON (for config-schema cross-check)
// Standalone module; does NOT touch the main slicer_core.js build (which keeps the stub PrintConfig).
#include <string>
#include <sstream>
#include <emscripten/bind.h>
#include "config/libslic3r/PrintConfig.hpp"

using namespace Slic3r;

static const char* type_to_string(ConfigOptionType type) {
    switch (type) {
        case coNone:               return "coNone";
        case coFloat:              return "coFloat";
        case coFloats:             return "coFloats";
        case coInt:                return "coInt";
        case coInts:               return "coInts";
        case coString:             return "coString";
        case coStrings:            return "coStrings";
        case coPercent:            return "coPercent";
        case coPercents:           return "coPercents";
        case coFloatOrPercent:     return "coFloatOrPercent";
        case coFloatsOrPercents:   return "coFloatsOrPercents";
        case coPoint:              return "coPoint";
        case coPoints:             return "coPoints";
        case coPoint3:             return "coPoint3";
        case coBool:               return "coBool";
        case coBools:              return "coBools";
        case coEnum:               return "coEnum";
        case coEnums:              return "coEnums";
        case coPointsGroups:       return "coPointsGroups";
        case coIntsGroups:         return "coIntsGroups";
        default:                   return "coUnknown";
    }
}

static const char* mode_to_string(ConfigOptionMode mode) {
    switch (mode) {
        case comSimple:   return "simple";
        case comAdvanced: return "advanced";
        case comExpert:   return "expert";
        case comDevelop:  return "develop";
        default:          return "unknown";
    }
}

static void json_escape(std::ostream& out, const std::string& text) {
    out << '"';
    for (char character : text) {
        switch (character) {
            case '"':
                out << "\\\"";
                break;
            case '\\':
                out << "\\\\";
                break;
            case '\n':
                out << "\\n";
                break;
            case '\r':
                out << "\\r";
                break;
            case '\t':
                out << "\\t";
                break;
            default:
                if ((unsigned char)character < 0x20) {
                    char escaped[8];
                    std::snprintf(escaped, sizeof escaped, "\\u%04x", character);
                    out << escaped;
                }
                else out << character;
        }
    }
    out << '"';
}

static void write_json_string_array(std::ostream& out, const std::vector<std::string>& values) {
    out << '[';
    for (size_t i = 0; i < values.size(); ++i) {
        if (i) out << ',';
        json_escape(out, values[i]);
    }
    out << ']';
}

int option_count() { return (int)print_config_def.options.size(); }

int full_print_config_keys() {
    FullPrintConfig full_config;
    return (int)full_config.keys().size();
}

std::string default_of(const std::string& key) {
    auto option_def = print_config_def.get(key);
    if (!option_def || !option_def->default_value) return std::string();
    return option_def->default_value->serialize();
}

int enum_count(const std::string& key) {
    auto option_def = print_config_def.get(key);
    if (!option_def) return -1;
    return (int)option_def->enum_values.size();
}

std::string dump_schema_json() {
    std::ostringstream out;
    out << '{';
    bool first = true;
    for (const auto& entry : print_config_def.options) {
        const std::string& key = entry.first;
        const ConfigOptionDef& option_def = entry.second;
        if (!first) out << ',';
        first = false;
        json_escape(out, key);
        out << ":{";
        out << "\"type\":\"" << type_to_string(option_def.type) << "\"";
        out << ",\"mode\":\"" << mode_to_string(option_def.mode) << "\"";
        const char* nullable_text = "false";
        if (option_def.nullable) nullable_text = "true";
        out << ",\"nullable\":" << nullable_text;
        out << ",\"label\":";
        json_escape(out, option_def.label);
        out << ",\"full_label\":";
        json_escape(out, option_def.full_label);
        out << ",\"category\":";
        json_escape(out, option_def.category);
        out << ",\"tooltip\":";
        json_escape(out, option_def.tooltip);
        out << ",\"sidetext\":";
        json_escape(out, option_def.sidetext);
        out << ",\"ratio_over\":";
        json_escape(out, option_def.ratio_over);
        // min/max only meaningful when set away from +/-FLT_MAX
        if (option_def.min > -3.0e38f) out << ",\"min\":" << option_def.min;
        if (option_def.max <  3.0e38f) out << ",\"max\":" << option_def.max;
        out << ",\"enum_values\":";
        write_json_string_array(out, option_def.enum_values);
        out << ",\"enum_labels\":";
        write_json_string_array(out, option_def.enum_labels);
        if (option_def.default_value) {
            out << ",\"default\":";
            json_escape(out, option_def.default_value->serialize());
        } else {
            out << ",\"default\":null";
        }
        out << '}';
    }
    out << '}';
    return out.str();
}

EMSCRIPTEN_BINDINGS(config_probe) {
    emscripten::function("option_count", &option_count);
    emscripten::function("full_print_config_keys", &full_print_config_keys);
    emscripten::function("default_of", &default_of);
    emscripten::function("enum_count", &enum_count);
    emscripten::function("dump_schema_json", &dump_schema_json);
}
