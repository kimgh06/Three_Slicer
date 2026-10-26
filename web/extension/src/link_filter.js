// Which links and downloads the extension offers to open. Pure functions of the extension list the viewport opens
// (openableExtensions(), compiled into the service worker by build.mjs), so the tests run them under node.
import { fileExt } from 'three-slicer-viewer/loaders'
import { ARCHIVE_EXT } from './archive.js'

// The extension of the last path segment, ignoring the query and the fragment. '' when the URL does not parse.
export function urlExtension(url) {
  try {
    return fileExt(new URL(url).pathname.split('/').pop())
  } catch {
    return ''
  }
}

// A link the context menu offers: anything the viewport opens, and a .zip, whose members it opens.
export function linkExtensions(extensions) {
  return [...extensions, ARCHIVE_EXT]
}

// chrome.contextMenus targetUrlPatterns: a match pattern cannot say "ends in .stl, maybe with a query", so each
// extension takes two.
export function contextMenuPatterns(extensions) {
  return linkExtensions(extensions).flatMap((extension) => [`*://*/*.${extension}`, `*://*/*.${extension}?*`])
}

// The saved path as a file: URL, for a POSIX path or a Windows one (C:\Users\… -> file:///C:/Users/…).
export function fileUrlOf(path) {
  const segments = path.replaceAll('\\', '/').split('/').filter((segment, index) => segment || index === 0)
  const encoded = segments.map((segment) => {
    if (/^[A-Za-z]:$/.test(segment)) return segment
    return encodeURIComponent(segment)
  })
  let joined = encoded.join('/')
  if (!joined.startsWith('/')) joined = `/${joined}`
  return `file://${joined}`
}

const WEB_PROTOCOLS = ['https:', 'http:']

function protocolOf(url) {
  try {
    return new URL(url).protocol
  } catch {
    return ''
  }
}

// The download the viewer should open, once the browser finished writing it, as { file, url?, filename }, or null.
// `file` is the saved file, which the viewer reads when the user allowed file access: it is exactly what was
// downloaded, and the only copy of a blob: download (Thingiverse revokes its blob within 500ms) or of one that needed
// the user's session. `url` is the download's web address, fetched again when file access is off.
// The saved name decides, because a download URL often has no extension (`/download?id=…`) while the name does. A .zip
// is not opened from a download: unlike a link the user picked, a downloaded archive is rarely a model.
export function downloadToOpen(item, extensions) {
  if (item?.state !== 'complete' || !item.filename) return null
  const filename = item.filename.split(/[\\/]/).pop()
  if (!extensions.includes(fileExt(filename))) return null
  const request = { file: fileUrlOf(item.filename), filename }
  const url = item.finalUrl || item.url
  if (WEB_PROTOCOLS.includes(protocolOf(url))) request.url = url
  return request
}

// The browser saves "benchy.stl" as "benchy (1).stl" when the folder has one already; a badge expecting the first
// name must still recognise the second.
export function sameDownloadName(saved, expected) {
  const unnumbered = saved.replace(/ \(\d+\)(?=\.[^.]+$)/, '')
  return saved === expected || unnumbered === expected
}
