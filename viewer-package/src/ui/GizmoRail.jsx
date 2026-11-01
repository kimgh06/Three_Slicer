import React from 'react'
import { GIZMO_TOOLS, SUPPORT_PAINT_TOOL } from '../core/toolbar_items.js'
import { ToolGroup, ToolButton } from './ToolGroup.jsx'

// The transform gizmos plus the support painting mode, in the top bar's ribbon.
//  `paintEnabled` false removes the brush entirely (SLA — the selector paints FFF support/material states, and a
//  button that cannot do anything should not be offered).
export default function GizmoRail({ gizmoMode, paintMode, onGizmo, onTogglePaint, paintEnabled = true }) {
  const gizmoClass = (mode) => {
    if (gizmoMode === mode && paintMode === 'off') return 'on'
    return ''
  }
  const paintClass = () => {
    if (paintMode !== 'off') return 'on'
    return ''
  }
  return (
    <nav className="tool-band" role="toolbar" aria-label="Gizmo tools">
      <ToolGroup caption="Transform">
        {GIZMO_TOOLS.map(tool => (
          <ToolButton key={tool.id} tool={tool} className={gizmoClass(tool.mode)} onClick={() => onGizmo(tool.mode)} testId={`gizmo-${tool.id}`} />
        ))}
      </ToolGroup>
      {paintEnabled && (
        <ToolGroup caption="Support">
          <ToolButton tool={SUPPORT_PAINT_TOOL} className={paintClass()} onClick={onTogglePaint} testId={`gizmo-${SUPPORT_PAINT_TOOL.id}`} />
        </ToolGroup>
      )}
    </nav>
  )
}
