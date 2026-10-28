import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// The extension's pages: the viewer tab (the demo app's slicer screen) and the options page. build.mjs sets the output
// folder per target browser, builds the service worker on its own and completes the folder into a loadable extension.
// base './' because an extension page lives at chrome-extension://<id>/viewer.html: absolute /assets/ paths resolve
// there too, but a relative base keeps the folder loadable from any root, Firefox's moz-extension:// included.
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  publicDir: false,
  resolve: { dedupe: ['react', 'react-dom', 'three'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    emptyOutDir: true,
    // The kernel wasm must stay a file: inlined it becomes a string every pthread isolate parses (see AGENTS.md).
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        viewer: resolve(__dirname, 'viewer.html'),
        options: resolve(__dirname, 'options.html'),
      },
    },
  },
})
