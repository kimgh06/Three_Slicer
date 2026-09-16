import React from 'react'

// Renders the objectTools() array. Entries with `sep` become dividers; entries without `run` are disabled.
export default function ObjectToolbar({ tools }) {
  return (
    <div className="vp-top-toolbar" role="toolbar" aria-label="Object tools">
      {tools.map((t, i) => t.sep
        ? <span key={'sep' + i} className="vtt-sep" />
        : <button key={t.id} onClick={t.run} disabled={t.disabled?.() ?? !t.run}
            title={t.tip} data-testid={`tool-${t.id}`}><img src={t.icon} alt={t.label} /></button>)}
    </div>
  )
}
