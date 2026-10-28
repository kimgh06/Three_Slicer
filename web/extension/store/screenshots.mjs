// The Chrome Web Store screenshots (1280x800), taken from the built extension: Benchy on the plate, then sliced in the
// preview. Run after `node build.mjs`; writes store/screenshot-*.png.
import { chromium } from 'playwright'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, '..', 'dist')
const benchy = readFileSync(resolve(here, '..', '..', 'viewer', 'public', 'benchy.stl'))

const server = createServer((request, response) => { response.writeHead(200); response.end(benchy) })
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const modelUrl = `http://127.0.0.1:${server.address().port}/benchy.stl`

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
})
let [worker] = context.serviceWorkers()
if (!worker) worker = await context.waitForEvent('serviceworker')
const page = await context.newPage()
await page.goto(`chrome-extension://${new URL(worker.url()).host}/viewer.html?url=${encodeURIComponent(modelUrl)}`)
await page.getByText(/1 object\(s\)/).first().waitFor({ timeout: 30000 })
await page.waitForTimeout(1000)
await page.screenshot({ path: resolve(here, 'screenshot-prepare.png') })
await page.click('[data-testid="slice-btn"]')
await page.locator('[data-testid="slice-stats"]').waitFor({ timeout: 120000 })
await page.getByText('Preview', { exact: true }).click()
await page.waitForTimeout(2000)
await page.screenshot({ path: resolve(here, 'screenshot-preview.png') })
await context.close()
server.close()
console.log(`screenshots -> ${pathToFileURL(here)}`)
