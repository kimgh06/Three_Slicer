// The toggle evaluator parses enable_if itself instead of handing it to Function(), which a page whose CSP has no
// 'unsafe-eval' refuses (the browser extension's did, and every option stayed enabled there). This pins the parser to
// what Function gave, over every upstream rule the extractor kept, with random values for its locals and config reads.
import assert from 'node:assert/strict'
import { substituteEnableIf, evaluateBooleanExpression, makeToggle } from 'three-slicer-viewer/toggle'
import { toggleRules, schema } from '../src/data.js'
import { disabledKeys, makeCfg } from '../src/toggle_eval.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ok: ${label}`)
    return
  }
  let suffix = ''
  if (detail) suffix = ` — ${detail}`
  console.log(`  FAIL: ${label}${suffix}`)
  failures++
}

// The reference: what the evaluator did before, in node, where Function is allowed.
function viaFunction(source) {
  try { return !!Function('"use strict";return (' + source + ')')() } catch { return null }
}

// A deterministic generator, so a failure reproduces.
let seed = 12345
function random() {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

const expressions = []
for (const group of Object.values(toggleRules)) {
  for (const rule of group?.rules ?? []) {
    if (rule.enable_if) expressions.push(rule.enable_if)
  }
}

console.log('\n[parser == Function over every rule]')
{
  const randomCfg = () => ({
    bool: () => random() < 0.5,
    int: () => Math.floor(random() * 5) - 1,
    float: () => Math.round(random() * 40 - 10) / 4,
  })
  let compared = 0
  let translatable = 0
  const mismatches = []
  for (const expression of expressions) {
    // A local stands where a value does, never before a call's parenthesis: substituting a function name would make an
    // expression the evaluator never meets (`false && true(true)`).
    const identifiers = String(expression).match(/\b[A-Za-z_]\w*\b(?!\s*\()/g) ?? []
    for (let trial = 0; trial < 40; trial++) {
      const locals = {}
      for (const name of identifiers) locals[name] = random() < 0.5
      const substituted = substituteEnableIf(expression, locals, randomCfg())
      compared++
      if (substituted === null) continue
      translatable++
      const parsed = evaluateBooleanExpression(substituted)
      const reference = viaFunction(substituted)
      if (parsed !== reference) mismatches.push(`${substituted} -> parser ${parsed}, Function ${reference}`)
    }
  }
  console.log(`  ${expressions.length} rules, ${compared} evaluations, ${translatable} translatable`)
  check('there are rules to compare', expressions.length > 100 && translatable > 1000, `${expressions.length} / ${translatable}`)
  check('the parser gives what Function gave, every time', mismatches.length === 0, mismatches.slice(0, 5).join(' | '))
}

console.log('\n[grammar]')
{
  const cases = [
    ['true', true], ['false', false], ['!true', false], ['!!0', false],
    ['true && false || true', true], ['true && (false || false)', false],
    ['1 < 2 && 2 <= 2 && 3 > 2 && 3 >= 4', false], ['0.15 > 0', true], ['.5 == 0.5', true],
    ['1 == true', true], ['2 == true', false], ['0 != false', false],
    ['!(1 > 2) == true', true],
    ['', null], ['true &&', null], ['(true', null], ['true)', null], ['1 = 1', null], ['3 & 1', null], ['1..2', null],
  ]
  for (const [source, expected] of cases) check(`${JSON.stringify(source)} -> ${expected}`, evaluateBooleanExpression(source) === expected, String(evaluateBooleanExpression(source)))
}

console.log('\n[the bound evaluator still disables what upstream does]')
{
  // Measured with Function before the parser replaced it: the defaults disable 55 keys, support on enables the support
  // options, sparse infill at 0% disables the infill pattern.
  const defaults = Object.keys(disabledKeys(makeCfg({})))
  check('the schema defaults disable 55 options', defaults.length === 55, String(defaults.length))
  const withSupport = Object.keys(disabledKeys(makeCfg({ enable_support: true })))
  check('support on enables the support style', defaults.includes('support_style') && !withSupport.includes('support_style'))
  const noInfill = Object.keys(disabledKeys(makeCfg({ sparse_infill_density: '0%' })))
  check('0% infill disables the infill pattern', !defaults.includes('sparse_infill_pattern') && noInfill.includes('sparse_infill_pattern'))
  check('the unbound evaluator disables nothing', Object.keys(makeToggle({}, schema).disabledKeys(makeCfg({}))).length === 0)
}

if (failures) console.log(`\n${failures} CHECK(S) FAILED`)
else console.log('\nALL TOGGLE PARITY CHECKS PASSED')
assert.equal(failures, 0)
