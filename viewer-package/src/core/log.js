// Console output, switchable by the host (<Viewport features={{ logs: false }} />).
//
// A published component that writes to the host's console unconditionally is noise in somebody else's application,
// and these lines are diagnostics — which kernel variant loaded, why a cancel did nothing, how long an export's
// three phases took. Useful while working on the viewer, not in a product's console.
//
// A module-level flag rather than a context or a prop threaded through ten call sites: the log sites live in
// factories and effects that already receive a deps object each, and adding a logger to all of them would cost
// more than the feature. One viewer per page is the normal case; two with different settings would share the last
// one set, which is a trade this note exists to make visible rather than to hide.
let enabled = true

export function setLogging(on) { enabled = !!on }

export const log = {
  info: (...args) => { if (enabled) console.info(...args) },
  warn: (...args) => { if (enabled) console.warn(...args) },
  error: (...args) => { if (enabled) console.error(...args) },
}
