#!/usr/bin/env node
// Builds the extension into a folder a browser loads as is:
//  1. Vite builds the viewer tab (the demo app's slicer screen) and the options page.
//  2. The service worker and each content script the manifest names are built on their own, one file each: sharing
//     chunks with the pages put three.js (540KB) in a chunk the worker imported, parsed on every wake-up for one
//     fileExt(). A manifest content script cannot be a module, so those are classic scripts.
//  3. The manifest is written with this package's version, in the target browser's shape, and the icons are copied.
// `--target=firefox` builds into dist-firefox/ (src/targets.js holds what differs); the default is Chrome, into dist/.
// The service worker filters links and downloads by the extensions the viewport opens. That list grows at import time
// (registerLoader), so it is read here, after the app's STEP loader registered, and compiled in as
// __OPENABLE_EXTENSIONS__ instead of being typed out a second time. The options page names the same list.
import { build } from 'vite'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
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

writeFileSync(resolve(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
cpSync(resolve(here, 'icons'), resolve(dist, 'icons'), { recursive: true })

console.log(`extension ${manifest.version} (${targetName}) -> ${dist}`)
