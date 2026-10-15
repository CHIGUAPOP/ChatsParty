import React from 'react'
import { api } from '../lib/api'
import { Icon, SliderFit } from './ui'

function fmt(sec: number) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p2 = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p2(mm)}:${p2(ss)}` : `${mm}:${p2(ss)}`
}

/**
 * B 站视频画面（原生 <video> 方案）。
 *
 * 画面和声音是**同一个元素**：引擎（music-engine.tsx）持有一个模块级单例
 * <video>，直接播 platform=html5 取来的整条 mp4（音视频混流）。
 * currentTime / pause / volume / ended 全是原生的 —— 暂停就是暂停、进度条就是
 * 真 seek、播完 onended 推队列。以前「卸播放器记进度」「按总时长自己数」
 * 「画面静音 + 另一路音频出声」这些绕弯子全部不需要了。
 *
 * 这个组件只做两件事：
 *  1. 开一块 16:9 的场地，把单例元素 `videoAttach` 进来 —— 元素是同一个节点，
 *     挪窝不打断播放，所以页面随便切、播放不中断；
 *  2. 画控件（播停 / 时间 / 进度 / 音量 / 下一个）。
 *
 * **画面框永远 16:9**（styles.css，栽过两次的铁律）：视频本身是 16:9，
 * 容器拉成别的形状就会大片黑/白 —— 别再改 aspect-ratio。
 *
 * `elsewhere`（画面在音乐浮窗里）：音乐浮窗开着时，出声的是浮窗那个窗口，
 * 这边只摆占位；控件照常画 —— 播停/进度会转发给浮窗去执行（见引擎），
 * 音量走配置两个窗口共用。
 */
export default function VideoStage({
  bvid,
  pic,
  playing,
  elapsed,
  duration,
  buffering = false,
  ready = false,
  error = '',
  elsewhere = false,
  volume = 0.8,
  muted = false,
  onVolume,
  onMuted,
  onToggle,
  onNext,
  onSeek,
  videoAttach,
  bare = false,
}: {
  /** BV 号（给「在浏览器里打开」那个出口用） */
  bvid?: string
  pic?: string
  /** 视频元素是否在响（引擎从原生事件里拿的） */
  playing: boolean
  elapsed: number
  duration: number
  buffering?: boolean
  /** 已解出至少一帧画面：海报只垫到这一刻，别盖住暂停时的冻结帧 */
  ready?: boolean
  error?: string
  elsewhere?: boolean
  /** 音量 0~1（直接落在原生元素上） */
  volume?: number
  muted?: boolean
  onVolume?: (v: number) => void
  onMuted?: (v: boolean) => void
  onToggle: () => void
  onNext: () => void
  onSeek: (sec: number) => void
  /** 引擎给的挂载函数：把单例 <video> 挂进这块场地 */
  videoAttach?: (host: HTMLElement | null) => void
  /**
   * 纯播放器形态：只留画面 + 控件（浮窗和弹幕功能区那两处用这个）。
   * 不显示标题、UP 主、下面的说明文字 —— 那几行是给「点歌页」这种全信息
   * 场景看的，摆在浮窗里既占地方又和画面重复。
   */
  bare?: boolean
}) {
  const hostRef = React.useRef<HTMLDivElement>(null)
  // 挂载 / 卸载时把单例元素接进来 / 摘下来。摘下来元素还活着（只是没挂树上），
  // 声音照出 —— 这是「切页面不断播」的根。
  React.useEffect(() => {
    const host = hostRef.current
    if (!host || elsewhere) {
      videoAttach?.(null)
      return
    }
    videoAttach?.(host)
    return () => videoAttach?.(null)
  }, [videoAttach, elsewhere])

  const pct = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0
  /**
   * 点进度条：跳到点了的那个位置。原生 seek —— 直接拨 currentTime，
   * 不再重建播放器，「跳到当前位置附近点了没反应」这种事不存在了。
   */
  const jump = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return
    const r = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    onSeek(ratio * duration)
  }

  const volPct = Math.round(Math.min(1, Math.max(0, Number(volume))) * 100)
  const setVol = (v: number) => {
    if (v > 0 && muted) onMuted?.(false)
    onVolume?.(v)
  }

  return (
    <div className={`vstage${bare ? ' vstage--bare' : ''}`}>
      <div className="vstage__frame" onClick={elsewhere ? undefined : onToggle}>
        {/*
          视频元素的宿主。引擎把单例 <video> append 进来；流没到手之前它是黑的，
          下面那层海报垫着 —— 解出第一帧（ready）就撤，别盖住暂停时的冻结帧。
        */}
        <div className="vstage__videohost" ref={hostRef} />

        {elsewhere ? (
          <div className="vstage__elsewhere">
            {pic ? <img src={pic} alt="" /> : null}
            <span className="vstage__elsewheretag">画面在音乐浮窗里</span>
          </div>
        ) : (
          !ready && (
            <div className="vstage__poster" aria-hidden>
              {pic ? <img src={pic} alt="" /> : null}
              <span className="vstage__posterplay">
                <Icon name="play" size={22} />
              </span>
            </div>
          )
        )}

        {/*
          「缓冲中…」/ 出错提示。**只能贴底窄条，不许铺满** —— 这里以前放过一块
          不透明底板把画面整个盖住，就是「有声音没画面」那次事故的元凶。
        */}
        {(buffering || error) && !elsewhere && (
          <div className="vstage__fail" role="status">
            <span>{error || '缓冲中…'}</span>
          </div>
        )}

        {/* 控件：鼠标移到画面上才浮出来。点控件不许触发「点画面暂停」 */}
        <div className="vstage__ctrl" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="vstage__btn"
            onClick={onToggle}
            title={playing ? '暂停' : '播放'}
            aria-label={playing ? '暂停' : '播放'}
          >
            <Icon name={playing ? 'stop' : 'play'} size={18} />
          </button>

          <span className="vstage__time">
            {fmt(elapsed)} / {fmt(duration)}
          </span>

          <div
            className="vstage__bar"
            onClick={jump}
            title="点一下跳到这里"
            role="slider"
            aria-label="播放进度"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(elapsed)}
            tabIndex={0}
          >
            <span className="vstage__barfill" style={{ width: `${pct}%` }} />
          </div>

          <div className="vstage__vol" title={`音量 ${muted ? 0 : volPct}%`}>
            <button
              type="button"
              className="vstage__btn vstage__btn--tiny"
              onClick={() => onMuted?.(!muted)}
              title={muted ? '取消静音' : '静音'}
              aria-label={muted ? '取消静音' : '静音'}
            >
              <Icon name={muted || volPct === 0 ? 'volMute' : 'vol'} size={18} />
            </button>
            <SliderFit
              value={muted ? 0 : Math.min(1, Math.max(0, Number(volume)))}
              min={0}
              max={1}
              step={0.05}
              onChange={setVol}
              title="音量（拖动调整）"
              ariaLabel="音量"
            />
          </div>

          <button type="button" className="vstage__btn" onClick={onNext} title="下一个" aria-label="下一个">
            <Icon name="skip" size={18} />
          </button>
          {/*
            「在浏览器里打开」只在要看全信息的地方摆着（点歌页）。
            纯播放器形态下用户点名只要「控制器 + 关闭」，这颗不是播放控制，收起来。
          */}
          {!bare && (
            <button
              type="button"
              className="vstage__btn"
              onClick={() => api.app.openExternal(`https://www.bilibili.com/video/${bvid || ''}`).catch(() => {})}
              title="在浏览器里打开这个视频"
              aria-label="在浏览器里打开"
            >
              <Icon name="link" size={18} />
            </button>
          )}
        </div>
      </div>
      {/* 说明那行只在「要看全信息」的地方出现（点歌页）；浮窗里纯播放器，不留字 */}
      {!bare && (
        <div className="vstage__hint">
          {elsewhere
            ? '音乐浮窗开着，画面和声音都在那边 —— 键照常能用，会转给浮窗执行'
            : '点画面暂停 / 继续；这条视频播完会自动播队列里的下一个'}
        </div>
      )}
    </div>
  )
}
