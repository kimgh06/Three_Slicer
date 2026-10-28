// The extension's service worker: opens a slicer tab from the toolbar button, a link's context menu, a finished model
// download and a site badge. MV3 stops it when idle, so what it must remember lives in chrome.storage.session.
import { contextMenuPatterns, downloadToOpen, fileUrlOf, localModelToOpen, sameDownloadName } from './link_filter.js'
import { loadSettings } from './settings.js'
import { targetNamed } from './targets.js'
import { viewerQuery, VIEWER_PAGE } from './viewer_query.js'

// openableExtensions() at build time (build.mjs), so this list and the viewport's own cannot drift.
const EXTENSIONS = __OPENABLE_EXTENSIONS__
const TARGET = targetNamed(__TARGET__)
const MENU_ID = 'three-slicer-open-link'
const OPENED_PREFIX = 'opened-download:'
// A badge click announces the download it is about to start, so that one opens even with the option off.
const EXPECTED_PREFIX = 'expected-download:'
const EXPECTED_FOR_MS = 60_000

function openViewer(request) {
  let page = VIEWER_PAGE
  if (request) page = viewerQuery({ ...request, sent: Date.now() })
  return chrome.tabs.create({ url: chrome.runtime.getURL(page) })
}

chrome.action.onClicked.addListener(() => openViewer(null))

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Open in Three Slicer',
      contexts: ['link'],
      targetUrlPatterns: contextMenuPatterns(EXTENSIONS),
    })
  })
})

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_ID && info.linkUrl) openViewer({ url: info.linkUrl })
})

// Takes the announcement for this file name if there is a fresh one; stale ones are dropped on the way.
async function takeExpected(filename) {
  const stored = await chrome.storage.session.get(null)
  for (const [key, announcedAt] of Object.entries(stored)) {
    if (!key.startsWith(EXPECTED_PREFIX)) continue
    if (Date.now() - announcedAt > EXPECTED_FOR_MS) {
      await chrome.storage.session.remove(key)
      continue
    }
    if (sameDownloadName(filename, key.slice(EXPECTED_PREFIX.length))) {
      await chrome.storage.session.remove(key)
      return true
    }
  }
  return false
}

// A download opens once the browser finished writing it (downloadToOpen). The session store keeps one download from
// opening two tabs across a worker restart; the set covers two events of one download arriving together, which would
// both read the store before either wrote it.
const claimedDownloads = new Set()

// The download to open in this browser: where an extension cannot read saved files, only by its web address.
function openableDownload(item) {
  const request = downloadToOpen(item, EXTENSIONS)
  if (!request || TARGET.readsSavedFiles) return request
  const { file, ...byAddress } = request
  if (!byAddress.url) return null
  return byAddress
}

// Every download decision is logged to the service worker console (chrome://extensions -> Three Slicer -> service
// worker), so "it did not open" can be told apart from "the browser never reported the download".
function logDownload(item, decision) {
  console.info('[three-slicer] download', item.id, decision, { state: item.state, filename: item.filename, url: item.finalUrl || item.url, mime: item.mime })
}

// A local model's tab goes to the slicer before Chrome makes a download of it, so the original file is read and no copy
// is left in Downloads. Where the redirect lost the race, the download that follows is the copy: cancelled and removed.
const redirectedLocalFiles = new Set()

function redirectLocalModel(tabId, url) {
  if (!TARGET.readsSavedFiles) return
  const request = localModelToOpen(url, EXTENSIONS)
  if (!request) return
  redirectedLocalFiles.add(url)
  console.info('[three-slicer] local file opened in the slicer tab', url)
  chrome.tabs.update(tabId, { url: chrome.runtime.getURL(viewerQuery({ ...request, sent: Date.now() })) })
}

chrome.tabs.onCreated.addListener((tab) => redirectLocalModel(tab.id, tab.pendingUrl))
chrome.tabs.onUpdated.addListener((tabId, change) => redirectLocalModel(tabId, change.url))

async function removeLocalCopy(item) {
  console.info('[three-slicer] download', item.id, 'is the copy of a local file already open: removed')
  await chrome.downloads.cancel(item.id).catch(() => {})
  if (item.state === 'complete' && item.filename && fileUrlOf(item.filename) !== item.url) await chrome.downloads.removeFile(item.id).catch(() => {})
  await chrome.downloads.erase({ id: item.id }).catch(() => {})
}

async function maybeOpenDownload(item) {
  if (redirectedLocalFiles.has(item.url)) {
    await removeLocalCopy(item)
    return
  }
  const request = openableDownload(item)
  if (!request) {
    logDownload(item, 'not opened: not a finished download of a file the slicer opens')
    return
  }
  if (claimedDownloads.has(item.id)) return
  claimedDownloads.add(item.id)
  const key = OPENED_PREFIX + item.id
  if ((await chrome.storage.session.get(key))[key]) return
  await chrome.storage.session.set({ [key]: true })
  const settings = await loadSettings(chrome.storage)
  const expected = await takeExpected(request.filename)
  if (!settings.openDownloads && !expected) {
    logDownload(item, 'not opened: "Open downloaded models" is off')
    return
  }
  logDownload(item, 'opened in a slicer tab')
  await openViewer(request)
}

chrome.downloads.onCreated.addListener((item) => maybeOpenDownload(item))
chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state?.current) console.info('[three-slicer] download', delta.id, 'state ->', delta.state.current, delta.error?.current ?? '')
  if (delta.state?.current !== 'complete') return
  const [item] = await chrome.downloads.search({ id: delta.id })
  if (item) await maybeOpenDownload(item)
})

// Messages from the site content scripts. The reply waits for the store write, so a badge that starts its download
// right after the announcement cannot race it.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab) return false
  if (message?.type === 'expect-download' && message.filename) {
    chrome.storage.session.set({ [EXPECTED_PREFIX + message.filename]: Date.now() }).then(() => sendResponse(true))
    return true
  }
  return false
})
