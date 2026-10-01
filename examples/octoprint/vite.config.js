import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative base so the same build works at a domain root and under a sub-path — the /demos route in
  // web/viewer serves these from /demos/<name>/.
  base: './',
  plugins: [react()],

  // The two three-slicer requirements: the kernel worker is an ES module, and the multithreaded glue
  // uses top-level await.
  worker: { format: 'es' },
  build: { target: 'es2022' },

  // The viewer builds its worker with a co-located `new Worker(new URL(...), ...)`, which Vite bundles
  // properly on its own — this embed needs no `?worker` import (instant-quote, which drives the worker
  // through three-slicer/client, does).
  optimizeDeps: { exclude: ['three-slicer'] },

  // Cross-origin isolation switches the kernel to the multithreaded build. Off by default so dev matches
  // plain static hosting.
  // server: {
  //   headers: {
  //     'Cross-Origin-Opener-Policy': 'same-origin',
  //     'Cross-Origin-Embedder-Policy': 'require-corp',
  //   },
  // },
})
