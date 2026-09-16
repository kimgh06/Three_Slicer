# Third-party notices

`three-slicer-viewer` is licensed MIT (`LICENSE`). It contains no code from OrcaSlicer, PrusaSlicer or any other
slicer — the provenance audit behind that statement is `../packages/PROVENANCE.md`.

## Peer dependencies (not bundled or redistributed)

| Package | License | Used for |
| --- | --- | --- |
| three | MIT | the scene, and `three/examples/jsm/libs/fflate.module.js` for zip/unzip in the 3mf and SL1 codecs |
| react, react-dom | MIT | `<Viewport/>` and `<SettingsPanel/>`; the `/toolpath` and `/gcode` entries need neither |

All three are optional peers: a consumer that only parses G-code or builds toolpath geometry installs none of them.

## Data

`data/config-schema-lean.json`, `data/ui-tree-keys.json` and `data/preset-keys.json` are option-key lists, types,
defaults and layout flags extracted from OrcaSlicer's configuration — facts about an option set, carrying none of
its authored text (labels, tooltips) and none of its vendor preset values. Those stay with `three-slicer`.
