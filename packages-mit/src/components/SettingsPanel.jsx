// three-slicer/components — <SettingsPanel/> : config-schema-driven slicer settings form.
// Independent & props-driven: NO global state, NO React context, NO router. Depends only on React,
// @three-slicer/data (schema/ui-tree/toggle-rules), and three-slicer (settingRaw/disabledKeys/makeCfg).
// Props:
//   settings     : sparse map {optKey: value} (edited keys only; missing = schema default)
//   setSettings  : (updater) => void   (React setState-style; the ONLY way state leaves the component)
//   onOptionOpen : (optKey) => void    (optional; label click — deep-link/detail. Omit → plain labels,
//                  which is what apps/independence-check does to prove zero router coupling.)
import React, { useMemo, useState } from 'react'
import ShadowHost from './shadow_host.jsx'
import shadowCss from './styles.css?inline'   // Shadow DOM isolation — inlined as a string at build time
import BedShapeEditor from './BedShapeEditor.jsx'
import { leanSchema, uiTreeKeys } from 'three-slicer-viewer/data'

// Custom widget registry — the equivalent of upstream Tab.cpp's line widget substitution (create_bed_shape_widget).
//  Composite types that schema-driven widgets cannot express are overridden by the editors registered here.
//  Consumers can add/replace them via <SettingsPanel customWidgets={{key: Component}}/>.
const CUSTOM_WIDGETS = {
  printable_area: BedShapeEditor,
}
import { settingRaw, printerTechnology } from 'three-slicer-viewer/settings'
import { disabledKeys, makeCfg } from 'three-slicer-viewer/toggle'
import { UNKNOWN_COLOR } from '../core/viewer_defaults.js'
import { THEME_CSS } from '../core/theme.js'

const MODES = ['all', 'simple', 'advanced', 'expert', 'develop']
const builderLabel = b => b.replace('::build', '').replace('Tab', '').replace('_sla', ' (SLA)')
// The ui-tree is keyed by upstream's own builder names, and upstream spells the technology into them
//  (TabSLAPrint, TabPrinter::build_sla vs build_fff) — so the name IS the supports_printer_technology()
//  declaration, and matching it is the whole port of that virtual.
const builderTech = b => (/SLA|build_sla\b/.test(b) ? 'SLA' : 'FFF')

// The three data props and their defaults. This package ships no upstream text: `leanSchema` carries types,
//  defaults, enum values, layout flags and units but no label or tooltip, so a field is labelled by its key;
//  the default tree is one flat page per builder; and the unbound toggle disables nothing. `three-slicer/components`
//  passes the full schema, the real ui-tree and the rule-bound toggle, which is what makes the desktop panel read
//  as it does. A host with its own labels (a translation, its own vocabulary) passes its own schema.
const DEFAULT_TREE = Object.fromEntries(Object.entries(uiTreeKeys)
  .map(([builder, keys]) => [builder, keys.length ? [{ page: 'Settings', groups: [{ group: builderLabel(builder), options: keys }] }] : []]))
const UNBOUND_TOGGLE = { makeCfg, disabledKeys }
const mainBuilders = (uiTree) => Object.keys(uiTree).filter(b => uiTree[b].length > 0)

function isDirty(schema, settings, key) {
  if (!settings || !(key in settings)) return false
  const d = schema[key]?.default
  const def = Array.isArray(d) ? d[0] : d
  return String(settings[key]) !== String(def ?? '')
}
function passesMode(schema, k, mode) {
  if (mode === 'all' || k.startsWith('<')) return true
  const m = schema[k]?.mode
  if (mode === 'simple') return m === 'simple'
  if (mode === 'advanced') return m === 'simple' || m === 'advanced'
  return true
}
function widgetFor(def) {
  if (!def) return 'unknown'
  if (def.gui_type === 'color') return 'color'
  if (def.enum_values) return 'select'
  if (def.type === 'coBool' || def.type === 'coBools') return 'checkbox'
  if (def.multiline || def.is_code) return 'textarea'
  if (def.type === 'coPoints' || def.type === 'coPoint') return 'points'
  return 'input'
}
function ModeBadge({ mode }) { return <span className={`badge mode-${mode ?? 'none'}`}>{mode ?? '—'}</span> }

function EditableWidget({ def, optKey, settings, setSettings, disabled, customWidgets }) {
  const raw = settingRaw(settings, optKey)
  const set = v => setSettings(s => ({ ...s, [optKey]: v }))
  const Custom = customWidgets?.[optKey] ?? CUSTOM_WIDGETS[optKey]
  if (Custom) return <Custom def={def} value={raw} onChange={set} disabled={disabled} />
  const kind = widgetFor(def)
  const scalar = Array.isArray(raw) ? raw[0] : raw
  switch (kind) {
    case 'select':
      return (<select value={scalar ?? ''} onChange={e => set(e.target.value)} disabled={disabled}>
        {def.enum_values.map((v, i) => <option key={v} value={v}>{def.enum_labels?.[i] ?? v}</option>)}
      </select>)
    case 'checkbox':
      return <input type="checkbox" checked={Array.isArray(raw) ? !!raw[0] : !!raw} onChange={e => set(e.target.checked)} disabled={disabled} />
    case 'color':
      return <input type="color" value={typeof scalar === 'string' && scalar.startsWith('#') ? scalar : UNKNOWN_COLOR} onChange={e => set(e.target.value)} disabled={disabled} />
    case 'textarea':
      return <textarea rows={2} value={Array.isArray(raw) ? raw.join('\n') : (raw ?? '')} onChange={e => set(e.target.value)} disabled={disabled} />
    case 'points':
      return <code className="pts">{JSON.stringify(raw ?? [])}</code>
    case 'unknown':
      return <span className="muted">No schema</span>
    default:
      return (<span className="inputwrap">
        <input value={scalar ?? ''} onChange={e => set(e.target.value)} disabled={disabled} />
        {def.sidetext && <span className="unit">{def.sidetext}</span>}
      </span>)
  }
}

function EditableOptionRow({ schema, optKey, settings, setSettings, disabled, onOptionOpen, customWidgets, overridden, onRevertKey }) {
  if (optKey.startsWith('<')) return <div className="row custom"><span className="muted">⚙ Custom widget {optKey}</span></div>
  const def = schema[optKey]
  const cond = disabled ? disabled[optKey] : undefined
  const off = cond != null
  const dirty = isDirty(schema, settings, optKey)
  const reset = () => setSettings(s => { const n = { ...s }; delete n[optKey]; return n })
  const label = def?.label || def?.full_label || optKey
  return (
    <div className={'row' + (off ? ' disabled' : '')} title={off ? `Disabled when: ${cond}` : (def?.tooltip ?? '')} data-testid={`row-${optKey}`}>
      <span className="lbl-cell">
        {overridden && <button type="button" className="override-dot" onClick={() => onRevertKey?.(optKey)}
          title="This plate's override — click to follow the global value again" data-testid={`override-${optKey}`} />}
        {dirty && <span className="dirty-dot" title="Changed from default" data-testid={`dirty-${optKey}`} />}
        {onOptionOpen
          ? <button type="button" className="lbl lbl-link" onClick={() => onOptionOpen(optKey)} title="Details">{label}</button>
          : <span className="lbl">{label}</span>}
      </span>
      <code className="key">{optKey}</code>
      <ModeBadge mode={def?.mode} />
      <span className="widget-cell">
        <EditableWidget def={def} optKey={optKey} settings={settings} setSettings={setSettings} disabled={off} customWidgets={customWidgets} />
        {dirty && <button className="reset-btn" onClick={reset} title="Reset to default" data-testid={`reset-${optKey}`}>↺</button>}
      </span>
    </div>
  )
}

// `only` pins the panel to one builder (optionally one page) and drops the search/group/page/mode chrome,
//  so a host can embed a single page — e.g. the printer's Motion ability — inside another card.
export default function SettingsPanel({ schema = leanSchema, uiTree = DEFAULT_TREE, toggle = UNBOUND_TOGGLE,
  settings, setSettings, onOptionOpen, embedded = false, customWidgets, only, overriddenKeys, onRevertKey }) {
  const MAIN_BUILDERS = useMemo(() => mainBuilders(uiTree), [uiTree])
  const [builder, setBuilder] = useState(only?.builder ?? MAIN_BUILDERS[0] ?? '')
  const [pageIdx, setPageIdx] = useState(0)
  const [mode, setMode] = useState('all')
  const [query, setQuery] = useState('')
  // Builders are filtered by the printer profile's technology — FFF tabs for a filament printer, the SLA tabs
  //  for a resin one. When the technology flips, the selected builder may no longer be offered; the render falls
  //  back to the first offered one rather than writing state during render. `only` bypasses the filter: a host
  //  that pinned one page keeps it regardless of what the profile says.
  const tech = printerTechnology(settings)
  const builders = MAIN_BUILDERS.filter(b => builderTech(b) === tech)
  const activeBuilder = only?.builder ?? (builders.includes(builder) ? builder : builders[0] ?? '')
  const allPages = uiTree[only?.builder ?? activeBuilder] ?? []
  const pages = only?.page ? allPages.filter(p => p.page === only.page) : allPages
  const page = pages[Math.min(pageIdx, pages.length - 1)]
  const disabled = useMemo(() => toggle.disabledKeys(toggle.makeCfg(settings)), [settings, toggle])
  const q = query.trim().toLowerCase()
  const hits = useMemo(() => {
    if (!q) return []
    return Object.entries(schema)
      .filter(([k, d]) => k.includes(q) || d.label?.toLowerCase().includes(q) || d.full_label?.toLowerCase().includes(q))
      .slice(0, 60).map(([k]) => k)
  }, [q])
  const row = (k, i) => <EditableOptionRow schema={schema} key={k + i} optKey={k} settings={settings} setSettings={setSettings} disabled={disabled} onOptionOpen={onOptionOpen} customWidgets={customWidgets}
    overridden={overriddenKeys?.includes(k)} onRevertKey={onRevertKey} />
  return (
    <ShadowHost css={THEME_CSS + shadowCss} className={embedded ? 'sp-embedded' : undefined}>
    <div className="settings-panel">
      {!only && <div className="sp-top">
        <input className="sp-search" placeholder={`Search options (${Object.keys(schema).length})…`} value={query} onChange={e => setQuery(e.target.value)} data-testid="opt-search" />
        {!q && (<>
          <label className="sp-builder"><span>Settings group</span>
            <select value={activeBuilder} onChange={e => { setBuilder(e.target.value); setPageIdx(0) }}>
              {builders.map(b => <option key={b} value={b}>{builderLabel(b)}</option>)}
            </select>
          </label>
          <div className="sp-pages">
            {pages.map((p, i) => <button key={p.page + i} className={i === Math.min(pageIdx, pages.length - 1) ? 'on' : ''} onClick={() => setPageIdx(i)}>{p.page}</button>)}
          </div>
          <div className="sp-modes">
            {MODES.map(m => <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{m}</button>)}
          </div>
        </>)}
      </div>}
      <div className="sp-body">
        {q ? (
          <section data-testid="search-results">
            <h3>Search: “{query}” — {hits.length} hit{hits.length === 1 ? '' : 's'}{hits.length === 60 ? '+' : ''}</h3>
            {hits.map(row)}
            {!hits.length && <p className="muted">No matches</p>}
          </section>
        ) : page ? (<>
          {!only && <h2>{page.page} <span className="muted">Tab.cpp:{page.line}</span></h2>}
          {page.groups.map(g => {
            // Embedded in a host card there is no room for the unimplemented-widget placeholders — drop them there.
            const opts = g.options.filter(k => passesMode(schema, k, mode) && !(only && k.startsWith('<')))
            if (!opts.length) return null
            return (<section key={g.group + g.line}>
              <h3>{g.group || '(untitled group)'} <span className="muted">:{g.line}</span></h3>
              {opts.map(row)}
            </section>)
          })}
        </>) : <p className="muted">No builder</p>}
      </div>
    </div>
    </ShadowHost>
  )
}
