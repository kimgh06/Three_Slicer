import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveSlaParams } from '../engine/src/settings.js'

const here = dirname(fileURLToPath(import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'sla-strategies-'))
const source = join(temporary, 'test.cpp')
const binary = join(temporary, 'test')

const harness = String.raw`
#include "slasupport_bridge.h"
#include <cassert>
#include <iostream>
#include <string>

using namespace slasupport_bridge;

int main() {
  const StrategyCapability default_cap = strategy_capability(SupportStrategy::default_tree);
  assert(default_cap.strategy == SupportStrategy::default_tree);
  assert(default_cap.status == StrategyCapabilityStatus::supported);
  assert(std::string(default_cap.code) == "SLA_SUPPORT_STRATEGY_SUPPORTED");

  const StrategyCapability branching_cap = strategy_capability(SupportStrategy::branching);
  assert(branching_cap.strategy == SupportStrategy::branching);
  assert(branching_cap.status == StrategyCapabilityStatus::dependency_unavailable);
  assert(std::string(branching_cap.code) == "SLA_SUPPORT_BRANCHING_DEPENDENCY_UNAVAILABLE");

  const StrategyCapability organic_cap = strategy_capability(SupportStrategy::organic);
  assert(organic_cap.strategy == SupportStrategy::organic);
  assert(organic_cap.status == StrategyCapabilityStatus::unsupported_upstream);
  assert(std::string(organic_cap.code) == "SLA_SUPPORT_ORGANIC_UNSUPPORTED_UPSTREAM");

  std::cout << "default=supported branching=dependency_unavailable organic=unsupported_upstream\n";
}
`

try {
  writeFileSync(source, harness)
  execFileSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', here,
    source, join(here, 'slasupport_bridge_validate.cpp'), '-o', binary], { stdio: 'inherit' })
  assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(),
    'default=supported branching=dependency_unavailable organic=unsupported_upstream')

  assert.equal(deriveSlaParams({}).support_tree_type, 'default')
  assert.equal(deriveSlaParams({ support_tree_type: 'branching' }).support_tree_type, 'branching')
  assert.equal(deriveSlaParams({ support_tree_type: 'organic' }).support_tree_type, 'organic')

  const manifest = JSON.parse(readFileSync(join(here, 'slasupport_port/SOURCE_MANIFEST.json'), 'utf8'))
  const branching = manifest.deferredDependencyProbes.find(unit => unit.upstreamPath.endsWith('/BranchingTreeSLA.cpp'))
  assert.equal(branching?.copied, false)

  const bridge = readFileSync(join(here, 'slasupport_bridge.cpp'), 'utf8')
  assert.match(bridge, /strategy_capability\(cfg\.strategy\)/)
  assert.match(bridge, /status != StrategyCapabilityStatus::supported/)
  assert.match(bridge, /DefaultSupportTree::execute/)

  console.log('test_sla_strategies: explicit Default dispatch, Branching capability, Organic rejection, and settings forwarding passed')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
