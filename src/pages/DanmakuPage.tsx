import React from 'react'
import { api, AppConfig, FloatPanel, FloatState, LiveEvent } from '../lib/api'
import { Button, Chip, Icon, Select, Switch, UserAvatar, useDraftInput } from '../components/ui'
import ViewersList from '../components/ViewersList'
import PaidHistory from '../components/PaidHistory'
import MusicConsole from '../components/MusicConsole'

interface Props {
  config: AppConfig
  patch: (p: Record<string, unknown>) => Promise<AppConfig>
  notify: (m: string, e?: boolean) => void
  events: LiveEvent[]
  status: string
}

const TYPE_LABEL: Record<string, { text: string; variant?: 'gift' | 'sc' | 'guard' }> = {
  gift: { text: '礼物', variant: 'gift' },
  guard: { text: '上舰', variant: 'guard' },
  superchat: { text: '醒目留言', variant: 'sc' },
  enter: { text: '进场' },
  live: { text: '开播' },
  offline: { text: '下播' },
}

const FONT_SIZES = [
  { value: '18', label: '小 18' },
  { value: '25', label: '标准 25' },
  { value: '36', label: '大 36' },
]

/** 四个浮窗的面板名与叫法。和 electron/float.cjs 的 FLOAT_PANELS 逐字一致 */
const FLOAT_PANELS: { id: FloatPanel; label: string }[] = [
  { id: 'danmaku', label: '弹幕' },
  { id: 'viewers', label: '当前观众' },
  { id: 'gifts', label: '礼物 · 付费留言' },
  { id: 'music', label: '音乐控制台' },
]

export default function DanmakuPage({ config, patch, notify, events, status }: Props) {
  const [text, setText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [showPanel, setShowPanel] = React.useState(false)
  // 四个浮窗的开关状态。以主进程为准（浮窗可能在自己那边被关掉）
  const [floats, setFloats] = React.useState<FloatState | null>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const draft = useDraftInput(text, setText)
  // 关掉自动滚动之后再切回这一页，不该又被打开 —— 存进配置
  const autoScroll = config.danmaku?.autoScroll !== false

  React.useEffect(() => {
    if (!autoScroll || !listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [events, autoScroll])

  React.useEffect(() => {
    // 用可选链兜底：主进程批次比渲染层旧时 api.float 整个是 undefined，
    // 直接 .state() 会同步抛出去，连 .catch 都接不住（那不是 rejected promise）
    try {
      api.float
        ?.state()
        .then(setFloats)
        .catch(() => {})
      return api.float?.onState?.(setFloats)
    } catch {
      return undefined
    }
  }, [])

  const floatOpened = (p: FloatPanel) => Boolean(floats?.panels?.[p]?.opened)

  const openFloat = async (p: FloatPanel) => {
    const label = FLOAT_PANELS.find((x) => x.id === p)?.label || p
    try {
      const r = await api.float?.open(p)
      if (r?.ok) {
        notify(`${label}已弹出为浮窗：拖右上角的横杠挪位置，设置里可收回`)
      } else {
        notify(r?.message || '打不开桌面浮窗', true)
      }
    } catch (e) {
      // 静默吞掉的话按钮点下去一点反应都没有 —— 这里必须说出声。
      notify(`打不开桌面浮窗：${(e as Error)?.message || '重启一下应用再试'}`, true)
    }
  }

  const closeFloat = async (p: FloatPanel) => {
    try {
      await api.float?.close(p)
    } catch {
      /* 收回失败多半是主进程已经不在了 */
    }
  }

  // 播报中的「跳过 / 清空」在顶栏那条播报胶囊里，切到别的页面也还在
  const send = async () => {
    const msg = text.trim()
    if (!msg) return
    setSending(true)
    const r = await api.live.send(msg)
    setSending(false)
    if (r.ok) {
      setText('')
      notify('已发送')
    } else {
      notify(r.message || '发送失败', true)
    }
  }

  const colorHex = `#${(config.danmaku?.sendColor ?? 16777215).toString(16).padStart(6, '0')}`

  return (
    <div className="danmaku-page">
      {/* 左边是弹幕流水；右边三块是「不用离开这一页也要看得到」的东西 */}
      <div className="danmaku-main">
        <FloatRegion
          panel="danmaku"
          label="弹幕"
          floated={floatOpened('danmaku')}
          onPop={() => openFloat('danmaku')}
          onClose={() => closeFloat('danmaku')}
          className="danmaku-main__list"
        >
          <div className="danmaku-list" ref={listRef}>
            {events.length === 0 ? (
              <div className="empty-state">
                {status === 'idle' ? '还没连接直播间，先去「连接」页填房间号' : '等待弹幕…'}
              </div>
            ) : (
              events.map((e, i) => <EventRow key={e.id || i} ev={e} anchorUid={Number(config.room?.anchorUid) || 0} />)
            )}
          </div>
        </FloatRegion>

        <div className="composer-dock">
          {showPanel && (
            <div className="composer-panel">
              <div className="composer-panel__row">
                <span className="composer-panel__label">弹幕颜色</span>
                <div className="color-field">
                  <input
                    className="color-input color-input--sm"
                    type="color"
                    value={colorHex}
                    onChange={(e) =>
                      patch({ danmaku: { sendColor: parseInt(e.target.value.slice(1), 16) } })
                    }
                  />
                  <span className="mono">{colorHex}</span>
                </div>
              </div>
              <div className="composer-panel__row">
                <span className="composer-panel__label">字号</span>
                <div style={{ width: 150 }}>
                  <Select
                    label="字号"
                    value={String(config.danmaku?.sendFontSize ?? 25)}
                    onChange={(v) => patch({ danmaku: { sendFontSize: Number(v) } })}
                    options={FONT_SIZES}
                  />
                </div>
              </div>
              <div className="composer-panel__row">
                <span className="composer-panel__label">展示模式</span>
                <div style={{ width: 150 }}>
                  <Select
                    label="展示模式"
                    value={String(config.danmaku?.sendMode ?? 1)}
                    onChange={(v) => patch({ danmaku: { sendMode: Number(v) } })}
                    options={[
                      { value: '1', label: '滚动' },
                      { value: '4', label: '底部' },
                      { value: '5', label: '顶部' },
                    ]}
                  />
                </div>
              </div>
              <div className="composer-panel__row">
                <span className="composer-panel__label">列表自动滚动到底部</span>
                <Switch value={autoScroll} onChange={(v) => patch({ danmaku: { autoScroll: v } })} />
              </div>

              {/* 桌面浮窗的总开关都在这儿。平时各区域右上角的圆点就是单个的入口 */}
              <div className="composer-panel__divider">桌面浮窗</div>
              {FLOAT_PANELS.map((p) => (
                <div className="composer-panel__row" key={p.id}>
                  <span className="composer-panel__label">{p.label}</span>
                  <Switch
                    value={floatOpened(p.id)}
                    onChange={(v) => (v ? openFloat(p.id) : closeFloat(p.id))}
                  />
                </div>
              ))}
              <div className="composer-panel__row">
                <span className="composer-panel__label">浮窗置顶（压在全屏游戏上面）</span>
                <Switch
                  value={floats?.alwaysOnTop !== false}
                  onChange={(v) => patch({ float: { alwaysOnTop: v } })}
                />
              </div>
              <div className="composer-panel__hint">
                每个区域右上角有条白色小横杠，点一下就把那一块弹出成浮窗；点浮窗右上角的 ×
                （或点弹出的「收回」）就收回来。透明度和字体大小在浮窗右上角的设置里调。
              </div>
            </div>
          )}

          <div className="composer-bar">
            <input
              className="composer-bar__input"
              maxLength={30}
              placeholder={status === 'idle' ? '先连接直播间才能发弹幕' : '说点什么…（Enter 发送）'}
              value={draft.value}
              onChange={draft.onChange}
              onCompositionStart={draft.onCompositionStart}
              onCompositionEnd={draft.onCompositionEnd}
              onKeyDown={(e) => {
                // 拼音选词时的回车不能当发送
                if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) send()
              }}
            />
            <span className="composer-bar__count">{text.length}/30</span>
            <button
              type="button"
              className={`icon-btn${showPanel ? ' is-active' : ''}`}
              title={`发送设置（弹幕颜色 ${colorHex}）`}
              onClick={() => setShowPanel((v) => !v)}
            >
              <Icon name="settings" size={20} />
              <span className="icon-btn__dot" style={{ background: colorHex }} />
            </button>
            <Button onClick={send} disabled={sending || !text.trim()} icon="send">
              发送
            </Button>
          </div>
        </div>
      </div>

      {/* 右侧栏：三块「不用切页面也要看得到」的东西。
          每块右上角都有个圆点 —— 点一下弹出为桌面浮窗，这里就让位给占位说明。 */}
      <aside className="danmaku-side">
        <FloatRegion
          panel="viewers"
          label="当前观众"
          floated={floatOpened('viewers')}
          onPop={() => openFloat('viewers')}
          onClose={() => closeFloat('viewers')}
          className="float-region--viewers"
        >
          <ViewersList />
        </FloatRegion>
        <FloatRegion
          panel="gifts"
          label="礼物 · 付费留言"
          floated={floatOpened('gifts')}
          onPop={() => openFloat('gifts')}
          onClose={() => closeFloat('gifts')}
          className="float-region--gifts"
        >
          <PaidHistory events={events} />
        </FloatRegion>
        <FloatRegion
          panel="music"
          label="音乐控制台"
          floated={floatOpened('music')}
          onPop={() => openFloat('music')}
          onClose={() => closeFloat('music')}
          className="float-region--music"
        >
          <MusicConsole
            volume={config.music?.volume ?? 0.6}
            onVolume={(v) => patch({ music: { volume: v } })}
          />
        </FloatRegion>
      </aside>
    </div>
  )
}

/**
 * 「弹出为浮窗」的区域包装：
 * 右上角一条短白色横杠（不要图标，hover 才亮），点一下这一块就搬进桌面浮窗；
 * 浮窗开着的时候原位只留一颗「收回」小胶囊，点整颗就收回。两边永远只显示一份。
 */
function FloatRegion({
  panel,
  label,
  floated,
  onPop,
  onClose,
  className = '',
  children,
}: {
  panel: FloatPanel
  label: string
  floated: boolean
  onPop: () => void
  onClose: () => void
  className?: string
  children: React.ReactNode
}) {
  if (floated) {
    // 不带 className（float-region--* / danmaku-main__list 那些是**区域**的布局类：
    // flex: 2 1 0 之类会把这颗占位竖向拉高一大块）。弹出态就是一条压扁的「收回」
    return (
      <button
        type="button"
        className={`float-gone float-gone--${panel}`}
        title={`「${label}」正在桌面浮窗里显示，点一下收回`}
        aria-label={`收回${label}浮窗`}
        onClick={onClose}
      >
        收回
      </button>
    )
  }
  return (
    <div className={`float-region ${className}`.trim()}>
      <button
        type="button"
        className="float-bar"
        title={`弹出为浮窗：${label}`}
        aria-label={`弹出为浮窗：${label}`}
        onClick={onPop}
      />
      {children}
    </div>
  )
}

/** 导出给桌面浮窗用：弹幕浮窗里渲染的就是这同一行组件，样式天然一致。
 *  showFace 只在浮窗里关（设置弹层的「显示头像」），关掉能一眼看更多弹幕 */
export function EventRow({
  ev,
  anchorUid = 0,
  showFace = true,
}: {
  ev: LiveEvent
  anchorUid?: number
  showFace?: boolean
}) {
  const tag = TYPE_LABEL[ev.type]
  const medal = ev.medal
  const name = ev.username || (ev.uid ? `用户${ev.uid}` : '匿名用户')
  // 主播身上没有自己房间的粉丝牌，房管位也不是他 —— 弹幕包里根本没有「我是主播」这个字段，
  // 只能拿 uid 和连接房间时记下的主播 uid 比。标出来是为了让「谁会被当成主播放行」看得见。
  const isAnchor = anchorUid > 0 && Number(ev.uid) === anchorUid
  return (
    <div className="danmaku-item">
      {showFace && <UserAvatar src={ev.face} name={name} uid={ev.uid} />}
      <div className="danmaku-body">
        <div className="danmaku-head">
          <span className="danmaku-name">{name}</span>
          {medal && medal.name && (
            <Chip>
              {medal.name} · {medal.level}
            </Chip>
          )}
          {isAnchor && <Chip variant="sc">主播</Chip>}
          {ev.isAdmin && <Chip>房管</Chip>}
          {tag && <Chip variant={tag.variant}>{tag.text}</Chip>}
          {ev.price ? <Chip variant={ev.type === 'superchat' ? 'sc' : 'gift'}>¥{ev.price}</Chip> : null}
        </div>
        {ev.emojiUrl ? (
          <img src={ev.emojiUrl} alt={ev.content} style={{ height: 40 }} />
        ) : (
          <div className="danmaku-text">{renderContent(ev)}</div>
        )}
      </div>
    </div>
  )
}

/** 把 [表情名] 替换成图片，直播间表情才有画面感 */
function renderContent(ev: LiveEvent) {
  const text = ev.content || ''
  if (!ev.emots) return text
  const parts: React.ReactNode[] = []
  const re = /\[([^\]]{1,12})\]/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const emot = ev.emots[m[1]]
    if (emot?.url) {
      parts.push(
        <img key={key++} src={emot.url} alt={m[1]} style={{ height: 24, verticalAlign: 'middle' }} />,
      )
    } else {
      parts.push(m[0])
    }
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
