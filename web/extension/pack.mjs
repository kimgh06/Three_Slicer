#!/usr/bin/env node
// Zips a build into the archive a store upload takes, with manifest.json at the archive root:
// three-slicer-extension-<version>.zip for Chrome, -firefox.zip for `--target=firefox`. Run after `node build.mjs`.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { DEFAULT_TARGET, targetNamed } from './src/targets.js'

const here = dirname(fileURLToPath(import.meta.url))
const targetName = process.argv.find((argument) => argument.startsWith('--target='))?.slice('--target='.length) ?? DEFAULT_TARGET
const dist = resolve(here, targetNamed(targetName).outDir)
const suffix = { [DEFAULT_TARGET]: '' }[targetName] ?? `-${targetName}`
const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'))

function filesUnder(folder) {
  return readdirSync(folder).flatMap((name) => {
    const path = resolve(folder, name)
    if (statSync(path).isDirectory()) return filesUnder(path)
    return [path]
  })
}

const entries = {}
for (const path of filesUnder(dist)) entries[relative(dist, path)] = readFileSync(path)
const archive = resolve(here, `three-slicer-extension-${manifest.version}${suffix}.zip`)
writeFileSync(archive, zipSync(entries, { level: 9 }))
console.log(`${Object.keys(entries).length} files -> ${archive}`)
