import { defineConfig } from 'vite'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Library build — transpiles JSX only; everything else stays external.
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),   // pins entry/outDir even when run from the repo root via --config
  build: {
    lib: {
      // The workers are entries rather than bundled imports: make_worker.js reaches each by a dist-relative URL,
      // and only dist/ is published. Keeping them entries is what puts a file at that URL.
      entry: {
        index: 'src/index.js', toolpath: 'src/scene/toolpath_gpu.js', gcode_parse: 'src/core/gcode_parse.js',
        model_loaders: 'src/scene/model_loaders.js', components: 'src/components/SettingsPanel.jsx',
        'parse_3mf.worker': 'src/parse_3mf.worker.js', 'sla_reconstruct.worker': 'src/sla_reconstruct.worker.js',
        'sla_slice.worker': 'src/sla_slice.worker.js', 'sl1_encode.worker': 'src/sl1_encode.worker.js',
      },
      formats: ['es'],
    },
    outDir: 'dist',
    target: 'es2022',
    emptyOutDir: true,
    rollupOptions: {
      external: [/^react(-dom)?($|\/)/, /^three($|\/)/,
        // Self-references. settings/ and data.js ship UNBUNDLED and are imported by package name so the JSON
        //  import attributes survive (see src/settings/data.js) — bundling them in would strip the attribute.
        /^three-slicer-viewer($|\/)/,
        // make_worker.js is external + copied verbatim (build script) — preserves the static worker pattern.
        /make_worker\.js$/],
      output: { paths: (id) => /make_worker\.js$/.test(id) ? './make_worker.js' : id },
    },
  },
})
