// The extension's own settings, in chrome.storage.sync. The service worker and the options page read them through here.
export const DEFAULT_SETTINGS = {
  // Open a downloaded model in a slicer tab. The download itself still completes.
  openDownloads: true,
}

export async function loadSettings(storage) {
  const stored = await storage.sync.get(DEFAULT_SETTINGS)
  return { ...DEFAULT_SETTINGS, ...stored }
}

export function saveSetting(storage, key, value) {
  return storage.sync.set({ [key]: value })
}
