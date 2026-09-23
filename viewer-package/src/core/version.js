// The version string the toolbar badge shows. `package.json` is its owner and the only one: a browser cannot
// read package.json, so vite's `define` inlines the value at build time (vite.config.js) rather than anyone
// typing the number here. test_version_lockstep.mjs already holds the two packages to one number; this file is
// what puts that number on screen, and the same test checks it is still derived rather than spelled out.
//
// A host importing src/ directly (no vite define) leaves the global undefined. `typeof` on an undeclared
// identifier is safe, so that case is an empty string and the badge simply does not render — an inlined
// fallback number would be the drift this file exists to prevent.
function injectedVersion() {
  if (typeof __VIEWER_VERSION__ !== 'string') return ''
  return __VIEWER_VERSION__
}

export const VERSION = injectedVersion()
