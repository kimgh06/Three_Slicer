// The painting tools that act on one click instead of a drag (upstream's Smart fill, Bucket fill and the single-facet
//  POINTER). Read by the brush input, both brush panels and the slicer worker (`three-slicer-viewer/paint`), so a
//  tool added here is one the whole paint path treats as a fill.
export const FILL_TOOLS = new Set(['smart', 'bucket', 'triangle'])

// The fills that spread across neighbouring facets and so take a fill angle. Triangle is bucket fill with the
//  propagation off (the worker passes -1 as its angle), so it has no angle to set.
export const ANGLE_FILL_TOOLS = new Set(['smart', 'bucket'])
