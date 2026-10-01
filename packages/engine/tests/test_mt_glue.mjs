// The threaded kernel's glue must not carry its wasm. Every pthread worker is started from the glue file itself and
//  parses all of it, while taking the compiled module from the main thread — so bytes inlined there (SINGLE_FILE) are
//  a dead string literal in each of ~16 isolates per kernel. Measured in Chrome on haaland.3mf: ~60MB of V8 heap per
//  pthread isolate, and three slicing workers filled the renderer's shared 4GB pointer-compression cage ("V8
//  javascript OOM", 4 of 6 runs). Split: ~1MB per isolate. The wasm is reached through the literal
//  new URL("…", import.meta.url) shape, which is what Vite and webpack emit as an asset.
import { readFileSync } from 'node:fs'

const glueUrl = new URL('../src/slicer_core.mt.js', import.meta.url)
const wasmUrl = new URL('../src/slicer_core.mt.wasm', import.meta.url)
const glue = readFileSync(glueUrl, 'utf8')
const failures = []

const GLUE_LIMIT_BYTES = 1024 * 1024
if (glue.length > GLUE_LIMIT_BYTES) failures.push(`mt glue is ${glue.length} bytes (limit ${GLUE_LIMIT_BYTES}): the wasm is inlined again`)
if (glue.includes("binaryDecode('")) failures.push('mt glue decodes an inlined binary (SINGLE_FILE is back on the mt link)')
if (!glue.includes('new URL("slicer_core.mt.wasm",import.meta.url)')) failures.push('mt glue does not reach its wasm through new URL("slicer_core.mt.wasm", import.meta.url)')

const wasm = readFileSync(wasmUrl)
if (!WebAssembly.validate(wasm)) failures.push('slicer_core.mt.wasm does not validate')

// And it still loads from beside the glue under node, which is how every mt kernel test reaches it.
const { default: createSlicerMt } = await import(glueUrl.href)
const kernel = await createSlicerMt()
if (typeof kernel.slice !== 'function') failures.push('mt kernel loaded without slice()')

if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1) }
console.log(`ok: mt glue ${glue.length} bytes, wasm ${wasm.length} bytes beside it, kernel loads`)
process.exit(0)
