// 3MF parsing off the main thread. A real MakerWorld project takes ~2s to read (52MB compressed, 315MB of XML,
//  3.8M triangles) and every millisecond of that used to be a frozen UI — no spinner, no camera, no cancel.
//  Nothing here needs the DOM (regexes and fflate only), so the whole parser moves across unchanged.
// The result's triangle arrays are TRANSFERRED rather than copied: they are the bulk of the payload (34M floats,
//  ~136MB on that file) and the worker has no use for them afterwards. The input buffer is NOT transferred —
//  cloning 52MB costs little next to the parse, and neutering it would leave the caller's in-thread fallback
//  (model_loaders.js) with an empty buffer if this worker ever fails to start.
import { parse3MFProject } from './core/parse_3mf.js'

self.onmessage = async (event) => {
  const { id, buffer, baseName } = event.data || {}
  try {
    const { objects, project } = await parse3MFProject(buffer, baseName)
    // Maps (the paint slots, project.objectMeta) survive structured clone as Maps, so the shape the main thread
    //  receives is the shape parse3MFProject returns — no serialisation step to keep in sync.
    self.postMessage({ id, objects, project }, objects.map(o => o.tris.buffer))
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) })
  }
}
