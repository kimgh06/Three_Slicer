import React from 'react'
import { ToolGroup, ToolButton } from './ToolGroup.jsx'

// A `sep` entry of the objectTools() array opens a group and names it. Entries without `run` are disabled.
function groupsOf(tools) {
  const groups = []
  for (const tool of tools) {
    if (tool.sep) groups.push({ caption: tool.group, tools: [] })
    else groups[groups.length - 1].tools.push(tool)
  }
  return groups
}

export default function ObjectToolbar({ tools }) {
  return (
    <div className="tool-band" role="toolbar" aria-label="Object tools">
      {groupsOf(tools).map(group => (
        <ToolGroup key={group.caption} caption={group.caption}>
          {group.tools.map(tool => (
            <ToolButton key={tool.id} tool={tool} onClick={tool.run} disabled={tool.disabled?.() ?? !tool.run} testId={`tool-${tool.id}`} />
          ))}
        </ToolGroup>
      ))}
    </div>
  )
}
