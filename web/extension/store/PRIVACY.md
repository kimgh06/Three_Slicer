# Three Slicer extension — privacy policy

The Three Slicer browser extension does not collect, store or transmit personal data.

## What it does with files

- Slicing runs inside the browser, in the extension's own page, with a WebAssembly build of the OrcaSlicer kernel.
  Models and G-code are never uploaded anywhere.
- When you open a link with the extension, it fetches that one file from the link's address. The request carries no
  cookies, so it reads the file the way a public link resolves.
- When a model download opens in a slicer tab, the tab reads the file the browser saved, if you allowed the extension
  to read file URLs; otherwise it fetches the download's address again, without cookies. It reads no other file.
- The file stays in the tab's memory. Closing the tab discards it. The download itself is saved by the browser as
  usual.

## What it stores

- One setting, whether downloaded models open in a slicer tab, in `chrome.storage.sync`.
- The ids of downloads it already opened, and the name of a file whose "Open in Three Slicer" button was just clicked,
  in `chrome.storage.session`, which the browser clears when it closes.

No analytics, tracking, advertising or remote code. The extension makes no request other than the file you opened.

## Permissions

| Permission | Why |
|---|---|
| `downloads` | Notice a finished model download (by its saved file name) and open it in a slicer tab |
| File URL access (optional, off until you turn it on) | Read a finished download from disk: the only copy of a file a site hands out as an in-page download (Thingiverse does) |
| `contextMenus` | The "Open in Three Slicer" item on links to model files |
| `storage` | The setting above and the opened-download ids |
| host access to all sites | Fetch the model a link or a download points at, from whichever site hosts it; the open button runs on thingiverse.com only |

## Source

The extension is open source (AGPL-3.0-or-later): https://github.com/kimgh06/Three_Slicer/tree/main/web/extension
