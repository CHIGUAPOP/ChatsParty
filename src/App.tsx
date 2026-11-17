import React from 'react'
import { api, AppConfig, LiveEvent, LoginInfo, UpdateCheckResult } from './lib/api'
import { MusicPlayerProvider } from './lib/music-engine'
import { applyThemeConfig } from './lib/theme'
import { setResolvedFace } from './lib/faces'
import { useEmoticonBookSync } from './lib/emoticons'
import { Icon, Snackbar } from './components/ui'
import Onboarding from './components/Onboarding'
import ConnectPage from './pages/ConnectPage'
import DanmakuPage from './pages/DanmakuPage'
import MusicPage from './pages/MusicPage'
import VoicePage from './pages/VoicePage'
import VoicesPage from './pages/VoicesPage'
import AppearancePage from './pages/AppearancePage'
import OverlayPage from './pages/OverlayPage'
import AboutPage from './pages/AboutPage'
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

/** 「关于」不占导航栏的一格 —— 只从左上角图标进入，所以单独拎出来 */
type PageId = (typeof PAGES)[number]['id'] | 'about'

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
  // 首次启动的新手引导。全新安装时主进程会把 general.onboardingSeen 置成 false
  const [onboarding, setOnboarding] = React.useState(false)
  const [update, setUpdate] = React.useState<UpdateCheckResult | null>(null)

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
      paintTheme(c)
    })
  }, [])

  /**
   * 新手引导只认「明确写着的 false」。
   * undefined 一律不弹 —— 老用户升级上来配置里没有这个键，不该突然被弹一脸；
   * 全新安装时主进程在 load() 里把它置成 false，那才是真的要引导。
   */
  React.useEffect(() => {
    if (config && config.general?.onboardingSeen === false) setOnboarding(true)
  }, [config?.general?.onboardingSeen])

  /**
   * 检查更新：启动后延迟几秒查一次，这个进程内不再查第二次。
   * 失败/跳过一律静默（连不上 GitHub 不是用户需要知道的事）。
   * 用 ref 读配置，避免 effect 依赖 config 导致定时器被反复重置。
   */
  const cfgRef = React.useRef<AppConfig | null>(null)
  cfgRef.current = config
  React.useEffect(() => {
    const t = window.setTimeout(async () => {
      const c = cfgRef.current
      if (!c || c.general?.autoCheckUpdate === false) return
      try {
        const r = await api.app.updateCheck({ reason: 'auto' })
        if (r?.ok && r.hasUpdate && r.latest && r.latest !== c.general?.skipUpdateVersion) setUpdate(r)
      } catch {
        /* 连不上就放弃，不重试 */
      }
    }, 3000)
    return () => window.clearTimeout(t)
  }, [])

  const openUpdate = React.useCallback(
    async (u: UpdateCheckResult) => {
      const r = await api.app
        .openExternal(u.url || '')
        .catch(() => ({ ok: false, message: '打不开下载页' }))
      if (!r.ok) notify((r as any).message || '打不开下载页', true)
    },
    [notify],
  )

  React.useEffect(() => {
    if (config) paintTheme(config)
  }, [config?.theme?.seed, config?.theme?.mode, config?.theme?.style, config?.theme?.motion])

  React.useEffect(() => {
    api.bilibili.loginInfo().then(setLoginInfo)
  }, [])

  // 表情图册：主进程那边按「登录成功 / 进房间 / 每 30 分钟」推，这里只负责收下
  useEmoticonBookSync()

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
      // 在线语音挂了、临时换备用嗓子念 —— 不是错误，但主播得知道现在听到的不是原来那个声音
      api.tts.onNotice((n) => n?.message && notify(n.message)),
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
        // 队列堆积时主进程会叫我们播快一点（rate > 1）。playbackRate 是变速不变调的，
        // 但得显式打开 preservesPitch —— 不然听感就是录音带快进，音调跟着一起飘。
        const rate = Number(p.rate)
        audio.playbackRate = Number.isFinite(rate) && rate > 0 ? Math.min(3, rate) : 1
        audio.preservesPitch = true
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

  // 断言成非 null 是安全的：pageProps 只会在下面「配置已到手」的那个分支里被用到。
  // TS 没法跨闭包收窄外层变量，所以这里显式说一句。
  const pageProps = { config: config as AppConfig, patch, notify }

  const content = !config ? (
    <div className="app-shell">
      <div className="empty-state" style={{ margin: 'auto' }}>
        正在载入配置…
      </div>
    </div>
  ) : (
    <div className="app-shell">
      <nav className="nav-rail">
        <button
          type="button"
          className={`nav-rail__logo${page === 'about' ? ' is-active' : ''}`}
          title="关于 ChatsParty"
          aria-label="关于 ChatsParty"
          onClick={() => setPage('about')}
        >
          <img src={appIcon} alt="关于 ChatsParty" />
        </button>
        {PAGES.map((p) => (
          <button
            key={p.id}
            className={`nav-rail__item${page === p.id ? ' is-active' : ''}`}
            onClick={() => setPage(p.id)}
          >
            <span className="nav-rail__indicator" aria-hidden />
            <Icon name={p.icon} />
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
            <h1 className="top-bar__title">{page === 'about' ? '关于' : PAGES.find((p) => p.id === page)?.label}</h1>
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
          {update && (
            <button
              type="button"
              className="update-chip"
              title={`当前 v${update.current}，最新 v${update.latest}。点击打开下载页`}
              onClick={() => openUpdate(update)}
            >
              <Icon name="download" size={15} />
              有新版本 v{update.latest}
            </button>
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
          {page === 'about' && <AboutPage {...pageProps} />}
          <Snackbar message={toast.message} error={toast.error} />
          {/* 浮层向导盖在最上：它只在首次启动（或关于页手动重开）时出现 */}
          {onboarding && (
            <Onboarding
              config={config as AppConfig}
              patch={patch}
              notify={notify}
              loginInfo={loginInfo}
              setLoginInfo={setLoginInfo}
              onDone={() => setOnboarding(false)}
            />
          )}
        </div>
      </div>
    </div>
  )

  /**
   * 播放器挂在最外面一层：它必须比任何页面活得久。
   * 以前这段逻辑住在 MusicPage 里，切走页面组件一卸载、订阅就被摘掉，
   * 一首歌放完没人接下一首 —— 表现就是「放着放着就停」。
   */
  return (
    <MusicPlayerProvider config={config} notify={notify}>
      {content}
    </MusicPlayerProvider>
  )
}

/**
 * 把主题配置刷到 <html> 上：配色（M2 还要收敛容器色）、动效、界面风格。
 * 浮窗和主窗口共用同一份样式表与同一批令牌，所以设一次两边一起变。
 */
function paintTheme(c: AppConfig) {
  applyThemeConfig(c.theme)
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
