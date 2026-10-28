// The browsers the extension builds for and what differs between them. build.mjs picks one with --target=<name> and
// writes its manifest; the built code reads its own entry through __TARGET__.
export const DEFAULT_TARGET = 'chrome'

// Firefox needs an add-on id for MV3 and for storage.sync. The floor is data_collection_permissions, which AMO requires
// (web-ext lint: Firefox 140, Firefox for Android 142).
const GECKO_ID = 'three-slicer@kimgh06.github.io'
const GECKO_MIN_VERSION = '140.0'
const GECKO_ANDROID_MIN_VERSION = '142.0'

export const TARGETS = {
  chrome: {
    outDir: 'dist',
    // An extension may read file: URLs once the user allows it, so a download only on disk can be opened.
    readsSavedFiles: true,
    settingsUrl: (extensionId) => `chrome://extensions/?id=${extensionId}`,
    manifest: (manifest) => manifest,
  },
  firefox: {
    outDir: 'dist-firefox',
    // Firefox gives an extension no way to read a file: URL. A download that exists only on disk (a blob: download)
    // is therefore not opened, and the Thingiverse badge, whose downloads are all blob:, is left out.
    readsSavedFiles: false,
    settingsUrl: null,
    manifest: ({ background, content_scripts: contentScripts, ...rest }) => ({
      ...rest,
      // No MV3 service worker in Firefox: the same module runs as an event page.
      background: { scripts: [background.service_worker], type: 'module' },
      // Nothing is collected (store/PRIVACY.md); AMO requires the add-on to say so.
      browser_specific_settings: {
        gecko: { id: GECKO_ID, strict_min_version: GECKO_MIN_VERSION, data_collection_permissions: { required: ['none'] } },
        gecko_android: { strict_min_version: GECKO_ANDROID_MIN_VERSION },
      },
    }),
  },
}

export function targetNamed(name) {
  const target = TARGETS[name]
  if (!target) throw new Error(`Unknown target ${name}: one of ${Object.keys(TARGETS).join(', ')}`)
  return target
}
