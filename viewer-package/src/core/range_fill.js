// The coloured stretch of a .range-slider, as the custom properties its stylesheet rule reads.
export function rangeFill(low, high, max) {
  const share = value => `${(value / Math.max(1, max)) * 100}%`
  return { '--range-from': share(low), '--range-to': share(high) }
}
