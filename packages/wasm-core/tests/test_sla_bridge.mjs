import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'sla-bridge-'))
const source = join(temporary, 'test.cpp')
const binary = join(temporary, 'test')

const harness = String.raw`
#include "slasupport_bridge.h"
#include <cassert>
#include <iostream>
#include <limits>

using namespace slasupport_bridge;

Polygon square(double x) {
  return {{x, 0}, {x + 1, 0}, {x + 1, 1}, {x, 1}};
}

PreparedJob valid_job() {
  PreparedJob job;
  PreparedObject object;
  object.id = "part-a";
  object.mesh = {0,0,0, 1,0,0, 0,1,0};
  object.transform.matrix[12] = 12.5;
  job.objects.push_back(object);

  PreparedLayer first;
  first.object_id = object.id;
  first.index = 0;
  first.slice_z = 0.025;
  first.print_z = 0.05;
  first.height = 0.05;
  first.contours = {square(0)};
  first.modifier_masks = {
    {ModifierKind::blocker, {square(2)}},
    {ModifierKind::enforcer, {square(4)}}
  };
  job.layers.push_back(first);

  PreparedLayer second = first;
  second.index = 1;
  second.slice_z = 0.075;
  second.print_z = 0.10;
  second.modifier_masks.clear();
  job.layers.push_back(second);

  job.points = {
    {91, object.id, {0.2, 0.2, 0.0}, PointType::manual_add, 0.20, 0.0, true, true},
    {12, object.id, {0.3, 0.3, 0.0}, PointType::island,     0.25, 0.1, true, false},
    {77, object.id, {0.4, 0.4, 0.0}, PointType::slope,      0.30, 0.2, false, false}
  };
  return job;
}

void expect_error(const PreparedJob& job, const char* expected) {
  ValidationResult result = validate(job);
  assert(!result.ok);
  assert(result.error == expected);
}

int main() {
  PreparedJob job = valid_job();
  ValidationResult result = validate(job);
  assert(result.ok);
  assert(result.object_count == 1 && result.layer_count == 2 && result.point_count == 3);
  assert(result.blocker_mask_count == 1 && result.enforcer_mask_count == 1);
  assert((result.point_order == std::vector<std::uint64_t>{91, 12, 77}));

  std::size_t progress_calls = 0;
  job.callbacks.is_canceled = [] { return true; };
  job.callbacks.on_progress = [&](const Progress& p) {
    assert(p.phase == ProgressPhase::prepare);
    ++progress_calls;
  };
  assert(job.callbacks.is_canceled());
  job.callbacks.on_progress({ProgressPhase::prepare, 1, 3});
  assert(progress_calls == 1);

  PreparedJob bad;
  expect_error(bad, "objects: empty");
  bad = valid_job(); bad.objects[0].mesh.pop_back();
  expect_error(bad, "objects[0].mesh: expected non-empty triangle soup");
  bad = valid_job(); bad.objects.push_back(bad.objects[0]);
  expect_error(bad, "objects[1].id: duplicate");
  bad = valid_job(); bad.layers[0].object_id = "missing";
  expect_error(bad, "layers[0].object_id: unknown object");
  bad = valid_job(); bad.layers[1].index = 0;
  expect_error(bad, "layers[1].index: not strictly increasing");
  bad = valid_job(); bad.layers[0].contours[0].pop_back(); bad.layers[0].contours[0].pop_back();
  expect_error(bad, "layers[0].contours[0]: invalid polygon");
  bad = valid_job(); bad.layers[0].modifier_masks[0].kind = static_cast<ModifierKind>(9);
  expect_error(bad, "layers[0].modifier_masks[0].kind: invalid");
  bad = valid_job(); bad.points[1].object_id = "missing";
  expect_error(bad, "points[1].object_id: unknown object");
  bad = valid_job(); bad.points[1].head_front_radius = 0;
  expect_error(bad, "points[1]: invalid position, radius, or elevation");
  bad = valid_job(); bad.points[1].manual = true;
  expect_error(bad, "points[1].manual: requires manual_add type");
  bad = valid_job(); bad.objects[0].transform.matrix[0] = std::numeric_limits<double>::infinity();
  expect_error(bad, "objects[0].transform: non-finite coordinate");

  std::cout << "objects=1 layers=2 points=3 blockers=1 enforcers=1 order=91,12,77 malformed=11 callbacks=2\n";
}
`

try {
  writeFileSync(source, harness)
  execFileSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', here,
    source, join(here, 'slasupport_bridge_validate.cpp'), '-o', binary], { stdio: 'inherit' })
  const output = execFileSync(binary, { encoding: 'utf8' }).trim()
  assert.equal(output, 'objects=1 layers=2 points=3 blockers=1 enforcers=1 order=91,12,77 malformed=11 callbacks=2')

  for (const file of ['slice_sla.cpp', 'bindings.cpp']) {
    const text = readFileSync(join(here, file), 'utf8')
    assert.doesNotMatch(text, /#include\s*[<"](?:libslic3r\/SLA|slasupport_port)/,
      `${file} must not include Prusa SLA headers`)
  }
  assert.doesNotMatch(readFileSync(join(here, 'slasupport_bridge.h'), 'utf8'), /#include\s*[<"]libslic3r/)
  console.log('test_sla_bridge: prepared records, validation, ordering, callbacks, and include isolation passed')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
