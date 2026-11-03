import React, { useRef, useState } from 'react'

const LARGE_STEP = 10

// Applies on Enter or on leaving the field, and Escape puts the value back. The up and down keys step right away, and
//  Shift steps ten times as far. What is typed reaches `onCommit` only as a finite number.
export default function NumberField({ value, step, onCommit, testId }) {
  const [draft, setDraft] = useState(null)
  const cancelled = useRef(false)   // blur runs before the state from Escape has rendered
  const apply = () => {
    const typed = Number(draft)
    const usable = draft !== null && draft.trim() && Number.isFinite(typed) && typed !== value
    if (usable && !cancelled.current) onCommit(typed)
    cancelled.current = false
    setDraft(null)
  }
  const onKeyDown = (event) => {
    if (event.key === 'Enter') event.target.blur()
    else if (event.key === 'Escape') { event.stopPropagation(); cancelled.current = true; event.target.blur() }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      const start = Number(draft ?? value)
      setDraft(null)
      if (!Number.isFinite(start)) return
      const direction = { ArrowUp: 1, ArrowDown: -1 }[event.key]
      const size = { true: step * LARGE_STEP, false: step }[event.shiftKey]
      onCommit(start + direction * size)
    }
  }
  return (
    <input className="fine-number" inputMode="decimal" value={draft ?? value.toFixed(2)} data-testid={testId}
      onChange={event => setDraft(event.target.value)} onBlur={apply} onKeyDown={onKeyDown} />
  )
}
