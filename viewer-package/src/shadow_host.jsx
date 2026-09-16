import React, { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Shadow DOM isolation host — injects the component styles into the shadow root so host app CSS
// is fully blocked in both directions (class names cannot collide). React 17+ attaches event
// listeners to portal containers as well (preparePortalMount), so synthetic events work inside the shadow.
// The host div/container uses display:contents so it is layout-transparent — children lay out as before.
//
// The portal container is created before render. Waiting for the shadow root and opening the portal
// conditionally would run the child's mount useEffect with ref=null before the child ref is attached
// (three.js would never initialize). Instead children mount into a detached container from the first commit,
// and a layout effect moves that container into the shadow root — before paint, so there is no flicker.
// (It touches document during render, so SSR is impossible — load it with ssr:false in Next and friends.)
export default function ShadowHost({ css, className, children }) {
  const hostRef = useRef(null)
  const [container] = useState(() => {
    const el = document.createElement('div')
    el.style.display = 'contents'
    return el
  })
  useLayoutEffect(() => {
    const host = hostRef.current
    const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' })
    let style = shadow.querySelector('style[data-ts-css]')
    if (!style) { style = document.createElement('style'); style.setAttribute('data-ts-css', ''); shadow.append(style) }
    style.textContent = css
    if (!shadow.contains(container)) shadow.append(container)
  }, [css, container])
  return <div ref={hostRef} className={className}>{createPortal(children, container)}</div>
}
