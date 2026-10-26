import { loadSettings, saveSetting } from './settings.js'

// The formats a download opens by, as build.mjs compiled them from the viewport's own list.
document.getElementById('formats').textContent = __OPENABLE_EXTENSIONS__.map((extension) => `.${extension}`).join(' ')

// Every checkbox on the page is a boolean setting under its own id.
const settings = await loadSettings(chrome.storage)
for (const input of document.querySelectorAll('input[type="checkbox"]')) {
  input.checked = settings[input.id]
  input.addEventListener('change', () => saveSetting(chrome.storage, input.id, input.checked))
}
