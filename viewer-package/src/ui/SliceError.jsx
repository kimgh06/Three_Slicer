// The slice error line. A custom G-code error (CUSTOM_GCODE_ERROR, from the kernel's PlaceholderParser) carries the
// parser's own lines after the message — the template line and a ^ under the failing column — which only line up in
// a left-aligned monospaced block, so everything after the first line goes into one.
import React from 'react'

export default function SliceError({ error }) {
  const [message, ...detail] = String(error).split('\n')
  const detailText = detail.join('\n').replace(/\n+$/, '')
  return (
    <div className="slice-err side-warn" data-testid="slice-err">
      {message}
      {detailText && <pre className="slice-err-detail">{detailText}</pre>}
    </div>
  )
}
