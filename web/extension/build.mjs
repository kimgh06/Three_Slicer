#!/usr/bin/env node
// Builds the extension into a folder a browser loads as is:
//  1. Vite builds the viewer tab (the demo app's slicer screen) and the options page.
//  2. The service worker and each content script the manifest names are built on their own, one file each: sharing
//     chunks with the pages put three.js (540KB) in a chunk the worker imported, parsed on every wake-up for one
//     fileExt(). A manifest content script cannot be a module, so those are classic scripts.
//  3. boot.js is written from the built worker's name and put ahead of the bundle in viewer.html: the 3mf parse worker
//     then starts while the 3MB bundle is still compiling (measured without it: the file was fetched 87ms in and the
//     worker, started by the bundle, took it at 201ms). The bundle picks the worker up through window.threeSlicerBoot.
//  4. The manifest is written with this package's version, in the target browser's shape, and the icons are copied.
// `--target=firefox` builds into dist-firefox/ (src/targets.js holds what differs); the default is Chrome, into dist/.
// The service worker filters links and downloads by the extensions the viewport opens. That list grows at import time
// (registerLoader), so it is read here, after the app's STEP loader registered, and compiled in as
// __OPENABLE_EXTENSIONS__ instead of being typed out a second time. The options page names the same list.
import { build } from 'vite'
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openableExtensions } from 'three-slicer-viewer/loaders'
import '../viewer/src/step_loader.js'
import { DEFAULT_TARGET, targetNamed } from './src/targets.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'))
const targetName = process.argv.find((argument) => argument.startsWith('--target='))?.slice('--target='.length) ?? DEFAULT_TARGET
const target = targetNamed(targetName)
const dist = resolve(here, target.outDir)
const sourceManifest = JSON.parse(readFileSync(resolve(here, 'manifest.json'), 'utf8'))
const manifest = target.manifest(sourceManifest)
manifest.version = packageJson.version

const define = {
  __OPENABLE_EXTENSIONS__: JSON.stringify(openableExtensions()),
  __TARGET__: JSON.stringify(targetName),
  // Printed by the viewer tab with its timing line: tells a stale unpacked load (no reload after a build) apart.
  __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
}
await build({ configFile: resolve(here, 'vite.config.js'), define, build: { outDir: dist } })

// Each script file the manifest names is built from the source file of the same name under src/.
const scripts = [
  { fileName: sourceManifest.background.service_worker, format: 'es' },
  ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js).map((fileName) => ({ fileName, format: 'iife' })),
]
for (const script of scripts) {
  await build({
    configFile: false,
    root: here,
    logLevel: 'warn',
    define,
    build: {
      target: 'es2022',
      outDir: dist,
      emptyOutDir: false,
      lib: { entry: resolve(here, 'src', script.fileName), formats: [script.format], name: 'threeSlicer', fileName: () => script.fileName },
    },
  })
}

// Vite writes the parse worker twice, as the module the bundle starts and as a classic script nothing references
//  (present with the viewer sources at HEAD too); boot.js wants the module.
const parseWorkerFile = readdirSync(resolve(dist, 'assets'))
  .filter((name) => /^parse_3mf\.worker-.*\.js$/.test(name))
  .filter((name) => !readFileSync(resolve(dist, 'assets', name), 'utf8').startsWith('(function'))
if (parseWorkerFile.length !== 1) throw new Error(`expected one built module parse worker, found ${parseWorkerFile.join(', ') || 'none'}`)
writeFileSync(resolve(dist, 'boot.js'), `// Written by build.mjs: starts the 3mf parse worker ahead of the bundle (any query is a file to open). A worker that
// fails to start before the bundle adopts it is marked, so the bundle starts its own instead.
if (location.search) {
  const parseWorker = new Worker(new URL('./assets/${parseWorkerFile[0]}', import.meta.url), { type: 'module' })
  window.threeSlicerBoot = { parseWorker, failed: false }
  parseWorker.onerror = () => { window.threeSlicerBoot.failed = true }
}
`)
const viewerHtml = resolve(dist, 'viewer.html')
const html = readFileSync(viewerHtml, 'utf8')
const bundleTag = html.indexOf('<script type="module" crossorigin src="./assets/viewer-')
if (bundleTag < 0) throw new Error('viewer.html: the bundle script tag was not found')
writeFileSync(viewerHtml, html.slice(0, bundleTag) + '<script type="module" src="./boot.js"></script>\n    ' + html.slice(bundleTag))

writeFileSync(resolve(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
cpSync(resolve(here, 'icons'), resolve(dist, 'icons'), { recursive: true })

console.log(`extension ${manifest.version} (${targetName}) -> ${dist}`)
