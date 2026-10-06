import React from 'react'
import { resolveFace } from '../lib/faces'

/* --------------------------------- 图标 --------------------------------- */

/** 内部有挖空区域的图标：外框实心 → 内圈挖空 → 内部小块再实心，靠 evenodd 逐层切换 */
const EVEN_ODD = new Set(['settings', 'chat'])

const PATHS: Record<string, string> = {
  // 插头：两枚插脚 + 圆头本体 + 底部一截电线，整体上下各留 1px
  plug: 'M9 1h2v5H9V1Zm4 0h2v5h-2V1ZM5 6h14v4.5a7 7 0 0 1-7 7 7 7 0 0 1-7-7V6Zm6 11.5h2v4.5h-2v-4.5Z',
  // 弹幕：气泡外框挖空，里面放两条长短不一的消息行。
  // 行数不能多 —— 24px 画三行以上，抗锯齿后就是一片条纹
  chat:
    'M4 2H20a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-9l-5 5v-5H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM7 6.5h10v2.5H7ZM7 11.5h7v2.5H7Z',
  voice:
    'M12 15a4 4 0 0 0 4-4V6a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4Zm6-4a6 6 0 0 1-5 5.92V20h-2v-3.08A6 6 0 0 1 6 11h2a4 4 0 0 0 8 0h2Z',
  palette:
    'M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.8-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2Zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z',
  layers: 'M12 2 2 7l10 5 10-5-10-5Zm0 9.5L4.2 7.6 2 8.7l10 5 10-5-2.2-1.1-7.8 3.9Zm0 4L4.2 11.6 2 12.7l10 5 10-5-2.2-1.1-7.8 3.9Z',
  // 齿轮：原来那条是手写的相对坐标版本，齿形不闭合，放大看是歪的。换成官方 Material Icons 路径
  settings:
    'M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z',
  send: 'M3 20.5 21 12 3 3.5 3 10l12 2-12 2v6.5Z',
  refresh: 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z',
  stop: 'M7 7h10v10H7V7Z',
  play: 'M8 5v14l11-7L8 5Z',
  // 跳到下一首：两条竖线 + 三角
  skip: 'M6 5h2v14H6V5Zm3 7 9-7v14l-9-7Zm11 0h2v-2h-2v2Zm0 4h2v-2h-2v2Z',
  logout: 'M10 17v-2H5V9h5V7l5 5-5 5Zm2-14h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6v-2h6V5h-6V3Z',
  search: 'M10 2a8 8 0 1 0 4.9 14.32l4.39 4.39 1.42-1.42-4.39-4.39A8 8 0 0 0 10 2Zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z',
  add: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z',
  delete: 'M9 3h6l1 2h4v2H4V5h4l1-2ZM6 9h12l-1 11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 9Zm3 2v8h2v-8H9Zm4 0v8h2v-8h-2Z',
  link: 'M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12ZM8 13h8v-2H8v2Zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10Z',
  // 音符：八分音符双联
  music:
    'M20 3v11.5a3.5 3.5 0 1 1-2-3.16V6.3l-7 1.4v9.3a3.5 3.5 0 1 1-2-3.16V5.7l11-2.2ZM11 9.1l7-1.4v2.1l-7 1.4V9.1Z',
}

export function Icon({ name, size = 24 }: { name: keyof typeof PATHS | string; size?: number }) {
  const d = PATHS[name] || PATHS.chat
  // 这两个图标是「外框挖空 + 内部实心」的组合，靠 evenodd 出效果，不依赖子路径方向
  const rule = EVEN_ODD.has(name) ? 'evenodd' : undefined
  return (
    <svg className="nav-rail__icon" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d={d} fillRule={rule} clipRule={rule} />
    </svg>
  )
}

/* --------------------------------- 卡片 --------------------------------- */

export function Card({
  title,
  desc,
  variant = 'filled',
  children,
  actions,
}: {
  title?: string
  desc?: string
  variant?: 'filled' | 'outlined' | 'elevated'
  children?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className={`card${variant === 'outlined' ? ' card--outlined' : variant === 'elevated' ? ' card--filled' : ''}`}>
      {(title || actions) && (
        <div className="row row--between" style={{ marginBottom: desc ? 4 : 16 }}>
          <h3 className="card__title">{title}</h3>
          {actions && <div className="row" style={{ gap: 8 }}>{actions}</div>}
        </div>
      )}
      {desc && <p className="card__desc">{desc}</p>}
      {children}
    </div>
  )
}

export function Row({
  label,
  hint,
  children,
}: {
  label?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="row row--between">
      {(label || hint) && (
        <div className="row__text">
          {label && <div className="row__label">{label}</div>}
          {hint && <div className="row__hint">{hint}</div>}
        </div>
      )}
      {children}
    </div>
  )
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="section__title">{children}</div>
}

/* --------------------------------- 按钮 --------------------------------- */

export function Button({
  children,
  onClick,
  variant = 'filled',
  disabled,
  small,
  icon,
}: {
  children?: React.ReactNode
  onClick?: () => void
  variant?: 'filled' | 'tonal' | 'outlined' | 'text' | 'danger'
  disabled?: boolean
  small?: boolean
  icon?: string
}) {
  return (
    <button
      className={`btn btn--${variant}${small ? ' btn--sm' : ''}`}
      onClick={onClick}
      disabled={disabled}
      type="button"
    >
      {icon && <Icon name={icon} size={18} />}
      {children}
    </button>
  )
}

/* --------------------------------- 开关 --------------------------------- */

export function Switch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className={`switch${value ? ' is-on' : ''}`}
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
    >
      <span className="switch__knob" />
    </button>
  )
}

/* -------------------------------- 文本输入 ------------------------------- */

/**
 * 受控输入框 + 中文输入法的老问题：
 *
 * 拼音在候选窗里还没上屏时，浏览器会先把拼音字母塞进 input 的 value。
 * 我们这边每个按键都要回一趟主进程（改配置）再把新值灌回 value，
 * 于是 React 拿着上一拍的值去覆盖 DOM —— 候选窗被顶掉，字母还会重复上屏。
 *
 * 解法是给输入框留一份本地草稿：
 *  - 合成期间（compositionstart → compositionend）只更新草稿，绝不回传父组件
 *  - 父组件给的 value 变了（比如切换了提供方），才把草稿同步回来
 *  - 合成结束把最终值一次性提交
 */
export function useDraftInput(value: string, onChange: (v: string) => void) {
  const [draft, setDraft] = React.useState(value)
  const composing = React.useRef(false)
  // 已经发出去、还没被父组件回显的值。父组件的回显是异步的（走一遍 IPC + 落盘），
  // 连续输入时旧的回显会晚于新的一次到达 —— 那时如果拿它回灌，用户后面敲的字就被截掉了。
  // 密钥这种「错一个字符就 401」的字段被截断，表现就是「明明填对了却说 invalid token」。
  const pending = React.useRef<string[]>([])
  const lastEmitted = React.useRef(value)

  React.useEffect(() => {
    const idx = pending.current.indexOf(value)
    if (idx >= 0) {
      // 这是我们自己发出去的值回来了（可能是乱序的旧值），不是外部改动，忽略。
      // 注意不要顺手改 lastEmitted —— 已经排空的值再回来一次时就认不出来了。
      pending.current.splice(idx, 1)
      return
    }
    if (value === lastEmitted.current) return
    // 真正的外部改动（比如发完弹幕清空、点了重置），才回灌
    pending.current = []
    lastEmitted.current = value
    setDraft(value)
  }, [value])

  const emit = React.useCallback(
    (v: string) => {
      lastEmitted.current = v
      pending.current.push(v)
      // 只留最近 8 个，避免长时间输入把队列堆爆
      if (pending.current.length > 8) pending.current.shift()
      setDraft(v)
      onChange(v)
    },
    [onChange],
  )

  type T = HTMLInputElement | HTMLTextAreaElement

  return {
    value: draft,
    onChange: (e: React.ChangeEvent<T>) => {
      if (composing.current) {
        setDraft(e.target.value)
        return
      }
      emit(e.target.value)
    },
    onCompositionStart: () => {
      composing.current = true
    },
    onCompositionEnd: (e: React.CompositionEvent<T>) => {
      composing.current = false
      emit(e.currentTarget.value)
    },
  }
}

/**
 * 输入即保存 —— 不用回车，也不用点「保存」。
 *
 * 三个要点：
 *  1. 焦点在框里时，显示的是你正在打的原文，**绝不拿服务端回写去覆盖它**。
 *     否则「绑定, 换音色」会被配置层标准化成「绑定、换音色」，
 *     打到一半逗号就被吃掉、光标乱跳 —— 这正是以前必须回车提交的原因。
 *  2. 停手 delay 毫秒自动落一次盘（打字过程中不会每敲一下就写一次配置文件）。
 *  3. 失焦立刻补一次，并把显示切回标准化后的真值（顺手把「点歌, 点歌」这类收拾整齐）。
 *
 * 只给「写进配置」的字段用。搜索词、试听句、弹幕内容这类只是触发动作的输入框不要用。
 *
 * @param external 配置里的当前值（显示用，未聚焦时以它为准）
 * @param onSave   真正落盘的动作
 */
export function useLiveSave(
  external: string,
  onSave: (v: string) => void,
  delay = 600,
): { value: string; onChange: (v: string) => void; onBlur: () => void } {
  // 非 null = 用户正在编辑，显示以它为准
  const [typing, setTyping] = React.useState<string | null>(null)
  const timer = React.useRef<number | null>(null)
  const latest = React.useRef('')
  const saveRef = React.useRef(onSave)
  saveRef.current = onSave

  const stopTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }

  const onChange = (v: string) => {
    setTyping(v)
    latest.current = v
    stopTimer()
    timer.current = window.setTimeout(() => {
      timer.current = null
      saveRef.current(latest.current)
    }, delay)
  }

  const onBlur = () => {
    if (typing === null) return
    stopTimer()
    saveRef.current(latest.current)
    // 交回给配置显示。此时配置里已经是标准化后的值，框里的文字会被收拾整齐
    setTyping(null)
  }

  // 切页导致卸载时，把还没落盘的最后几个字补上。
  // 只有 timer 还挂着才补 —— StrictMode 的「假卸载」没有挂起的 timer，不会误写空值。
  React.useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
        saveRef.current(latest.current)
      }
    },
    [],
  )

  return { value: typing ?? external, onChange, onBlur }
}

export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  mono,
  onEnter,
  onBlur,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  mono?: boolean
  /** 只给「触发动作」的输入框用（搜索、试一句）。写配置的字段请用 useLiveSave，不要靠回车 */
  onEnter?: () => void
  /** 失焦回调。和 useLiveSave 搭配时用来把没落盘的补上，并把显示切回标准化后的真值 */
  onBlur?: () => void
}) {
  const draft = useDraftInput(value, onChange)
  return (
    <div className={`field${draft.value ? ' is-floating' : ''}`}>
      <input
        className="field__input"
        style={mono ? { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 } : undefined}
        type={type}
        placeholder={placeholder}
        onChange={draft.onChange}
        onCompositionStart={draft.onCompositionStart}
        onCompositionEnd={draft.onCompositionEnd}
        onKeyDown={
          onEnter
            ? (e) => {
                // 合成期间的回车是选词，不能当成提交
                if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) onEnter()
              }
            : undefined
        }
        onBlur={onBlur}
        value={draft.value}
      />
      <label className="field__label">{label}</label>
    </div>
  )
}

export function TextArea({
  label,
  value,
  onChange,
  onBlur,
  rows = 3,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onBlur?: () => void
  rows?: number
}) {
  const draft = useDraftInput(value, onChange)
  return (
    <div className={`field${draft.value ? ' is-floating' : ''}`}>
      <textarea
        className="field__textarea"
        rows={rows}
        onChange={draft.onChange}
        onCompositionStart={draft.onCompositionStart}
        onCompositionEnd={draft.onCompositionEnd}
        onBlur={onBlur}
        value={draft.value}
      />
      <label className="field__label">{label}</label>
    </div>
  )
}

export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="field is-floating">
      <select className="field__select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <label className="field__label">{label}</label>
    </div>
  )
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
}: {
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  suffix?: string
}) {
  // 拖动期间用本地值：受控值要经过一次异步 IPC 才回显，中间那一拍 React 会把
  // 滑块弹回旧位置，手感发涩。松手/键盘操作才真正提交
  const [local, setLocal] = React.useState(value)
  const dragging = React.useRef(false)

  React.useEffect(() => {
    if (!dragging.current) setLocal(value)
  }, [value])

  const shown = dragging.current ? local : value
  const pct = ((shown - min) / (max - min)) * 100
  return (
    <div className="row" style={{ gap: 12 }}>
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        style={{ ['--slider-pct' as any]: `${pct}%` }}
        onChange={(e) => {
          const v = Number(e.target.value)
          setLocal(v)
          onChange(v)
        }}
        onPointerDown={() => {
          dragging.current = true
        }}
        onPointerUp={() => {
          dragging.current = false
        }}
        onBlur={() => {
          dragging.current = false
        }}
      />
      <span style={{ minWidth: 64, textAlign: 'right', fontSize: 13, color: 'var(--md-sys-color-on-surface-variant)' }}>
        {shown}
        {suffix || ''}
      </span>
    </div>
  )
}

/* -------------------------------- 提示条 -------------------------------- */

export function Snackbar({ message, error }: { message: string; error?: boolean }) {
  if (!message) return null
  return (
    <div className={`snackbar${error ? ' is-error' : ''}`}>
      <span style={{ flex: 1 }}>{message}</span>
    </div>
  )
}

/* --------------------------------- 头像 --------------------------------- */

export function Avatar({ src, name, size }: { src?: string; name?: string; size?: number }) {
  const [broken, setBroken] = React.useState(false)
  const resolved = resolveFace(src)
  React.useEffect(() => setBroken(false), [resolved])
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.42) } : undefined
  if (!resolved || broken) {
    return (
      <div className="avatar avatar--fallback" style={style}>
        {(name || '?').slice(0, 1)}
      </div>
    )
  }
  return <img className="avatar" style={style} src={resolved} alt="" onError={() => setBroken(true)} />
}

/* --------------------------------- 徽章 --------------------------------- */

export function Chip({ children, variant }: { children: React.ReactNode; variant?: 'gift' | 'sc' | 'guard' | 'ok' }) {
  return <span className={`chip${variant ? ` chip--${variant}` : ''}`}>{children}</span>
}
