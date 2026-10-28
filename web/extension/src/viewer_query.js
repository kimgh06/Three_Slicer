// The viewer tab's address: viewer.html?url=<web address>&file=<saved file>&filename=<name>&sent=<ms>. The service
// worker writes it and the viewer reads it, so both go through this module. A link carries `url` only; a finished
// download carries `file` and, when it came from a web address, `url` too. `sent` is the epoch millisecond the worker
// sent the tab here, so the tab can say how long Chrome took to start it (a cold service worker, a new renderer).
export const VIEWER_PAGE = 'viewer.html'
const FIELDS = ['url', 'file', 'filename', 'sent']

export function viewerQuery(request) {
  const params = new URLSearchParams()
  for (const field of FIELDS) {
    if (request[field]) params.set(field, request[field])
  }
  return `${VIEWER_PAGE}?${params}`
}

// The request in the viewer's own URL, or null when the tab was opened empty (the toolbar button).
export function requestedFile(search) {
  const params = new URLSearchParams(search)
  if (!params.get('url') && !params.get('file')) return null
  const request = {}
  for (const field of FIELDS) {
    if (params.get(field)) request[field] = params.get(field)
  }
  return request
}
