// The port side of cooling_bridge.h: the upstream CoolingBuffer over the host's settings.
#include "../../cooling_bridge.h"

#include "GCode/CoolingBuffer.hpp"
#include "PrintConfig.hpp"
#include "settings_json.hpp"

#include <memory>

namespace cooling_bridge {

using namespace Slic3r;

namespace {
struct Session {
  PrintConfig config;   // CoolingBuffer keeps a reference: the session owns it for the buffer's lifetime
  std::unique_ptr<CoolingBuffer> buffer;
};
std::unique_ptr<Session> g_session;
}  // namespace

std::string begin(const std::string& settings_json, const std::vector<unsigned int>& extruders) {
  g_session.reset();
  auto session = std::make_unique<Session>();
  try {
    DynamicPrintConfig loaded;
    std::vector<std::pair<std::string, std::string>> extras;
    std::vector<std::string> objectNames;
    std::string error = load_settings_json(settings_json, loaded, extras, objectNames);
    if (!error.empty())
      return error;
    session->config.apply(loaded, true);
    // The writer's tool-change prefix is "T" for every flavor this kernel writes (GCodeWriter::toolchange_prefix:
    //  "M108 T" / "M135 T" only for MakerWare and Sailfish).
    std::string prefix = "T";
    if (session->config.gcode_flavor.value == gcfMakerWare) prefix = "M135 T";
    if (session->config.gcode_flavor.value == gcfSailfish) prefix = "M108 T";
    session->buffer = std::make_unique<CoolingBuffer>(session->config, prefix, Vec3d::Zero(), extruders);
  } catch (const std::exception& error) {
    return std::string("cooling settings could not be loaded: ") + error.what();
  }
  g_session = std::move(session);
  return std::string();
}

bool active() {
  return g_session != nullptr;
}

std::string process_layer(std::string&& gcode, int layer_id, unsigned int current_extruder) {
  if (!g_session)
    return std::move(gcode);
  g_session->buffer->set_current_extruder(current_extruder, current_extruder);
  return g_session->buffer->process_layer(std::move(gcode), size_t(layer_id), true);
}

Markers markers(unsigned int extruder) {
  Markers out;
  if (!g_session) return out;
  const PrintConfig& config = g_session->config;
  out.overhang = config.enable_overhang_bridge_fan.get_at(extruder);
  out.overhang_external = config.overhang_fan_threshold.get_at(extruder) == int(Overhang_threshold_none);
  out.support_interface = config.support_material_interface_fan_speed.get_at(extruder) > -1;
  out.ironing = config.ironing_fan_speed.get_at(extruder) > -1;
  return out;
}

void end() {
  g_session.reset();
}

} // namespace cooling_bridge
