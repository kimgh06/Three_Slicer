// Neither kernel's glue may carry its wasm. The threaded one: every pthread worker is started from the glue file
//  itself and parses all of it, while taking the compiled module from the main thread — so bytes inlined there
//  (SINGLE_FILE) are a dead string literal in each of ~16 isolates per kernel. Measured in Chrome on haaland.3mf: ~60MB
//  of V8 heap per pthread isolate, and three slicing workers filled the renderer's shared 4GB pointer-compression cage
//  ("V8 javascript OOM", 4 of 6 runs). Split: ~1MB per isolate. The single-threaded one: inlined, its glue was a 7.2MB
//  script, and Firefox's add-on validator refuses any JS file over 5MB ("File is too large to parse"). The wasm is
//  reached through the literal new URL("…", import.meta.url) shape, which is what Vite and webpack emit as an asset.
import { readFileSync } from 'node:fs'
import { KERNEL_WASM_BYTES } from '../src/kernel_wasm_bytes.js'

const GLUE_LIMIT_BYTES = 1024 * 1024
const failures = []
const report = []

for (const name of ['slicer_core', 'slicer_core.mt']) {
  const glueUrl = new URL(`../src/${name}.js`, import.meta.url)
  const glue = readFileSync(glueUrl, 'utf8')
  if (glue.length > GLUE_LIMIT_BYTES) failures.push(`${name}.js is ${glue.length} bytes (limit ${GLUE_LIMIT_BYTES}): the wasm is inlined again`)
  if (glue.includes("binaryDecode('")) failures.push(`${name}.js decodes an inlined binary (SINGLE_FILE is back on its link)`)
  if (!glue.includes(`new URL("${name}.wasm",import.meta.url)`)) failures.push(`${name}.js does not reach its wasm through new URL("${name}.wasm", import.meta.url)`)

  const wasm = readFileSync(new URL(`../src/${name}.wasm`, import.meta.url))
  if (!WebAssembly.validate(wasm)) failures.push(`${name}.wasm does not validate`)
  // The worker's download percentage divides by this; a stale entry stops the bar short of 100 or past it.
  if (KERNEL_WASM_BYTES[`${name}.wasm`] !== wasm.length) failures.push(`kernel_wasm_bytes.js says ${KERNEL_WASM_BYTES[`${name}.wasm`]} for ${name}.wasm, the file is ${wasm.length} bytes (rerun build.sh)`)

  // And it still loads from beside the glue under node, which is how every kernel test reaches it.
  const { default: createSlicer } = await import(glueUrl.href)
  const kernel = await createSlicer()
  if (typeof kernel.slice !== 'function') failures.push(`${name} kernel loaded without slice()`)
  report.push(`${name} glue ${glue.length} bytes, wasm ${wasm.length} bytes`)
}

if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1) }
console.log(`ok: ${report.join('; ')}, both kernels load`)
process.exit(0)
