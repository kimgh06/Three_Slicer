import React, { Suspense, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { CHROME_STORE_URL, REPO, REPO_URL } from './repo.js'
import SiteNav from './SiteNav.jsx'
import { handOffFiles } from './handoff.js'

// The live embed below mounts the real <Viewport/>, so the same guard Prepare.jsx uses applies here:
// Googlebot's renderer has no WebGL, and mounting there would blank the one page that carries the
// crawlable content. Without WebGL the static screenshot simply stays.
const webglAvailable = (() => {
  try {
    const probeCanvas = document.createElement('canvas')
    return !!(probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl'))
  } catch { return false }
})()

// Lazy on purpose, twice over: the chunk (three.js + the viewer) only downloads once the section
// scrolls into view, and the kernel WASM only downloads if the visitor actually presses Slice.
const Viewport = React.lazy(() => import('./kernel_viewport.jsx'))

// Measured from the shipped artifacts (catalog sizes from data/, the invariant count from wasm-core/tests/test.mjs):
// update alongside them.
const PRINTER_COUNT = '1,041'
const FILAMENT_COUNT = '5,999'
const INVARIANT_COUNT = '120+'

const FEATURE_GROUPS = [
  ['01 / Slicing', 'A real slicer, not a preview',
    'Ported from OrcaSlicer\u2019s own source to WebAssembly.', [
      ['Variable-width walls', 'Arachne walls follow thin features without gaps.'],
      ['Tree and grid supports', 'Organic trees or grids, with paint-on blockers.'],
      ['Multi-material', 'Paint colours. Tool changes are generated for you.'],
      ['Resin', 'Slices to .sl1 with PrusaSlicer\u2019s supports and pad.'],
    ]],
  ['02 / Projects', 'Opens what you already have',
    'Bring a MakerWorld project or a bare STL.', [
      ['3mf projects', 'Plates, settings and painting come back as saved.'],
      ['Up to 30 plates', 'Each plate can keep its own settings.'],
      [`${PRINTER_COUNT} printer profiles`, `Bambu Lab, Prusa, Creality, Voron and ${FILAMENT_COUNT} filament presets.`],
      ['STL, OBJ, STEP, AMF, PLY', 'G-code and .sl1 files open in the preview.'],
    ]],
  ['03 / Your computer', 'Nothing leaves this tab',
    'No server, so no upload and no queue.', [
      ['No upload', 'Slicing runs on your own processor.'],
      ['No install', 'Open the page and start.'],
      ['Multithreaded', 'Slices several plates side by side.'],
      ['Layer-by-layer preview', 'Scrub layers and moves, coloured by feature.'],
    ]],
]

const SPECS = [
  ['License', 'AGPL-3.0 kernel, MIT viewer'],
  ['Based on', 'OrcaSlicer, PrusaSlicer 2.9.6'],
  ['Kernel checks', `${INVARIANT_COUNT} invariants`],
  ['G-code', 'byte-identical gate'],
]

// Kept word-for-word in sync with the FAQPage JSON-LD in index.html — Google only honours FAQ
// structured data whose answers are visible on the rendered page.
const FAQ = [
  ['Do my models get uploaded anywhere?',
   'No. The slicing kernel is compiled to WebAssembly and runs inside the browser tab, so the model file never leaves the machine it was opened on.'],
  ['Which file formats can it slice?',
   'STL, OBJ, 3MF, AMF and PLY are read directly, and STEP is read through a loader that only downloads when a STEP file is actually opened. An .sl1 resin archive can be opened as well. The output is G-code for filament printers, or an .sl1 archive for resin ones.'],
  ['Is it based on a real slicer?',
   'Yes. The kernel is a port of OrcaSlicer, which is itself a PrusaSlicer/Slic3r descendant. Arachne wall generation, tree supports, multi-material segmentation and the prime tower are ported from that source rather than reimplemented, and the resin support-point generator, support tree and pad are ported from PrusaSlicer 2.9.6.'],
  ['Can I use the slicer in my own site or app?',
   'Yes, as two npm packages. three-slicer (AGPL-3.0-or-later) is the slicing kernel for Node or the browser. three-slicer-viewer (MIT) is the React viewer and settings panel on their own — model and G-code preview with no slicing and no AGPL code, usable in closed-source products. Installing three-slicer gives you both.'],
]

function Screenshot() {
  return (
    <picture>
      <source srcSet="/usage.webp" type="image/webp" />
      <img
        src="/usage.png"
        alt="A sliced Benchy in the Preview tab: organic tree supports, per-feature toolpath colors, dual layer-range slider, filament and print-time estimates"
        width="2674"
        height="1996"
        fetchpriority="high"
      />
    </picture>
  )
}

// The screenshot's spot, upgraded in place: off by default, and when the section scrolls into view the
// real slicer mounts with a Benchy already on the plate (an FFF session — the default technology).
// The prime tower ghost draws whenever two extruders are loaded (the default filament pair) unless the
// map holds an explicit false — the viewer reads the MAP, not the schema default. The support keys are
// inert until the checkbox sets enable_support: tree supports only, standing on the build plate only.
const INITIAL_SETTINGS = {
  enable_prime_tower: false,
  // The kernel routes tree vs grid from support_style ONLY (settings.js maps /tree|organic/ -> the real
  // organic TreeSupport); support_type is not consulted, so 'tree(auto)' alone still sliced grid.
  support_style: 'organic',
  support_on_build_plate_only: true,
}

function LiveSlicer() {
  const [armed, setArmed] = useState(false)      // the section has been near the viewport once
  const [files, setFiles] = useState(null)       // [{name, data}] — held in state for a stable identity
  const [settings, setSettings] = useState(INITIAL_SETTINGS)
  // Slicing goes through the sliceRequest prop: bumping the counter requests one slice in place — no
  // remount, so the scene never blanks. Reset still remounts (the key), because clearing a sliced result
  // back to the plain model is what a remount IS; the benchy buffer stays in state, so it re-parses but
  // never re-downloads.
  //
  // `phase` goes busy AT THE CLICK ('preparing', until the viewer's slicing event takes over) so the
  // buttons hold one continuous disabled window; the veil covers the first slice's kernel download.
  const [generation, setGeneration] = useState(0)
  const [sliceRequest, setSliceRequest] = useState(0)
  const [phase, setPhase] = useState('idle')     // idle | preparing | slicing | done
  // Wall clock from the click to the viewer's slicing event, on the visitor's own machine.
  const [sliceSeconds, setSliceSeconds] = useState(null)
  const sliceStartedAt = useRef(0)
  const boxRef = useRef(null)

  useEffect(() => {
    if (!webglAvailable) return
    const io = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setArmed(true); io.disconnect() }
    }, { rootMargin: '200px' })
    io.observe(boxRef.current)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!armed) return
    let gone = false
    fetch('/benchy.stl')
      .then(response => { if (!response.ok) throw new Error(String(response.status)); return response.arrayBuffer() })
      .then(buffer => { if (!gone) setFiles([{ name: 'benchy.stl', data: buffer }]) })
      .catch(() => {})                            // fetch failure leaves the screenshot — never a broken frame
    return () => { gone = true }
  }, [armed])

  const startSlice = () => {
    sliceStartedAt.current = performance.now()
    setSliceSeconds(null)
    setPhase('preparing')
    setSliceRequest(n => n + 1)
  }
  const finishSlice = () => {
    setPhase(previous => {
      if (previous === 'slicing') return 'done'
      return previous
    })
    setSliceSeconds(((performance.now() - sliceStartedAt.current) / 1000).toFixed(1))
  }

  const live = webglAvailable && armed && files
  const busy = phase === 'preparing' || phase === 'slicing'
  const sliceLabel = { idle: 'Slice this Benchy', done: 'Sliced' }[phase] ?? 'Slicing…'
  let figureClass = 'lp-shot'
  if (live) figureClass += ' lp-live'
  return (
    <figure className={figureClass} ref={boxRef}>
      {!live && <Screenshot />}
      {live && (
        <>
          <div className="lp-live-frame">
            <Suspense fallback={<Screenshot />}>
              <Viewport
                key={generation}
                settings={settings}
                setSettings={setSettings}
                files={files}
                sliceRequest={sliceRequest}
                panels={{ sidebar: false, topBar: false, gizmoRail: false, objectToolbar: false, plateBar: false, sliceBar: false, paintPanel: false, emptyHint: false, status: false }}
                features={{ shortcuts: false }}
                onEvent={event => {
                  if (event.type !== 'slicing') return
                  if (event.value) setPhase('slicing')
                  else finishSlice()
                }}
              />
            </Suspense>
            {phase === 'preparing' && <div className="lp-live-veil">Starting the slice…</div>}
          </div>
          <div className="lp-live-bar">
            <button className="lp-btn primary" disabled={phase !== 'idle'} onClick={startSlice}>{sliceLabel}</button>
            <label className="lp-live-check">
              <input
                type="checkbox"
                checked={!!settings.enable_support}
                disabled={busy}
                onChange={event => {
                  const enabled = event.target.checked
                  setSettings(current => ({ ...current, enable_support: enabled }))
                  // Already sliced? Re-slice in place with the new setting — no remount.
                  if (phase === 'done') startSlice()
                }}
              />
              Supports
            </label>
            <button className="lp-btn" disabled={busy}
              onClick={() => { setPhase('idle'); setSliceSeconds(null); setSettings(INITIAL_SETTINGS); setGeneration(n => n + 1) }}>
              Reset
            </button>
          </div>
          {phase === 'done' && sliceSeconds !== null && (
            <div className="home-result" role="status">
              <p><b>Sliced in {sliceSeconds} s on this computer.</b> Nothing was uploaded.</p>
              <Link className="lp-btn primary" to="/slice">Try your own model</Link>
            </div>
          )}
        </>
      )}
      <figcaption className="home-fig">
        <span>Fig. 01 {live && '— Live slicer'}{!live && '— Slicer preview'}</span>
        <span>Benchy</span>
      </figcaption>
    </figure>
  )
}

// A model dropped anywhere on the page goes to the slicer. The listeners run in the capture phase so the embedded
//  viewport below never takes the file: a drop always goes to the full slicer.
function useModelDrop() {
  const navigate = useNavigate()
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const carriesFiles = (event) => event.dataTransfer?.types?.includes('Files')
    const onDrag = (event) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      setDragging(true)
    }
    const onLeave = (event) => {
      if (carriesFiles(event) && !event.relatedTarget) setDragging(false)
    }
    const onDrop = (event) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      setDragging(false)
      if (!event.dataTransfer.files.length) return
      handOffFiles([...event.dataTransfer.files])
      navigate('/slice')
    }
    window.addEventListener('dragenter', onDrag, true)
    window.addEventListener('dragover', onDrag, true)
    window.addEventListener('dragleave', onLeave, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragenter', onDrag, true)
      window.removeEventListener('dragover', onDrag, true)
      window.removeEventListener('dragleave', onLeave, true)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [navigate])

  return dragging
}

export default function Landing() {
  const dragging = useModelDrop()
  return (
    <div className="landing home">
      <SiteNav current="/" />
      {dragging && <div className="home-drop-veil" data-testid="home-drop-veil">Drop it to open the slicer</div>}

      <header className="home-hero">
        <div className="home-hero-copy">
          <p className="home-label">Browser slicer · Filament and resin</p>
          {/* Googlebot indexes this rendered page, not index.html's pre-render fallback (createRoot clears it),
              so the heading says what the <title> and the JSON-LD say: a web slicer. */}
          <h1>The web slicer for 3D printing.</h1>
          <p className="home-lede">Drop a model here and get G-code.<br />OrcaSlicer&rsquo;s engine, running in your browser.</p>
          <div className="home-actions">
            <Link className="lp-btn primary" to="/slice">Open the slicer</Link>
            <a className="lp-btn" href={CHROME_STORE_URL} target="_blank" rel="noreferrer">Add to Chrome</a>
          </div>
          <ul className="home-facts">
            <li>Free, no account</li>
            <li>Nothing uploaded</li>
            <li>Open source</li>
          </ul>
        </div>
        <div className="home-figure"><LiveSlicer /></div>
      </header>

      <main>
        <section className="home-section" aria-labelledby="features-title">
          <p className="home-label">What it does</p>
          <h2 id="features-title">Everything a slicer does, in a tab</h2>
          {FEATURE_GROUPS.map(([label, title, intro, rows]) => (
            <div key={label} className="home-group">
              <div>
                <p className="home-group-label">{label}</p>
                <h3>{title}</h3>
                <p>{intro}</p>
              </div>
              <dl>
                {rows.map(([name, detail]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{detail}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </section>

        <section className="home-section home-open" aria-labelledby="open-title">
          <div>
            <p className="home-label">Open source</p>
            <h2 id="open-title">The whole port is on GitHub</h2>
            <p>Read the code, check the output, or embed it.<br />
              On npm as <code>three-slicer</code> and <code>three-slicer-viewer</code>.<br />
              <a href="/docs/orcaslicer-webassembly-port">How it was ported</a></p>
            <div className="home-actions">
              <a className="lp-btn primary" href={REPO_URL} target="_blank" rel="noreferrer">View on GitHub</a>
              <Link className="lp-btn" to="/demos">Integration demos</Link>
            </div>
          </div>
          <dl className="home-spec">
            {SPECS.map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            <div>
              <dt>Source</dt>
              <dd><a href={REPO_URL} target="_blank" rel="noreferrer">{REPO}</a></dd>
            </div>
          </dl>
        </section>

        <section className="home-section" aria-labelledby="start-title">
          <p className="home-label">Get started</p>
          <h2 id="start-title">Three ways to use it</h2>
          <div className="home-ways">
            <Link to="/slice"><b>In this browser</b><small>Nothing to set up</small></Link>
            <a href={CHROME_STORE_URL} target="_blank" rel="noreferrer"><b>Chrome extension</b><small>Opens model links and downloads</small></a>
            <a href="/docs"><b>npm packages</b><small>Put the slicer in your product</small></a>
          </div>
        </section>

        <section className="home-section" aria-labelledby="faq-title">
          <p className="home-label">FAQ</p>
          <h2 id="faq-title">Questions</h2>
          <div className="home-faq">
            {FAQ.map(([question, answer]) => (
              <details key={question}>
                <summary>{question}</summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <span>Three Slicer, based on OrcaSlicer</span>
        <a href={REPO_URL} target="_blank" rel="noreferrer">{REPO}</a>
        <a href={`${REPO_URL}/discussions`} target="_blank" rel="noreferrer">Community</a>
        <a href="/docs">Docs</a>
        <a href="/about">About</a>
        <a href="/license">License</a>
      </footer>
    </div>
  )
}
