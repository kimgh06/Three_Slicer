import React from 'react'
import { ribbonGroups } from '../core/toolbar_items.js'
import { ToolGroup, ToolButton } from './ToolGroup.jsx'

const buttonClass = (tool) => {
  if (tool.active) return 'on'
  return ''
}

export default function ObjectToolbar({ tools }) {
  return (
    <div className="tool-band" role="toolbar" aria-label="Object tools">
      {ribbonGroups(tools).map(group => (
        <ToolGroup key={group.caption} caption={group.caption}>
          {group.tools.map(tool => (
            <ToolButton key={tool.id} tool={tool} className={buttonClass(tool)} onClick={tool.run} disabled={tool.disabled?.()} testId={`tool-${tool.id}`} />
          ))}
        </ToolGroup>
      ))}
    </div>
  )
}
