import React from 'react'
import { splitIcon, eyeIcon, eyeSlashIcon, deleteIcon } from '../core/icons.js'

// Object list card: print toggle, name, extruder selector, split and delete, plus the two slice toggles.
// With more than one plate the rows group under plate headers — each object's `plate` annotation comes from
// the same membership function the merge uses (refreshObjects -> api.plateOfObject), so the list can never
// disagree with what a slice will actually cut. A header names the plate, carries its technology when it
// differs from the global one and the override dot the PlateBar shows, and clicking it selects that plate.
export default function ObjectList({
  objects, extruderColors, onToggleVisible, onExtruder, onSplit, onRemove,
  plateCount = 1, selectedPlate = 0, onSelectPlate, globalTech, plateTechOf, overridePlates,
  supportOnOf, onPlateSupport,
  selectedIds, onSelect,
  supportOn, onToggleSupport, fffSupport = true,
  overhangOn, onToggleOverhang, overhangAngle, paintMode, onTogglePaint,
  supportStyle, supportStyles, onSupportStyle,
  supportFilament, onSupportFilament, supportInterfaceFilament, onSupportInterfaceFilament,
  paintedObjectIds,
}) {
  // Upstream spells "whichever tool is already loaded" as extruder 0 on both keys, which is what keeps a support
  //  print single-material by default. Anything else is a deliberate second tool, and that is what the warning
  //  below is about — the selects themselves cannot tell the user how expensive the choice is.
  const supportTool = Number.isFinite(supportFilament) ? supportFilament : 0
  const interfaceTool = Number.isFinite(supportInterfaceFilament) ? supportInterfaceFilament : 0
  const dedicatedTool = supportTool > 0 || interfaceTool > 0
  // Painted-object ids arrive as a Set from a live tracker or as a plain array from serialised state; absent
  //  entirely until the paint side lands, in which case no row gets a badge.
  // Selection is shared with the 3D view, so the list highlights whatever is selected there and clicking a row
  //  selects in both. Ctrl/⌘+click toggles, the same modifier the viewport uses — a list that disagreed with the
  //  scene about what "add to selection" means would be worse than a list with no selection at all.
  const isSelected = (objectId) => Array.isArray(selectedIds) && selectedIds.includes(objectId)
  const clickRow = (event, objectId) => {
    if (!onSelect) return
    onSelect(objectId, event.ctrlKey || event.metaKey)
  }

  const isPainted = (objectId) => {
    if (!paintedObjectIds) return false
    return typeof paintedObjectIds.has === 'function'
      ? paintedObjectIds.has(objectId)
      : Array.isArray(paintedObjectIds) && paintedObjectIds.includes(objectId)
  }

  const toolOptions = [
    <option key="default" value={0}>Default (current tool)</option>,
    ...extruderColors.map((_color, index) => <option key={index} value={index + 1}>T{index + 1}</option>),
  ]

  const row = (o) => (
    <li key={o.id}
        className={`${o.visible === false ? 'obj-hidden' : ''}${isSelected(o.id) ? ' obj-selected' : ''}`.trim()}
        onClick={e => clickRow(e, o.id)}
        data-testid={`obj-row-${o.id}`}>
      <button className="obj-eye" onClick={e => { e.stopPropagation(); onToggleVisible(o.id) }} title="Include/exclude this object from printing — excluding it keeps it in the scene" data-testid={`eye-${o.id}`}>
        <img src={o.visible === false ? eyeSlashIcon : eyeIcon} alt={o.visible === false ? 'Hidden' : 'Visible'} />
      </button>
      <span className="obj-name" title={o.name}>{o.name}</span>
      {isPainted(o.id) && (
        <span className="obj-painted" data-testid={`obj-painted-${o.id}`}
              title="This object has material-painted regions — the extruder below applies only to the rest of it">🖌</span>
      )}
      <select className="obj-ext" value={o.extruder ?? 1} onClick={e => e.stopPropagation()} onChange={e => onExtruder(o.id, +e.target.value)} title="Which filament (extruder) prints this object" data-testid={`ext-${o.id}`}>
        {extruderColors.map((c, i) => <option key={i} value={i + 1}>T{i + 1}</option>)}
      </select>
      <button className="obj-split" onClick={e => { e.stopPropagation(); onSplit(o.id) }} title="Split to objects — every disconnected part (connected component) becomes its own object. Split to parts is not implemented (no part concept)" data-testid={`split-${o.id}`}><img src={splitIcon} alt="Split" /></button>
      <button className="obj-del" onClick={e => { e.stopPropagation(); onRemove(o.id) }} title="Remove this object from the scene"><img src={deleteIcon} alt="Delete" /></button>
    </li>
  )
  // Plate groups, only when there is more than one plate: headers on a single-plate scene would be furniture.
  const byPlate = new Map()
  for (const o of objects) { const p = o.plate ?? 0; if (!byPlate.has(p)) byPlate.set(p, []); byPlate.get(p).push(o) }
  const plateGroups = [...byPlate.keys()].sort((a, b) => a - b)
  return (
    <section className="side-card" data-testid="object-section">
      <div className="sc-head">📦 Objects <span className="sc-count">{objects.length}</span></div>
      <ul className="obj-list2" data-testid="obj-list">
        {plateCount <= 1 ? objects.map(row) : plateGroups.map(p => (
          <React.Fragment key={`plate-${p}`}>
            <li className={'obj-plate-head' + (p === selectedPlate ? ' on' : '')}
                onClick={() => onSelectPlate?.(p)} data-testid={`obj-plate-${p}`}
                title={`Select plate ${p + 1} — these objects slice with its settings`}>
              <span className="obj-plate-name">Plate {p + 1}</span>
              {plateTechOf && globalTech && plateTechOf(p) !== globalTech && (
                <span className="obj-plate-tech" data-testid={`obj-plate-tech-${p}`}>{plateTechOf(p)}</span>
              )}
              {overridePlates?.includes(p) && <span className="obj-plate-dot" title="Has per-plate setting overrides" />}
              {/* THIS plate's support switch — its effective enable_support, written into its own override.
                  FFF plates only: resin supports are the Resin card's switch, a different key entirely. */}
              {supportOnOf && plateTechOf?.(p) !== 'SLA' && (
                <label className="obj-plate-sup" onClick={e => e.stopPropagation()}
                       title={`Generate support on plate ${p + 1} (its own enable_support override)`}>
                  <input type="checkbox" checked={supportOnOf(p)} onChange={e => onPlateSupport?.(p, e.target.checked)}
                         data-testid={`plate-support-${p}`} /> support
                </label>
              )}
              <span className="obj-plate-count">{byPlate.get(p).length}</span>
            </li>
            {byPlate.get(p).map(row)}
          </React.Fragment>
        ))}
      </ul>
      {/* The whole block below is FFF support (enable_support and friends). A resin slice generates its own
          supports through the Resin card's switch, so under SLA this section is absent rather than inert. */}
      {fffSupport && (<>
      <label className="slice-support"><input type="checkbox" checked={supportOn} onChange={onToggleSupport}
        title={plateCount > 1
          ? `Generate support on plate ${selectedPlate + 1} — written into that plate's override (enable_support)`
          : 'Generate support structures under overhangs (same as enable_support in the settings panel)'}
        data-testid="support-toggle" /> Generate support{plateCount > 1 ? ` — plate ${selectedPlate + 1}` : ''}</label>
      {/* The two things you actually do about support — see where it is needed, and brush it — used to live only
          on the left gizmo rail, with nothing here to hint they existed. */}
      {supportOn && (
        <div className="sc-info sup-style"><span>Style</span>
          <select className="sc-model" value={supportStyle} onChange={e => onSupportStyle(e.target.value)}
            data-testid="support-style"
            title="Support style (support_style). The kernel builds the tree/organic family as real tree support; the rest as grid.">
            {supportStyles.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      )}
      {supportOn && onSupportFilament && (
        <div className="sc-info sup-style"><span>Filament</span>
          <select className="sc-model" value={supportTool} onChange={e => onSupportFilament(+e.target.value)}
            data-testid="support-filament"
            title="Which filament prints the support body (support_filament). Default leaves it on whatever tool the layer is already using.">
            {toolOptions}
          </select>
        </div>
      )}
      {supportOn && onSupportInterfaceFilament && (
        <div className="sc-info sup-style"><span>Interface filament</span>
          <select className="sc-model" value={interfaceTool} onChange={e => onSupportInterfaceFilament(+e.target.value)}
            data-testid="support-interface-filament"
            title="Which filament prints the support interface — the few layers touching the model (support_interface_filament). This is where a release material pays off.">
            {toolOptions}
          </select>
        </div>
      )}
      {supportOn && dedicatedTool && (
        // A dedicated support tool is per-layer, not per-object: every layer that has both support and model
        //  changes tool at least twice, so the purge volume multiplies by the layer count rather than the part count.
        <div className="sup-filament-warn" data-testid="support-filament-warn">
          ⚠ Support on its own filament adds a tool change on nearly every layer — expect a much longer print and
          far more purge.
        </div>
      )}
      {supportOn && (
        <div className="support-tools">
          <label className="slice-support">
            <input type="checkbox" checked={!!overhangOn} onChange={onToggleOverhang}
              title={`Shade the facets that will need support (slope below ${overhangAngle}°, the support threshold angle)`}
              data-testid="overhang-toggle" /> Show overhangs <span className="muted">&lt;{overhangAngle}°</span>
          </label>
          <button className={paintMode !== 'off' ? 'sup-paint on' : 'sup-paint'} onClick={onTogglePaint}
            disabled={!objects.length} data-testid="support-paint-btn"
            title="Brush facets to force or block support — the same tool as the paint icon on the left rail">
            {paintMode !== 'off' ? 'Painting…' : 'Paint support'}
          </button>
        </div>
      )}
      </>)}
    </section>
  )
}
