// three-slicer-viewer/toggle — partial evaluation of enable_if expressions. Ships unbound (no rules: nothing
// disables); three-slicer/toggle binds upstream's toggle-rules.json and the full schema through makeToggle().
import type { SlicerSettings } from './settings-keys.d.ts'

/** Settings accessor — schema default when a value is missing, [0] for vector types. */
export interface ToggleCfg {
  bool(key: string): boolean
  int(key: string): number
  float(key: string): number
  /** Whether the key exists in config-schema */
  has(key: string): boolean
}

export function makeCfg(settings: SlicerSettings | null | undefined): ToggleCfg

/**
 * Evaluates a single enable_if expression. Untranslatable expressions return `null` (= fail-open, stays enabled) —
 * make sure to treat that as distinct from `false`.
 */
export function evalEnableIf(expr: string, locals: Record<string, unknown>, cfg: ToggleCfg): boolean | null

/** Keys that must be disabled under the current settings -> the enable_if expression that disabled them. Only rules that are unambiguously false. */
export function disabledKeys(cfg: ToggleCfg): Record<string, string>

/** Bind the evaluator to a rule set and a schema. `three-slicer/toggle` is `makeToggle(toggleRules, schema)`. */
export function makeToggle(rules?: Record<string, { rules?: Array<{ enable_if?: string; fields?: string[] }> }>, schema?: Record<string, { default?: unknown }>): {
  makeCfg(settings: SlicerSettings | null | undefined): ToggleCfg
  disabledKeys(cfg: ToggleCfg): Record<string, string>
  evalEnableIf(expr: string, locals: Record<string, unknown>, cfg: ToggleCfg): boolean | null
}
