import { argbFromHex, hexFromArgb, themeFromSourceColor, Hct } from '@material/material-color-utilities'

export type ThemeMode = 'light' | 'dark'

export interface Scheme {
  [token: string]: string
}

const BASE_TOKENS = [
  'primary',
  'onPrimary',
  'primaryContainer',
  'onPrimaryContainer',
  'secondary',
  'onSecondary',
  'secondaryContainer',
  'onSecondaryContainer',
  'tertiary',
  'onTertiary',
  'tertiaryContainer',
  'onTertiaryContainer',
  'error',
  'onError',
  'errorContainer',
  'onErrorContainer',
  'background',
  'onBackground',
  'surface',
  'onSurface',
  'surfaceVariant',
  'onSurfaceVariant',
  'outline',
  'outlineVariant',
  'inverseSurface',
  'inverseOnSurface',
  'inversePrimary',
  'shadow',
  'scrim',
] as const

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

/** MD3 的 surface container 分级官方库没直接给，按 tone 偏移从 surface 派生 */
function deriveSurfaceContainers(surfaceArgb: number, isDark: boolean): string[] {
  const hct = Hct.fromInt(surfaceArgb)
  const deltas = isDark ? [-2, 4, 6, 11, 16] : [2, -2, -4, -6, -8]
  return deltas.map((d) => hexFromArgb(Hct.from(hct.hue, hct.chroma, clamp(hct.tone + d, 0, 100)).toInt()))
}

export function buildScheme(seed: string, mode: ThemeMode): Scheme {
  let safeSeed = seed
  if (!/^#?[0-9a-fA-F]{6}$/.test(safeSeed)) safeSeed = '#6750A4'
  if (!safeSeed.startsWith('#')) safeSeed = `#${safeSeed}`

  const theme = themeFromSourceColor(argbFromHex(safeSeed))
  const raw: any = mode === 'dark' ? theme.schemes.dark : theme.schemes.light

  const out: Scheme = {}
  for (const token of BASE_TOKENS) {
    const v = raw[token]
    if (typeof v === 'number') out[token] = hexFromArgb(v)
  }
  out.surfaceTint = out.primary

  const [lowest, low, container, high, highest] = deriveSurfaceContainers(
    argbFromHex(out.surface || '#141218'),
    mode === 'dark',
  )
  out.surfaceContainerLowest = lowest
  out.surfaceContainerLow = low
  out.surfaceContainer = container
  out.surfaceContainerHigh = high
  out.surfaceContainerHighest = highest
  return out
}

export function applyScheme(scheme: Scheme, mode: ThemeMode) {
  const root = document.documentElement
  for (const [token, value] of Object.entries(scheme)) {
    const cssName = `--md-sys-color-${token.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`
    root.style.setProperty(cssName, value)
  }
  const bg = mode === 'dark' ? scheme.background : scheme.surface
  root.style.setProperty('--md-sys-color-background', mode === 'dark' ? scheme.background : scheme.surface)
  root.style.setProperty('--md-sys-color-surface', bg)
  root.style.colorScheme = mode
  root.dataset.theme = mode
}

/** 从种子色生成一排 tonal 色板，供调色面板挑选 */
export function tonalRamp(seed: string, tones: number[] = [95, 90, 80, 70, 60, 50, 40, 30, 20, 10]): string[] {
  let safeSeed = seed
  if (!/^#?[0-9a-fA-F]{6}$/.test(safeSeed)) safeSeed = '#6750A4'
  if (!safeSeed.startsWith('#')) safeSeed = `#${safeSeed}`
  const hct = Hct.fromInt(argbFromHex(safeSeed))
  return tones.map((t) => hexFromArgb(Hct.from(hct.hue, Math.max(hct.chroma, 24), t).toInt()))
}

export const PRESET_SEEDS = [
  '#6750A4',
  '#B3261E',
  '#F2B8B5',
  '#00639B',
  '#7D5260',
  '#3B6938',
  '#8F5000',
  '#485C6C',
  '#FFB4AB',
  '#4F378B',
  '#00A9A5',
  '#E8710A',
]
