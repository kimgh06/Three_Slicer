// The viewer tab's hand-off: the request viewer_query.js reads out of the tab's URL becomes the File list
// <Viewport files> loads. No DOM and no chrome.* here, so the tests run it under node.
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { fileExt } from 'three-slicer-viewer/loaders'
import { ARCHIVE_EXT } from './archive.js'

// A web address is fetched only over http(s), a saved download only as a file: URL. viewer.html is not a
// web-accessible resource, so a page cannot open it with addresses of its own choosing; they come from a link the user
// picked or a download the browser made.
const WEB_PROTOCOLS = ['https:', 'http:']
const FILE_PROTOCOL = 'file:'

// Typed failures the viewer tab words for the user.
export const INCOMING_ERRORS = {
  // The download is only on disk (a blob: download, or its address needs the user's session) and the user has not
  // allowed the extension to read file URLs.
  FILE_ACCESS_OFF: 'FILE_ACCESS_OFF',
  // The address or the file could not be read.
  FETCH_FAILED: 'FETCH_FAILED',
  // It was read but holds nothing the viewport opens.
  NOTHING_TO_OPEN: 'NOTHING_TO_OPEN',
}

class IncomingFileError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function protocolOf(url) {
  try {
    return new URL(url).protocol
  } catch {
    return ''
  }
}

// filename* (RFC 5987) first, then the plain filename parameter.
export function filenameFromContentDisposition(header) {
  if (!header) return null
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header)
  if (extended) return decodeURIComponent(extended[1].trim())
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header)
  if (plain) return plain[1].trim()
  return null
}

// The name the file is loaded under, which decides its loader: the name the service worker passed (the download's own
// file name), then the server's Content-Disposition, then the last segment of the URL path.
export function fileNameOf({ url, filename, contentDisposition }) {
  if (filename) return filename.split(/[\\/]/).pop()
  const fromHeader = filenameFromContentDisposition(contentDisposition)
  if (fromHeader) return fromHeader
  const segment = new URL(url).pathname.split('/').pop()
  return decodeURIComponent(segment)
}

// A .zip is opened as its members, keeping the ones the viewport opens. Anything else is one file. A .3mf is a zip
// too, but its own loader reads it whole.
export function filesFromBytes(bytes, name, extensions) {
  if (fileExt(name) !== ARCHIVE_EXT) return [new File([bytes], name)]
  const members = unzipSync(bytes)
  const files = []
  for (const [path, data] of Object.entries(members)) {
    const memberName = path.split('/').pop()
    if (path.startsWith('__MACOSX/') || !memberName) continue
    if (extensions.includes(fileExt(memberName))) files.push(new File([data], memberName))
  }
  return files
}

// An extension page with host permissions fetches cross-origin without CORS, so no service-worker proxy is needed.
// Cookies are not sent: a web address is fetched the way a public link resolves, never with the user's session.
async function readSource(source, filename, extensions, fetchImpl) {
  let response
  try {
    response = await fetchImpl(source, { credentials: 'omit' })
  } catch (error) {
    throw new IncomingFileError(INCOMING_ERRORS.FETCH_FAILED, `${source}: ${error.message}`)
  }
  if (!response.ok) throw new IncomingFileError(INCOMING_ERRORS.FETCH_FAILED, `HTTP ${response.status} for ${source}`)
  const name = fileNameOf({ url: source, filename, contentDisposition: response.headers.get('content-disposition') })
  // A single file stays the Blob the response holds: the viewport reads it once. Reading it into an array here first
  //  made one more copy of the whole file (51MB for haaland100_f3.3mf). Only an archive is unpacked here.
  if (fileExt(name) !== ARCHIVE_EXT) return [new File([await response.blob()], name)]
  const bytes = new Uint8Array(await response.arrayBuffer())
  const files = filesFromBytes(bytes, name, extensions)
  if (!files.length) throw new IncomingFileError(INCOMING_ERRORS.NOTHING_TO_OPEN, `${name} holds no file Three Slicer opens (${extensions.join(', ')})`)
  return files
}

// The saved file first when the extension may read it (the exact bytes the user downloaded, no second request), then
// the web address. Only a failed read moves on to the next source: a file with nothing to open is the same file at
// either address.
export async function fetchIncomingFiles(request, extensions, { fetchImpl = fetch, fileAccess = false } = {}) {
  const sources = []
  if (request.file && fileAccess) {
    if (protocolOf(request.file) !== FILE_PROTOCOL) throw new IncomingFileError(INCOMING_ERRORS.FETCH_FAILED, `Not a saved file: ${request.file}`)
    sources.push(request.file)
  }
  if (request.url) {
    if (!WEB_PROTOCOLS.includes(protocolOf(request.url))) throw new IncomingFileError(INCOMING_ERRORS.FETCH_FAILED, `Not a web address: ${request.url}`)
    sources.push(request.url)
  }
  let lastError = null
  for (const source of sources) {
    try {
      return await readSource(source, request.filename, extensions, fetchImpl)
    } catch (error) {
      if (error.code !== INCOMING_ERRORS.FETCH_FAILED) throw error
      lastError = error
    }
  }
  if (request.file && !fileAccess) {
    throw new IncomingFileError(INCOMING_ERRORS.FILE_ACCESS_OFF, `${request.filename ?? 'The download'} is saved on this computer, and Three Slicer may not read saved files yet`)
  }
  throw lastError
}
