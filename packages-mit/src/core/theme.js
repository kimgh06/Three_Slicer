// The viewer's own colours: the scene chrome, not data. Data palettes stay beside their data — the toolpath feature
//  and tool colours (toolpath_palette.js), the paint states (paint_colors.js), the filament defaults
//  (viewer_defaults.js). Strings rather than 0x numbers because three.js takes both and CSS takes only these.
export const THEME = Object.freeze({
  accent: '#00ae42',            // selection: the object, the selected plate, the scale handles, the box-select band
  accentHover: '#1f5c34',       // emissive tint of the object under the pointer
  sceneBackground: '#161a1e',
  lightSky: '#ffffff',
  lightGround: '#2a2f36',
  gridMinor: '#232a31',
  gridMajor: '#39434d',
  plateBorder: '#4a5560',
  plateLabel: '#5a6570',
  travel: '#5a6270',            // travel moves in the toolpath preview
  nozzle: '#ff7a1a',
  overhang: '#ff4433',          // the brush's overhang-limit overlay
  primeTower: '#4fd1c5',
  slaModel: '#d7862a',
  slaSupport: '#9b78d8',
  slaPad: '#b0a06a',
  inkOnLight: '#10141a',        // label text on a light swatch
  inkOnDark: '#ffffff',
})

// sRGB hex -> LINEAR [r,g,b] in 0..1, for vertex-colour attributes (three.js treats those as linear).
export function hexToLinear(hex) {
  const channel = value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return [1, 3, 5].map(at => channel(parseInt(hex.slice(at, at + 2), 16) / 255))
}

// The stylesheet palette: what the two shadow roots (the viewer and <SettingsPanel/>) paint their chrome with. Each
//  key becomes a PUBLIC custom property `--vp-<kebab-key>` a host can set on any ancestor — custom properties inherit
//  across the shadow boundary, nothing else does — and a private `--_<kebab-key>` the stylesheets use, which falls
//  back to the value here. Values are the most-used member of each group of near-identical colours the stylesheets
//  carried before (152 literals); VIEWER.md lists them and test_viewer_docs.mjs keeps that list complete.
export const UI_TOKENS = Object.freeze({
  // the brand green and its family
  accent: THEME.accent,
  accentHover: '#06c04d',
  accentDeep: '#23402c',        // the busy pulse on a dark control
  accentInk: '#167a3a',         // green text on a light surface
  accentOnDark: '#9fe3bd',      // green text on a dark surface
  accentSoft: '#e3f6ea',        // selected row / active tab on a light surface
  accentSoftBorder: '#9adfb6',
  onAccent: '#ffffff',          // text and marks on any filled status colour
  // the dark chrome: top bar, rail, viewport overlays, menus
  darkBase: '#0e1216',
  darkSurface: '#161b21',
  darkControl: '#1a2027',
  darkControlHover: '#28313a',
  darkBorder: '#2c353d',
  darkBorderStrong: '#3a4550',
  darkText: '#cdd6dd',
  darkTextMuted: '#aebcc6',
  darkTextFaint: '#8b98a2',
  darkTextDisabled: THEME.plateLabel,
  // the light sidebar and the settings panel
  lightBg: '#eef0f2',
  lightSurface: '#ffffff',
  lightSubtle: '#f6f7f8',
  lightControl: '#dfe6ea',
  lightControlHover: '#d3dee4',
  lightBorder: '#d5d8dd',
  lightDivider: '#e3e6ea',
  lightText: '#24282e',
  lightTextMuted: '#5a6069',
  lightTextFaint: '#8a9099',
  // status
  info: '#2b6cff',
  infoSoft: '#e6efff',
  techBadge: '#6d7ce0',         // the resin marker on an object-list plate header
  danger: '#e23b3b',
  dangerInk: '#a33b37',
  dangerSoft: '#fbeaea',
  dangerOnDark: '#ff8b8b',
  dangerDeep: '#4a2229',
  warn: '#f0a542',
  warnInk: '#a86a12',
  warnSoft: '#fdf4e3',
  warnBorder: '#d8b48a',
  warnOnDark: '#f0c060',
  warnDeep: '#3a2a10',
  warnDeepBorder: '#7a5a1e',
})

const kebab = key => key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())
// Prepended to each shadow root's stylesheet (ShadowHost).
export const THEME_CSS = `:host{${Object.entries(UI_TOKENS).map(([key, value]) => `--_${kebab(key)}:var(--vp-${kebab(key)},${value});`).join('')}}\n`
