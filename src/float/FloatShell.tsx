import React from 'react'
import { api, AppConfig, FloatPanel, FloatState, LiveEvent } from '../lib/api'
import { MusicPlayerProvider } from '../lib/music-engine'
import { setResolvedFace } from '../lib/faces'
import { Icon, Slider, Snackbar, Switch, useDraftInput } from '../components/ui'
import ViewersList from '../components/ViewersList'
import PaidHistory from '../components/PaidHistory'
import MusicConsole from '../components/MusicConsole'
import { EventRow } from '../pages/DanmakuPage'

/**
 * 桌面浮窗外壳。
 *
 * 四个浮窗（弹幕 / 当前观众 / 礼物 / 音乐控制台）加载的都是应用渲染层本尊，
 * 只是 ?float=<panel> 让这里只渲染对应那一个区域 —— 所以样式跟弹幕功能区
 * 一模一样（同一套 M3 设计令牌、同一批组件），不存在「第二套渲染」。
 *
 * 没有独立标题栏（用户点名去掉）：设置和 × 两颗按钮**直接融进内容自己的 UI** ——
 * 观众 / 礼物 / 音乐浮窗塞进各自卡片头部，弹幕浮窗贴在列表右上角；拖拽靠贴着
 * 窗口顶边的一条隐形拖拽区。透明度走主进程的窗口级 setOpacity —— CSS 淡化在
 * 不透明底板上透不到窗后的桌面。
 */

export default function FloatShell({ panel }: { panel: FloatPanel }) {
  const [config, setConfig] = React.useState<AppConfig | null>(null)
  const [events, setEvents] = React.useState<LiveEvent[]>([])
  const [status, setStatus] = React.useState('idle')
  const [fs, setFs] = React.useState<FloatState | null>(null)
  const [showPop, setShowPop] = React.useState(false)
  const [toast, setToast] = React.useState<{ message: string; error?: boolean }>({ message: '' })
  // 头像 data URL 到位后强制重渲染一次（跟主窗口同一套管线）
  const [, setFaceTick] = React.useState(0)
  const listRef = React.useRef<HTMLDivElement>(null)

  const notify = React.useCallback((message: string, error?: boolean) => {
    setToast({ message, error })
    window.setTimeout(() => setToast({ message: '' }), error ? 5200 : 3200)
  }, [])

  React.useEffect(() => {
    api.config.get().then(setConfig)
    const offs = [
      api.config.onChanged(setConfig),
      api.live.onEvent((e) => {
        setEvents((prev) => {
          const next = [...prev, e]
          return next.length > 300 ? next.slice(next.length - 300) : next
        })
      }),
      api.live.onStatus((s) => setStatus(s.status)),
      api.live.onFace((f) => {
        setResolvedFace(f.src, f.data)
        setFaceTick((t) => t + 1)
      }),
    ]
    try {
      offs.push(api.float?.onState?.(setFs))
    } catch {
      /* 主进程批次旧时没有这批接口 —— 浮窗少个状态显示而已 */
    }
    api.float
      ?.state()
      .then(setFs)
      .catch(() => {})
    return () => offs.forEach((f) => f && f())
  }, [])

  // 弹幕浮窗：列表自动滚动
  const autoScroll = config?.danmaku?.autoScroll !== false
  React.useEffect(() => {
    if (panel !== 'danmaku' || !autoScroll || !listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [events, autoScroll, panel])

  const me = fs?.panels?.[panel]

  const closeFloat = async () => {
    try {
      await api.float?.close(panel)
    } catch {
      /* 收回失败多半是主进程已经不在了，窗也跟着没了 */
    }
  }

  /**
   * 旋钮的本地值：一拖就改本地、一拖就发主进程（主进程那边自己防抖落盘）。
   * 关键是**绝不用主进程回流的状态盖回来** —— 之前滑块受控于 fs，拖完要等
   * 一次 IPC 往返才回显，松手那一拍先弹回旧值再应用，手感就是「不跟手 + 回弹」。
   */
  const [knobs, setKnobs] = React.useState<{ opacity: number; scale: number } | null>(null)
  const eff = knobs ?? { opacity: me?.opacity ?? 1, scale: me?.scale ?? 100 }
  const turn = (p: { opacity?: number; scale?: number }) => {
    setKnobs({ ...eff, ...p })
    api.float?.set(panel, p).catch(() => {})
  }

  // 弹幕浮窗可关头像：关掉能一眼看更多弹幕（只对弹幕浮窗生效，弹幕姬里照常显示）
  const showFaces = config?.float?.panels?.danmaku?.showFaces !== false
  const patchShowFaces = (v: boolean) => {
    api.config
      .patch({ float: { panels: { danmaku: { showFaces: v } } } })
      .then(setConfig)
      .catch(() => notify('没改成：配置没写进去', true))
  }

  // 低不透明度时的可读性补偿开关：窗口级透明是整扇窗一起淡，文字没法单独豁免
  //（DWM 逐像素乘 alpha）。这里在 < 75% 时切 is-dim —— 文字加阴影、次要文字提亮，
  // 主进程那边还叠加了一条可读性曲线把实际不透明度抬起来（见 float.cjs applyTo）
  const dim = eff.opacity < 0.75

  /* 浮窗的两颗常驻按钮：设置（弹层）+ ×（收回）。观众/礼物/音乐浮窗通过
     actions 塞进各自卡片头部；弹幕浮窗没有头部，贴在列表右上角。 */
  const winButtons = (
    <>
      <button
        type="button"
        className={`float-tbtn${showPop ? ' is-active' : ''}`}
        title="浮窗设置"
        aria-label="浮窗设置"
        onClick={() => setShowPop((v) => !v)}
      >
        <Icon name="settings" size={17} />
      </button>
      <button
        type="button"
        className="float-tbtn"
        title="收回浮窗：内容回到弹幕姬"
        aria-label="收回浮窗：内容回到弹幕姬"
        onClick={closeFloat}
      >
        <Icon name="close" size={17} />
      </button>
    </>
  )

  return (
    <MusicPlayerProvider config={config} notify={notify}>
      <div className={`float-shell${dim ? ' is-dim' : ''}`}>
        {/* 拖拽区：贴着窗口顶边的一条隐形横条 —— 各面板的头部就是它的标题栏 */}
        <div className="float-dragstrip" />

        {showPop && (
          <div className="float-pop" role="dialog" aria-label="浮窗显示设置">
            <div className="float-pop__row">
              <span>不透明度</span>
              <span className="float-pop__val">{Math.round(eff.opacity * 100)}%</span>
            </div>
            <Slider
              value={Math.round(eff.opacity * 100)}
              min={20}
              max={100}
              step={1}
              onChange={(v) => turn({ opacity: v / 100 })}
            />
            <div className="float-pop__row">
              <span>字体大小</span>
              <span className="float-pop__val">{eff.scale}%</span>
            </div>
            {/* 字体大小松手才应用：zoom 会缩放整个界面，跟手调的话滑块自己也跟着位移 */}
            <Slider value={eff.scale} min={50} max={200} step={5} onCommit={(v) => turn({ scale: v })} />
            {panel === 'danmaku' && (
              <div className="float-pop__row">
                <span>显示头像</span>
                <Switch value={showFaces} onChange={patchShowFaces} />
              </div>
            )}
            <div className="float-pop__hint">拖动马上生效，关掉浮窗也会记住；调得越低会自动多给文字补一点对比度</div>
          </div>
        )}

        {/* 透明度走主进程的窗口级 setOpacity（CSS 淡化透不到窗后的桌面） */}
        <div className="float-content">
          <div className={`float-body float-body--${panel === 'viewers' || panel === 'gifts' ? 'card' : panel}`}>
            {panel === 'danmaku' && (
              <>
                {/* 弹幕浮窗没有卡片头部：两颗按钮融成一颗胶囊，贴在列表右上角 */}
                <div className="float-topline">{winButtons}</div>
                <div className="danmaku-list" ref={listRef}>
                  {events.length === 0 ? (
                    <div className="empty-state">
                      {status === 'idle' ? '还没连接直播间，先回弹幕姬「连接」页填房间号' : '等待弹幕…'}
                    </div>
                  ) : (
                    events.map((e, i) => (
                      <EventRow
                        key={e.id || i}
                        ev={e}
                        anchorUid={Number(config?.room?.anchorUid) || 0}
                        showFace={showFaces}
                      />
                    ))
                  )}
                </div>
                <DanmakuFloatComposer status={status} notify={notify} />
              </>
            )}
            {panel === 'viewers' && <ViewersList actions={winButtons} />}
            {panel === 'gifts' && <PaidHistory events={events} actions={winButtons} />}
            {panel === 'music' && (
              <MusicConsole
                volume={config?.music?.volume ?? 0.6}
                actions={winButtons}
                onVolume={(v) => {
                  api.config.patch({ music: { volume: v } }).then(setConfig)
                }}
              />
            )}
          </div>
        </div>

        <Snackbar message={toast.message} error={toast.error} />
      </div>
    </MusicPlayerProvider>
  )
}

/** 弹幕浮窗自带的发送条：一条和弹幕区同色的深色矩形，贴着窗口底边。
 *  发送按钮只留一个图标（「发送」俩字是多余的），字数上限 40。 */
function DanmakuFloatComposer({ status, notify }: { status: string; notify: (m: string, e?: boolean) => void }) {
  const [text, setText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const draft = useDraftInput(text, setText)

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

  return (
    <div className="float-composer">
      <input
        className="float-composer__input"
        maxLength={40}
        placeholder={status === 'idle' ? '先连接直播间才能发弹幕' : '说点什么…（Enter 发送）'}
        value={draft.value}
        onChange={draft.onChange}
        onCompositionStart={draft.onCompositionStart}
        onCompositionEnd={draft.onCompositionEnd}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) send()
        }}
      />
      <span className="float-composer__count">{text.length}/40</span>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        title="发送"
        aria-label="发送"
        onClick={send}
        disabled={sending || !text.trim()}
      >
        <Icon name="send" size={18} />
      </button>
    </div>
  )
}
