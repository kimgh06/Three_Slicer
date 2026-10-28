// three-slicer-viewer/workers — the factories of this package's own workers, for a host that starts one before the
// viewer bundle has loaded (hand the parse worker to adoptParseWorker in three-slicer-viewer/loaders).

/** The 3mf parse worker. */
export function makeParse3mfWorker(): Worker
/** The SL1 mesh-reconstruction workers. */
export function makeSlaReconstructWorker(): Worker
export function makeSlaSliceWorker(): Worker
/** The SL1 mask encoder. */
export function makeSl1EncodeWorker(): Worker
