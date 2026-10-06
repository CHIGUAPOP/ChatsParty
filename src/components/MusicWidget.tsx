import React from 'react'
import { MusicQueueItem, MusicState } from '../lib/api'

/**
 * OBS 画面里的「正在播放 + 点歌队列」。
 *
 * 这里的 class 名和结构**必须和 overlay/index.html 里的保持逐字一致** ——
 * 弹幕页上的预览用的是同一套 CSS，两边一旦走样，主播调好的样式在 OBS 里就是另一个样。
 * 改动时请同时改这两个文件（scripts/smoke.cjs 有一道断言盯着类名不漂）。
 */

export const MUSIC_POS = [
  { value: 'tl', label: '左上' },
  { value: 'tr', label: '右上' },
  { value: 'bl', label: '左下' },
  { value: 'br', label: '右下' },
]

/** 队列里最多显示几条。0 = 完全不显示队列 */
export function widgetQueueCount(n: unknown, fallback = 3) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return fallback
  return Math.min(Math.floor(v), 10)
}

export default function MusicWidget({
  state,
  queueCount = 3,
  pos = 'tl',
}: {
  state: MusicState
  queueCount?: number
  pos?: string
}) {
  const cur = state?.current || null
  const items = (state?.items || []).slice(0, widgetQueueCount(queueCount))
  if (!cur && items.length === 0) return null

  return (
    <div className="cp-music" data-pos={pos}>
      {cur && (
        <div className="cp-mcard">
          <div className="cp-mcover">
            {cur.picUrl ? <img src={cur.picUrl} alt="" /> : <span className="cp-mcover__none">♪</span>}
          </div>
          <div className="cp-mbody">
            <div className="cp-mlabel">正在播放</div>
            <div className="cp-mtitle">{cur.name || '未命名'}</div>
            <div className="cp-msub">
              {[cur.artists, cur.requester ? `${cur.requester} 点的` : ''].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="cp-mqueue">
          <div className="cp-mlabel cp-mqueue__head">待播 {state?.queued ?? items.length} 首</div>
          {items.map((it, i) => (
            <QueueRow key={`${it.id}-${it.at}-${i}`} item={it} index={i + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

function QueueRow({ item, index }: { item: MusicQueueItem; index: number }) {
  return (
    <div className="cp-mrow">
      <span className="cp-mrow__no">{index}</span>
      <span className="cp-mrow__name">{item.name || '未命名'}</span>
      <span className="cp-mrow__who">{item.requester || ''}</span>
    </div>
  )
}
