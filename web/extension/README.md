# Three Slicer browser extension

The demo app's slicer screen (`web/viewer`'s `/slice`) as an extension page, plus the hand-off that opens a model in
it: a link's context menu, a finished model download from any site, the toolbar button, and a button beside each model
file on Thingiverse. Modelled on rhwp's extension (`edwardkim/rhwp`, `rhwp-chrome/`), which builds its web app a second
time as the extension's viewer page.

Published on the [Chrome Web Store](https://chromewebstore.google.com/detail/three-slicer-%E2%80%94-3d-printin/maniffhfpihfcoadbicplldbhohjmfko). The store takes the version in this folder's `package.json`,
which is separate from the npm packages' and has to go up with every upload.

```bash
npm i                                   # at the repository root, once
npx playwright install chromium         # once, for the tests and the screenshots
cd web/extension
npm run build                           # dist/ — load it unpacked (chrome://extensions, Developer mode)
npm run build -- --target=firefox       # dist-firefox/ — about:debugging, Load Temporary Add-on
npm test                                # unit checks, the build, then the built extension in Chromium
npm run pack                            # three-slicer-extension-<version>.zip for the store upload
npm run screenshots                     # store/screenshot-*.png
```

### After changing the viewer or the kernel

The bundle takes `three-slicer-viewer` and `three-slicer` from their built `dist/` (the packages' `exports`), not from
`viewer-package/src`. A build after a viewer change alone packs the previous viewer: the 30-plate limit was missing
from an extension built that way while the site already had it. Rebuild the packages first:

```bash
cd web && make pkg                      # the packages' dist/ (a kernel change also needs packages/wasm-core/build.sh first)
cd extension && npm run build
```

### Loading it in Chrome

1. `chrome://extensions`, turn on Developer mode.
2. First time: Load unpacked, pick `web/extension/dist`.
3. After a rebuild: the reload button on the Three Slicer card, then close and reopen any open slicer tab. An open tab
   keeps the bundle it started with.

## How a file gets to the slicer

1. The service worker (`src/background.js`) decides a link or a download is a model. The list it decides by is the
   viewport's own, `openableExtensions()` from `three-slicer-viewer/loaders`, read by `build.mjs` after the app's STEP
   loader registered and compiled in as `__OPENABLE_EXTENSIONS__`. A download is decided by the name the browser saves
   it under, because a download URL often has no extension; a downloaded `.zip` is not opened, a picked link to one is.
2. It opens `viewer.html?url=<address>&file=<saved file>&filename=<name>` (`src/viewer_query.js`): a link carries the
   address, a download waits until it is saved and carries the saved file too.
3. The viewer tab reads the file itself (`src/incoming_file.js`): the saved file when the user allowed file URL
   access, else the address. An extension page with host permissions is not subject to CORS, so no proxy is needed;
   no cookies are sent. A `.zip` opens as its model members.
4. `<Viewport files>` is mount-only, so the screen mounts once the file is in hand.

## Why a download is read from disk

Thingiverse downloads a file inside the page and hands it to the browser as a `blob:` URL it revokes within 500ms
(measured), and its `download:<id>` address answers 403 without the session. So the saved file is the only copy the
extension can read, which needs the user's "Allow access to file URLs" (off for a store install; the viewer tab says
so and links to the setting). Unpacked with `--load-extension` it starts on, which is what the e2e test runs with;
turning it off there reloads the extension and it does not come back, so the off path is covered by the unit test.

The Thingiverse badge (`src/content_thingiverse.js`) presses the site's own `Download <name>` button after announcing
the name, so the download opens even with the option off. The accessible label is the only thing it reads off the
page: the class names are build hashes. There is no Printables badge: its pages are behind a bot check that the
headless browser this was developed with does not pass, so its markup was never seen; its downloads still open through
the download path.

## How a 51MB project opens in about 0.5s

Measured on `haaland100_f3.3mf` (303MB of XML, 17 objects, 3.79M facets; page clock, median of 10): 1.24s when the
extension landed, 0.50–0.53s now. What each piece did, in the order it came:

- The viewport's 3mf parse reads the one big part's objects in several workers instead of one (`indexModelXml`
  finds the objects, their spans go out as the part inflates, each helper keeps and pre-builds what it read).
- `build.mjs` writes `dist/boot.js` ahead of the bundle: it starts the parse worker while the 3MB bundle compiles,
  and `viewer.jsx` adopts it (`adoptParseWorker`). Without it the worker took the fetched file up to 114ms late.
- The fetched File is handed to the parse worker unread (`preloadModel`, the moment the fetch ends), so the parse
  runs while the viewport mounts; the viewport's own load takes the result.
- The mesh carries no normal attribute (flat shading derives the face normal in the shader): 136MB less to upload.
- The root part is inflated on one helper and assembled on the parse worker. `DecompressionStream` inflates on the
  thread that reads it (measured: 219ms of zlib for 303MB, all of it the reader's own time, whatever queue sat
  between), so on one thread the indexing and dispatching (~130ms) could only follow it; on two they overlap.
- The archive is read as slices of the File (`zipEntriesFromBlob`): the big part streams from disk into its inflater,
  and nothing reads the 51MB whole first.
- An object's bytes go to its helper in pieces as they inflate (`scanModelXml` resumes on an open object), so the
  last object is read while its own bytes are still arriving instead of after; that was the parse's tail.

What remains is the floor of this file: ~220ms to inflate 303MB (one deflate stream, zlib at ~1.4GB/s), the last
object's own parse after that, and the scene. A typical model (11MB STL) shows in ~0.3s.

## Two things that look optional and are not

- `cross_origin_embedder_policy` / `cross_origin_opener_policy` in the manifest make the extension page cross-origin
  isolated, which is what lets the worker load the threaded kernel. Without them it falls back to the single-threaded
  one (Benchy: 0.6s mt, 2.6s st in the extension page).
- The kernels are linked with `-s DYNAMIC_EXECUTION=0` (`packages/wasm-core/build.sh`). Embind otherwise builds its
  invokers with `new Function`, which the extension CSP (`script-src 'self' 'wasm-unsafe-eval'`) refuses, and neither
  kernel loaded. The e2e test slices inside the extension page, so a regression there fails it.

## Firefox

`npm run build -- --target=firefox` writes `dist-firefox/` from the same sources; `src/targets.js` holds what differs.
The worker module runs as an event page (no MV3 service worker in Firefox), the manifest carries an add-on id and
`data_collection_permissions`, and since a Firefox extension cannot read a `file:` URL, a download that exists only on
disk is not opened and the Thingiverse badge is left out. Web downloads and links still open, fetched again from their
address.

Not run in a real Firefox: none was installed where this was built. `npx web-ext lint --source-dir dist-firefox`
reports one error that blocks an AMO listing: `FILE_TOO_LARGE` on the single-threaded kernel glue
(`slicer_core.js`, 7.2MB, the wasm inlined by `SINGLE_FILE`). The remaining warnings are React DOM's `innerHTML`.
Whether Firefox makes the page cross-origin isolated from the manifest keys, and so loads the threaded kernel, is
also unmeasured; without it the page slices on the single-threaded kernel.

## Store

`store/LISTING.md` holds the listing text and permission justifications, `store/PRIVACY.md` the privacy policy.
