#include "slasupport_bridge.h"

#include <cmath>
#include <algorithm>
#include <unordered_map>

namespace slasupport_bridge {
namespace {

bool finite(double value) { return std::isfinite(value); }

bool valid_polygon(const Polygon& polygon) {
  if (polygon.size() < 3) return false;
  for (const Vec2& point : polygon)
    if (!finite(point.x) || !finite(point.y)) return false;
  return true;
}

ValidationResult failure(const std::string& error) {
  ValidationResult result;
  result.error = error;
  return result;
}

bool correction_requested(const CorrectionRequest& request) {
  return request.absolute_xy != 0.0 || request.elephant_foot != 0.0 ||
         request.elephant_foot_min_width != 0.0 || request.faded_layers != 0 ||
         request.z_correction_layers != 0;
}

} // namespace

LayerAssemblyResult assemble_object_layers(
  const std::vector<std::string>& object_order,
  const std::vector<ObjectLayerInput>& layers)
{
  LayerAssemblyResult result;
  std::unordered_map<std::string, std::size_t> order;
  order.reserve(object_order.size());
  for (std::size_t i = 0; i < object_order.size(); ++i) {
    if (object_order[i].empty() || !order.emplace(object_order[i], i).second) {
      result.error = "object_order: expected unique non-empty ids";
      return result;
    }
  }

  std::unordered_map<std::string, std::size_t> last_index;
  std::unordered_map<std::string, double> last_z;
  std::vector<ObjectLayerInput> sorted = layers;
  for (std::size_t i = 0; i < sorted.size(); ++i) {
    const ObjectLayerInput& layer = sorted[i];
    if (order.find(layer.object_id) == order.end()) {
      result.error = "layers[" + std::to_string(i) + "].object_id: unknown object";
      return result;
    }
    if (!finite(layer.print_z) || !finite(layer.height) || layer.height <= 0.0) {
      result.error = "layers[" + std::to_string(i) + "]: invalid height or print_z";
      return result;
    }
    for (const auto* polygons : {&layer.model, &layer.support, &layer.pad})
      for (const Polygon& polygon : *polygons)
        if (!valid_polygon(polygon)) {
          result.error = "layers[" + std::to_string(i) + "]: invalid role polygon";
          return result;
        }
    auto previous_index = last_index.find(layer.object_id);
    if (previous_index != last_index.end() && layer.index <= previous_index->second) {
      result.error = "layers[" + std::to_string(i) + "].index: not strictly increasing";
      return result;
    }
    auto previous_z = last_z.find(layer.object_id);
    if (previous_z != last_z.end() && layer.print_z <= previous_z->second) {
      result.error = "layers[" + std::to_string(i) + "].print_z: not strictly increasing";
      return result;
    }
    last_index[layer.object_id] = layer.index;
    last_z[layer.object_id] = layer.print_z;
  }

  std::stable_sort(sorted.begin(), sorted.end(), [&](const ObjectLayerInput& left, const ObjectLayerInput& right) {
    if (left.print_z != right.print_z) return left.print_z < right.print_z;
    return order.at(left.object_id) < order.at(right.object_id);
  });
  for (const ObjectLayerInput& layer : sorted) {
    if (result.layers.empty() || result.layers.back().print_z != layer.print_z)
      result.layers.push_back({layer.print_z, layer.height, {}});
    else if (result.layers.back().height != layer.height) {
      result.error = "layers: contributions at the same print_z have different heights";
      result.layers.clear();
      return result;
    }
    std::uint8_t role_mask = layer_role_none;
    if (!layer.model.empty()) role_mask |= layer_role_model;
    if (!layer.support.empty()) role_mask |= layer_role_support;
    if (!layer.pad.empty()) role_mask |= layer_role_pad;
    result.layers.back().contributions.push_back({
      layer.object_id, order.at(layer.object_id), layer.index, role_mask,
      layer.model, layer.support, layer.pad,
    });
  }
  result.ok = true;
  return result;
}

CorrectionCapability correction_capability() { return {}; }

PadCapability pad_capability() { return {}; }

CorrectionResult apply_model_corrections(
  const std::vector<ObjectLayerInput>& layers,
  const CorrectionRequest& request)
{
  CorrectionResult result;
  result.layers = layers;
  if (!finite(request.absolute_xy) || !finite(request.elephant_foot) ||
      !finite(request.elephant_foot_min_width) || request.elephant_foot < 0.0 ||
      request.elephant_foot_min_width < 0.0) {
    result.error = "SLA_INVALID_CORRECTION_REQUEST";
    return result;
  }
  if (correction_requested(request)) {
    result.error = result.capability.code;
    return result;
  }
  result.ok = true;
  return result;
}

StrategyCapability strategy_capability(SupportStrategy strategy) {
  switch (strategy) {
    case SupportStrategy::default_tree:
      return {strategy, StrategyCapabilityStatus::supported, "SLA_SUPPORT_STRATEGY_SUPPORTED"};
    case SupportStrategy::branching:
      return {strategy, StrategyCapabilityStatus::dependency_unavailable,
              "SLA_SUPPORT_BRANCHING_DEPENDENCY_UNAVAILABLE"};
    case SupportStrategy::organic:
      return {strategy, StrategyCapabilityStatus::unsupported_upstream,
              "SLA_SUPPORT_ORGANIC_UNSUPPORTED_UPSTREAM"};
  }
  return {strategy, StrategyCapabilityStatus::unsupported_upstream,
          "SLA_SUPPORT_STRATEGY_INVALID"};
}

static bool polygon_contains(const Polygon& polygon, const Vec2& point) {
  bool inside = false;
  for (std::size_t i = 0, previous = polygon.size() - 1; i < polygon.size(); previous = i++) {
    const Vec2& vertex = polygon[i];
    const Vec2& previous_vertex = polygon[previous];
    if ((vertex.y > point.y) != (previous_vertex.y > point.y) &&
        point.x < (previous_vertex.x - vertex.x) * (point.y - vertex.y) / (previous_vertex.y - vertex.y) + vertex.x)
      inside = !inside;
  }
  return inside;
}

std::vector<SupportPoint> filter_support_points_by_modifiers(
  const std::vector<SupportPoint>& points,
  const std::vector<PreparedLayer>& layers,
  bool enforcers_only)
{
  std::vector<SupportPoint> filtered;
  filtered.reserve(points.size());
  for (const SupportPoint& point : points) {
    const PreparedLayer* selected = nullptr;
    for (const PreparedLayer& layer : layers)
      if (layer.object_id == point.object_id && layer.print_z >= point.position.z &&
          (selected == nullptr || layer.print_z < selected->print_z))
        selected = &layer;
    if (selected == nullptr) continue;
    bool enforced = false;
    bool blocked = false;
    for (const ModifierMask& mask : selected->modifier_masks)
      for (const Polygon& polygon : mask.polygons)
        if (polygon_contains(polygon, {point.position.x, point.position.y})) {
          if (mask.kind == ModifierKind::enforcer) enforced = true;
          else blocked = true;
        }
    if (enforced || (!enforcers_only && !blocked)) filtered.push_back(point);
  }
  return filtered;
}

ValidationResult validate(const PreparedJob& job) {
  if (job.objects.empty()) return failure("objects: empty");

  std::unordered_map<std::string, std::size_t> objects;
  objects.reserve(job.objects.size());
  for (std::size_t i = 0; i < job.objects.size(); ++i) {
    const PreparedObject& object = job.objects[i];
    if (object.id.empty()) return failure("objects[" + std::to_string(i) + "].id: empty");
    if (!objects.emplace(object.id, i).second)
      return failure("objects[" + std::to_string(i) + "].id: duplicate");
    if (object.mesh.empty() || object.mesh.size() % 9 != 0)
      return failure("objects[" + std::to_string(i) + "].mesh: expected non-empty triangle soup");
    for (float coordinate : object.mesh)
      if (!finite(coordinate)) return failure("objects[" + std::to_string(i) + "].mesh: non-finite coordinate");
    for (double coordinate : object.transform.matrix)
      if (!finite(coordinate)) return failure("objects[" + std::to_string(i) + "].transform: non-finite coordinate");
    const auto& matrix = object.transform.matrix;
    if (matrix[3] != 0.0 || matrix[7] != 0.0 || matrix[11] != 0.0 || matrix[15] != 1.0)
      return failure("objects[" + std::to_string(i) + "].transform: expected affine matrix");
  }

  std::unordered_map<std::string, std::size_t> last_layer_index;
  std::unordered_map<std::string, double> last_print_z;
  std::size_t blockers = 0;
  std::size_t enforcers = 0;
  for (std::size_t i = 0; i < job.layers.size(); ++i) {
    const PreparedLayer& layer = job.layers[i];
    if (objects.find(layer.object_id) == objects.end())
      return failure("layers[" + std::to_string(i) + "].object_id: unknown object");
    if (!finite(layer.slice_z) || !finite(layer.print_z) || !finite(layer.height) || layer.height <= 0.0)
      return failure("layers[" + std::to_string(i) + "]: invalid height or Z");
    const auto previous_index = last_layer_index.find(layer.object_id);
    if (previous_index != last_layer_index.end() && layer.index <= previous_index->second)
      return failure("layers[" + std::to_string(i) + "].index: not strictly increasing");
    const auto previous_z = last_print_z.find(layer.object_id);
    if (previous_z != last_print_z.end() && layer.print_z <= previous_z->second)
      return failure("layers[" + std::to_string(i) + "].print_z: not strictly increasing");
    last_layer_index[layer.object_id] = layer.index;
    last_print_z[layer.object_id] = layer.print_z;
    for (std::size_t contour_index = 0; contour_index < layer.contours.size(); ++contour_index)
      if (!valid_polygon(layer.contours[contour_index]))
        return failure("layers[" + std::to_string(i) + "].contours[" + std::to_string(contour_index) + "]: invalid polygon");
    for (std::size_t mask_index = 0; mask_index < layer.modifier_masks.size(); ++mask_index) {
      const ModifierMask& mask = layer.modifier_masks[mask_index];
      if (mask.kind != ModifierKind::blocker && mask.kind != ModifierKind::enforcer)
        return failure("layers[" + std::to_string(i) + "].modifier_masks[" + std::to_string(mask_index) + "].kind: invalid");
      if (mask.kind == ModifierKind::blocker) ++blockers;
      else ++enforcers;
      for (std::size_t polygon_index = 0; polygon_index < mask.polygons.size(); ++polygon_index)
        if (!valid_polygon(mask.polygons[polygon_index]))
          return failure("layers[" + std::to_string(i) + "].modifier_masks[" + std::to_string(mask_index) + "].polygons[" + std::to_string(polygon_index) + "]: invalid polygon");
    }
  }

  ValidationResult result;
  result.point_order.reserve(job.points.size());
  for (std::size_t i = 0; i < job.points.size(); ++i) {
    const SupportPoint& point = job.points[i];
    if (objects.find(point.object_id) == objects.end())
      return failure("points[" + std::to_string(i) + "].object_id: unknown object");
    if (!finite(point.position.x) || !finite(point.position.y) || !finite(point.position.z) ||
        !finite(point.head_front_radius) || point.head_front_radius <= 0.0 ||
        !finite(point.elevation) || point.elevation < 0.0)
      return failure("points[" + std::to_string(i) + "]: invalid position, radius, or elevation");
    if (point.type != PointType::manual_add && point.type != PointType::island && point.type != PointType::slope)
      return failure("points[" + std::to_string(i) + "].type: invalid");
    if (point.manual && point.type != PointType::manual_add)
      return failure("points[" + std::to_string(i) + "].manual: requires manual_add type");
    result.point_order.push_back(point.source_id);
  }

  result.ok = true;
  result.object_count = job.objects.size();
  result.layer_count = job.layers.size();
  result.point_count = job.points.size();
  result.blocker_mask_count = blockers;
  result.enforcer_mask_count = enforcers;
  return result;
}

} // namespace slasupport_bridge
