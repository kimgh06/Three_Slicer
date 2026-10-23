import SettingsPanelCore from 'three-slicer-viewer/components'   // the settings form (MIT)
import { schema, uiTree } from 'three-slicer/data'               // upstream's labels, tooltips and tab tree (AGPL)
import { makeCfg, disabledKeys } from 'three-slicer/toggle'       // the evaluator bound to upstream's toggle rules (AGPL)

// The permissive settings form with upstream's data plugged in — the one place the pages bind it.
const PANEL_DATA = { schema, uiTree, toggle: { makeCfg, disabledKeys } }

export default function SettingsPanel(props) {
  return <SettingsPanelCore {...PANEL_DATA} {...props} />
}
