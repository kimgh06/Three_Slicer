import React, { useState } from 'react'

// Outside the component, because a section unmounts while it does not apply (Preview in Prepare, Filament under SLA) and
//  coming back should not reopen what the user closed. ponytail: lost on reload; storage if that ever matters.
const closedSections = new Set()

// One collapsible sidebar box: the heading with its count, scope switch and buttons in fixed places, then its rows. A
//  button inside <summary> is its own click target, so pressing one does not fold the box.
export function Section({ title, count = null, scope = null, actions = null, className = '', testId, children }) {
  const [open, setOpen] = useState(!closedSections.has(title))
  const onToggle = (event) => {
    const nowOpen = event.currentTarget.open
    setOpen(nowOpen)
    if (nowOpen) closedSections.delete(title)
    else closedSections.add(title)
  }
  return (
    <details className={`side-card ${className}`.trim()} open={open} onToggle={onToggle} data-testid={testId}>
      <summary className="sc-head">
        <span className="sc-title">{title}</span>
        {count != null && <span className="sc-count">{count}</span>}
        <span className="sc-head-end">{scope}{actions}</span>
      </summary>
      {children}
    </details>
  )
}

// One label + control row. `as="label"` makes the whole row toggle a checkbox; a row holding buttons must stay a div,
//  or a click on the label presses its first button.
export function Field({ label, as: Row = 'div', className = '', children, ...rest }) {
  return (
    <Row className={`field ${className}`.trim()} {...rest}>
      <span className="field-label">{label}</span>
      {children}
    </Row>
  )
}
