import React, { useState } from 'react'

// The application menu, at the left of the top bar row; Viewport leaves it out with the top bar, a host's way of asking for no chrome. `getMenus` is called on every render of this row, because Paste reads the clipboard ref
//  and a ref change re-renders nothing: the items have to be read when the menu opens, not when Viewport last drew.
export default function MenuBar({ getMenus }) {
  const [openId, setOpenId] = useState(null)
  const close = () => setOpenId(null)
  const toggle = (id) => setOpenId(current => {
    if (current === id) return null
    return id
  })
  const run = (item) => () => { close(); item.run() }
  return (
    <nav className="menubar" role="menubar" aria-label="Application menu" data-testid="menu-bar"
      onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}>
      {openId && <div className="menu-scrim" onPointerDown={close} data-testid="menu-scrim" />}
      {getMenus().map(menu => (
        <div className="menu-root" key={menu.id}>
          <button className={openId === menu.id ? 'menu-title on' : 'menu-title'} aria-haspopup="menu" aria-expanded={openId === menu.id}
            onClick={() => toggle(menu.id)} onPointerEnter={() => { if (openId) setOpenId(menu.id) }}
            data-testid={`menu-${menu.id}`}>{menu.label}</button>
          {openId === menu.id && (
            <div className="ctx-menu menu-drop" role="menu" data-testid={`menu-drop-${menu.id}`}>
              {menu.items.map((item, index) => {
                if (item.sep) return <hr key={'sep' + index} />
                return (
                  <button key={item.id} role="menuitem" disabled={item.disabled} onClick={run(item)} title={item.title} data-testid={`menu-item-${item.id}`}>
                    <span><span className="menu-check">{item.checked && '✓'}</span>{item.label}</span>
                    {item.shortcut && <span className="ctx-key">{item.shortcut}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ))}
    </nav>
  )
}
