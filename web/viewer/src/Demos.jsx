import React, { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { REPO } from './repo.js'
import SiteNav from './SiteNav.jsx'

// The demos are separate npm projects under examples/. `npm run demos` builds them into
// public/demos/<name>/ and writes the manifest this page reads; without that step the page says so
// rather than showing four broken frames.
//
// They run in an iframe, not re-implemented here, so what you see is the real build: its own worker,
// its own kernel, its own settings. Same-origin, and this app serves COOP/COEP, so the frame inherits
// cross-origin isolation and the demos get the multithreaded kernel.


// Absolute, and built from the app's own base — a relative 'demos/…' resolves differently at /demos and
// /demos/ (the trailing slash makes it /demos/demos/…), and this page is reachable both ways.
const ASSETS = `${import.meta.env.BASE_URL}demos/`

const CATALOG = {
  'instant-quote': {
    title: 'Instant Quote',
    sells: 'Headless slicing',
    blurb: 'Slice in the browser, price the result. No viewer, no React — the SDK on its own.',
    surfaces: ['client', 'settings', 'viewer/loaders', 'viewer/toolpath'],
  },
  'printer-showcase': {
    title: 'Printer Showcase',
    sells: 'Drop-in embed',
    blurb: 'A product page with a slicer in it. Three machines, host-owned settings, Shadow DOM isolation.',
    surfaces: ['viewer', 'settings'],
  },
  'cad-embed': {
    title: 'CAD Embed',
    sells: 'Programmable engine',
    blurb: 'Move a slider, get print time back. Debounced re-slicing with a generation guard.',
    surfaces: ['client', 'settings', 'toggle', 'viewer/toolpath'],
  },
  'farm-dashboard': {
    title: 'Print Farm',
    sells: 'Client-side compute',
    blurb: 'Queue jobs for several printers. Slicing happens here; a backend would only hold G-code.',
    surfaces: ['client', 'settings', 'viewer/gcode', 'viewer/toolpath'],
  },
}

const ORDER = ['instant-quote', 'printer-showcase', 'cad-embed', 'farm-dashboard']

export default function Demos() {
  const [manifest, setManifest] = useState(null)
  const [source, setSource] = useState('')
  const [copied, setCopied] = useState(false)

  // Which demo is open lives in the URL, so one can be linked to directly. `replace` on the default pick
  // keeps the back button pointing at wherever the visitor came from rather than at this same page.
  const [params, setParams] = useSearchParams()
  const selected = params.get('d')
  const select = (name, replace = false) => setParams(name ? { d: name } : {}, { replace })

  useEffect(() => {
    fetch(`${ASSETS}manifest.json`)
      .then(response => (response.ok ? response.json() : []))
      .catch(() => [])
      .then(entries => {
        setManifest(entries)
        const known = entries.some(item => item.name === params.get('d'))
        if (!known && entries[0]) select(entries[0].name, true)
      })
    // Runs once: a later ?d= change must not refetch the manifest.
  }, [])

  const entry = manifest?.find(item => item.name === selected) ?? null
  const meta = selected ? CATALOG[selected] : null

  // Keyed on the MANIFEST entry, not on ?d=, so a name the manifest does not have is never fetched: a dev
  // server (and most static hosts) answer an unknown path with the SPA's own index.html at status 200, which
  // `response.ok` accepts — that HTML then lands in the code block. The doctype check is the second half of
  // that guard, for a demo that is in the manifest but whose integration.txt failed to copy.
  // `live` because the two fetches can land out of order and the loser must not overwrite the winner.
  useEffect(() => {
    if (!entry) return
    let live = true
    setSource('')
    setCopied(false)
    fetch(`${ASSETS}${entry.name}/integration.txt`)
      .then(response => (response.ok ? response.text() : ''))
      .catch(() => '')
      .then(text => {
        if (!live) return
        setSource(/^\s*<(!doctype|html)/i.test(text) ? '' : text)
      })
    return () => { live = false }
  }, [entry?.name])

  const copySource = () => {
    navigator.clipboard?.writeText(source).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }, () => {})
  }

  return (
    <div className="landing demos">
      <SiteNav current="/demos" />
      <header className="lp-head demos-head">
        <div className="lp-kicker">three-slicer · demos</div>
        <h1>Four ways to consume the package</h1>
        <p>
          Each demo is a standalone project that installs <code>three-slicer</code> from npm and sells exactly one
          integration shape. They run below as their own build — the same files you get by copying the folder.
        </p>
        <div className="lp-cta">
          <Link className="lp-btn" to="/">Overview</Link>
          <Link className="lp-btn primary" to="/slice">Open the slicer</Link>
          <a className="lp-btn" href={`https://github.com/${REPO}/tree/main/examples`} target="_blank" rel="noreferrer">
            examples/ on GitHub
          </a>
        </div>
      </header>

      <main>

        <section className="lp-section">
          <div className="demos-grid">
            {ORDER.map(name => {
              const info = CATALOG[name]
              const ready = manifest?.some(item => item.name === name)
              return (
                <button
                  key={name}
                  type="button"
                  className={`demos-card${name === selected ? ' is-active' : ''}${ready ? '' : ' is-missing'}`}
                  onClick={() => ready && select(name)}
                  aria-pressed={name === selected}
                >
                  <span className="demos-card-sells">{info.sells}</span>
                  <strong>{info.title}</strong>
                  <span className="demos-card-blurb">{info.blurb}</span>
                  <span className="demos-card-surfaces">
                    {info.surfaces.map(surface => <code key={surface}>{surface}</code>)}
                  </span>
                  {!ready && manifest && <span className="demos-card-missing">not built</span>}
                </button>
              )
            })}
          </div>
        </section>

        {manifest?.length === 0 && (
          <section className="lp-section demos-empty">
            <div className="lp-section-head">
              <h2>Nothing built yet</h2>
              <p>The demos are separate projects. Build them once and this page picks them up:</p>
            </div>
            <pre>{`cd examples/instant-quote && npm i   # once per demo
cd web/viewer && npm run demos`}</pre>
          </section>
        )}

        {entry && meta && (
          <>
            <section className="lp-section">
              <div className="demos-frame-head">
                <div className="lp-section-head">
                  <h2>{meta.title}</h2>
                  <p>{meta.blurb}</p>
                </div>
                <div className="demos-actions">
                  <a href={`${ASSETS}${entry.name}/index.html`} target="_blank" rel="noreferrer">Open full page</a>
                  {/* ?file= or StackBlitz opens the README — the integration file is the thing being sold,
                      so it is what the tab should already be on. */}
                  <a
                    href={`https://stackblitz.com/github/${REPO}/tree/main/examples/${entry.name}?file=${entry.integration}`}
                    target="_blank"
                    rel="noreferrer"
                  >Edit on StackBlitz</a>
                  <a
                    href={`https://github.com/${REPO}/tree/main/examples/${entry.name}`}
                    target="_blank"
                    rel="noreferrer"
                  >Source</a>
                </div>
              </div>
              <iframe
                key={entry.name}
                className="demos-frame"
                src={`${ASSETS}${entry.name}/index.html`}
                title={`${meta.title} demo`}
              />
              <p className="demos-note">
                This page serves COOP/COEP, so the frame is cross-origin isolated and the demos load the
                <strong> multithreaded kernel</strong>. That changes the numbers: the sample cube reports 15m here
                and 12m on a plain static host, with identical geometry (99 layers, 8,095 segments) and identical
                filament (4.1&nbsp;g). Only the time estimate differs — worth knowing before you price anything on it.
              </p>
            </section>

            <section className="lp-section">
              <div className="demos-frame-head">
                <div className="lp-section-head">
                  <h2>The whole integration</h2>
                  <p>
                    <code>examples/{entry.name}/{entry.integration}</code> · {entry.lines} lines · imports nothing but
                    the package
                  </p>
                </div>
                <div className="demos-actions">
                  <button type="button" onClick={copySource} disabled={!source}>
                    {copied ? 'Copied' : 'Copy the file'}
                  </button>
                </div>
              </div>

              {/* Both lines come from the demo's own package.json via the manifest, so neither can claim a
                  version or a peer the demo does not actually install. */}
              {entry.deps?.length > 0 && (
                <p className="demos-install">
                  <code>npm i {entry.deps.join(' ')}</code>
                  {entry.version && <span> · built against three-slicer {entry.version}</span>}
                </p>
              )}

              <pre className="demos-source">{source || 'Loading…'}</pre>
              <p className="demos-note">
                Copying that file is the whole integration. The rest of the demo — drop zones, cards, sliders —
                is chrome you would replace with your own.
              </p>
            </section>
          </>
        )}
      </main>

      <footer className="lp-foot">
        <span>Take one</span>
        <code>npx degit {REPO}/examples/{selected ?? 'instant-quote'} my-app</code>
      </footer>
    </div>
  )
}
