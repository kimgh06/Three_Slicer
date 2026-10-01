// octoprint — the whole integration: what <Viewport onExport> needs to send a plate's G-code to OctoPrint
// instead of the Downloads folder. No React, no DOM beyond fetch/FormData/Blob, so it runs under node too
// (test_upload.mjs drives it against a stub server).
//
// OctoPrint's REST API: POST /api/files/{location} with a multipart `file` field, `select`/`print` as form
// fields, and the key in the X-Api-Key header. https://docs.octoprint.org/en/master/api/files.html

/** Only plain G-code goes to OctoPrint. A `.gcode.3mf` is a Bambu print job OctoPrint does not print. */
export const isPrintable = filename => filename.toLowerCase().endsWith('.gcode')

/**
 * Why a request from this page to `url` cannot work, before trying it — or null.
 *
 * A browser refuses an http: request from an https: page (mixed content) without a usable error, so the
 * fetch would only fail with "TypeError: Failed to fetch". localhost is exempt: browsers treat it as a
 * secure origin.
 */
export function connectionProblem(url, pageProtocol) {
  let target
  try {
    target = new URL(url)
  } catch {
    return 'Enter the OctoPrint address, e.g. http://octopi.local'
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return 'The address must start with http:// or https://'
  const local = target.hostname === 'localhost' || target.hostname === '127.0.0.1' || target.hostname === '[::1]'
  if (pageProtocol === 'https:' && target.protocol === 'http:' && !local) {
    return 'This page is https and OctoPrint is http, so the browser blocks the request (mixed content). '
      + 'Run this demo over http (npm run dev) or serve OctoPrint over https.'
  }
  return null
}

// The trailing slash keeps a sub-path (OctoPrint behind a reverse proxy) when the path is resolved against it.
const endpoint = (url, path) => new URL(path, `${url.replace(/\/+$/, '')}/`)

/** Turns a failed fetch into a message a user can act on. */
async function failure(response) {
  const text = await response.text().catch(() => '')
  if (response.status === 401 || response.status === 403) return `OctoPrint rejected the API key (${response.status})`
  return `OctoPrint answered ${response.status}${text && `: ${text.slice(0, 200)}`}`
}

const unreachable = error => new Error(
  `Could not reach OctoPrint (${error.message}). Check the address, and that "Allow Cross Origin Resource `
  + 'Sharing (CORS)" is on in OctoPrint\'s Settings > API.',
)

/** GET /api/version — confirms the address, CORS and the key in one request. Resolves the server version. */
export async function checkConnection({ url, apiKey }) {
  let response
  try {
    response = await fetch(endpoint(url, 'api/version'), { headers: { 'X-Api-Key': apiKey } })
  } catch (error) {
    throw unreachable(error)
  }
  if (!response.ok) throw new Error(await failure(response))
  const { server } = await response.json()
  return server
}

/** Uploads one G-code file to OctoPrint's local storage, optionally starting the print. */
export async function uploadGcode({ url, apiKey, file, filename, print = false }) {
  const form = new FormData()
  form.append('file', file, filename)
  form.append('select', String(print))
  form.append('print', String(print))

  let response
  try {
    response = await fetch(endpoint(url, 'api/files/local'), {
      method: 'POST', headers: { 'X-Api-Key': apiKey }, body: form,
    })
  } catch (error) {
    throw unreachable(error)
  }
  if (!response.ok) throw new Error(await failure(response))
  return response.json()
}
