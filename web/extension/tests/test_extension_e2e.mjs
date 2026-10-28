// The built extension (dist/) in a real Chromium: the viewer tab opens what a URL points at, a model download opens a
// viewer tab, other downloads do not, and the kernel slices inside the extension page. Run `node build.mjs` first.
// Skips (not fails) without Playwright's Chromium, as the GPU checks skip without a device.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import { chromium } from 'playwright'
import { openableExtensions } from 'three-slicer-viewer/loaders'
import '../../viewer/src/step_loader.js'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, '..', 'dist')
assert.ok(existsSync(resolve(dist, 'manifest.json')), 'dist/ is missing: run `node build.mjs` first')

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ok: ${label}`)
    return
  }
  let suffix = ''
  if (detail) suffix = ` — ${detail}`
  console.log(`  FAIL: ${label}${suffix}`)
  failures++
}

console.log('\n[dist: what build.mjs wrote]')
{
  const background = readFileSync(resolve(dist, 'background.js'), 'utf8')
  check('the service worker is one file (no chunk imports)', !/\bimport\s*[{*\w]|\bimport\(/.test(background))
  check('it carries the viewport\'s extension list', background.replace(/\s+/g, '').includes(JSON.stringify(openableExtensions())),
    JSON.stringify(openableExtensions()))
  const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'))
  const packageJson = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8'))
  check('the manifest version is the package version', manifest.version === packageJson.version, manifest.version)
}

const benchy = readFileSync(resolve(here, '..', '..', 'viewer', 'public', 'benchy.stl'))
const ROUTES = {
  '/benchy.stl': { body: benchy },
  '/parts.zip': { body: zipSync({ 'files/benchy.stl': new Uint8Array(benchy), 'README.txt': strToU8('parts'), '__MACOSX/files/._benchy.stl': strToU8('x') }) },
  '/docs.zip': { body: zipSync({ 'README.txt': strToU8('no model') }) },
  '/notes.txt': { body: Buffer.from('not a model') },
  // The page the downloads are started from.
  '/page.html': { body: Buffer.from('<!doctype html><title>downloads</title>'), headers: { 'content-type': 'text/html' } },
  // A download URL with no extension: only the server's file name says it is a model.
  '/download': { body: benchy, headers: { 'content-disposition': 'attachment; filename="benchy.stl"' } },
}
// No Access-Control-Allow-Origin anywhere: the extension page must not need it.
const server = createServer((request, response) => {
  const route = ROUTES[new URL(request.url, 'http://localhost').pathname]
  if (!route) { response.writeHead(404); response.end(); return }
  response.writeHead(200, { 'content-type': 'application/octet-stream', ...route.headers })
  response.end(route.body)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`

// Downloads must never reach the user's own folder. The profile's default directory is a temporary one, so even the
// browser's default behavior saves there, and the CDP override below (real names) points at it too.
const profileDir = mkdtempSync(resolve(tmpdir(), 'three-slicer-ext-profile-'))
const downloadDir = resolve(profileDir, 'downloads')
mkdirSync(resolve(profileDir, 'Default'), { recursive: true })
writeFileSync(resolve(profileDir, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false } }))

let context
try {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  })
} catch (error) {
  console.log(`skip: no Playwright Chromium (npx playwright install chromium) — ${error.message.split('\n')[0]}`)
  server.close()
  rmSync(profileDir, { recursive: true, force: true })
  process.exit(0)
}
let [worker] = context.serviceWorkers()
if (!worker) worker = await context.waitForEvent('serviceworker')
const extensionId = new URL(worker.url()).host
// Thingiverse, as far as the badge reads it: one button per file labelled "Download <name>", which fetches the file
// from the site and hands it to the browser as a blob: download it revokes shortly after (measured: unreadable 500ms
// later). Served under the real host so the manifest's content script match applies.
const THING_PAGE = 'https://www.thingiverse.com/thing:1/files'
await context.route('https://www.thingiverse.com/**', (route) => {
  const path = new URL(route.request().url()).pathname
  if (path === '/download:1') return route.fulfill({ status: 200, body: benchy, contentType: 'application/octet-stream' })
  return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>thing</title>
    <div><h5>benchy.stl</h5><button aria-label="Download benchy.stl">Download</button></div>
    <div><h5>brochure.pdf</h5><button aria-label="Download brochure.pdf">Download</button></div>
    <script>
      for (const button of document.querySelectorAll('button[aria-label]')) button.addEventListener('click', async () => {
        const bytes = await (await fetch('/download:1')).arrayBuffer()
        const url = URL.createObjectURL(new Blob([bytes]))
        const link = Object.assign(document.createElement('a'), { href: url, download: button.getAttribute('aria-label').slice(9) })
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 100)
      })
    </script>` })
})
// Playwright saves downloads under GUID names with no extension, and the service worker decides by the saved name, as
// it must for a URL like /download?id=1. Saving under the real name, as a browser does, needs the default behavior back.
// The override lasts as long as its CDP session, so the page holding it stays open until the end.
const downloadBehaviorPage = await context.newPage()
await (await context.newCDPSession(downloadBehaviorPage)).send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir })
const viewerUrl = (target) => `chrome-extension://${extensionId}/viewer.html?url=${encodeURIComponent(target)}`
// The extension CSP has no 'unsafe-eval': anything that evaluates a string fails there and nowhere else. The kernel glue
// (embind) and the settings toggle evaluator both did, silently; every page records what the CSP refused.
await context.addInitScript(() => {
  window.__cspViolations = []
  document.addEventListener('securitypolicyviolation', (event) => window.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`))
})

// The viewport lives in a shadow root; Playwright's text locators pierce it, innerText does not.
async function loadedObjects(page) {
  const status = await page.getByText(/\d+ object\(s\)/).first().textContent({ timeout: 15000 }).catch(() => null)
  return Number(/(\d+) object\(s\)/.exec(status ?? '')?.[1] ?? 0)
}
async function incomingError(page) {
  return page.locator('[data-testid="incoming-error"]').textContent({ timeout: 15000 }).catch(() => null)
}
// The next viewer tab to open, or null when none opens within `ms`.
function nextViewerTab(ms) {
  return context.waitForEvent('page', { predicate: (page) => page.url().includes('/viewer.html'), timeout: ms }).catch(() => null)
}
async function download(path) {
  const page = await context.newPage()
  await page.goto(`${origin}/page.html`)
  await page.evaluate((href) => {
    const link = Object.assign(document.createElement('a'), { href, download: '' })
    document.body.append(link)
    link.click()
  }, `${origin}${path}`)
  return page
}
// A download the page makes from a blob and revokes, as Thingiverse does: nothing outside the page can fetch it again.
async function blobDownload(name) {
  const page = await context.newPage()
  await page.goto(`${origin}/page.html`)
  await page.evaluate(async (fileName) => {
    const bytes = await (await fetch('/benchy.stl')).arrayBuffer()
    const url = URL.createObjectURL(new Blob([bytes]))
    Object.assign(document.createElement('a'), { href: url, download: fileName }).click()
    setTimeout(() => URL.revokeObjectURL(url), 100)
  }, name)
  return page
}

console.log('\n[viewer tab: the page is cross-origin isolated, so the threaded kernel loads]')
{
  const page = await context.newPage()
  await page.goto(viewerUrl(`${origin}/benchy.stl`))
  check('crossOriginIsolated', await page.evaluate(() => crossOriginIsolated))
  check('an STL URL with no CORS headers loads one object', (await loadedObjects(page)) === 1)
  await page.click('[data-testid="slice-btn"]')
  const stats = await page.locator('[data-testid="slice-stats"]').textContent({ timeout: 120000 }).catch(() => '')
  check('the model slices inside the extension page', /240 layers/.test(stats), stats.slice(0, 80))
  const violations = await page.evaluate(() => window.__cspViolations)
  check('the page breaks no CSP rule (no string evaluation)', violations.length === 0, [...new Set(violations)].join(', '))
  // The settings panel disables options its toggle rules say are off: 3 under the defaults, as on the site.
  const disabledFields = await page.locator('input:disabled, select:disabled').count()
  check('the toggle rules disable options in the extension too', disabledFields > 0, String(disabledFields))
  await page.close()
}

console.log('\n[viewer tab: archives and failures]')
{
  const page = await context.newPage()
  await page.goto(viewerUrl(`${origin}/parts.zip`))
  check('a zip opens its model members only', (await loadedObjects(page)) === 1)
  check('the member keeps its own name', (await page.getByText('benchy.stl', { exact: true }).count()) === 1)
  await page.goto(viewerUrl(`${origin}/missing.stl`))
  check('a 404 says so', /HTTP 404/.test(await incomingError(page) ?? ''))
  await page.goto(viewerUrl(`${origin}/docs.zip`))
  check('a zip without a model says so', /holds no file/.test(await incomingError(page) ?? ''))
  await page.goto(viewerUrl('file:///etc/hosts'))
  check('a non-web URL is refused', /Not a web address/.test(await incomingError(page) ?? ''))
  await page.close()
}

console.log('\n[downloads]')
{
  let tab = nextViewerTab(15000)
  let source = await download('/benchy.stl')
  let opened = await tab
  check('a model download opens a viewer tab', !!opened)
  if (opened) {
    check('the tab names the downloaded file', new URL(opened.url()).searchParams.get('filename') === 'benchy.stl', opened.url())
    check('the tab loads it', (await loadedObjects(opened)) === 1)
    await opened.close()
  }
  await source.close()

  tab = nextViewerTab(15000)
  source = await download('/download')
  opened = await tab
  check('an extension-less URL opens by the saved file name', !!opened)
  if (opened) {
    // The browser uniquifies the saved name (the first test saved a benchy.stl already), and the viewer uses it.
    const savedName = new URL(opened.url()).searchParams.get('filename')
    check('the saved name comes from Content-Disposition', /^benchy( \(\d+\))?\.stl$/.test(savedName ?? ''), savedName)
    check('and the model loads under it', (await loadedObjects(opened)) === 1 && (await opened.getByText(savedName, { exact: true }).count()) === 1)
    await opened.close()
  }
  await source.close()

  tab = nextViewerTab(15000)
  source = await blobDownload('blobby.stl')
  opened = await tab
  check('a blob: download opens from its saved file', !!opened && new URL(opened.url()).searchParams.get('file')?.startsWith('file://') && !new URL(opened.url()).searchParams.get('url'))
  if (opened) {
    check('and loads', (await loadedObjects(opened)) === 1)
    await opened.close()
  }
  await source.close()

  tab = nextViewerTab(4000)
  source = await download('/notes.txt')
  check('a non-model download opens nothing', !(await tab))
  await source.close()

  tab = nextViewerTab(4000)
  source = await download('/parts.zip')
  check('a downloaded zip opens nothing (only a picked link does)', !(await tab))
  await source.close()

  await worker.evaluate(() => chrome.storage.sync.set({ openDownloads: false }))
  tab = nextViewerTab(4000)
  source = await download('/benchy.stl')
  check('with the option off, a model download opens nothing', !(await tab))
  await source.close()
  await worker.evaluate(() => chrome.storage.sync.set({ openDownloads: true }))
}

console.log('\n[a model file from this computer]')
{
  // Finder drop on a tab, a drop on the tab strip and "Open With > Google Chrome" all reach Chrome as a new tab heading
  // for the file: URL. That tab is sent to the slicer with the original file, and no copy is left in Downloads.
  const local = resolve(here, '..', '..', '..', 'viewer-package', 'testing_files', 'cube.3mf')
  const copies = () => (existsSync(downloadDir) && readdirSync(downloadDir).filter((name) => name.startsWith('cube'))) || []
  const tab = await context.newPage()
  await tab.goto(`${origin}/page.html`)
  let opened = nextViewerTab(15000)
  const session = await context.newCDPSession(tab)
  const data = { items: [], files: [local], dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) await session.send('Input.dispatchDragEvent', { type, x: 100, y: 100, data })
  let viewer = await opened
  check('a dropped local model opens in a slicer tab', !!viewer)
  if (viewer) {
    check('reading the original file', new URL(viewer.url()).searchParams.get('file') === pathToFileURL(local).href, viewer.url())
    check('and loads it', (await loadedObjects(viewer)) === 1)
    await viewer.close()
  }
  await tab.close()
  opened = nextViewerTab(15000)
  await worker.evaluate((url) => chrome.tabs.create({ url }), pathToFileURL(local).href)
  viewer = await opened
  check('a local model opened in a new tab opens in the slicer', !!viewer && (await loadedObjects(viewer)) === 1)
  await viewer?.close()
  await new Promise((done) => setTimeout(done, 1500))
  check('no copy of it is left in Downloads', copies().length === 0, copies().join(', '))
}

console.log('\n[Thingiverse badge]')
{
  // The option off: the badge's announcement is what opens the download.
  await worker.evaluate(() => chrome.storage.sync.set({ openDownloads: false }))
  const page = await context.newPage()
  await page.goto(THING_PAGE)
  const badges = page.locator('.three-slicer-open')
  await badges.first().waitFor({ timeout: 10000 }).catch(() => null)
  check('one badge, beside the model file only', (await badges.count()) === 1)
  check('it names the file', /benchy\.stl/.test(await badges.first().getAttribute('title') ?? ''))
  const tab = nextViewerTab(15000)
  await badges.first().click()
  const opened = await tab
  check('the badge downloads the file and opens it with the option off', !!opened)
  if (opened) {
    check('the opened tab loads it', (await loadedObjects(opened)) === 1)
    await opened.close()
  }
  const quiet = nextViewerTab(4000)
  await page.locator('button[aria-label="Download benchy.stl"]').click()
  check('the site\'s own button, with the option off, still opens nothing', !(await quiet))
  await page.close()
  await worker.evaluate(() => chrome.storage.sync.set({ openDownloads: true }))
}

console.log('\n[context menu]')
{
  const registered = await worker.evaluate(() => new Promise((done) => {
    chrome.contextMenus.update('three-slicer-open-link', {}, () => done(!chrome.runtime.lastError))
  }))
  check('the link menu is registered', registered)
}

// File access off (what a store install starts with) is not driven here: turning the toggle off on
// chrome://extensions reloads an extension loaded with --load-extension, and it does not come back (measured: no
// worker, its pages ERR_BLOCKED_BY_CLIENT for 6s). test_extension.mjs covers the fallback to the web address and the
// FILE_ACCESS_OFF refusal.

await context.close()
server.close()
rmSync(profileDir, { recursive: true, force: true })
if (failures) console.log(`\n${failures} CHECK(S) FAILED`)
else console.log('\nALL EXTENSION E2E CHECKS PASSED')
assert.equal(failures, 0)
