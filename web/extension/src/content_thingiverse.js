// Thingiverse lists a thing's files with one button each, labelled "Download <file name>". Beside each one for a file
// the slicer opens, this adds "Open in Three Slicer": it announces the download to the service worker and presses the
// site's own button, so the file arrives the way the site sends it (a blob: download behind its session, which nothing
// outside the page can fetch again) and opens once saved, whatever the "open downloads" option says.
// The accessible label is the one thing read off the page: Thingiverse's class names are build hashes.
import { fileExt } from 'three-slicer-viewer/loaders'

const EXTENSIONS = __OPENABLE_EXTENSIONS__
const LABEL_PREFIX = 'Download '
const BADGE_CLASS = 'three-slicer-open'
const badged = new WeakSet()

function fileNameOf(button) {
  return button.getAttribute('aria-label').slice(LABEL_PREFIX.length).trim()
}

function makeBadge(siteButton, filename) {
  const badge = document.createElement('button')
  badge.type = 'button'
  badge.className = BADGE_CLASS
  badge.textContent = 'Open in Three Slicer'
  badge.title = `Download ${filename} and open it in the Three Slicer extension`
  badge.style.cssText = 'margin-left:8px;padding:4px 10px;border:0;border-radius:6px;background:#00ae42;color:#fff;font:600 12px/1.4 system-ui,sans-serif;cursor:pointer'
  badge.addEventListener('click', async (event) => {
    event.preventDefault()
    event.stopPropagation()
    await chrome.runtime.sendMessage({ type: 'expect-download', filename })
    siteButton.click()
  })
  return badge
}

function addBadges() {
  for (const button of document.querySelectorAll(`button[aria-label^="${LABEL_PREFIX}"]`)) {
    if (badged.has(button)) continue
    badged.add(button)
    const filename = fileNameOf(button)
    if (!EXTENSIONS.includes(fileExt(filename))) continue
    button.after(makeBadge(button, filename))
  }
}

// The site is a single-page app: the file list renders after load and again on every navigation.
addBadges()
new MutationObserver(addBadges).observe(document.documentElement, { childList: true, subtree: true })
