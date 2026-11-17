import { argbFromHex, hexFromArgb, themeFromSourceColor, Hct } from '@material/material-color-utilities'

export type ThemeMode = 'light' | 'dark'
/** 动效方案：standard 克制，expressive 为 M3 Expressive 的弹簧 + 位移表达 */
export type MotionScheme = 'standard' | 'expressive'
/** 界面风格。m3 = Material 3（默认），m2 = Material 2（方角、重阴影、少染色） */
export type ThemeStyle = 'm3' | 'm2'

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

/**
 * Material 2 下的配色改写。
 *
 * M3 的层次主要靠**表面染色**表达：卡片、按钮、输入框各用一档 surface-container
 * 或 primary-container，深浅差别自己就分层了。M2 反过来 —— 只有一种表面色，
 * 层次靠**阴影**（elevation）堆出来，彩色容器只留给真正需要强调的东西。
 *
 * 所以这里把各种 container 收成表面色/中性色，把文字色收回 on-surface。
 * 这样现有组件全都不用改，只是「看起来不再是 M3」。
 * 形状与阴影的差别在 styles.css 的 `html[data-style='m2']` 里。
 */
/** 往白色掺一点，保持色相：M2 深色卡片本质就是「surface 上叠一层白」 */
function liftTowardWhite(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.round(v + (255 - v) * amount).toString(16).padStart(2, '0'),
  )
  return `#${ch.join('')}`
}

export function toM2Scheme(scheme: Scheme, mode: ThemeMode): Scheme {
  const out: Scheme = { ...scheme }
  const surface = scheme.surface
  /**
   * M2 的「抬起的表面」：浅色是纯白，深色是「背景 + 一层白」。
   * 不能直接沿用 surface —— 深色下阴影在暗底上几乎看不见，
   * 卡片只要不比背景亮一截，就会看起来像"凹进去的坑"而不是浮起来的一块。
   * 也不写死 #1e1e1e：种子色一换背景偏紫偏蓝，死灰的卡片会显脏。
   */
  const raised = mode === 'dark' ? liftTowardWhite(surface, 0.06) : '#ffffff'
  // 最底层留给页面背景；其余各档全部收成同一个抬升面（M2 没有分层表面）
  out.surfaceContainerLowest = surface
  out.surfaceContainerLow = raised
  out.surfaceContainer = raised
  out.surfaceContainerHigh = raised
  out.surfaceContainerHighest = raised
  // 彩色容器退回中性：亮色下用极浅的中性面，暗色下用 surfaceVariant 那种灰
  const neutral = raised
  out.primaryContainer = neutral
  out.onPrimaryContainer = scheme.primary
  out.secondaryContainer = neutral
  out.onSecondaryContainer = scheme.onSurface
  out.tertiaryContainer = neutral
  out.onTertiaryContainer = scheme.tertiary
  out.errorContainer = neutral
  out.onErrorContainer = scheme.error
  // M2 的「inverse」是一块深色浮层（snackbar），保持深底浅字
  out.inverseSurface = mode === 'dark' ? '#e6e0e9' : '#323232'
  out.inverseOnSurface = mode === 'dark' ? '#141218' : '#ffffff'
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

/** 切换动效方案：只改 <html data-motion>，CSS 里所有缓动/时长/位移令牌会整体跟着换 */
export function applyMotion(scheme: MotionScheme) {
  document.documentElement.dataset.motion = scheme
}

/**
 * 切换界面风格：只改 <html data-style>。
 * 圆角、阴影、间距、按钮形状全在 CSS 里按这个属性覆盖 —— 浮窗和主窗口共用同一份
 * 样式表与同一批令牌，所以一处切换两边一起变。
 */
export function applyStyle(style: ThemeStyle) {
  document.documentElement.dataset.style = style === 'm2' ? 'm2' : 'm3'
}

/** 主题配置里真正决定观感的那几项（主窗口与浮窗都只用这些） */
export interface ThemeConfigLike {
  seed?: string
  mode?: ThemeMode
  motion?: MotionScheme
  style?: ThemeStyle
}

/**
 * 一次把整套主题刷到 <html>：配色（M2 还要收敛容器色）、动效、风格。
 *
 * 主窗口和浮窗都调这一个 —— 浮窗以前只拿 config 读逻辑字段，压根没刷过主题，
 * 所以一直挂着样式表里那套写死的深紫。现在两边同一份，切什么风格都一起变。
 */
export function applyThemeConfig(t: ThemeConfigLike | undefined) {
  const mode = t?.mode === 'light' ? 'light' : 'dark'
  const style = t?.style === 'm2' ? 'm2' : 'm3'
  const base = buildScheme(t?.seed || '#6750A4', mode)
  applyScheme(style === 'm2' ? toM2Scheme(base, mode) : base, mode)
  applyMotion(t?.motion === 'standard' ? 'standard' : 'expressive')
  applyStyle(style)
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
