import React from 'react'

// One ribbon group: its buttons over a caption, the layout PowerPoint's ribbon uses. Each button's label sits under
//  its icon, so the icon's alt text is empty and a screen reader reads the name once.
export function ToolGroup({ caption, children }) {
  return (
    <div className="tool-group">
      <div className="tool-buttons">{children}</div>
      <div className="tool-caption">{caption}</div>
    </div>
  )
}

export function ToolButton({ tool, className = '', onClick, disabled, testId }) {
  return (
    <button className={className} onClick={onClick} disabled={disabled} title={tool.tip} data-testid={testId}>
      <img src={tool.icon} alt="" /><span>{tool.label}</span>
    </button>
  )
}
