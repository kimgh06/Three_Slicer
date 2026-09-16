// Keyboard shortcuts (upstream SPECS §4 + PrusaSlicer/Cura conventions).
// Which keys are live depends on Prepare/Preview. All are ignored while an input widget has focus.
// The component rebuilds the handler each render so it closes over fresh state; this file only holds the map.
export function makeKeyHandler(deps) {
  return (e) => {
    // Shadow DOM: at window level e.target is retargeted to the shadow host -> use composedPath to find the real target
    const t = e.composedPath ? e.composedPath()[0] : e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    const k = e.key, low = typeof k === 'string' ? k.toLowerCase() : ''
    const mod = e.ctrlKey || e.metaKey
    const stop = () => { e.preventDefault(); e.stopPropagation() }
    // A letter shortcut is matched on the PHYSICAL key (e.code), not on e.key. Under a Korean layout e.key for the
    //  M key is 'ㅁ' (and 'Process' mid-composition), so every letter shortcut below silently did nothing while the
    //  IME was switched on — the non-letter keys (arrows, Delete, Escape) kept working, which is what made it look
    //  intermittent. e.key stays as a fallback so a layout that remaps the Latin letters still matches what is printed
    //  on the key. Named keys are layout-independent and keep reading e.key.
    const key = (ch) => e.code === 'Key' + ch.toUpperCase() || low === ch

    if (mod) {                                            // ---- Ctrl/⌘ combinations (both modes) ----
      if (key('r')) { stop(); if (!deps.slicing) deps.slice('current') }        // slice (upstream Ctrl+R)
      else if (key('c')) { stop(); deps.copy() }
      else if (key('v')) { stop(); deps.paste() }
      else if (key('x')) { stop(); deps.copy(); deps.remove() }
      else if (key('k') || key('d')) { stop(); deps.duplicate() }  // Ctrl+K (upstream) / ⌘D (macOS convention)
      // Ctrl+A selects every object, as upstream does (EVT_GLCANVAS_SELECT_ALL). Upstream ignores it while a
      //  painting gizmo is open; here the paint modes take the canvas anyway, so the same intent is served by the
      //  handler simply not being reachable with a brush active.
      else if (key('a')) { stop(); deps.selectAll?.() }
      return
    }

    // ---- Painting: while a brush is open the letter keys are the brush's own ----
    // Upstream binds the tools to letters in the gizmo itself (GLGizmoMmuSegmentation::on_key_down_select_tool_type,
    //  C/S/F/T) and the filaments to the number row (on_number_key_down), which is what makes a two-colour paint job
    //  one hand on the mouse. They shadow the object shortcuts (S is the scale gizmo, B zooms the bed) only while a
    //  brush is actually open — and anything not listed falls through, so Escape still closes the brush.
    if (deps.isPainting?.()) {
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1] ?? (/^[1-9]$/.test(k) ? k : null)
      if (key('c'))      { stop(); deps.paintCursor?.('circle'); return }
      else if (key('s')) { stop(); deps.paintCursor?.('sphere'); return }
      else if (key('f')) { stop(); deps.paintTool?.('smart'); return }
      else if (key('b')) { stop(); deps.paintTool?.('bucket'); return }
      else if (key('t')) { stop(); deps.paintTool?.('triangle'); return }
      else if (key('v')) { stop(); deps.paintAxisLock?.('vertical'); return }
      else if (key('h')) { stop(); deps.paintAxisLock?.('horizontal'); return }
      else if (digit)    { stop(); deps.pickExtruder?.(Number(digit) - 1); return }
    }

    if (deps.isPreview()) {                               // ---- Preview: layer inspection ----
      const step = e.shiftKey ? 10 : 1
      if (k === 'ArrowUp')        { stop(); deps.stepLayer(step) }
      else if (k === 'ArrowDown') { stop(); deps.stepLayer(-step) }
      else if (key('l'))          { stop(); deps.toggleSingleLayer() }
      else if (key('t'))          { stop(); deps.toggleTravel() }
      else if (key('z'))          { stop(); deps.zoomAll() }
      else if (key('b'))          { stop(); deps.zoomBed() }
      else if (k === 'Escape')    { stop(); deps.leavePreview() }
      return
    }

    // ---- Prepare: object manipulation ----
    if (key('m') || key('g'))  { stop(); deps.setGizmo('translate') }       // M = upstream, G = Blender convention (kept)
    else if (key('r'))         { stop(); deps.setGizmo('rotate') }
    else if (key('s'))         { stop(); deps.setGizmo('scale') }
    else if (key('z'))         { stop(); deps.zoomAll() }
    else if (key('b'))         { stop(); deps.zoomBed() }
    else if (k === 'Delete' || k === 'Backspace') { stop(); deps.remove() }
    else if (k === 'Escape')        { stop(); deps.cancelTool() }
    else if (k === 'PageUp')        { stop(); deps.rotateSelected(Math.PI / 4) }
    else if (k === 'PageDown')      { stop(); deps.rotateSelected(-Math.PI / 4) }
    else if (k.startsWith?.('Arrow')) {                                     // nudge: 10mm, Shift = 1mm (Prusa convention)
      stop(); const d = e.shiftKey ? 1 : 10
      deps.nudgeSelected(k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0,
                         k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0)
    }
    else if (k === '?' || (e.shiftKey && e.code === 'Slash')) { stop(); deps.toggleHelp() }
  }
}
