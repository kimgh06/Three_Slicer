// A model chosen on the landing page, on its way to /slice. A module variable rather than router state: a File need
//  not survive history serialization, and a reload of /slice should open an empty plate, not the old file.
let waiting = null

export function handOffFiles(files) {
  waiting = files
}

export function takeHandedOffFiles() {
  const files = waiting
  waiting = null
  return files
}
