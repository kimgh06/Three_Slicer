# Send to OctoPrint — three-slicer demo

The full slicer page (printer, filament and process cards with OrcaSlicer's parameter tree), where exporting
G-code uploads it to an OctoPrint server instead of saving it to Downloads. Answers
[issue #35](https://github.com/kimgh06/Three_Slicer/issues/35): "can I send the sliced G-code to OctoPrint?"

The integration is [`src/octoprint.js`](./src/octoprint.js) plus one prop. `<Viewport/>` hands every file it
would download to `onExport`; returning `true` means "handled, do not download":

```jsx
import Viewport from 'three-slicer/viewer'
import { isPrintable, uploadGcode } from './octoprint.js'

<Viewport onExport={(file, filename) => {
  if (!isPrintable(filename)) return false             // STL, 3mf, .gcode.3mf download as usual
  uploadGcode({ url, apiKey, file, filename, print }) // POST /api/files/local
  return true
}} />
```

`.gcode` comes from Export G-code ▾ → Plain .gcode. The main Export G-code button saves a `.gcode.3mf`
(the Bambu print-job format), which OctoPrint does not print, so the demo lets it download.

## Running it

```bash
npm i
npm run dev      # http://localhost:5173
npm test         # src/octoprint.js against a stub OctoPrint server
```

In OctoPrint:

1. Settings > API: copy the API key (or create an application key under Settings > Application Keys).
2. Settings > API: turn on "Allow Cross Origin Resource Sharing (CORS)" and restart OctoPrint. Without it the
   browser blocks every request from this page.

Enter the address and key in the bar at the top, press Test connection, slice, and export. The address,
key and "start printing" choice are kept in this browser's `localStorage` only.

## Where it works

The browser, not this code, decides whether a page can reach OctoPrint:

| This page | OctoPrint | Result |
| --- | --- | --- |
| `http://` (`npm run dev`, a LAN host) | `http://` | works |
| any | `https://` with a certificate the browser trusts | works |
| `https://` (e.g. the hosted `/demos` page) | `http://` on the LAN | blocked as mixed content |

The last row is the common case for a hosted page and a Raspberry Pi, so the demo checks it before sending and
says so instead of failing with "Failed to fetch". Chrome may additionally ask for permission before a public
site reaches a private address (Private Network Access).

If an upload fails for any other reason (wrong key, OctoPrint offline), the status line offers the G-code as a
download. It is a button rather than an automatic download because the upload outlives the Export click's user
activation, and Chrome blocks a download started after that.

## Not included

An OctoPrint plugin that serves this page from OctoPrint itself. That would remove the CORS and mixed-content
limits (same origin) and could send COOP/COEP headers for the multithreaded kernel, but it is a Python package
with its own release cycle, so it stays outside this repository.
