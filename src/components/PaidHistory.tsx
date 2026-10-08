import React from 'react'
import { LiveEvent } from '../lib/api'
import { Chip, Icon, UserAvatar } from './ui'

/** 付费类事件。这三类都会带 price，是同一批「给过钱的」 */
const PAID: LiveEvent['type'][] = ['gift', 'superchat', 'guard']

/** 最多留多少条。超了从头砍 —— 这场直播刚开始的那几十块不值得一直占着内存 */
const MAX_ROWS = 100

/**
 * 礼物 / 付费留言历史。
 *
 * 数据不用另外要接口：这些事件本来就在弹幕流里，主进程一直往这边推，
 * 这里只是把它们从 `events` 里挑出来、倒序摆好。
 *
 * 放在弹幕页右侧而不是塞进弹幕列表里，是因为这几件事的节奏完全不同 ——
 * 弹幕一秒能刷十条，付费事件一分钟才一条，混在一起那条 ¥30 的醒目留言
 * 转眼就被刷走了，主播根本来不及看。
 */
export default function PaidHistory({ events, actions }: { events: LiveEvent[]; actions?: React.ReactNode }) {
  const rows = React.useMemo(
    () => events.filter((e) => PAID.indexOf(e.type) >= 0).slice(-MAX_ROWS).reverse(),
    [events],
  )

  const total = React.useMemo(
    () => rows.reduce((sum, e) => sum + (Number(e.price) || 0), 0),
    [rows],
  )

  return (
    <section className="side-card side-card--paid">
      <header className="side-card__head">
        <Icon name="gift" size={16} />
        <span>礼物 · 付费留言</span>
        {rows.length > 0 && <span className="side-card__badge">{rows.length}</span>}
        <span className="side-card__spacer" />
        {total > 0 && <span className="side-card__meta">≈ ¥{total}</span>}
        {actions}
      </header>

      <div className="side-card__body">
        {rows.length === 0 ? (
          <div className="side-card__empty">这一场还没有人投喂或发醒目留言</div>
        ) : (
          <div className="plist">
            {rows.map((e, i) => (
              <div className="plist__row" key={e.id || `${e.uid}-${e.timestamp}-${i}`}>
                <UserAvatar src={e.face} name={e.username} size={24} uid={e.uid} />
                <div className="plist__main">
                  <div className="plist__head">
                    <span className="plist__name">{e.username || '匿名用户'}</span>
                    {e.type === 'superchat' && <Chip variant="sc">醒目留言</Chip>}
                    {e.type === 'guard' && <Chip variant="guard">上舰</Chip>}
                    {e.price ? <Chip variant="gift">¥{e.price}</Chip> : null}
                  </div>
                  <div className="plist__text">{e.content}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
