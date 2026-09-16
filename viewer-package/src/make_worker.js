// Worker factories for this package's own workers — this file is NOT bundled; the build copies it verbatim into
// dist/. For consumer bundlers (Vite/webpack) to recognise a worker as a chunk, the static
// `new Worker(new URL('literal', import.meta.url))` pattern must survive in a file the consumer sees. Every URL
// here is dist-relative: each worker is a lib entry of this package's build and lands beside this file.
// The SLICER worker is not here — it belongs to the AGPL package, which keeps its own make_worker.js.
// 3MF parsing worker. Unlike the slicer worker this one points INTO dist/ — the viewer's `src/` is not published
// (packages/package.json `files` ships `viewer/dist` only), so the worker is a lib entry of the viewer's own build
// and lands beside this file. The static `new Worker(new URL(…))` pattern is what matters either way.
export function makeParse3mfWorker() {
  return new Worker(new URL('./parse_3mf.worker.js', import.meta.url), { type: 'module' })
}

// SL1 mesh-reconstruction workers — same dist-relative story as the 3mf parser above. The pipeline is N slice
// producers (PNG -> occupancy) feeding one nets consumer; see sla_slice.worker.js for why it splits there.
export function makeSlaReconstructWorker() {
  return new Worker(new URL('./sla_reconstruct.worker.js', import.meta.url), { type: 'module' })
}

export function makeSlaSliceWorker() {
  return new Worker(new URL('./sla_slice.worker.js', import.meta.url), { type: 'module' })
}

// SL1 export encoder — the write-side counterpart of the slice workers above, same dist-relative story.
export function makeSl1EncodeWorker() {
  return new Worker(new URL('./sl1_encode.worker.js', import.meta.url), { type: 'module' })
}
