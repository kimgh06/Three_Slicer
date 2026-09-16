import { MAX_PAINT_EXTRUDERS, DEFAULT_FILAMENT_COLORS, UNKNOWN_COLOR } from '../core/viewer_defaults.js'

// The default palette lives in core/viewer_defaults.js; re-exported here for existing importers.
export { DEFAULT_FILAMENT_COLORS }

// The filament list: its colours, and adding or removing a slot.
//
// The colour lives in TWO places on purpose and they have to be written together. `extruderColors` is what the
// viewer DRAWS with — the object bodies, the paint chips, the paint overlay, the toolpath Filament view — and is
// component state so those re-render. `filament_colour` is what the SETTINGS MAP carries: it is the key upstream
// stores the palette under, so it is what `<SettingsPanel/>` edits, what a "Save as 3mf" writes out, and what a
// project import reads back (`replaceAll`, called from actions/model_load.js). Only the import direction existed:
// picking a colour moved the state and left the settings map holding whatever the project had, so the swatch and
// the saved file disagreed from the first click — and a project saved after recolouring came back in the old
// colours. Every mutation below therefore mirrors the new list into the settings map.
//
// `extruderColorsRef` is written SYNCHRONOUSLY by its setter (use_state_ref.js), so the mirror reads the list that
// was just set rather than threading it through by hand.
export function makeFilamentColors(deps) {
  const {
    extruderColorsRef, setExtruderColors, setSettings, apiRef, objectsRef, refreshObjects, applyViewColors, selectFilament,
  } = deps

  const mirrorToSettings = () => setSettings?.(prev => ({ ...prev, filament_colour: [...extruderColorsRef.current] }))

  function setExtColor(index, hex) {
    setExtruderColors(colors => colors.map((color, i) => (i === index ? hex : color)))
    mirrorToSettings()
    apiRef.current?.recolorObjects()
    applyViewColors()
  }

  function addFilament() {
    setExtruderColors(colors => (colors.length >= MAX_PAINT_EXTRUDERS
      ? colors : [...colors, DEFAULT_FILAMENT_COLORS[colors.length] || UNKNOWN_COLOR]))
    mirrorToSettings()
  }

  // Deleting removes the SELECTED extruder, not the last one, so the objects assigned to it and to every later
  //  slot have to be moved with it — otherwise each of them would silently inherit its neighbour's filament.
  function removeFilament(index) {
    const colors = extruderColorsRef.current
    if (colors.length <= 1) return
    // The card passes the selected extruder's index; a bare call (older hosts) still removes the last one.
    const removed = Number.isInteger(index) ? Math.min(Math.max(index, 0), colors.length - 1) : colors.length - 1
    setExtruderColors(colors.filter((_color, i) => i !== removed))
    mirrorToSettings()
    for (const object of objectsRef.current) {
      const extruder = object.extruder || 1
      if (extruder === removed + 1) apiRef.current?.setObjectExtruder(object.id, 1)          // its filament is gone -> back to T1
      else if (extruder > removed + 1) apiRef.current?.setObjectExtruder(object.id, extruder - 1)   // later tools shift down one slot
    }
    apiRef.current?.recolorObjects()
    refreshObjects()
    // The slot the selection pointed at may be gone, or may now be past the end. selectFilament moves the card and
    //  the brush together, which is what stops the two from drifting apart the moment a filament is deleted.
    selectFilament?.(Math.min(removed, extruderColorsRef.current.length - 1))
  }

  // A project import replaces the whole list. The project's own `filament_colour` has already landed in the settings
  //  map by then, but the list drawn here can differ from it — a blank entry is drawn grey and anything past the
  //  selector's 16 slots is dropped — so it is mirrored back like every other change, or a save writes the raw list.
  function replaceAll(colors) {
    const next = colors.slice(0, MAX_PAINT_EXTRUDERS)
    if (!next.length) return
    setExtruderColors(next)
    mirrorToSettings()
    apiRef.current?.recolorObjects()
    applyViewColors()
  }

  return { setExtColor, addFilament, removeFilament, replaceAll }
}
