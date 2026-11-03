#pragma once
#include <cstddef>
#include <string>
#include <vector>

enum MeshBooleanOperation { MESH_BOOLEAN_UNION = 0, MESH_BOOLEAN_DIFFERENCE = 1, MESH_BOOLEAN_INTERSECTION = 2 };

// `first` and `second` are triangle soups, nine floats per face, in one frame. Returns "" on success, or a typed
//  refusal ("MESH_BOOLEAN_…: …"), with `positions` holding the result as a soup.
std::string mesh_boolean_run(const float* first, size_t firstFloats, const float* second, size_t secondFloats, int operation,
                             std::vector<float>& positions);
