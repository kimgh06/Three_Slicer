// Runs `apply` at most once per scheduled frame, however often it is asked for. A slice's progress arrives as one worker
//  message per step (612 for one Hylian Shield plate), and each set React state and re-rendered the viewport. In Firefox
//  those renders kept the main thread busy long after the worker had finished, and the next plate waited behind its own
//  queued messages: 28 plates took 161 s there against 25 s in Chromium.
export function frameCoalesce(apply, schedule, cancel) {
  let pending = 0
  const run = () => { pending = 0; apply() }
  return {
    request() { if (!pending) pending = schedule(run) },
    // Applies now: the last state of a run must not wait for a frame a hidden tab may never draw.
    flush() { if (pending) cancel(pending); run() },
  }
}
