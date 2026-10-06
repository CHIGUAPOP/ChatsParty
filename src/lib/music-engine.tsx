import React from 'react'
import { api, AppConfig, MusicQueueItem, MusicState } from './api'

/**
 * 音乐播放引擎。
 *
 * 以前这段逻辑写在 MusicPage 里，结果是：切到别的页面 -> MusicPage 卸载 ->
 * 订阅 `music:state` 的监听器被摘掉、播放当前曲目的 effect 也没了。
 * 表现就是「一首歌放完就停」，必须切回点歌页它才想起来该放下一首。
 *
 * 现在放到 App 层常驻：不管你在哪个页面，播放器都在跑，队列也照常推进。
 * MusicPage 退化成遥控器 —— 只负责读状态和发指令。
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
}

/** 浏览器抛的音频错误是英文加错误码，主播看不懂也做不了什么。翻成「哪儿错了 + 现在怎么办」。 */
function describeAudioFailure(el: HTMLAudioElement | null, e?: any): string {
  const code = el?.error?.code
  if (code === 1) return '播放被中断了'
  if (code === 2) return '网络断了，这首歌没下载完 —— 重新点一次'
  if (code === 3) return '这个音频文件解不开 —— 换一版试试'
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
let playingId = 0

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
  const notifyRef = React.useRef(notify)
  notifyRef.current = notify

  const bindAudio = React.useCallback((el: HTMLAudioElement) => {
    el.onloadedmetadata = () => setDuration(el.duration || 0)
    el.ontimeupdate = () => setPosition(el.currentTime || 0)
    el.onerror = () => {
      setPlaying(false)
      // 播放中途断流也走这里；统一由它负责提示 + 跳下一首
      notifyRef.current(describeAudioFailure(el), true)
      playingId = 0
      api.music.next()
    }
    el.onended = () => {
      setPlaying(false)
      playingId = 0
      api.music.next()
    }
  }, [])

  /* 订阅队列状态。这里常驻，所以切页面不会漏掉任何一次推进 */
  React.useEffect(() => {
    let alive = true
    api.music
      .state()
      .then((s) => {
        if (!alive) return
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

  /** 取链接并播放当前这首 */
  const playCurrent = React.useCallback(
    async (item: MusicQueueItem) => {
      if (!item) return
      if (playingId === item.id && audioEl) {
        // 已经在播这首了（比如只是页面重建），别重复取链
        return
      }
      playingId = item.id
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
        el.volume = volumeRef.current
        bindAudio(el)
        await el.play()
        setPlaying(true)
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

  // 当前曲目变了就播它；队列空了就停
  React.useEffect(() => {
    if (!ready) return
    const cur = state.current
    if (!cur) {
      if (audioEl) {
        audioEl.pause()
        audioEl.onended = null
      }
      playingId = 0
      setPlaying(false)
      return
    }
    playCurrent(cur)
    // playCurrent 里已经用 playingId 挡住了「同一首重复取链」，
    // 所以手动暂停之后不会因为重复渲染又开始放。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, state.current?.id])

  /* 音量随时可调，不用等重启 */
  React.useEffect(() => {
    if (audioEl) audioEl.volume = volumeRef.current
  }, [config?.music?.volume])

  /* 歌词：换歌时取一次 */
  React.useEffect(() => {
    const id = state.current?.id
    let alive = true
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
  const curSongId = state.current?.id || 0
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

  const toggle = React.useCallback(() => {
    const el = audioEl
    if (!el || !el.src) {
      // 还没有播放器实例（比如从没播过，或上一首失败）：直接让主进程推进一格
      if (!state.current) api.music.play()
      else playCurrent(state.current)
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
  }, [playCurrent, state.current])

  const stop = React.useCallback(() => {
    if (!audioEl) return
    audioEl.pause()
    setPlaying(false)
  }, [])

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
  }

  return <MusicPlayerContext.Provider value={value}>{children}</MusicPlayerContext.Provider>
}
