import React from 'react'
import { VERSION } from '../core/version.js'

// The build number, shown at the right end of the status bar. What a bug report needs to name a build, which is
// why it is on by default (features.versionBadge turns it off — see VIEWER.md).
// VERSION is empty in a source-consumed build (no vite `define`, see core/version.js); nothing is drawn then.
export default function VersionBadge({ on = true }) {
  if (!on || !VERSION) return null
  return <span className="vp-version" data-testid="version-badge" title={`three-slicer-viewer ${VERSION}`}>v{VERSION}</span>
}
