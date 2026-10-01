// The demo page: the full slicer (printer, filament and process cards with OrcaSlicer's parameter tree), plus a
// connection bar. The integration is the `onExport` prop below and src/octoprint.js — the viewer hands every
// file it would download to `onExport`, and returning true says "handled, do not download".
import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Viewport from 'three-slicer/viewer'
import SettingsPanel from 'three-slicer/components'
import { checkConnection, connectionProblem, isPrintable, uploadGcode } from './octoprint.js'
import './page.css'

const STORAGE_KEY = 'octoprint-demo'
const NO_CONNECTION = { url: '', apiKey: '', print: false }

// The address and key stay in this browser only. A private window or blocked storage starts empty.
function loadConnection() {
  try {
    return { ...NO_CONNECTION, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') }
  } catch {
    return NO_CONNECTION
  }
}

function saveConnection(connection) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(connection))
  } catch {
    // Storage blocked: the values still work for this visit.
  }
}

// The fallback when OctoPrint cannot take the file, run from its own click: the upload outlives the Export
// click's user activation, and a download started after that is blocked as automatic (export_actions.js
// saveWindowOpen in the viewer). The URL is revoked late enough for the browser to finish reading it.
function download({ file, filename }) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(file)
  link.download = filename
  document.body.appendChild(link)
  link.click()
  setTimeout(() => { link.remove(); URL.revokeObjectURL(link.href) }, Math.max(4000, file.size / 10000))
}

const SAMPLE = { url: 'calibration-cube.stl' }

function App() {
  const [settings, setSettings] = useState({})
  const [connection, setConnection] = useState(loadConnection)
  const [status, setStatus] = useState({ kind: 'idle', text: 'Slice, then Export G-code ▾ → Plain .gcode: the file goes to OctoPrint instead of Downloads.' })
  const [sample, setSample] = useState(null)
  const [unsent, setUnsent] = useState(null)   // { file, filename } of a failed upload, offered as a download

  const update = patch => setConnection(previous => {
    const next = { ...previous, ...patch }
    saveConnection(next)
    return next
  })

  const configured = Boolean(connection.url && connection.apiKey)

  const test = async () => {
    const problem = connectionProblem(connection.url, location.protocol)
    if (problem) {
      setStatus({ kind: 'error', text: problem })
      return
    }
    setStatus({ kind: 'busy', text: 'Connecting…' })
    try {
      const version = await checkConnection(connection)
      setStatus({ kind: 'ok', text: `Connected to OctoPrint ${version}.` })
    } catch (error) {
      setStatus({ kind: 'error', text: error.message })
    }
  }

  const onExport = useCallback((file, filename) => {
    // STL, 3mf and .gcode.3mf saves, and every save before a connection is set up, download as usual.
    if (!configured) return false
    if (!isPrintable(filename)) {
      if (filename.endsWith('.gcode.3mf')) {
        setStatus({ kind: 'error', text: `OctoPrint prints plain G-code: use Export G-code ▾ → Plain .gcode. Downloaded ${filename} instead.` })
      }
      return false
    }
    const problem = connectionProblem(connection.url, location.protocol)
    if (problem) {
      setStatus({ kind: 'error', text: `${problem} Downloaded ${filename} instead.` })
      return false
    }
    setUnsent(null)
    setStatus({ kind: 'busy', text: `Uploading ${filename}…` })
    uploadGcode({ ...connection, file, filename })
      .then(() => {
        let text = `${filename} uploaded to OctoPrint.`
        if (connection.print) text = `${filename} uploaded — printing.`
        setStatus({ kind: 'ok', text })
      })
      .catch(error => {
        setStatus({ kind: 'error', text: error.message })
        setUnsent({ file, filename })
      })
    return true
  }, [configured, connection])

  // `files` is read once at mount, so the viewer waits for the sample's bytes. A failed fetch still mounts it.
  useEffect(() => {
    fetch(SAMPLE.url)
      .then(response => response.arrayBuffer())
      .then(data => setSample([{ name: SAMPLE.url, data }]))
      .catch(() => setSample([]))
  }, [])

  return (
    <div className="page">
      <header className="bar">
        <strong className="brand">Send to OctoPrint</strong>
        <label>
          <span>Address</span>
          <input
            type="url" placeholder="http://octopi.local" value={connection.url}
            onChange={event => update({ url: event.target.value.trim() })}
          />
        </label>
        <label>
          <span>API key</span>
          <input
            type="password" autoComplete="off" value={connection.apiKey}
            onChange={event => update({ apiKey: event.target.value.trim() })}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={connection.print} onChange={event => update({ print: event.target.checked })} />
          <span>Start printing after upload</span>
        </label>
        <button type="button" onClick={test} disabled={!configured}>Test connection</button>
        <p className={`status status-${status.kind}`} role="status">
          {status.text}
          {unsent && <button type="button" className="inline" onClick={() => download(unsent)}>Download {unsent.filename}</button>}
        </p>
      </header>

      <main className="frame">
        {sample && <Viewport
          files={sample}
          settings={settings}
          setSettings={setSettings}
          onExport={onExport}
          processPanel={(panelSettings, setPanelSettings) =>
            <SettingsPanel embedded settings={panelSettings} setSettings={setPanelSettings} />}
          filamentPanel={(filamentSettings, setFilamentSettings) =>
            <SettingsPanel embedded settings={filamentSettings} setSettings={setFilamentSettings}
              only={{ builder: 'TabFilament::build' }} />}
        />}
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
