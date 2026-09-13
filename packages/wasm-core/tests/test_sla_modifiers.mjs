import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'sla-modifiers-'))
const source = join(temporary, 'test.cpp')
const binary = join(temporary, 'test')

const harness = String.raw`
#include "slasupport_bridge.h"
#include <algorithm>
#include <cassert>
#include <iostream>
using namespace slasupport_bridge;

Polygon box(double x0, double x1) { return {{x0,0},{x1,0},{x1,2},{x0,2}}; }
SupportPoint point(std::uint64_t id, double x) {
  return {id, "part", {x,1,1}, PointType::slope, 0.2, 0, false, false};
}
PreparedLayer layer() {
  PreparedLayer out; out.object_id="part"; out.index=0; out.slice_z=1; out.print_z=1; out.height=.05;
  return out;
}

int main() {
  const std::vector<SupportPoint> points{point(1,1), point(2,3), point(3,5)};

  // Given enforcers-only with no enforcer, all automatically generated points are rejected.
  PreparedLayer none = layer();
  assert(filter_support_points_by_modifiers(points, {none}, true).empty());

  // Adding an enforcer admits only points inside it.
  PreparedLayer enforced = layer();
  enforced.modifier_masks = {{ModifierKind::enforcer, {box(2,4)}}};
  auto only = filter_support_points_by_modifiers(points, {enforced}, true);
  assert(only.size() == 1 && only[0].source_id == 2);

  // A blocker reduces but does not erase ordinary support points.
  PreparedLayer blocked = layer();
  blocked.modifier_masks = {{ModifierKind::blocker, {box(0,2)}}};
  auto reduced = filter_support_points_by_modifiers(points, {blocked}, false);
  assert((reduced.size() == 2 && reduced[0].source_id == 2 && reduced[1].source_id == 3));

  // Enforcer precedence is deterministic where masks overlap, independent of mask record order.
  PreparedLayer overlap = layer();
  overlap.modifier_masks = {{ModifierKind::blocker, {box(2,4)}}, {ModifierKind::enforcer, {box(2,4)}}};
  auto first = filter_support_points_by_modifiers(points, {overlap}, false);
  std::reverse(overlap.modifier_masks.begin(), overlap.modifier_masks.end());
  auto second = filter_support_points_by_modifiers(points, {overlap}, false);
  assert(first.size() == 3 && second.size() == 3);
  for (std::size_t i = 0; i < first.size(); ++i) assert(first[i].source_id == second[i].source_id);

  std::cout << "enforcers_only=1 blocker_remainder=2 overlap_precedence=3 repeat=stable\n";
}
`

try {
  writeFileSync(source, harness)
  execFileSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', here,
    source, join(here, 'slasupport_bridge_validate.cpp'), '-o', binary], { stdio: 'inherit' })
  const output = execFileSync(binary, { encoding: 'utf8' }).trim()
  assert.equal(output, 'enforcers_only=1 blocker_remainder=2 overlap_precedence=3 repeat=stable')
  console.log(`test_sla_modifiers: ${output}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
