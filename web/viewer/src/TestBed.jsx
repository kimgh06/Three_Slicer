import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import Viewport from './kernel_viewport.jsx'
import SettingsPanel from './settings_panel.jsx'
import './step_loader.js'   // registers the .step/.stp loader — see Prepare.jsx; main.jsx no longer holds it
import {
  printersByVendor, printerSettings, printerKeys, printerDefaultPreset,
  processPresets, filamentPresets, deriveKernelParams,
} from 'three-slicer/settings'

// The embedding surface, driven from outside the component — the thing /slice cannot show, because /slice is a
// host that made one set of choices. Every `panels` and `features` key is a switch here, the preset chain a host
// would run at startup is a picker, and both the settings map and the kernel params it derives are on screen.
//
// The configuration lives in the URL (`?off=sidebar,warmup&ro=printerCard`), which is the point: a viewer bug
// reproduces by sending a link rather than by describing which toggles to flip.

const PANELS = ['topBar', 'gizmoRail', 'objectToolbar', 'paintPanel', 'statsCard', 'plateBar', 'emptyHint',
  'status', 'bedWarn', 'sidebar', 'printerCard', 'filamentCard', 'objectList', 'towerCard', 'previewControls',
  'processCard', 'sliceBar']
// Only these take 'readonly' (types/viewer.d.ts LockablePanel) — the rest are on/off, so their third state is
//  not offered rather than offered and ignored.
const LOCKABLE = new Set(['sidebar', 'printerCard', 'filamentCard', 'objectList', 'towerCard',
  'previewControls', 'processCard', 'sliceBar'])

// Two of the six are read once, in a mount-only effect: features.warmup by the slice hook and features.contextMenu
//  by the scene setup. Flipping either has to remount the component to mean anything, so the Viewport `key` below
//  is built from exactly those two — the other four take effect on the next render and must NOT remount, or every
//  toggle would throw the loaded scene away.
const FEATURES = [
  ['shortcuts', 'window keyboard bindings'],
  ['warmup', 'load the WASM kernel on mount', 'remount'],
  ['drop', 'drag and drop onto the canvas'],
  ['filePicker', 'the file dialog'],
  ['contextMenu', 'right-click menu', 'remount'],
  ['logs', 'console output (viewer + worker)'],
]
const MOUNT_ONLY = FEATURES.filter(f => f[2]).map(f => f[0])
const FEATURE_KEYS = FEATURES.map(f => f[0])

// A preset only writes the keys it sets, so switching one without clearing its key set first leaves the previous
//  pick's leftovers behind — an ABS material followed by a PLA one keeps ABS's chamber temperature. This is the
//  exact helper the package README prescribes, here so the test bed proves the documented shape works.
const applyPreset = (base, preset, keys, idKey, name) => {
  const next = { ...base }
  for (const key of keys) delete next[key]
  Object.assign(next, preset)
  // The cards record which preset is active under these upstream keys, and the preset-file save reads them to
  //  name its output and to decide between a bare machine .json and an .orca_printer bundle. A test bed that
  //  applied the values but not the id would quietly behave differently from the UI it is meant to stand in for —
  //  measured: the same Save produced "Custom printer.json" here and the full bundle from the card.
  if (idKey) next[idKey] = name
  return next
}

const parseList = (text) => new Set((text ?? '').split(',').map(s => s.trim()).filter(Boolean))

export default function TestBed() {
  const [params, setParams] = useSearchParams()
  const off = useMemo(() => parseList(params.get('off')), [params])
  const readonly = useMemo(() => parseList(params.get('ro')), [params])

  const [settings, setSettings] = useState({})
  const [events, setEvents] = useState([])
  const [saves, setSaves] = useState([])
  const [swallow, setSwallow] = useState(false)  // off by default: a save that silently vanishes reads as broken, not as the onExport demo
  const [gcode, setGcode] = useState(null)
  const [sl1, setSl1] = useState(null)          // the File itself — a stable identity is what the prop asks for
  // The `files` prop is read once on mount, so applying a new pick means a remount — `n` rides on the mount key.
  const [initialFiles, setInitialFiles] = useState({ list: null, n: 0 })
  const [show, setShow] = useState('')          // which inspector is open
  const eventsRef = useRef(null)

  // ---- presets: the chain a host runs at startup -----------------------------------------------------------
  const [catalog, setCatalog] = useState(null)  // {proc, fil} — both artifacts load on demand
  const [printer, setPrinter] = useState('')
  const [process, setProcess] = useState('')
  const [filament, setFilament] = useState('')
  // Applying at MOUNT is a different code path from applying afterwards: the plate grid is laid out from the bed
  //  the component currently knows about, so a bed that arrives later moves the grid under everything already
  //  placed. The toggle exists to make that difference visible rather than to hide it.
  const [atMount, setAtMount] = useState(true)

  useEffect(() => {
    Promise.all([processPresets(), filamentPresets()]).then(([proc, fil]) => setCatalog({ proc, fil }))
  }, [])

  const vendors = useMemo(() => Object.keys(printersByVendor).sort(), [])
  const processList = useMemo(
    () => (catalog && printer ? catalog.proc.listFor(printer) : []), [catalog, printer])
  const filamentList = useMemo(() => {
    if (!catalog || !printer) return []
    const recommended = catalog.fil.recommendedFor(printer)
    return recommended.length ? recommended : catalog.fil.listFor(printer)
  }, [catalog, printer])

  const pickPrinter = (name) => {
    setPrinter(name)
    if (!name) return
    const recommended = printerDefaultPreset(name)
    setProcess(recommended); setFilament('')
    setSettings(s => {
      let next = applyPreset(s, printerSettings(name), printerKeys, 'printer_settings_id', name)
      if (catalog && recommended) next = applyPreset(next, catalog.proc.settingsFor(recommended), catalog.proc.keys, 'print_settings_id', recommended)
      return next
    })
  }
  const pickProcess = (name) => {
    setProcess(name)
    if (catalog && name) setSettings(s => applyPreset(s, catalog.proc.settingsFor(name), catalog.proc.keys, 'print_settings_id', name))
  }
  const pickFilament = (name) => {
    setFilament(name)
    if (catalog && name) setSettings(s => applyPreset(s, catalog.fil.settingsFor(name), catalog.fil.keys, 'filament_settings_id', name))
  }

  // ---- url-backed switches ---------------------------------------------------------------------------------
  const writeParams = (nextOff, nextRo) => {
    const query = {}
    if (nextOff.size) query.off = [...nextOff].join(',')
    if (nextRo.size) query.ro = [...nextRo].join(',')
    setParams(query, { replace: true })
  }
  const toggleFeature = (key) => {
    const next = new Set(off)
    next.has(key) ? next.delete(key) : next.add(key)
    writeParams(next, readonly)
  }
  // on -> readonly -> off -> on, for a lockable panel; on <-> off for the rest.
  const cyclePanel = (key) => {
    const nextOff = new Set(off), nextRo = new Set(readonly)
    if (off.has(key)) { nextOff.delete(key); nextRo.delete(key) }
    else if (readonly.has(key)) { nextRo.delete(key); nextOff.add(key) }
    else if (LOCKABLE.has(key)) nextRo.add(key)
    else nextOff.add(key)
    writeParams(nextOff, nextRo)
  }
  const panelState = (key) => (off.has(key) ? 'off' : readonly.has(key) ? 'readonly' : 'on')

  const panels = useMemo(() => {
    const out = {}
    for (const key of PANELS) {
      if (off.has(key)) out[key] = false
      else if (readonly.has(key) && LOCKABLE.has(key)) out[key] = 'readonly'
    }
    return out
  }, [off, readonly])
  const features = useMemo(
    () => Object.fromEntries(FEATURE_KEYS.filter(k => off.has(k)).map(k => [k, false])), [off])

  // The mount key also carries whether presets are applied at mount, so flipping that re-runs the first render
  //  with the settings already in place — which is the case being tested.
  const mountKey = MOUNT_ONLY.map(k => (off.has(k) ? '0' : '1')).join('') + (atMount ? `+${printer}${process}` : '')
    + `+files${initialFiles.n}`

  const kernelParams = useMemo(() => { try { return deriveKernelParams(settings) } catch { return {} } }, [settings])

  const push = (line) => setEvents(prev => [`${new Date().toISOString().slice(11, 23)}  ${line}`, ...prev].slice(0, 200))
  useEffect(() => { if (eventsRef.current) eventsRef.current.scrollTop = 0 }, [events])

  // One picker for both injection props, routed on the extension — which is also how the exclusivity gets
  //  enforced rather than described: picking one clears the other, so "both set" cannot be built from here.
  const onInjectFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.name.toLowerCase().endsWith('.sl1')) { setSl1(file); setGcode(null) }
    else { setGcode(await file.text()); setSl1(null) }
  }

  const onInitialFiles = (event) => {
    const list = Array.from(event.target.files || [])
    event.target.value = ''
    if (list.length) setInitialFiles(prev => ({ list, n: prev.n + 1 }))
  }

  return (
    <div className="tb">
      <aside className="tb-side">
        <h1>Test bed</h1>
        <p className="tb-note">
          Every switch is a prop on <code>&lt;Viewport/&gt;</code>. The URL holds the configuration —
          copy it to reproduce this exact setup.
        </p>

        <h2>presets <span className="tb-dim">what a host sets up front</span></h2>
        {!catalog && <div className="tb-line">loading the process and filament catalogs…</div>}
        <select value={printer} onChange={e => pickPrinter(e.target.value)}>
          <option value="">— printer —</option>
          {vendors.map(vendor => (
            <optgroup key={vendor} label={vendor}>
              {Object.keys(printersByVendor[vendor]).sort().map(name => <option key={name} value={name}>{name}</option>)}
            </optgroup>
          ))}
        </select>
        <select value={process} onChange={e => pickProcess(e.target.value)} disabled={!processList.length}>
          <option value="">— process ({processList.length}) —</option>
          {processList.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <select value={filament} onChange={e => pickFilament(e.target.value)} disabled={!filamentList.length}>
          <option value="">— filament ({filamentList.length}) —</option>
          {filamentList.map(m => <option key={m.name} value={m.name}>{m.name}{m.type ? ` · ${m.type}` : ''}</option>)}
        </select>
        <label className="tb-row">
          <input type="checkbox" checked={atMount} onChange={e => setAtMount(e.target.checked)} />
          <span className="tb-dim">apply at mount (remounts — the other path is applying them live)</span>
        </label>
        <div className="tb-line">
          settings <b>{Object.keys(settings).length}</b> keys · kernel params <b>{Object.keys(kernelParams).length}</b>
          <button onClick={() => setShow(show === 'settings' ? '' : 'settings')}>settings</button>
          <button onClick={() => setShow(show === 'kernel' ? '' : 'kernel')}>params</button>
          <button onClick={() => { setSettings({}); setPrinter(''); setProcess(''); setFilament('') }}>reset</button>
        </div>
        {show && (
          <pre className="tb-log tb-json">
            {JSON.stringify(show === 'settings' ? settings : kernelParams, null, 1)}
          </pre>
        )}

        <h2>features <span className="tb-dim">behaviour</span></h2>
        {FEATURES.map(([key, what, remount]) => (
          <label key={key} className="tb-row">
            <input type="checkbox" checked={!off.has(key)} onChange={() => toggleFeature(key)} />
            <span className="tb-key">{key}</span>
            <span className="tb-dim">{what}{remount ? ' · remounts' : ''}</span>
          </label>
        ))}

        <h2>panels <span className="tb-dim">click to cycle · ● on ◐ readonly ○ off</span></h2>
        <div className="tb-grid">
          {PANELS.map(key => {
            const state = panelState(key)
            return (
              <button key={key} className={`tb-panel tb-${state}`} onClick={() => cyclePanel(key)}
                title={LOCKABLE.has(key) ? 'on → readonly → off' : 'on → off (not lockable)'}>
                <span className="tb-mark">{state === 'on' ? '●' : state === 'readonly' ? '◐' : '○'}</span>
                {key}
              </button>
            )
          })}
        </div>

        <h2>onExport</h2>
        <label className="tb-row">
          <input type="checkbox" checked={swallow} onChange={e => setSwallow(e.target.checked)} />
          <span className="tb-dim">intercept saves instead of downloading</span>
        </label>
        {saves.map((s, i) => <div key={i} className="tb-line">💾 {s}</div>)}

        <h2>files <span className="tb-dim">mount-time import (remounts) — models, .sl1, presets</span></h2>
        <input type="file" multiple onChange={onInitialFiles}
          accept=".stl,.obj,.3mf,.amf,.ply,.step,.stp,.sl1,.json,.orca_printer,.orca_bundle,.orca_filament,.zip" />
        {initialFiles.list && (
          <div className="tb-line">
            {initialFiles.list.map(f => f.name).join(', ')}{' '}
            <button onClick={() => setInitialFiles(prev => ({ list: null, n: prev.n + 1 }))}>clear</button>
          </div>
        )}

        <h2>inject <span className="tb-dim">render without slicing — .gcode (FFF) / .sl1 (SLA)</span></h2>
        <input type="file" accept=".gcode,.gco,.g,.nc,.sl1,text/plain" onChange={onInjectFile} />
        {gcode && (
          <div className="tb-line">
            gcode: {(gcode.length / 1e6).toFixed(2)} MB <button onClick={() => setGcode(null)}>clear</button>
          </div>
        )}
        {sl1 && (
          <div className="tb-line">
            sl1: {sl1.name} — {(sl1.size / 1e6).toFixed(2)} MB <button onClick={() => setSl1(null)}>clear</button>
          </div>
        )}

        <h2>onEvent / onSliced</h2>
        <button onClick={() => setEvents([])}>clear log</button>
        <div className="tb-log" ref={eventsRef}>
          {events.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </aside>

      <main className="tb-main">
        <Viewport
          key={mountKey}
          settings={settings} setSettings={setSettings}
          panels={panels} features={features}
          gcode={gcode} sl1={sl1} files={initialFiles.list}
          processPanel={<SettingsPanel embedded settings={settings} setSettings={setSettings} />}
          motionPanel={<SettingsPanel embedded settings={settings} setSettings={setSettings}
            only={{ builder: 'TabPrinter::build_kinematics_page' }} />}
          filamentPanel={(filamentSettings, setFilamentSettings) => (
            <SettingsPanel embedded settings={filamentSettings} setSettings={setFilamentSettings}
              only={{ builder: 'TabFilament::build' }} />
          )}
          onEvent={e => push(`${e.type}: ${JSON.stringify(e.value)}`)}
          onSliced={r => push(`onSliced: plate ${r.plate}, ${r.stats.layers} layers, ${r.gcode.length} chars`
            + (r.throughput ? `, ${Math.round(r.throughput.ms)}ms @ ${Math.round(r.throughput.layersPerSecond)} layers/s` : ''))}
          onExport={(file, filename) => {
            setSaves(prev => [`${filename} — ${(file.size / 1e6).toFixed(2)} MB (${file.type})`, ...prev].slice(0, 8))
            push(`onExport: ${filename} ${file.size} bytes`)
            return swallow            // falsy lets the browser download it as well
          }}
        />
      </main>
    </div>
  )
}
