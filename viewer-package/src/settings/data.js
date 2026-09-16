// The single import site for this package's JSON artifacts — the same funnel rule as three-slicer's
// engine/src/data.js: Vite strips `with { type: 'json' }` from bundles, so JSON may only be imported from a
// module that is shipped UNBUNDLED and that the viewer build treats as external. That module is this one.
export { default as leanSchema } from '../../data/config-schema-lean.json' with { type: 'json' }
export { default as uiTreeKeys } from '../../data/ui-tree-keys.json' with { type: 'json' }
export { default as presetKeys } from '../../data/preset-keys.json' with { type: 'json' }
