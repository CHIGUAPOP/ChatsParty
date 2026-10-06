import React from 'react'
import { api, AppConfig, LiveEvent, MusicState } from '../lib/api'
import { Avatar, Button, Chip, Icon, Select, Switch, useDraftInput } from '../components/ui'
import MusicWidget from '../components/MusicWidget'

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

export default function DanmakuPage({ config, patch, notify, events, status }: Props) {
  const [text, setText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [showPanel, setShowPanel] = React.useState(false)
  const listRef = React.useRef<HTMLDivElement>(null)
  const draft = useDraftInput(text, setText)
  // 关掉自动滚动之后再切回这一页，不该又被打开 —— 存进配置
  const autoScroll = config.danmaku?.autoScroll !== false

  /* OBS 画面预览：用的是叠加层那套样式，看到的就是观众看到的样子 */
  const [music, setMusic] = React.useState<MusicState>({ items: [], current: null, queued: 0 })
  const showPreview = config.danmaku?.showObsPreview !== false
  React.useEffect(() => {
    api.music.state().then(setMusic)
    return api.music.onState(setMusic)
  }, [])

  React.useEffect(() => {
    if (!autoScroll || !listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [events, autoScroll])

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
      <div className="danmaku-list" ref={listRef}>
        {events.length === 0 ? (
          <div className="empty-state">
            {status === 'idle' ? '还没连接直播间，先去「连接」页填房间号' : '等待弹幕…'}
          </div>
        ) : (
          events.map((e, i) => <EventRow key={e.id || i} ev={e} anchorUid={Number(config.room?.anchorUid) || 0} />)
        )}
      </div>

      <div className="composer-dock">
        {showPreview && (
          <div className="obs-preview">
            <span className="obs-preview__tag">OBS 画面预览</span>
            {config.overlay?.showMusic === false ? (
              <div className="obs-preview__off">点歌面板已关闭（在「叠加层」页打开后这里才有东西）</div>
            ) : music.current || music.items.length > 0 ? (
              // 队列里没歌时组件自己会渲染成空，这里就不用再占位了
              <MusicWidget
                state={music}
                queueCount={config.overlay?.musicQueueCount}
                pos={config.overlay?.musicPos || 'tl'}
              />
            ) : (
              <div className="obs-preview__off">还没有人在弹幕里点歌，预览里暂时是空的</div>
            )}
          </div>
        )}

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
            className={`icon-btn${showPreview ? ' is-active' : ''}`}
            title="OBS 画面预览"
            onClick={() => patch({ danmaku: { showObsPreview: !showPreview } })}
          >
            <Icon name="music" size={20} />
          </button>
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
  )
}

function EventRow({ ev, anchorUid = 0 }: { ev: LiveEvent; anchorUid?: number }) {
  const tag = TYPE_LABEL[ev.type]
  const medal = ev.medal
  const name = ev.username || (ev.uid ? `用户${ev.uid}` : '匿名用户')
  // 主播身上没有自己房间的粉丝牌，房管位也不是他 —— 弹幕包里根本没有「我是主播」这个字段，
  // 只能拿 uid 和连接房间时记下的主播 uid 比。标出来是为了让「谁会被当成主播放行」看得见。
  const isAnchor = anchorUid > 0 && Number(ev.uid) === anchorUid
  return (
    <div className="danmaku-item">
      <Avatar src={ev.face} name={name} />
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
