import React from 'react'
import { moveIcon, rotateIcon, scaleIcon, paintIcon } from '../core/icons.js'

// S3 left rail: the transform gizmos plus the support painting mode.
//  `paintEnabled` false removes the brush entirely (SLA — the selector paints FFF support/material states, and a
//  button that cannot do anything should not be offered).
export default function GizmoRail({ gizmoMode, paintMode, onGizmo, onTogglePaint, paintEnabled = true }) {
  const active = (mode) => (gizmoMode === mode && paintMode === 'off' ? 'on' : '')
  return (
    <nav className="left-rail" role="toolbar" aria-label="Gizmo tools">
      <button className={active('translate')} onClick={() => onGizmo('translate')} title="Move the object across the bed — drag a gizmo axis or use arrow keys for 10mm (Shift 1mm). A part prints off the bed, so there is no up/down axis (M/G)" data-testid="gizmo-move"><img src={moveIcon} alt="Move" /></button>
      <button className={active('rotate')} onClick={() => onGizmo('rotate')} title="Rotate the object — PageUp/PageDown rotates in 45° steps (R)" data-testid="gizmo-rotate"><img src={rotateIcon} alt="Rotate" /></button>
      <button className={active('scale')} onClick={() => onGizmo('scale')} title="Scale the object — drag a corner of the bounding box to resize X, Y and Z together, or a gizmo axis for one axis (S)" data-testid="gizmo-scale"><img src={scaleIcon} alt="Scale" /></button>
      {paintEnabled && (<>
        <div className="rail-sep" />
        <button className={paintMode !== 'off' ? 'on' : ''} onClick={onTogglePaint} title="Brush facets to enforce or block support — the wheel changes the brush size" data-testid="gizmo-paint"><img src={paintIcon} alt="Support painting" /></button>
      </>)}
    </nav>
  )
}
