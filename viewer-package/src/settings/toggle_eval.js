// Stage 25 S5.1: partial translation of toggle-rules — upstream C++ toggle_options conditions (enable_if) -> JS.
//  Scope: among the rules touching keys the viewer handles, only those "fully" translatable with the hardcoded locals below.
//  Untranslatable ones (unknown locals, enum comparisons, …) fail open (stay enabled) — avoids wrongly disabling (honest partial implementation).
//  Translating all 907 keys / 231 rules is out of scope (noted in the README). Reference: toggle_print_fff_options.locals in toggle-rules.json.
import { leanSchema } from './data.js'

/**
 * The evaluator bound to a rule set and a schema. This package ships NO rules: toggle-rules.json is extracted from
 * upstream's toggle_options logic and stays with the AGPL package, which binds it and re-exports the result as
 * `three-slicer/toggle`. Bound to nothing, disabledKeys() disables nothing — every field stays enabled.
 */
export function makeToggle(toggles = {}, schema = leanSchema) {
// Settings value accessor (settings map first, schema default otherwise). Percentages ("15%") become numbers.
function makeCfg(settings) {
  const val = k => {
    let v
    if (settings) v = settings[k]
    if (v === undefined || v === '') {
      const d = schema[k]?.default
      v = d
      if (Array.isArray(d)) v = d[0]
    }
    return v
  }
  const num = k => {
    const n = parseFloat(val(k))
    if (!Number.isFinite(n)) return 0
    return n
  }
  return {
    bool: k => { const v = val(k); return v === true || v === 1 || v === '1' || v === 'true' },
    int: k => Math.trunc(num(k)),
    float: k => num(k),
    has: k => k in schema,
  }
}

// Upstream locals translated inline (viewer-related conditions only). Each value is a boolean.
function makeLocals(cfg) {
  const have_raft = cfg.int('raft_layers') > 0
  const has_spiral_vase = cfg.bool('spiral_mode')
  const has_top_shell = cfg.int('top_shell_layers') > 0 || (has_spiral_vase && cfg.int('bottom_shell_layers') > 1)
  const has_bottom_shell = cfg.int('bottom_shell_layers') > 0
  return {
    have_raft,
    have_perimeters: cfg.int('wall_loops') > 0,
    have_infill: cfg.float('sparse_infill_density') > 0,
    has_spiral_vase,
    has_top_shell,
    has_bottom_shell,
    has_solid_infill: has_top_shell || has_bottom_shell,
    have_skirt: cfg.int('skirt_loops') > 0,
    have_support_material: cfg.bool('enable_support') || have_raft,
    have_support_interface: cfg.int('support_interface_top_layers') > 0 || cfg.int('support_interface_bottom_layers') > 0,
    have_prime_tower: cfg.bool('enable_prime_tower'),
  }
}

// Map of keys disabled under the current settings { key: condition }. Only rules that are unambiguously false.
function disabledKeys(cfg) {
  const locals = makeLocals(cfg)
  const groups = ['toggle_print_fff_options', 'toggle_filament_options', 'toggle_printer_options',
    'TabFilament::toggle_options', 'TabPrinter::toggle_options']
  const out = {}
  for (const gname of groups) {
    const g = toggles[gname]
    if (!g || !Array.isArray(g.rules)) continue
    for (const rule of g.rules) {
      if (!rule.enable_if || !Array.isArray(rule.fields)) continue
      const en = evalEnableIf(rule.enable_if, locals, cfg)
      if (en === false) for (const k of rule.fields) if (!(k in out)) out[k] = rule.enable_if
    }
  }
  return out
}
return { makeCfg, disabledKeys, evalEnableIf }
}

// Evaluates enable_if (up to the first comma) to a boolean. Returns null (= stays enabled) when not fully translatable.
export function evalEnableIf(expr, locals, cfg) {
  const substituted = substituteEnableIf(expr, locals, cfg)
  if (substituted === null) return null
  return evaluateBooleanExpression(substituted)
}

// enable_if with every config read and local replaced by its value, or null when something is left that is not a
// boolean expression of values.
export function substituteEnableIf(expr, locals, cfg) {
  let s = String(expr).split(',')[0].trim()
  if (!s) return null
  // Direct config access pattern -> value substitution
  s = s.replace(/config->opt_bool\(\s*"([^"]+)"\s*\)/g, (_, k) => String(cfg.bool(k)))
  s = s.replace(/config->opt_int\(\s*"([^"]+)"\s*\)/g, (_, k) => String(cfg.int(k)))
  s = s.replace(/config->opt_float\(\s*"([^"]+)"\s*\)/g, (_, k) => String(cfg.float(k)))
  // Substitute known locals (longest name first — prevents partial matches)
  for (const name of Object.keys(locals).sort((a, b) => b.length - a.length))
    s = s.replace(new RegExp('\\b' + name + '\\b', 'g'), String(!!locals[name]))
  // Check the remaining string is a safe boolean expression (only true/false/numbers/operators/parens) — otherwise unknown -> null
  const stripped = s.replace(/\btrue\b|\bfalse\b/g, '1')
  if (!/^[\s()!<>=&|0-9.]*$/.test(stripped)) return null
  return s
}

// After substitution an enable_if is a C++ boolean expression over true/false and numbers, which the check above
// narrows to ! && || == != < > <= >= and parentheses. It is parsed here rather than handed to Function(): a page whose
// CSP has no 'unsafe-eval' refuses Function, and the browser extension's does, so every option stayed enabled there
// (measured: 3 fields disabled on the site, 0 in the extension, 564 CSP violations). The operators keep JavaScript's
// semantics, loose == included, so the result is the one Function gave (test_toggle_parity.mjs, every upstream rule).
// Anything else the check lets through (a lone = & |, a malformed number) is not translatable: null, as before.
const EXPRESSION_TOKEN = /\s*(\d+\.?\d*|\.\d+|true|false|&&|\|\||==|!=|<=|>=|[()!<>])/y
const COMPARE = {
  '==': (left, right) => left == right,   // eslint-disable-line eqeqeq
  '!=': (left, right) => left != right,   // eslint-disable-line eqeqeq
  '<': (left, right) => left < right,
  '>': (left, right) => left > right,
  '<=': (left, right) => left <= right,
  '>=': (left, right) => left >= right,
}
const EQUALITY = ['==', '!=']
const RELATIONAL = ['<', '>', '<=', '>=']

function tokenize(source) {
  const tokens = []
  EXPRESSION_TOKEN.lastIndex = 0
  while (EXPRESSION_TOKEN.lastIndex < source.length) {
    if (!source.slice(EXPRESSION_TOKEN.lastIndex).trim()) break
    const match = EXPRESSION_TOKEN.exec(source)
    if (!match) return null
    tokens.push(match[1])
  }
  return tokens
}

// Recursive descent in C++ precedence: || < && < == != < relational < unary !.
export function evaluateBooleanExpression(source) {
  const tokens = tokenize(source)
  if (!tokens?.length) return null
  let position = 0
  const peek = () => tokens[position]
  const take = () => tokens[position++]
  function primary() {
    const token = take()
    if (token === '(') {
      const value = either()
      if (take() !== ')') throw new SyntaxError('unclosed (')
      return value
    }
    if (token === '!') return !primary()
    if (token === 'true') return true
    if (token === 'false') return false
    if (token !== undefined && /^[\d.]/.test(token)) return Number(token)
    throw new SyntaxError(`unexpected ${token}`)
  }
  function binary(operand, operators) {
    return () => {
      let left = operand()
      while (operators.includes(peek())) {
        const operator = take()
        left = COMPARE[operator](left, operand())
      }
      return left
    }
  }
  const relational = binary(primary, RELATIONAL)
  const equality = binary(relational, EQUALITY)
  function both() {
    let left = equality()
    while (peek() === '&&') {
      take()
      const right = equality()
      left = left && right
    }
    return left
  }
  function either() {
    let left = both()
    while (peek() === '||') {
      take()
      const right = both()
      left = left || right
    }
    return left
  }
  try {
    const value = either()
    if (position !== tokens.length) return null
    return !!value
  } catch {
    return null
  }
}

// The unbound default: nothing disables. `three-slicer/toggle` is the bound one.
const unbound = makeToggle({}, leanSchema)
export const makeCfg = unbound.makeCfg
export const disabledKeys = unbound.disabledKeys
