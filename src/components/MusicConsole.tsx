import React from 'react'
import { api } from '../lib/api'
import { Button, Icon, Slider } from './ui'
import { useMusicPlayer } from '../lib/music-engine'

function fmt(sec: number) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 简单音乐控制台。
 *
 * 「简单」是刻意的：完整的搜索、点歌、整张队列都在「点歌」页，
 * 而这一块是**在弹幕页顺手能按到**的那几个键 —— 暂停 / 下一首 / 清空 / 音量。
 * 主播大多数时候人在弹幕页，为了切一首歌专门跳走再跳回来，很打断节奏。
 *
 * 播放器本体不在这里（在 src/lib/music-engine.tsx 里常驻），
 * 所以这块只是遥控器：怎么切页面都不会影响正在放的那首。
 */
export default function MusicConsole({
  volume,
  onVolume,
  actions,
}: {
  volume: number
  onVolume: (v: number) => void
  /** 桌面浮窗的设置/× 两颗按钮：排在这个头部最右（主窗口不传） */
  actions?: React.ReactNode
}) {
  const { state, playing, position, duration, loading, toggle } = useMusicPlayer()
  const cur = state.current
  // 只预告「下一首」，不预告两首：右侧栏高度是抢来的 —— 多摆一条歌名，
  // 观众榜就少一行。队列看全了去「点歌」页。
  const upcoming = state.items.slice(0, 1)

  return (
    <section className="side-card side-card--console">
      <header className="side-card__head">
        <Icon name="music" size={16} />
        <span>音乐控制台</span>
        {state.queued > 0 && <span className="side-card__badge">待播 {state.queued}</span>}
        {actions}
      </header>

      <div className="side-card__body">
        <div className="mconsole__now">
          <div className="mconsole__cover">
            {cur?.picUrl ? <img src={cur.picUrl} alt="" /> : <Icon name="music" size={22} />}
          </div>
          <div className="mconsole__main">
            <div className="mconsole__title" title={cur?.name}>
              {cur ? cur.name : '没有在播的歌'}
            </div>
            <div className="mconsole__sub" title={cur?.artists}>
              {cur ? cur.artists : '等观众在弹幕里点，或去「点歌」页搜'}
            </div>
          </div>
        </div>

        <div className="mconsole__time">
          <span>{cur ? fmt(position) : '0:00'}</span>
          <span>{loading ? '取播放地址…' : cur ? cur.durationText || fmt(duration) : '0:00'}</span>
        </div>

        <div className="mconsole__ctrl">
          <Button variant="filled" small onClick={toggle} icon={playing ? 'stop' : 'play'} disabled={!cur}>
            {playing ? '暂停' : '播放'}
          </Button>
          <Button variant="outlined" small onClick={() => api.music.next()} icon="skip" disabled={!cur && state.items.length === 0}>
            下一首
          </Button>
          <Button
            variant="text"
            small
            onClick={() => api.music.clear()}
            icon="delete"
            disabled={state.items.length === 0}
          >
            清空
          </Button>
        </div>

        <div className="mconsole__vol">
          <Icon name="voice" size={16} />
          <div style={{ flex: 1 }}>
            <Slider value={volume} min={0} max={1} step={0.05} onChange={onVolume} />
          </div>
        </div>

        {upcoming.length > 0 && (
          <div className="mconsole__queue">
            {upcoming.map((it, i) => (
              <div className="mconsole__qrow" key={`${it.id}-${it.at}`}>
                <span className="mconsole__qno">{i + 1}</span>
                <span className="mconsole__qname">{it.name}</span>
                <span className="mconsole__qmeta">{it.requester ? `${it.requester}点的` : it.artists}</span>
              </div>
            ))}
            {state.queued > upcoming.length && (
              <div className="mconsole__more">还有 {state.queued - upcoming.length} 首，去「点歌」页看全部</div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
