import { useEffect, useRef, useState } from 'react'
import { resolveWorkerCount, memoryWorkerCap } from './core/slice_pool.js'

// An all-plates run's state for the component: the run map (core/slice_pool.js) while one is on, the host
//  callback that follows it, and what the Workers select offers — Auto's resolved value for THIS machine and
//  kernel, and the ceiling (the core count; more was measured to gain nothing). `slice_workers` is a viewer
//  knob in the settings map, like `sla_antialias`: 0 or absent is Auto.
// `objects` are the list rows; the largest plate's STL size (50 bytes a facet) is what the memory cap reads.
export function useSliceRun({ onSliceRun, kernelKind, plateCount, objects = [] }) {
  const [plateRun, setPlateRun] = useState(null)   // {workers:{pool,active,kernel}, plates:{[i]:{state,progress,rate}}} | null
  const onSliceRunRef = useRef(onSliceRun); onSliceRunRef.current = onSliceRun
  useEffect(() => { onSliceRunRef.current?.(plateRun) }, [plateRun])
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
  const perPlate = {}
  for (const o of objects) if (o.visible !== false) perPlate[o.plate] = (perPlate[o.plate] || 0) + (o.facets || 0) * 50
  const largestBytes = Math.max(0, ...Object.values(perPlate))
  const autoWorkers = resolveWorkerCount({ setting: 0, kernel: kernelKind, cores, plates: plateCount, largestBytes })
  return { plateRun, setPlateRun, autoWorkers, cores, memoryWorkers: memoryWorkerCap(largestBytes) }
}
