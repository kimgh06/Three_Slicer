// The object-list state rows, in ONE place: every path that rebuilds the list (load, delete, extruder change,
// refreshObjects) must produce the same shape, or a row silently loses a field — which is exactly what
// happened to the `plate` annotation when three call sites each spelled the mapping out by hand (the loader's
// copy lacked it, so freshly loaded objects all grouped under plate 1 until something else refreshed).
// `facets` is what the plate-parallel Auto worker count sizes memory by — an STL is 50 bytes per facet.
export function objectRows(records, api) {
  return records.map(o => ({ id: o.id, name: o.name, extruder: o.extruder, visible: o.visible !== false,
    plate: api?.plateOfObject?.(o) ?? 0, facets: (o.localPos?.length ?? 0) / 9 }))
}
