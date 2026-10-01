// Builds examples/* and copies each dist into public/demos/<name>/, so the /demos route can serve the
// real thing in an iframe rather than a re-implementation of it.
//
// The demos are standalone npm projects (they install three-slicer from the registry, not from this
// repo), so this script does not try to link anything — it runs their own build and copies the output.
// A demo that has not had `npm i` run in it is skipped with a message rather than failing the build:
// the /demos page degrades to "not built yet" for that card.
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const examples = resolve(here, '../../../examples')
const out = resolve(here, '../public/demos')

// The file each demo would have you copy into your own app — shown next to the running demo.
const DEMOS = [
  { name: 'instant-quote', integration: 'src/estimate.js' },
  { name: 'printer-showcase', integration: 'src/slicer_section.jsx' },
  { name: 'cad-embed', integration: 'src/print_feedback.js' },
  { name: 'farm-dashboard', integration: 'src/submit_job.js' },
  { name: 'octoprint', integration: 'src/octoprint.js' },
]

await mkdir(out, { recursive: true })

const force = process.argv.includes('--force')

/** Newest mtime under a path, skipping the directories a build should not depend on. */
async function newest(path) {
  const info = await stat(path)
  if (!info.isDirectory()) return info.mtimeMs
  const entries = await readdir(path, { withFileTypes: true })
  let latest = info.mtimeMs
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    latest = Math.max(latest, await newest(join(path, entry.name)))
  }
  return latest
}

/**
 * `make dev` depends on this, so it has to be cheap when nothing changed: four Vite builds are ~8s and
 * would be paid on every dev start. Compare the copied output against the demo's sources instead.
 */
async function isStale(dir, copied) {
  if (force || !existsSync(join(copied, 'index.html'))) return true
  const [source, built] = await Promise.all([newest(dir), stat(join(copied, 'index.html'))])
  return source > built.mtimeMs
}

const built = []
for (const demo of DEMOS) {
  const dir = join(examples, demo.name)
  if (!existsSync(join(dir, 'node_modules'))) {
    console.warn(`[demos] skip ${demo.name} — run \`npm i\` in examples/${demo.name} first`)
    continue
  }

  const copied = join(out, demo.name)
  if (await isStale(dir, copied)) {
    console.log(`[demos] building ${demo.name}`)
    execFileSync('npm', ['run', 'build'], { cwd: dir, stdio: 'inherit' })
    await cp(join(dir, 'dist'), copied, { recursive: true })
    await cp(join(dir, demo.integration), join(copied, 'integration.txt'))
  } else {
    console.log(`[demos] ${demo.name} up to date`)
  }
  // The install line and the version badge come from the demo's OWN package.json rather than being
  // written into the page: the two drift, and they already did — the demos sat on ^0.1.7 while the
  // package published 0.2.4, which nothing on the page could have shown.
  const { dependencies = {} } = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  built.push({
    ...demo,
    lines: (await readFile(join(dir, demo.integration), 'utf8')).split('\n').length,
    deps: Object.keys(dependencies).sort(),
    version: dependencies['three-slicer'] ?? null,
  })
}

// A manifest rather than a hard-coded list in the page: the page then shows exactly what exists.
await writeFile(join(out, 'manifest.json'), JSON.stringify(built, null, 2) + '\n')
console.log(`[demos] ${built.length}/${DEMOS.length} ready in public/demos/`)
