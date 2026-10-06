import React from 'react'
import { api, AppConfig, LiveEvent, LoginInfo } from './lib/api'
import { applyScheme, buildScheme } from './lib/theme'
import { setResolvedFace } from './lib/faces'
import { Icon, Snackbar } from './components/ui'
import ConnectPage from './pages/ConnectPage'
import DanmakuPage from './pages/DanmakuPage'
import MusicPage from './pages/MusicPage'
import VoicePage from './pages/VoicePage'
import VoicesPage from './pages/VoicesPage'
import AppearancePage from './pages/AppearancePage'
import OverlayPage from './pages/OverlayPage'
import appIcon from './assets/icon.png'

const PAGES = [
  { id: 'connect', label: '连接', icon: 'plug' },
  { id: 'danmaku', label: '弹幕', icon: 'chat' },
  { id: 'music', label: '点歌', icon: 'music' },
  { id: 'voice', label: '语音', icon: 'voice' },
  { id: 'voices', label: '音色', icon: 'layers' },
  { id: 'theme', label: '外观', icon: 'palette' },
  { id: 'obs', label: 'OBS', icon: 'settings' },
] as const

type PageId = (typeof PAGES)[number]['id']

export default function App() {
  const [config, setConfig] = React.useState<AppConfig | null>(null)
  const [page, setPage] = React.useState<PageId>('connect')
  const [toast, setToast] = React.useState<{ message: string; error?: boolean }>({ message: '' })
  const [events, setEvents] = React.useState<LiveEvent[]>([])
  const [status, setStatus] = React.useState('idle')
  const [popularity, setPopularity] = React.useState(0)
  // 头像 data URL 到位后用它做一次强制重渲染
  const [, setFaceTick] = React.useState(0)
  const [loginInfo, setLoginInfo] = React.useState<LoginInfo>({ isLogin: false })
  // 播报状态：决定顶栏那个「跳过」胶囊出不出来。放在这一层是为了切页面也不丢
  const [speech, setSpeech] = React.useState<{ state: string; text: string }>({ state: 'idle', text: '' })
  const [queued, setQueued] = React.useState(0)

  const notify = React.useCallback((message: string, error?: boolean) => {
    setToast({ message, error })
    window.setTimeout(() => setToast({ message: '' }), error ? 5200 : 3200)
  }, [])

  const patch = React.useCallback(async (partial: Record<string, unknown>) => {
    const next = await api.config.patch(partial)
    setConfig(next)
    return next
  }, [])

  React.useEffect(() => {
    api.config.get().then((c) => {
      setConfig(c)
      applyScheme(buildScheme(c.theme?.seed || '#6750A4', c.theme?.mode || 'dark'), c.theme?.mode || 'dark')
    })
  }, [])

  React.useEffect(() => {
    if (!config) return
    applyScheme(buildScheme(config.theme?.seed || '#6750A4', config.theme?.mode || 'dark'), config.theme?.mode || 'dark')
  }, [config?.theme?.seed, config?.theme?.mode])

  React.useEffect(() => {
    api.bilibili.loginInfo().then(setLoginInfo)
  }, [])

  React.useEffect(() => {
    const offs = [
      api.live.onEvent((e) => {
        setEvents((prev) => {
          const next = [...prev, e]
          return next.length > 300 ? next.slice(next.length - 300) : next
        })
      }),
      api.live.onStatus((s) => {
        setStatus(s.status)
        if (s.status === 'error' && s.message) notify(s.message, true)
      }),
      api.live.onPopularity((p) => setPopularity(p.popularity)),
      api.live.onError((e) => notify(e.message, true)),
      api.bilibili.onLogin(setLoginInfo),
      // 头像由主进程带 Referer 抓回来后推过来，存进映射表再触发一次重渲染
      api.live.onFace((f) => {
        setResolvedFace(f.src, f.data)
        setFaceTick((t) => t + 1)
      }),
      api.tts.onError((e) => notify(`语音合成失败：${e.message}`, true)),
      // 主进程把密钥里的脏字符洗掉了 —— 说一声，否则用户永远不知道刚才 401 为什么
      api.config.onNotice((n) => {
        if (n?.messages?.length) notify(n.messages.join('；'), true)
      }),
      // 主进程自己也会改配置（连上直播间写入房间信息、Fish 兜底模型、叠加层端口顺延），
      // 不订阅的话界面一直显示旧值
      api.config.onChanged((c) => setConfig(c)),
    ]
    return () => offs.forEach((f) => f())
  }, [notify])

  const speaking = speech.state === 'loading' || speech.state === 'playing'

  /* 播报状态订阅。放这里而不是弹幕页：播报是瞬时的，切走再切回来会漏掉事件 */
  React.useEffect(() => {
    const apply = (s: { state?: string; text?: string; queued?: number; busy?: boolean }) => {
      const next = s?.state === 'loading' || s?.state === 'playing' ? s.state : 'idle'
      const text = next === 'idle' ? '' : s?.text || ''
      setSpeech((prev) => (prev.state === next && prev.text === text ? prev : { state: next, text }))
      if (typeof s?.queued === 'number') setQueued(s.queued)
    }
    const offs = [
      api.tts.onState((s) => apply(s)),
      api.tts.onSkip(() => apply({ state: 'idle' })),
    ]
    // 刚启动 / 刚切回来：主动问一次现在在念什么
    api.tts.queue().then((q) => apply(q))
    const timer = window.setInterval(() => {
      api.tts.queue().then((q) => apply(q))
    }, 800)
    return () => {
      offs.forEach((f) => f())
      window.clearInterval(timer)
    }
  }, [])

  const skip = React.useCallback(async () => {
    const r = await api.tts.skip()
    setSpeech({ state: 'idle', text: '' })
    notify(r.skipped || r.pending ? '已跳过当前播报' : '当前没有正在播报的内容')
  }, [notify])

  const clearQueue = React.useCallback(async () => {
    const r = await api.tts.clear()
    setSpeech({ state: 'idle', text: '' })
    setQueued(0)
    notify(r.cleared > 0 ? `已清空 ${r.cleared} 条待播` : '队列本来就是空的')
  }, [notify])

  // Esc 跳过：手在键盘上时不用去找按钮（输入框里的 Esc 留给输入法）
  const speakingRef = React.useRef(false)
  const skipRef = React.useRef(skip)
  speakingRef.current = speaking
  skipRef.current = skip
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !speakingRef.current) return
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      skipRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* 音频播报：主进程合成完推过来，这里播放并在结束时回执 */
  React.useEffect(() => {
    // 留着当前这条的引用，「跳过」才有东西可停
    let current: HTMLAudioElement | null = null

    const stopCurrent = () => {
      const a = current
      current = null
      if (!a) return false
      // 先摘掉回调：主动暂停也会触发 onended，那样会多 ack 一次、把队列推进两格
      a.onended = null
      a.onerror = null
      try {
        a.pause()
        a.currentTime = 0
      } catch {
        /* 已经结束的音频 pause 会抛，忽略 */
      }
      return true
    }

    const offPlay = api.tts.onPlay((p) => {
      stopCurrent()
      try {
        const bin = atob(p.base64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const url = URL.createObjectURL(new Blob([bytes], { type: p.mime || 'audio/wav' }))
        const audio = new Audio(url)
        audio.volume = Number.isFinite(p.volume) ? p.volume : 0.9
        const finish = () => {
          if (current === audio) current = null
          URL.revokeObjectURL(url)
          api.tts.ack()
        }
        audio.onended = finish
        audio.onerror = finish
        current = audio
        audio.play().catch(finish)
      } catch {
        api.tts.ack()
      }
    })

    // 主进程说「跳过」：停掉声音就行，队列那边它自己已经放行了，不要再 ack
    const offSkip = api.tts.onSkip(() => {
      stopCurrent()
    })

    return () => {
      offPlay()
      offSkip()
      stopCurrent()
    }
  }, [])

  if (!config) {
    return (
      <div className="app-shell">
        <div className="empty-state" style={{ margin: 'auto' }}>
          正在载入配置…
        </div>
      </div>
    )
  }

  const pageProps = { config, patch, notify }

  return (
    <div className="app-shell">
      <nav className="nav-rail">
        <div className="nav-rail__logo" title="ChatsParty">
          <img src={appIcon} alt="ChatsParty" />
        </div>
        {PAGES.map((p) => (
          <button
            key={p.id}
            className={`nav-rail__item${page === p.id ? ' is-active' : ''}`}
            onClick={() => setPage(p.id)}
          >
            <span className="nav-rail__indicator">
              <Icon name={p.icon} />
            </span>
            <span className="nav-rail__label">{p.label}</span>
          </button>
        ))}
        <div className="nav-rail__spacer" />
        {loginInfo.isLogin && loginInfo.face ? (
          <img
            src={loginInfo.face}
            alt=""
            title={loginInfo.uname || '已登录'}
            style={{ width: 36, height: 36, borderRadius: '50%' }}
          />
        ) : null}
      </nav>

      <div className="main">
        <header className="top-bar">
          <div>
            <h1 className="top-bar__title">{PAGES.find((p) => p.id === page)?.label}</h1>
          </div>
          <div className="top-bar__spacer" />
          {speaking && (
            <span className="speech-chip" title={speech.text}>
              <span className="speech-chip__dot" />
              <span className="speech-chip__label">{speech.state === 'loading' ? '合成中' : '播报中'}</span>
              <span className="speech-chip__text">{speech.text}</span>
              <button type="button" className="speech-chip__btn" onClick={skip} title="跳过当前播报（Esc）">
                <Icon name="skip" size={16} />
                跳过
              </button>
              {queued > 0 && (
                <button type="button" className="speech-chip__btn" onClick={clearQueue} title="把排队等着念的也清掉">
                  清空 {queued}
                </button>
              )}
            </span>
          )}
          <span className={`status-pill${status === 'authenticated' || status === 'connected' ? ' is-live' : ''}`}>
            <span className="status-dot" />
            {statusLabel(status)}
          </span>
          {popularity > 0 && (
            <span className="status-pill">人气 {popularity.toLocaleString('zh-CN')}</span>
          )}
          {config.room?.title && (
            <span className="top-bar__subtitle" style={{ maxWidth: 320 }}>
              {config.room.title}
            </span>
          )}
        </header>

        <div className="content" style={{ position: 'relative' }}>
          {page === 'connect' && <ConnectPage {...pageProps} loginInfo={loginInfo} setLoginInfo={setLoginInfo} />}
          {page === 'danmaku' && <DanmakuPage {...pageProps} events={events} status={status} />}
          {page === 'music' && <MusicPage {...pageProps} />}
          {page === 'voice' && <VoicePage {...pageProps} />}
          {page === 'voices' && <VoicesPage {...pageProps} />}
          {page === 'theme' && <AppearancePage {...pageProps} />}
          {page === 'obs' && <OverlayPage {...pageProps} />}
          <Snackbar message={toast.message} error={toast.error} />
        </div>
      </div>
    </div>
  )
}

function statusLabel(s: string) {
  switch (s) {
    case 'connected':
    case 'authenticated':
      return '已连接'
    case 'connecting':
      return '连接中'
    case 'reconnecting':
      return '重连中'
    case 'disconnected':
      return '已断开'
    case 'error':
      return '出错'
    default:
      return '未连接'
  }
}
