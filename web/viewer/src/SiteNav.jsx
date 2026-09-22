import React from 'react'
import { REPO, REPO_URL } from './repo.js'
import './site_nav.css'

// The top bar of the React routes. The static pages (about, license, docs) carry the same markup written out,
//  because they ship without a script. Plain <a>, not <Link>: half the targets are static HTML entries the
//  router has no route for.
const ITEMS = [
  ['Slicer', '/slice'],
  ['Docs', '/docs'],
  ['Demos', '/demos'],
  ['About', '/about'],
  ['GitHub', REPO_URL],
]

export default function SiteNav({ current }) {
  return (
    <header className="site-nav">
      <div className="site-nav-inner">
        <a className="site-nav-brand" href="/">Three Slicer</a>
        <nav aria-label="Site">
          {ITEMS.map(([label, href]) => (
            <a key={label} href={href} aria-current={current === href && 'page'}>
              {label}
              {href === REPO_URL && (
                <img className="site-nav-badge" src={`https://img.shields.io/github/stars/${REPO}?style=social`} alt="GitHub stars" width="80" height="20" />
              )}
            </a>
          ))}
        </nav>
      </div>
    </header>
  )
}
