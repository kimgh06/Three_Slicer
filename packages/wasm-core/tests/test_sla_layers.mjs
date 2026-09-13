import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'sla-layers-'))
const source = join(temporary, 'test.cpp')
const binary = join(temporary, 'test')

writeFileSync(source, String.raw`
#include "slasupport_bridge.h"
#include <cassert>
#include <iostream>

using namespace slasupport_bridge;

static Polygon square(double x) {
  return {{x, 0}, {x + 1, 0}, {x + 1, 1}, {x, 1}};
}

int main() {
  std::vector<ObjectLayerInput> inputs{
    {"b", 0, 0.05, 0.05, {}, {square(20)}, {}},
    {"b", 1, 0.10, 0.05, {}, {}, {}},
    {"a", 0, 0.05, 0.05, {square(0)}, {}, {square(10)}},
    {"a", 1, 0.10, 0.05, {square(1)}, {}, {}},
  };

  const LayerAssemblyResult assembled = assemble_object_layers({"a", "b"}, inputs);
  assert(assembled.ok);
  assert(assembled.layers.size() == 2);
  assert(assembled.layers[0].print_z == 0.05);
  assert(assembled.layers[1].print_z == 0.10);
  assert(assembled.layers[0].contributions[0].object_id == "a");
  assert(assembled.layers[0].contributions[1].object_id == "b");
  assert(assembled.layers[0].contributions[0].role_mask == (layer_role_model | layer_role_pad));
  assert(assembled.layers[0].contributions[1].role_mask == layer_role_support);
  assert(assembled.layers[1].contributions[0].object_id == "a");
  assert(assembled.layers[1].contributions[1].object_id == "b");
  assert(assembled.layers[1].contributions[1].role_mask == layer_role_none);
  assert(assembled.layers[1].contributions[1].layer_index == 1);

  const CorrectionCapability capability = correction_capability();
  assert(capability.status == CorrectionCapabilityStatus::dependency_unavailable);
  assert(std::string(capability.code) == "SLA_PRINTER_Z_CORRECTION_DEPENDENCY_UNAVAILABLE");

  const CorrectionResult omitted = apply_model_corrections(inputs, {});
  assert(omitted.ok);
  assert(omitted.layers[2].model[0][0].x == 0.0);

  CorrectionRequest requested;
  requested.absolute_xy = -0.1;
  requested.z_correction_layers = 2;
  const CorrectionResult blocked = apply_model_corrections(inputs, requested);
  assert(!blocked.ok);
  assert(blocked.error == capability.code);
  assert(blocked.layers[2].model[0][0].x == 0.0);
  assert(blocked.layers[0].object_id == "b");

  std::cout << "layers=" << assembled.layers.size()
            << " empty_owner=" << assembled.layers[1].contributions[1].object_id
            << " correction=" << blocked.error << '\n';
}
`)

try {
  execFileSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', here,
    source, join(here, 'slasupport_bridge_validate.cpp'), '-o', binary], { stdio: 'inherit' })
  const output = execFileSync(binary, { encoding: 'utf8' }).trim()
  assert.equal(output,
    'layers=2 empty_owner=b correction=SLA_PRINTER_Z_CORRECTION_DEPENDENCY_UNAVAILABLE')
  console.log(`test_sla_layers: ${output}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
