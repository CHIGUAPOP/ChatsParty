import React from 'react'
import { api, AppConfig, FloatState, MusicQueueItem, MusicState } from './api'

/**
 * 音乐播放引擎。
 *
 * 以前这段逻辑写在 MusicPage 里，结果是：切到别的页面 -> MusicPage 卸载 ->
 * 订阅 `music:state` 的监听器被摘掉、播放当前曲目的 effect 也没了。
 * 表现就是「一首歌放完就停」，必须切回点歌页它才想起来该放下一首。
 *
 * 现在放到 App 层常驻：不管你在哪个页面，播放器都在跑，队列也照常推进。
 * MusicPage 退化成遥控器 —— 只负责读状态和发指令。
 *
 * ==============================
 * 跨窗口的播放权（重要）
 * ==============================
 * 主窗口和每个浮窗都是**独立的渲染进程**，各自跑着一份本引擎（各自有各自的
 * <audio> / <video> 元素），而 music:state 这类广播是发给所有窗口的 ——
 * 不分归属的话，开个音乐浮窗就是两份一模一样的声音一起响。
 *
 * 所以规则是：**同一时刻只有一个窗口真正出声**：
 *  - 音乐浮窗开着 → 它拥有播放权（画面和声音都在它那儿）；
 *  - 否则 → 主窗口拥有；
 *  - 其它浮窗（弹幕 / 观众 / 礼物）永远不拥有。
 *
 * 拥有者把自己的进度当心跳推出来（music:tick → 主进程广播），其余窗口照着
 * 镜像 —— 界面照常动，只是不出声；它们的播放/暂停/拖进度转发给拥有者去执行
 * （music:remote）。窗口从拥有者变回非拥有者（或反过来）时，各自的元素
 * 暂停 / 接着放，当前这条不换。
 */

export interface LyricLine {
  time: number
  text: string
}

export interface MusicPlayerValue {
  state: MusicState
  /** 队列状态是否已拉到手。没拉到之前任何状态都别信（详见下方 ready 注释） */
  ready: boolean
  playing: boolean
  position: number
  duration: number
  loading: boolean
  lrc: LyricLine[]
  lrcIndex: number
  toggle: () => void
  stop: () => void
  /** 当前这条是 B 站视频时才有值（歌曲恒为 null） */
  video: { bvid: string; cid: number; title: string; duration: number; pic: string; up: string } | null
  /** 视频元素是否真的在响（原生 video 的 paused 反面） */
  videoPlaying: boolean
  /** 视频已播秒数（原生 video 的 currentTime，不再靠计时器估算） */
  videoElapsed: number
  /** 视频总时长（元数据到手后用视频自己的；之前是队列里记的估算值） */
  videoDuration: number
  /** 流在缓冲（waiting 事件里）。给「缓冲中…」那条提示用 */
  videoBuffering: boolean
  /** 已经解出至少一帧画面。海报只垫到这一刻为止，别盖住暂停时的冻结帧 */
  videoReady: boolean
  /** 取流 / 播放失败的提示（空串 = 没有） */
  videoError: string
  /** 这个窗口不是出声的那一个（音乐浮窗开着）：画面摆占位，键转发给浮窗 */
  videoElsewhere: boolean
  /** 把单例 <video> 挂进容器（null = 摘下来）。挪窝不打断播放 */
  videoAttach: (host: HTMLElement | null) => void
  videoVolume: number
  videoMuted: boolean
  setVideoVolume: (v: number) => void
  setVideoMuted: (v: boolean) => void
  /**
   * **跟着当前条目走的音量旋钮**：在播 B 站视频时它控制视频音量，在播歌时控制歌的音量。
   *
   * 为什么非要有它：界面上有好几处音量滑块（点歌页「正在播放」卡片、弹幕页和浮窗的
   * 音乐控制台），以前一律绑死 `music.volume` —— 于是播着视频拖它们，画面上那个滑块
   * 动得挺欢，视频一点没变小（视频的音量在 `video.volume` 上）。用户眼里就是
   * 「音量控制失灵」。所有「不知道当前播的是什么」的地方都应该用这四个，别直接用配置里的值。
   */
  activeVolume: number
  activeMuted: boolean
  setActiveVolume: (v: number) => void
  setActiveMuted: (v: boolean) => void
  /** 拖进度条：跳到第 n 秒（原生 seek，直接拨 currentTime，不再重建任何东西） */
  videoSeekTo: (sec: number) => void
}

/**
 * 浏览器抛的媒体错误是英文加错误码，主播看不懂也做不了什么。
 * 翻成「哪儿错了 + 现在怎么办」。歌和视频共用（同一个 media element 协议）。
 */
function describeAudioFailure(el: HTMLMediaElement | null, e?: any): string {
  const code = el?.error?.code
  if (code === 1) return '播放被中断了'
  if (code === 2) return '网络断了，这首没下载完 —— 重新点一次'
  if (code === 3) return '这个文件解不开 —— 换一版试试'
  if (code === 4) return '拿到的播放地址播不了（会员/版权限制，或地址已过期）—— 换一版或重新点一次'
  const msg = String(e?.message || e || '')
  if (/no supported source|not supported/i.test(msg)) {
    return '拿到的播放地址播不了（会员/版权限制，或地址已过期）—— 换一版或重新点一次'
  }
  if (/not allowed|user gesture|interact/i.test(msg)) return '自动播放被拦了 —— 点一下播放按钮'
  return msg || '这首歌播放失败了'
}

/**
 * 播放器和「当前这首的 id」放在组件外面：
 * 组件就算因为什么原因重新挂载，也不会把正在播的那首从头再放一遍，播完的回调也还在。
 */
let audioEl: HTMLAudioElement | null = null
// 队列里歌和视频的 id 各编各的，所以这个标记带类型前缀（见 keyOf）
let playingId: string | number = 0
/** 音频元素里装的是队列哪一条（keyOf）。跟 playingId 一起构成「真的在播这首」的证据 */
let audioKey = ''

/* ---------------- B 站视频：原生 <video> 单例 ---------------- */

let videoEl: HTMLVideoElement | null = null
function getVideoElement(): HTMLVideoElement {
  if (!videoEl) {
    const el = document.createElement('video')
    el.playsInline = true
    el.preload = 'auto'
    // 铺满宿主容器（容器永远 16:9，见 VideoStage / styles.css），画面按比例放
    el.style.width = '100%'
    el.style.height = '100%'
    el.style.objectFit = 'contain'
    el.style.display = 'block'
    el.dataset.vstageVideo = ''
    videoEl = el
  }
  return videoEl
}

/** 流地址缓存：暂停/继续、跨页面重挂、浮窗开开关关，都不用重复取 */
let streamCache = new Map<string, string>()

/**
 * 取「能直接喂 <video> 的整条播放地址」（platform=html5 的 mp4，音视频混流）。
 *
 * 这个函数**是可替换的**（`__setVideoStreamLoader`）：离线环境探不了真流，
 * 探针要能量「拿到流之后」的界面就得把这步换掉。生产路径永远走默认实现。
 */
let streamLoader: (bvid: string, cid: number) => Promise<string | null> = async (bvid, cid) => {
  try {
    const a = await api.music.videoAudio({ bvid, cid })
    return a?.url || null
  } catch {
    // 拿不到不是崩溃级：调用方提示一句并跳下一首，队列不在这儿停摆
    return null
  }
}
/** 只给离线探针用：换掉取流那一步。返回的函数可以还原。 */
export function __setVideoStreamLoader(fn: (bvid: string, cid: number) => Promise<string | null>) {
  const prev = streamLoader
  streamLoader = fn
  return () => {
    streamLoader = prev
  }
}

/**
 * 队列里混着歌和 B 站视频，两者的 id 各自独立编号 ——
 * 只比 id 的话，某首歌和某个视频撞号时会误判成「已经在播这首」。
 * 带上类型前缀就不会串。
 */
function kindOf(item?: { kind?: string } | null): 'video' | 'song' {
  return item?.kind === 'video' ? 'video' : 'song'
}
function keyOf(item: { id?: number; kind?: string } | null | undefined): string {
  if (!item) return ''
  return `${kindOf(item)}:${item.id ?? 0}`
}

/** 空歌词的固定引用。每渲染一次就新建一个数组的话，依赖它的 effect 会跟着每一帧重跑 */
const EMPTY_LRC: LyricLine[] = []

const MusicPlayerContext = React.createContext<MusicPlayerValue | null>(null)

export function useMusicPlayer(): MusicPlayerValue {
  const v = React.useContext(MusicPlayerContext)
  if (!v) throw new Error('useMusicPlayer 必须在 MusicPlayerProvider 内部使用')
  return v
}

interface Props {
  config: AppConfig | null
  notify: (m: string, e?: boolean) => void
  children: React.ReactNode
}

export function MusicPlayerProvider({ config, notify, children }: Props) {
  const [state, setState] = React.useState<MusicState>({ items: [], current: null, queued: 0 })
  const [playing, setPlaying] = React.useState(false)
  const [position, setPosition] = React.useState(0)
  const [duration, setDuration] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [lrc, setLrc] = React.useState<LyricLine[]>([])
  /**
   * 手上这份歌词是**哪首**的。
   * state 是主进程推过来的，换歌那一拍它已经是新歌了，而 lrc 还是上一首的 ——
   * 少了这个标记就会把旧词挂到新歌名下报上去，OBS 上就是「放着这首唱着那首」。
   * 0 表示「这份谁也不是」（刚换歌、还没取回来）。
   */
  const [lrcFor, setLrcFor] = React.useState(0)
  const [lrcIndex, setLrcIndex] = React.useState(-1)
  /* ---- B 站视频（同一条队列里的另一类条目） ---- */
  const [video, setVideo] = React.useState<MusicPlayerValue['video']>(null)
  const [videoPlaying, setVideoPlaying] = React.useState(false)
  const [videoElapsed, setVideoElapsed] = React.useState(0)
  const [videoDuration, setVideoDuration] = React.useState(0)
  const [videoBuffering, setVideoBuffering] = React.useState(false)
  const [videoReady, setVideoReady] = React.useState(false)
  const [videoError, setVideoError] = React.useState('')
  /**
   * 队列状态拉回来之前，**一个字都别信**。
   * 初值是 {current:null}，如果拿它去跑「没歌了就停」，就会先把播放器暂停、
   * 再把「当前这首」的标记清掉；等真实状态一到，又当成新歌从头播一遍。
   * 表现就是：暂停之后切走再切回来，歌自己又开始放了。
   */
  const [ready, setReady] = React.useState(false)

  // 播放回调要读最新的音量/歌词状态，但这些值放进依赖会让 Audio 反复重新绑定。
  // 用 ref 取最新值，回调本身保持稳定。
  const volumeRef = React.useRef(0.9)
  volumeRef.current = Number.isFinite(Number(config?.music?.volume)) ? Number(config?.music?.volume) : 0.9
  /** 视频的音量/静音（直接落在原生元素上，碰得到了） */
  const videoVolumeCfg = Number.isFinite(Number(config?.video?.volume)) ? Number(config?.video?.volume) : 0.8
  const videoMutedCfg = config?.video?.muted === true
  // 这两个 ref 只在这里取初值，之后跟着本地 state 走（见下面「装载新流」那组 effect）——
  // 每次渲染都拿 config 覆盖的话，拖滑条时 ref 会被按回旧值
  const videoVolumeRef = React.useRef(videoVolumeCfg)
  const videoMutedRef = React.useRef(videoMutedCfg)
  const notifyRef = React.useRef(notify)
  notifyRef.current = notify
  /** 播放意图的最新值（「该不该在响」）。播放权翻回来时照它决定接不接着放 */
  const playingRef = React.useRef(false)
  playingRef.current = playing
  /** 非拥有者窗口镜像来的进度（ regain 时拿来续播，别从头再来） */
  const positionRef = React.useRef(0)
  positionRef.current = position
  const videoElapsedRef = React.useRef(0)
  videoElapsedRef.current = videoElapsed
  /** 最新一帧队列状态：主进程广播过来的回调（如清晰度改动）里要读它 */
  const stateRef = React.useRef(state)
  stateRef.current = state

  /* ---- 跨窗口播放权 ---- */
  const thisFloat = new URLSearchParams(window.location.search).get('float')
  const isFloatWindow =
    thisFloat === 'danmaku' || thisFloat === 'viewers' || thisFloat === 'gifts' || thisFloat === 'music'
  const isMusicFloat = thisFloat === 'music'
  // 音乐浮窗自己就是出声的那一个；主窗口要看音乐浮窗开没开（float:state 全窗广播）
  const [musicFloatOpen, setMusicFloatOpen] = React.useState(isMusicFloat)
  React.useEffect(() => {
    if (isFloatWindow) return
    let alive = true
    const take = (s: FloatState | null) => {
      if (alive && s) setMusicFloatOpen(Boolean(s.panels?.music?.opened))
    }
    api.float?.state?.().then(take).catch(() => {})
    let off: (() => void) | undefined
    try {
      off = api.float?.onState?.(take)
    } catch {
      /* 主进程批次旧时没有这批接口 —— 少个归属仲裁而已 */
    }
    return () => {
      alive = false
      off?.()
    }
  }, [isFloatWindow])
  const ownsPlayback = isMusicFloat || (!isFloatWindow && !musicFloatOpen)
  const ownsPlaybackRef = React.useRef(ownsPlayback)
  ownsPlaybackRef.current = ownsPlayback

  /** 现在装在视频元素里的是队列哪一条（keyOf）。空串 = 没装 */
  const videoKeyRef = React.useRef('')
  /** 元数据还没到手时点的进度，等 loadedmetadata 再拨 */
  const pendingSeekRef = React.useRef(-1)

  const bindAudio = React.useCallback((el: HTMLAudioElement) => {
    el.onloadedmetadata = () => setDuration(el.duration || 0)
    el.ontimeupdate = () => setPosition(el.currentTime || 0)
    el.onerror = () => {
      setPlaying(false)
      // 进度归零：残留的「上一首播到哪」一旦被当成下一首的起点，
      // 新歌就会从上首的位置开始放（用户看到「怎么从 2 分多开始」）
      setPosition(0)
      // 播放中途断流也走这里；统一由它负责提示 + 跳下一首
      notifyRef.current(describeAudioFailure(el), true)
      playingId = 0
      audioKey = ''
      api.music.next()
    }
    el.onended = () => {
      setPlaying(false)
      setPosition(0)
      playingId = 0
      audioKey = ''
      api.music.next()
    }
  }, [])

  /**
   * 给视频元素绑事件。元素是单例，onxxx 属性赋值是覆盖同一个槽，重复绑无害。
   * 事件是**原生的**：timeupdate / ended / waiting 全都发生在元素自己身上，
   * 不管它此刻挂在哪个容器里 —— 所以页面切换、浮窗开合都漏不掉。
   */
  const bindVideo = React.useCallback((el: HTMLVideoElement) => {
    el.onloadedmetadata = () => {
      // 有些来源（如 MediaRecorder 直录的 webm）没有时长元数据，duration 是
      // Infinity —— 收敛成 0，让界面回落用队列里记的那个
      setVideoDuration(Number.isFinite(el.duration) ? el.duration : 0)
      setVideoReady(el.readyState >= 2)
      if (pendingSeekRef.current >= 0) {
        try {
          el.currentTime = pendingSeekRef.current
        } catch {
          /* 拨不了就算了，别为一次 seek 抛异常 */
        }
        pendingSeekRef.current = -1
      }
    }
    el.oncanplay = () => {
      setVideoReady(true)
      setVideoBuffering(false)
    }
    el.ontimeupdate = () => setVideoElapsed(el.currentTime || 0)
    el.onwaiting = () => setVideoBuffering(true)
    el.onplaying = () => {
      setVideoBuffering(false)
      setVideoReady(true)
      setVideoPlaying(true)
      setPlaying(true)
    }
    el.onpause = () => {
      setVideoPlaying(false)
      setPlaying(false)
    }
    el.onerror = () => {
      // 中途断流 / 地址过期。提示一句然后照常推进队列 —— 别让整条队列卡死在这
      setVideoBuffering(false)
      setVideoPlaying(false)
      setPlaying(false)
      notifyRef.current(describeAudioFailure(el), true)
      videoKeyRef.current = ''
      api.music.next()
    }
    el.onended = () => {
      setVideoPlaying(false)
      setPlaying(false)
      videoKeyRef.current = ''
      api.music.next()
    }
  }, [])

  /**
   * 取流并装进视频元素。取流是异步的，期间条目可能又变了（快速连点下一首），
   * 回来第一件事就是核对身份，不是这条了就什么都不动。
   */
  const loadVideo = React.useCallback(
    async (item: MusicQueueItem, itemKey: string, autoPlay = true, startAt = 0) => {
      const bvid = item.bvid || ''
      const cid = Number(item.cid) || 0
      const el = getVideoElement()
      bindVideo(el)
      videoKeyRef.current = itemKey
      setVideoBuffering(true)
      setVideoError('')
      let url = streamCache.get(`${bvid}:${cid}`) || null
      if (!url) {
        url = await streamLoader(bvid, cid)
        if (videoKeyRef.current !== itemKey) return // 等流的这几秒里已经换成别的了
        if (url) streamCache.set(`${bvid}:${cid}`, url)
      }
      if (!url) {
        setVideoBuffering(false)
        setVideoError('拿不到这条视频的播放地址（可能是会员 / 充电专属）')
        notifyRef.current('这条视频拿不到播放地址（会员/充电专属？），跳下一首', true)
        videoKeyRef.current = ''
        api.music.next()
        return
      }
      // 同一条流就别重设 src：一重设进度就归零
      if (el.src !== url) {
        el.src = url
        setVideoReady(false)
        if (startAt > 0) {
          // 元数据没到时设 currentTime 会落到「默认起播位置」，到达后生效；
          // 保险起见再记一笔，loadedmetadata 里兜底
          try {
            el.currentTime = startAt
          } catch {
            /* noop */
          }
          pendingSeekRef.current = startAt
        }
      }
      el.volume = Math.min(1, Math.max(0, videoVolumeRef.current))
      el.muted = videoMutedRef.current
      if (!autoPlay) {
        setVideoBuffering(false)
        return
      }
      try {
        await el.play()
      } catch (e: any) {
        if (videoKeyRef.current !== itemKey) return
        // 自动播放被拦时视频本身是好的：给个「点画面开始」的提示，别跳走
        if (/not allowed|user gesture|interact/i.test(String(e?.message || e))) {
          setVideoError('自动播放被拦了 —— 点一下画面开始播放')
        }
      }
    },
    [bindVideo],
  )

  /* 订阅队列状态。这里常驻，所以切页面不会漏掉任何一次推进 */
  React.useEffect(() => {
    let alive = true
    api.music
      .state()
      .then((s) => {
        if (!alive) return
        /**
         * 浮窗这类窗口是按需新建的：挂载时东西可能已经在别的窗口播到一半。
         * 主进程把最后一条播放心跳随快照下发 —— 先把镜像进度/播放意图补上、
         * 把「这条已经见过」的标记种好。不补的话，接管播放权那一刻
         * lastKeyRef 是空的，会被当成「换了条目」从头播（用户实测报过）。
         * key 对不上说明心跳是上一条的遗物，弃用。
         */
        const t = s?.tick
        const k = keyOf(s?.current || null)
        if (t && t.key && t.key === k) {
          const pos = Number(t.pos) || 0
          if (pos > 0) {
            setPosition(pos)
            setVideoElapsed(pos)
            if (Number(t.dur) > 0) {
              setDuration(Number(t.dur))
              setVideoDuration(Number(t.dur))
            }
          }
          setPlaying(Boolean(t.playing))
          setVideoPlaying(Boolean(t.playing))
          lastKeyRef.current = k
        }
        setState(s)
        setReady(true)
      })
      .catch(() => setReady(true))
    return () => {
      alive = false
    }
    // 只订阅，不在这里处理播放器 —— 播放由下面那个 effect 统一负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    const take = (s: MusicState) => {
      setState(s)
      setReady(true)
    }
    // 挂载时若正在播（比如组件重建），把 UI 状态补回来
    if (audioEl && !audioEl.paused) {
      setPlaying(true)
      setPosition(audioEl.currentTime || 0)
      setDuration(audioEl.duration || 0)
    }
    return api.music.onState(take)
  }, [bindAudio])

  /** 取链接并播放当前这首。autoPlay=false = 只把流装上，先不出声（播放权/暂停意图的场合） */
  const playCurrent = React.useCallback(
    async (item: MusicQueueItem, autoPlay = true, startAt = 0) => {
      if (!item) return
      if (playingId === keyOf(item) && audioKey === keyOf(item) && audioEl) {
        // 已经装着这首了（页面重建 / 播放权刚翻回来），别重复取链；
        // 该放的话从暂停处接着放
        if (autoPlay && audioEl.paused && audioEl.src) audioEl.play().catch(() => {})
        return
      }
      playingId = keyOf(item)
      setLoading(true)
      setLrc([])
      setLrcIndex(-1)
      setPosition(0)
      // 只有真的走到「创建播放器」这一步，才可能由 el.onerror 接管；取链接失败时它还该是 null
      let el: HTMLAudioElement | null = null
      try {
        const audio = await api.music.url(item.id)
        el = audioEl || new Audio()
        audioEl = el
        el.src = audio.url
        audioKey = keyOf(item)
        el.volume = volumeRef.current
        bindAudio(el)
        if (startAt > 0) {
          try {
            el.currentTime = startAt
          } catch {
            /* 元数据没到就先记着，播放器自己会落到那个位置 */
          }
        }
        if (autoPlay) {
          await el.play()
          setPlaying(true)
        }
      } catch (e: any) {
        playingId = 0
        setPlaying(false)
        // 媒体加载失败会同时触发 el.onerror，那边已经提示并跳下一首了 —— 这里别再跳一次，否则一次失败跳两首
        if (el?.error) return
        const msg = describeAudioFailure(el, e)
        notifyRef.current(msg, true)
        // 自动播放被拦时歌是好的，跳走反而莫名其妙
        if (!/自动播放/.test(msg)) api.music.next()
      } finally {
        setLoading(false)
      }
    },
    [bindAudio],
  )

  /** 上一次处理的条目。用来区分「换了条目（要点播）」和「播放权翻了（照镜像意图来）」 */
  const lastKeyRef = React.useRef('')

  // 当前曲目变了就播它；队列空了就停。视频和歌走两条路，但共用同一条队列。
  // ownsPlayback 也是依赖：播放权翻回来时（音乐浮窗关掉），这个窗口要把当前这条接上
  React.useEffect(() => {
    if (!ready) return
    const cur = state.current
    if (!cur) {
      if (audioEl) {
        audioEl.pause()
        audioEl.onended = null
      }
      if (videoEl) videoEl.pause()
      playingId = 0
      audioKey = ''
      videoKeyRef.current = ''
      lastKeyRef.current = ''
      setPlaying(false)
      setVideoPlaying(false)
      setVideo(null)
      return
    }
    const key = keyOf(cur)
    /**
     * 「要不要自动出声」：条目换了（观众点歌 / 播完推进）就是要播；
     * 条目没换、只是播放权翻回来，就照镜子里面的播放状态来 ——
     * 用户明明按了暂停，不该因为关个浮窗就又唱起来。
     */
    const itemChanged = lastKeyRef.current !== key
    lastKeyRef.current = key
    const autoPlay = itemChanged || playingRef.current

    if (!ownsPlayback) {
      // 这个窗口不是出声的那一个：安静地把本地元素停掉。
      // 界面照常渲染（进度靠心跳镜像），播放键会转发给拥有者。
      if (audioEl) audioEl.pause()
      if (videoEl) videoEl.pause()
      setPlaying(false)
      setVideoPlaying(false)
      if (kindOf(cur) === 'video') {
        // 画面也要有个交代：摆一块「画面在音乐浮窗里」的占位（见 VideoStage）
        setVideo({
          bvid: cur.bvid || '',
          cid: Number(cur.cid) || 0,
          title: cur.name || '',
          duration: Number(cur.duration) || 0,
          pic: cur.picUrl || '',
          up: (cur.artists || '').replace(/^UP：/, ''),
        })
      } else {
        setVideo(null)
      }
      return
    }
    if (kindOf(cur) === 'video') {
      // 轮到视频：停掉音频（上一首可能是歌），把流装进视频元素
      if (audioEl) {
        audioEl.pause()
        audioEl.onended = null
      }
      playingId = key
      setLoading(false)
      setLrc([])
      setLrcIndex(-1)
      setPosition(0)
      setVideo({
        bvid: cur.bvid || '',
        cid: Number(cur.cid) || 0,
        title: cur.name || '',
        duration: Number(cur.duration) || 0,
        pic: cur.picUrl || '',
        up: (cur.artists || '').replace(/^UP：/, ''),
      })
      setVideoDuration(Number(cur.duration) || 0)
      setPlaying(autoPlay)
      if (videoKeyRef.current === key && videoEl && videoEl.src) {
        // 已经装着这条了（播放权刚翻回来）：元素停在原地，该放就接着放。
        // 进度要拨到浮窗刚才播到的位置 —— 两个窗口的元素各存各的，
        // 不拨的话用户看到的进度（心跳镜像）和实际要播的位置对不上
        const at = Math.floor(videoElapsedRef.current)
        if (!itemChanged && at > 0 && Math.abs((videoEl.currentTime || 0) - at) > 1.5) {
          try {
            videoEl.currentTime = at
          } catch {
            /* 拨不了就算了，别为一次 seek 抛异常 */
          }
        }
        if (autoPlay) videoEl.play().catch(() => {})
        return
      }
      // 不是这条：重新取流。位置用镜像来的那个（浮窗刚才播到哪，接着哪）
      loadVideo(cur, key, autoPlay, itemChanged ? 0 : Math.floor(videoElapsedRef.current))
      return
    }
    // 轮到歌：视频元素停掉
    setVideo(null)
    setVideoPlaying(false)
    if (videoEl) videoEl.pause()
    /**
     * 续播位置：**只有条目没换**才按镜像进度接（浮窗播到哪这边接到哪）；
     * 条目换了（观众点歌 / 播完推进）一律从头。
     *
     * 这里曾经写成 `audioKey === key ? 0 : positionRef.current` —— 方向正好反了：
     * audioKey !== key 恰恰是「要重新取链的新歌」，却拿 positionRef（上一首残留的
     * 进度）当起点，于是新歌从上一首播到的地方开始（用户看到「怎么从 2 分多开始放」）。
     * 视频分支一直是对的（itemChanged ? 0 : 镜像），歌这路漏了。
     */
    const resumeAt = itemChanged ? 0 : Math.floor(positionRef.current)
    playCurrent(cur, autoPlay, resumeAt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, state.current?.id, ownsPlayback, loadVideo, playCurrent])

  /* 音量随时可调，不用等重启 */
  React.useEffect(() => {
    if (audioEl) audioEl.volume = volumeRef.current
  }, [config?.music?.volume])

  /**
   * 视频的声音。写进配置是为了「滑条是滑条」—— 拖到哪就停在哪，关掉重开也一样，
   * 而不是每拖一下都靠一次 IPC 往返回显（那手感就是弹回去）。
   * 本地 state 立刻生效，落盘走主进程那条防抖。
   */
  const [videoVolume, setVideoVolumeState] = React.useState(videoVolumeCfg)
  const [videoMuted, setVideoMutedState] = React.useState(videoMutedCfg)

  /**
   * 视频的音量/静音直接落在原生元素上 —— 原生 video，碰得到了。
   *
   * **依赖必须是本地 state，不能是 config**：拖滑条走的是 `setVideoVolume`
   * → `api.config.patch`（直接 IPC），不经过 App 那份 config state ——
   * 等 config 回流的话这一下永远等不到，表现就是「滑条动得挺欢，视频音量纹丝不动」。
   */
  React.useEffect(() => {
    const el = videoEl
    if (!el) return
    el.volume = Math.min(1, Math.max(0, videoVolume))
    el.muted = videoMuted
  }, [videoVolume, videoMuted])

  /* 装载新一条流时也要按当前这两个值来（元素可能被换过 src） */
  React.useEffect(() => {
    videoVolumeRef.current = videoVolume
    videoMutedRef.current = videoMuted
  }, [videoVolume, videoMuted])

  React.useEffect(() => {
    setVideoVolumeState(videoVolumeCfg)
  }, [videoVolumeCfg])
  React.useEffect(() => {
    setVideoMutedState(videoMutedCfg)
  }, [videoMutedCfg])

  const setVideoVolume = React.useCallback((v: number) => {
    const n = Math.min(1, Math.max(0, Number(v)))
    if (!Number.isFinite(n)) return
    setVideoVolumeState(n)
    // 拖到有声音就把静音解开：滑条一动还不出声才是真的怪
    if (n > 0 && videoMutedRef.current) {
      setVideoMutedState(false)
      api.config.patch({ video: { volume: n, muted: false } }).catch(() => {})
      return
    }
    api.config.patch({ video: { volume: n } }).catch(() => {})
  }, [])

  const setVideoMuted = React.useCallback((v: boolean) => {
    setVideoMutedState(Boolean(v))
    api.config.patch({ video: { muted: Boolean(v) } }).catch(() => {})
  }, [])

  /** 歌的音量。也立刻落到元素上，别等配置回流（滑条要跟手） */
  const setMusicVolume = React.useCallback((v: number) => {
    const n = Math.min(1, Math.max(0, Number(v)))
    if (!Number.isFinite(n)) return
    volumeRef.current = n
    if (audioEl) audioEl.volume = n
    api.config.patch({ music: { volume: n } }).catch(() => {})
  }, [])

  /** 当前在播的是视频吗（video 非空 = 轮到 B 站视频了） */
  const onVideo = Boolean(video)
  const activeVolume = onVideo ? videoVolume : Number.isFinite(Number(config?.music?.volume)) ? Number(config?.music?.volume) : 0.6
  // 歌没有静音这一档（静音是给视频准备的），所以播歌时恒为 false
  const activeMuted = onVideo ? videoMuted : false
  const setActiveVolume = onVideo ? setVideoVolume : setMusicVolume
  const setActiveMuted = onVideo ? setVideoMuted : () => {}

  /**
   * 拖进度条：跳到第 n 秒。原生 seek —— 直接拨 currentTime，
   * 不再重建播放器、不再有「跳到同一处点了没反应」这回事。
   * 非拥有者把这一下转发给拥有者去做。
   */
  const videoSeekTo = React.useCallback((sec: number) => {
    const s = Math.max(0, Math.floor(Number(sec) || 0))
    if (!ownsPlaybackRef.current) {
      api.music.remote?.({ type: 'seek', sec: s })
      return
    }
    const el = videoEl
    if (!el || !el.src) return
    if (el.readyState === 0) {
      pendingSeekRef.current = s
    } else {
      try {
        el.currentTime = s
      } catch {
        pendingSeekRef.current = s
      }
    }
    setVideoElapsed(s)
  }, [])

  /** 把单例视频元素挂进容器。挪窝不打断播放 —— 元素一直是同一个节点 */
  const videoAttach = React.useCallback((host: HTMLElement | null) => {
    const el = getVideoElement()
    if (host) {
      if (el.parentElement !== host) host.appendChild(el)
    } else if (el.parentElement) {
      el.parentElement.removeChild(el)
    }
  }, [])

  /* 拥有者：把当前播放进度当心跳推出去（非拥有窗口的界面照这个动） */
  React.useEffect(() => {
    if (!ownsPlayback || !state.current) return
    const push = () => {
      const cur = state.current
      if (!cur) return
      if (kindOf(cur) === 'video') {
        const el = videoEl
        api.music.tickPush?.({
          // key 随心跳走：主进程存底后随快照下发，新窗口拿它核对
          //「这条心跳还属于当前条目吗」—— 不匹配就当没有，别拿旧进度续新条目
          key: keyOf(cur),
          pos: el?.currentTime || 0,
          dur: el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : Number(cur.duration) || 0,
          playing: Boolean(el && el.src && !el.paused),
        })
      } else {
        api.music.tickPush?.({
          key: keyOf(cur),
          pos: audioEl?.currentTime || 0,
          dur: audioEl && audioEl.duration ? audioEl.duration : 0,
          playing: Boolean(audioEl && !audioEl.paused),
        })
      }
    }
    push()
    const t = window.setInterval(push, 400)
    return () => window.clearInterval(t)
    // playing 也在依赖里：播停切换的下一拍就推一次，别让对面等 400ms
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownsPlayback, state.current?.id, playing])

  /* 非拥有者：镜像拥有者的心跳 —— 界面上的进度/播停照样是活的 */
  React.useEffect(() => {
    const off = api.music.onTick?.((t) => {
      if (ownsPlaybackRef.current) return
      setPlaying(Boolean(t.playing))
      setVideoPlaying(Boolean(t.playing))
      setPosition(Number(t.pos) || 0)
      setVideoElapsed(Number(t.pos) || 0)
      if (Number(t.dur) > 0) {
        setDuration(Number(t.dur))
        setVideoDuration(Number(t.dur))
      }
    })
    return () => off?.()
  }, [])

  const toggle = React.useCallback(() => {
    // 不是出声的窗口：转发给拥有者去做（两边的 UI 是同一套，键也是同一套）
    if (!ownsPlaybackRef.current) {
      api.music.remote?.({ type: 'toggle' })
      return
    }
    if (video) {
      const el = videoEl
      if (!el || !el.src) {
        // 流还没装上（正在取地址，或者上次取失败了）：再取一次
        if (state.current && kindOf(state.current) === 'video') {
          loadVideo(state.current, keyOf(state.current), true)
        }
        return
      }
      if (el.paused) {
        el.play()
          .then(() => setPlaying(true))
          .catch((e: any) => notifyRef.current(describeAudioFailure(el, e), true))
      } else {
        el.pause()
        setPlaying(false)
      }
      return
    }
    const el = audioEl
    if (!el || !el.src) {
      // 还没有播放器实例（比如从没播过，或上一首失败）：直接让主进程推进一格
      if (!state.current) api.music.play()
      else playCurrent(state.current, true)
      return
    }
    if (el.paused) {
      el.play()
        .then(() => setPlaying(true))
        .catch((e: any) => notifyRef.current(describeAudioFailure(el, e), true))
    } else {
      el.pause()
      setPlaying(false)
    }
  }, [loadVideo, playCurrent, state.current, video])

  const stop = React.useCallback(() => {
    if (video) {
      videoEl?.pause()
      setVideoPlaying(false)
      setPlaying(false)
      return
    }
    if (!audioEl) return
    audioEl.pause()
    setPlaying(false)
  }, [video])

  /* 非拥有者的播放/暂停键转发到这里来执行（只有拥有者理它） */
  const toggleRef = React.useRef(toggle)
  toggleRef.current = toggle
  const videoSeekToRef = React.useRef(videoSeekTo)
  videoSeekToRef.current = videoSeekTo
  React.useEffect(() => {
    const off = api.music.onRemote?.((cmd) => {
      if (!ownsPlaybackRef.current || !cmd) return
      if (cmd.type === 'toggle') toggleRef.current()
      if (cmd.type === 'seek') videoSeekToRef.current(Number(cmd.sec) || 0)
    })
    return () => off?.()
  }, [])

  /**
   * 清晰度被改了：主进程喊一嗓子，这里丢掉本地缓存的流（旧流是上一个清晰度的）
   * 重新取一条，并把进度拨回原处 —— 换清晰度不该把视频弹回开头。
   */
  React.useEffect(() => {
    const off = api.music.onReload?.(() => {
      const cur = stateRef.current?.current
      if (!cur || kindOf(cur) !== 'video') return
      const el = getVideoElement()
      const at = Number.isFinite(Number(el?.currentTime)) ? Number(el.currentTime) : videoElapsedRef.current
      const wasPlaying = Boolean(el?.src) && !el.paused
      streamCache.delete(`${cur.bvid || ''}:${Number(cur.cid) || 0}`)
      // 只有真正出声的那个窗口继续放；镜像窗口换好流停在那儿，等心跳来带
      loadVideo(cur, keyOf(cur), ownsPlaybackRef.current && wasPlaying, Math.floor(Number(at) || 0))
    })
    return () => off?.()
  }, [loadVideo])

  /* 歌词：换歌时取一次。视频没有歌词，别拿 cid 去问网易云 */
  React.useEffect(() => {
    const id = state.current?.id
    let alive = true
    if (kindOf(state.current) === 'video') {
      setLrc([])
      setLrcFor(id || 0)
      return
    }
    // 先作废：这一帧起，手上那份歌词不再代表任何人。
    // 放在这里而不是等新词到手，是因为「取回来」比「换歌」晚 —— 中间这段空窗
    // 正好是串歌最容易发生的时候。
    setLrcFor(0)
    if (!id) {
      setLrc([])
      return
    }
    api.music
      .lyric(id)
      .then((r) => {
        if (!alive) return
        setLrc(r.lrc || [])
        setLrcFor(id)
      })
      .catch(() => {
        if (!alive) return
        // 这首确实没有词（或是取失败了）。标记照样落到它身上，
        // 免得后面把「一直没拿到」当成「还没轮到它」而反复重试
        setLrc([])
        setLrcFor(id)
      })
    return () => {
      alive = false
    }
  }, [state.current?.id])

  /* 跟着播放进度高亮歌词 */
  React.useEffect(() => {
    if (!lrc.length) {
      setLrcIndex(-1)
      return
    }
    let idx = -1
    for (let i = 0; i < lrc.length; i++) {
      if (lrc[i].time <= position) idx = i
      else break
    }
    setLrcIndex(idx)
  }, [position, lrc])

  /**
   * 「当前这首歌的歌词」。对不上就当作没有 —— 换歌那一拍 lrc 还是上一首的，
   * 而点歌页会直接拿 lrc 往屏幕上画，OBS 那边也要照着报行号。
   * 两边都只认这一份，串歌才没有缝隙可钻。
   */
  // 视频没有歌词，按「没有在播的歌」上报 —— 否则 OBS 那条歌词带会一直挂着上一首的最后一句
  const curSongId = kindOf(state.current) === 'video' ? 0 : state.current?.id || 0
  const liveLrc = lrcFor === curSongId ? lrc : EMPTY_LRC
  const liveLrcIndex = lrcFor === curSongId ? lrcIndex : -1

  /* 把歌词同步给主进程，由它广播到 OBS 叠加层。
     只在「换歌 / 歌词到手 / 当前行变化 / 播放状态变化」时发，一首歌也就几十次，
     不按帧上报 —— 那样只是白白把一堆 IPC 扔过桥。
     整份歌词只在换歌时带一次，之后只发行号，主进程那边留着副本自己翻。 */
  // 已经把整份歌词交出去的那首歌的 id —— 只在真的发出去之后才更新，
  // 否则「换歌 → 歌词还没到手」那次空跑会把标记吃掉，歌词取回来就再也不补发了
  const sentLinesRef = React.useRef(0)
  React.useEffect(() => {
    const songId = curSongId
    if (!songId) {
      sentLinesRef.current = 0
      api.music.lyricSync({ songId: 0, index: -1, playing: false }).catch(() => {})
      return
    }
    // liveLrc 是空的，说明这首的词还没到手（或者它本来就没词）——
    // 那就只报「这句还没到」。宁可台上空几秒，也不能把上一首的词挂到它名下。
    const needLines = liveLrc.length > 0 && sentLinesRef.current !== songId
    api.music
      .lyricSync({
        songId,
        index: liveLrcIndex,
        playing,
        ...(needLines ? { lines: liveLrc } : {}),
      })
      .catch(() => {})
    if (needLines) sentLinesRef.current = songId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curSongId, liveLrc, liveLrcIndex, playing])

  const value: MusicPlayerValue = {
    state,
    ready,
    playing,
    position,
    duration,
    loading,
    lrc: liveLrc,
    lrcIndex: liveLrcIndex,
    toggle,
    stop,
    video,
    videoPlaying,
    videoElapsed,
    videoDuration,
    videoBuffering,
    videoReady,
    videoError,
    videoElsewhere: !ownsPlayback,
    videoAttach,
    videoVolume,
    videoMuted,
    setVideoVolume,
    setVideoMuted,
    activeVolume,
    activeMuted,
    setActiveVolume,
    setActiveMuted,
    videoSeekTo,
  }

  return <MusicPlayerContext.Provider value={value}>{children}</MusicPlayerContext.Provider>
}
