import { useEffect, useRef } from 'react'

// The `files` prop: one loadFiles pass on mount, through the same extension dispatch as a drop.
//  Deliberately mount-only — a host that recreates the array each render must not re-import its models;
//  runtime loading stays with the picker/drop. A LATER identity change is therefore ignored, and silently
//  ignored is how APIs get called wrong — so the first such change warns, pointing at the remount idiom.
export function useInitialFiles({ files, loadFiles }) {
  const seenRef = useRef({ value: files, warned: false })
  useEffect(() => {
    const seen = seenRef.current
    if (files !== seen.value && seen.value != null && files != null && !seen.warned) {
      seen.warned = true
      console.warn('[three-slicer] `files` is mount-only: a later change does not re-import. Remount (new key) to load a different set; runtime loading is the picker/drop.')
    }
    seen.value = files
  }, [files])
  useEffect(() => {
    if (files?.length) loadFiles(files.map(f => (typeof File !== 'undefined' && f instanceof File) ? f : new File([f.data], f.name)))
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
}
