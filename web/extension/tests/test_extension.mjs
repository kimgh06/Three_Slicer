// The extension's pure modules under node: the viewer URL, the fetch policy and file naming, archives, and which links
// and downloads are offered. Plus the guard that the extension list is read from its owner, never typed out here.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import { openableExtensions } from 'three-slicer-viewer/loaders'
import '../../viewer/src/step_loader.js'
import { viewerQuery, requestedFile, VIEWER_PAGE } from '../src/viewer_query.js'
import { fileNameOf, filenameFromContentDisposition, filesFromBytes, fetchIncomingFiles, INCOMING_ERRORS } from '../src/incoming_file.js'
import { ARCHIVE_EXT } from '../src/archive.js'
import { urlExtension, contextMenuPatterns, linkExtensions, downloadToOpen, fileUrlOf, sameDownloadName, localModelToOpen } from '../src/link_filter.js'
import { DEFAULT_SETTINGS, loadSettings } from '../src/settings.js'
import { DEFAULT_TARGET, TARGETS, targetNamed } from '../src/targets.js'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = resolve(here, '..')
const EXTENSIONS = openableExtensions()

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
// The typed code and message of a rejection, or null when it resolved.
async function rejection(promise) {
  try { await promise } catch (error) { return { code: error.code, message: error.message } }
  return null
}

console.log('\n[viewer URL: written by the service worker, read by the viewer tab]')
{
  const request = { url: 'https://files.example.com/a b/benchy.stl?token=1&x=2', file: 'file:///Users/me/Downloads/benchy%20(1).stl', filename: 'benchy (1).stl' }
  const query = viewerQuery(request)
  check('the page is the viewer', query.startsWith(`${VIEWER_PAGE}?`))
  check('round trip keeps url, file and filename', JSON.stringify(requestedFile(query.slice(query.indexOf('?')))) === JSON.stringify(request))
  check('absent fields are left out', viewerQuery({ url: 'https://x.test/m.stl' }) === `${VIEWER_PAGE}?url=https%3A%2F%2Fx.test%2Fm.stl`)
  check('a saved file alone is a request', JSON.stringify(requestedFile('?file=file%3A%2F%2F%2Fa.stl')) === JSON.stringify({ file: 'file:///a.stl' }))
  check('an empty tab has no request', requestedFile('') === null)
}

console.log('\n[fetch policy and naming]')
{
  check('filename* wins over filename', filenameFromContentDisposition(`attachment; filename="plain.stl"; filename*=UTF-8''%ED%95%9C%EA%B8%80.stl`) === '한글.stl')
  check('a quoted filename', filenameFromContentDisposition('attachment; filename="part 1.3mf"') === 'part 1.3mf')
  check('no header, no name', filenameFromContentDisposition(null) === null)
  check('the passed filename wins and loses its folders', fileNameOf({ url: 'https://a.test/x', filename: 'C:\\Users\\me\\Downloads\\boat.stl', contentDisposition: 'attachment; filename="other.stl"' }) === 'boat.stl')
  check('then the server name', fileNameOf({ url: 'https://a.test/download?id=1', contentDisposition: 'attachment; filename="boat.obj"' }) === 'boat.obj')
  check('then the URL path, decoded', fileNameOf({ url: 'https://a.test/models/my%20boat.stl?x=1' }) === 'my boat.stl')
}

console.log('\n[archives]')
{
  const zip = zipSync({
    'parts/hull.stl': strToU8('solid hull\nendsolid hull\n'),
    'parts/mast.3mf': strToU8('3mf bytes'),
    'README.md': strToU8('readme'),
    '__MACOSX/parts/._hull.stl': strToU8('resource fork'),
    'empty-folder/': new Uint8Array(0),
  })
  const files = filesFromBytes(zip, `model.${ARCHIVE_EXT}`, EXTENSIONS)
  check('a zip opens its model members, by their own names', files.map((file) => file.name).sort().join(',') === 'hull.stl,mast.3mf', files.map((file) => file.name).join(','))
  check('a non-archive is one file', filesFromBytes(strToU8('x'), 'boat.stl', EXTENSIONS).map((file) => file.name).join() === 'boat.stl')
  check('a .3mf is not unpacked', filesFromBytes(zip, 'project.3mf', EXTENSIONS).length === 1)
}

console.log('\n[fetchIncomingFiles: the saved file, then the web address]')
{
  const stl = 'solid x\nendsolid x\n'
  // A fake fetch answering per URL; `null` throws as a network failure would.
  const fake = (table) => {
    const seen = []
    const fetchImpl = async (url, options) => {
      seen.push({ url, options })
      const entry = table[url]
      if (entry === null || entry === undefined) throw new TypeError('Failed to fetch')
      return new Response(entry.body, { status: entry.status ?? 200, headers: entry.headers ?? {} })
    }
    return { fetchImpl, seen }
  }
  const file = 'file:///Users/me/Downloads/x.stl'
  const url = 'https://a.test/download?id=7'
  let run = fake({ [file]: { body: stl }, [url]: { body: stl } })
  let files = await fetchIncomingFiles({ file, url, filename: 'x.stl' }, EXTENSIONS, { fetchImpl: run.fetchImpl, fileAccess: true })
  check('with file access the saved file is read and the web is not asked', files[0]?.name === 'x.stl' && run.seen.map((call) => call.url).join() === file)
  run = fake({ [file]: null, [url]: { body: stl } })
  files = await fetchIncomingFiles({ file, url, filename: 'x.stl' }, EXTENSIONS, { fetchImpl: run.fetchImpl, fileAccess: true })
  check('a saved file that cannot be read falls back to the address', files.length === 1 && run.seen.length === 2)
  run = fake({ [url]: { body: stl } })
  files = await fetchIncomingFiles({ file, url, filename: 'x.stl' }, EXTENSIONS, { fetchImpl: run.fetchImpl, fileAccess: false })
  check('without file access the address is fetched, never the file', files.length === 1 && run.seen.map((call) => call.url).join() === url)
  check('cookies are not sent', run.seen.every((call) => call.options?.credentials === 'omit'))
  run = fake({ [url]: { status: 403, body: '' } })
  let failure = await rejection(fetchIncomingFiles({ file, url, filename: 'x.stl' }, EXTENSIONS, { fetchImpl: run.fetchImpl, fileAccess: false }))
  check('a download only on disk, without file access, asks for it', failure?.code === INCOMING_ERRORS.FILE_ACCESS_OFF, JSON.stringify(failure))
  failure = await rejection(fetchIncomingFiles({ file, filename: 'x.stl' }, EXTENSIONS, { fetchImpl: fake({}).fetchImpl, fileAccess: false }))
  check('so does a blob: download (a file and no address)', failure?.code === INCOMING_ERRORS.FILE_ACCESS_OFF)
  run = fake({ 'https://a.test/download?id=8': { body: stl, headers: { 'content-disposition': 'attachment; filename="y.stl"' } } })
  files = await fetchIncomingFiles({ url: 'https://a.test/download?id=8' }, EXTENSIONS, { fetchImpl: run.fetchImpl })
  check('a link is named by its server', files[0]?.name === 'y.stl')
  failure = await rejection(fetchIncomingFiles({ url: 'https://a.test/m.stl' }, EXTENSIONS, { fetchImpl: fake({ 'https://a.test/m.stl': { status: 404, body: '' } }).fetchImpl }))
  check('a failed link says so', failure?.code === INCOMING_ERRORS.FETCH_FAILED && /HTTP 404/.test(failure.message))
  failure = await rejection(fetchIncomingFiles({ url: 'file:///etc/hosts' }, EXTENSIONS, { fetchImpl: () => { throw new Error('fetched') } }))
  check('a file: URL is never taken as a web address', /Not a web address/.test(failure?.message ?? ''))
  failure = await rejection(fetchIncomingFiles({ file: 'https://a.test/m.stl' }, EXTENSIONS, { fetchImpl: () => { throw new Error('fetched') }, fileAccess: true }))
  check('a web address is never taken as a saved file', /Not a saved file/.test(failure?.message ?? ''))
  run = fake({ [file]: { body: zipSync({ 'a.txt': strToU8('x') }) }, [url]: { body: stl } })
  failure = await rejection(fetchIncomingFiles({ file, url, filename: 'docs.zip' }, EXTENSIONS, { fetchImpl: run.fetchImpl, fileAccess: true }))
  check('an archive with nothing to open stops there (the address holds the same file)', failure?.code === INCOMING_ERRORS.NOTHING_TO_OPEN && run.seen.length === 1)
  // A single file of another type is handed on as is: the viewport's own load names what it refuses.
  files = await fetchIncomingFiles({ url: 'https://a.test/notes.txt' }, EXTENSIONS, { fetchImpl: fake({ 'https://a.test/notes.txt': { body: 'x' } }).fetchImpl })
  check('a single unknown file is handed to the viewport', files.length === 1)
}

console.log('\n[links and downloads]')
{
  check('the URL extension ignores the query', urlExtension('https://a.test/m.STL?x=1.gcode#y') === 'stl')
  check('an unparseable URL has none', urlExtension('::') === '')
  const patterns = contextMenuPatterns(EXTENSIONS)
  for (const extension of linkExtensions(EXTENSIONS))
    check(`the menu covers .${extension}, with and without a query`, patterns.includes(`*://*/*.${extension}`) && patterns.includes(`*://*/*.${extension}?*`))
  check('the menu offers every openable extension and the archive', linkExtensions(EXTENSIONS).length === EXTENSIONS.length + 1)
  check('a POSIX path becomes a file URL', fileUrlOf('/Users/me/Down loads/boat#1.stl') === 'file:///Users/me/Down%20loads/boat%231.stl')
  check('a Windows path becomes a file URL', fileUrlOf('C:\\Users\\me\\Downloads\\boat.stl') === 'file:///C:/Users/me/Downloads/boat.stl')
  const item = (fields) => ({ id: 1, state: 'complete', url: 'https://a.test/download?id=1', filename: '/Users/me/Downloads/boat.stl', ...fields })
  check('a download still being written waits', downloadToOpen(item({ state: 'in_progress' }), EXTENSIONS) === null)
  check('a download with no name yet waits', downloadToOpen(item({ filename: '' }), EXTENSIONS) === null)
  check('a finished model opens as its saved file and its address', JSON.stringify(downloadToOpen(item({}), EXTENSIONS)) === JSON.stringify({ file: 'file:///Users/me/Downloads/boat.stl', filename: 'boat.stl', url: 'https://a.test/download?id=1' }))
  check('the redirected address is the one kept', downloadToOpen(item({ finalUrl: 'https://cdn.test/boat.stl' }), EXTENSIONS)?.url === 'https://cdn.test/boat.stl')
  const blobRequest = downloadToOpen(item({ url: 'blob:https://www.thingiverse.com/1234' }), EXTENSIONS)
  check('a blob: download opens as its saved file only', blobRequest?.file === 'file:///Users/me/Downloads/boat.stl' && !('url' in blobRequest), JSON.stringify(blobRequest))
  check('a G-code download opens', downloadToOpen(item({ filename: '/d/boat.gcode' }), EXTENSIONS) !== null)
  check('a text download does not', downloadToOpen(item({ filename: '/d/notes.txt' }), EXTENSIONS) === null)
  check('a zip download does not', downloadToOpen(item({ filename: `/d/boat.${ARCHIVE_EXT}` }), EXTENSIONS) === null)
  check('a local model file opens as itself', JSON.stringify(localModelToOpen('file:///Users/me/Down%20loads/haaland.3mf', EXTENSIONS)) === JSON.stringify({ file: 'file:///Users/me/Down%20loads/haaland.3mf', filename: 'haaland.3mf' }))
  check('a local file of another type, a web model and a blank tab do not', localModelToOpen('file:///Users/me/notes.txt', EXTENSIONS) === null && localModelToOpen('https://a.test/m.stl', EXTENSIONS) === null && localModelToOpen(undefined, EXTENSIONS) === null)
  check('a renamed copy is still the announced download', sameDownloadName('benchy (2).stl', 'benchy.stl') && sameDownloadName('benchy.stl', 'benchy.stl'))
  check('another file is not', !sameDownloadName('benchy2.stl', 'benchy.stl') && !sameDownloadName('benchy (2).stl.txt', 'benchy.stl'))
}

console.log('\n[settings]')
{
  const storage = (stored) => ({ sync: { get: async (defaults) => ({ ...defaults, ...stored }) } })
  check('downloads open by default', (await loadSettings(storage({}))).openDownloads === true)
  check('a stored choice wins', (await loadSettings(storage({ openDownloads: false }))).openDownloads === false)
  check('every setting has a default', Object.keys(DEFAULT_SETTINGS).length > 0)
}

console.log('\n[targets: one manifest, two browsers]')
{
  const source = JSON.parse(readFileSync(resolve(extensionRoot, 'manifest.json'), 'utf8'))
  check('Chrome is the default', DEFAULT_TARGET === 'chrome' && targetNamed(DEFAULT_TARGET) === TARGETS.chrome)
  check('the Chrome manifest is the source as written', JSON.stringify(TARGETS.chrome.manifest(source)) === JSON.stringify(source))
  const firefox = TARGETS.firefox.manifest(source)
  check('Firefox runs the same worker module as an event page', JSON.stringify(firefox.background) === JSON.stringify({ scripts: [source.background.service_worker], type: 'module' }))
  check('Firefox has an add-on id and declares no data collection', !!firefox.browser_specific_settings?.gecko?.id && firefox.browser_specific_settings.gecko.data_collection_permissions?.required?.[0] === 'none')
  check('Firefox ships no content script (its downloads are blob:, which it cannot read back)', !('content_scripts' in firefox) && TARGETS.firefox.readsSavedFiles === false)
  check('the targets build into different folders', TARGETS.chrome.outDir !== TARGETS.firefox.outDir)
  let unknown = null
  try { targetNamed('safari') } catch (error) { unknown = error.message }
  check('an unknown target is refused by name', /Unknown target safari/.test(unknown ?? ''))
}

console.log('\n[one owner: the extension list is never typed out in the extension]')
{
  // The pattern is built from the owner, so a format the viewport gains is guarded the day it is registered.
  const quoted = new RegExp(`['"\`](${[...EXTENSIONS, ARCHIVE_EXT].join('|')})['"\`]`)
  const sources = [
    ...readdirSync(resolve(extensionRoot, 'src')).map((name) => `src/${name}`),
    'manifest.json', 'build.mjs', 'vite.config.js',
  ]
  for (const path of sources) {
    const text = readFileSync(resolve(extensionRoot, path), 'utf8')
    const match = quoted.exec(text)
    const allowed = path === 'src/archive.js' && match?.[1] === ARCHIVE_EXT
    check(`${path} types out no extension`, !match || allowed, match?.[0])
  }
}

if (failures) console.log(`\n${failures} CHECK(S) FAILED`)
else console.log('\nALL EXTENSION CHECKS PASSED')
assert.equal(failures, 0)
