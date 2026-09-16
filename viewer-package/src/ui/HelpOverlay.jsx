import React from 'react'

// The '?' shortcut cheat sheet. Static content — the key handling lives in the shortcut hook.
export default function HelpOverlay({ onClose }) {
  return (
    <div className="help-overlay" data-testid="help-overlay" onClick={onClose}>
      <div className="help-card" onClick={e => e.stopPropagation()}>
        <h3>Shortcuts <span className="muted">(press ? to close)</span></h3>
        <div className="help-cols">
          <section>
            <h4>Prepare</h4>
            <dl>
              <dt>M / G</dt><dd>Move (on the bed)</dd><dt>R</dt><dd>Rotate</dd>
              <dt>S</dt><dd>Scale — drag a box corner for all of XYZ</dd>
              <dt>Arrow keys</dt><dd>Move 10mm (Shift 1mm)</dd>
              <dt>PageUp/Down</dt><dd>Rotate 45°</dd>
              <dt>Del</dt><dd>Delete selection</dd><dt>Esc</dt><dd>Clear selection / leave paint</dd>
              <dt>Click</dt><dd>Select · <b>Ctrl+click</b> adds or removes</dd>
              <dt>Shift+drag</dt><dd>Box-select everything the rectangle touches</dd>
              <dt>Ctrl+A</dt><dd>Select all</dd>
            </dl>
          </section>
          <section>
            <h4>Preview</h4>
            <dl>
              <dt>↑ / ↓</dt><dd>Layer (Shift steps of 10)</dd>
              <dt>L</dt><dd>Single layer</dd><dt>T</dt><dd>Travel</dd>
              <dt>Esc</dt><dd>Back to Prepare</dd>
            </dl>
          </section>
          <section>
            <h4>Common</h4>
            <dl>
              <dt>Ctrl+Z</dt><dd>Undo an object change (not settings or painting)</dd>
              <dt>Ctrl+Shift+Z</dt><dd>Redo</dd>
              <dt>Ctrl+R</dt><dd>Slice</dd>
              <dt>Ctrl+K / ⌘D</dt><dd>Duplicate</dd>
              <dt>Ctrl+C/V/X</dt><dd>Copy / paste / cut</dd>
              <dt>Z / B</dt><dd>Zoom all / zoom bed</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  )
}
