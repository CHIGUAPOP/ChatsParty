import React from 'react'
import { api, ViewersState } from '../lib/api'
import { Icon, UserAvatar } from './ui'

const EMPTY: ViewersState = {
  ok: false,
  roomId: 0,
  anchorUid: 0,
  onlineNum: 0,
  items: [],
  updatedAt: 0,
  error: '',
  onlineError: '',
  fetching: false,
}

/** 「多久没更新了」比一个绝对时间戳有用 —— 后者还要自己做减法 */
function ageText(s: ViewersState, now: number) {
  if (s.fetching) return '拉取中…'
  if (!s.updatedAt) return ''
  const sec = Math.max(0, Math.round((now - s.updatedAt) / 1000))
  if (sec < 5) return '刚刚更新'
  if (sec < 60) return `${sec} 秒前更新`
  return `${Math.round(sec / 60)} 分钟前更新`
}

/**
 * 「当前观众」—— B站的**高能榜 + 在线用户**两份名单并起来。
 *
 * 名字必须写准。这两份名单加起来才等于网页端「房间观众」里看到的那一列：
 * - **高能榜**（在线且有过互动：发弹幕 / 投喂 / 点赞），有贡献值、有名次。
 * - **在线用户**（人在房间里就算），没有贡献值，排名栏显示「-」。
 *
 * 但**仍然不等于观看人数**：挂着一直不动的纯潜水观众两边都不出现。
 * 卡片底下那行说明不能省 —— 不然主播会把「只有 80 人」当成直播间真的只有 80 个人看。
 *
 * 名单由主进程轮询（间隔在「OBS」页能调）。这里只是显示器，**没有手动刷新按钮**：
 * 右上角那条位置留给「弹出为浮窗」的白横杠，再放一个刷新钮两个会叠在一起。
 * 在桌面浮窗里，浮窗的设置/× 两颗按钮会通过 `actions` 排在头部最右。
 *
 * **「更新于多久之前」这一行是必须的**：拉取失败时主进程会保留上一份名单
 * （清空会让画面闪一下变空，更难用），于是一份卡住的旧数据和一个本来就安静的
 * 直播间在屏幕上长得一模一样。没有时间戳和失败提示，用户只能得出
 * 「这功能坏了 / 有互动也不更新」的结论 —— 这正是它被报回来的原因。
 */
export default function ViewersList({ actions }: { actions?: React.ReactNode }) {
  const [s, setS] = React.useState<ViewersState>(EMPTY)
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    api.viewers.state().then(setS)
    return api.viewers.onState(setS)
  }, [])

  // 只是为了让「多少秒前」自己走字。5 秒一跳足够，不必每秒重渲染这一栏
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  const age = ageText(s, now)

  return (
    <section className="side-card side-card--viewers">
      <header className="side-card__head">
        <Icon name="users" size={16} />
        <span>当前观众</span>
        {s.onlineNum > 0 && <span className="side-card__badge">{s.onlineNum} 人在线</span>}
        <span className="side-card__spacer" />
        {age && <span className="side-card__meta">{age}</span>}
        {actions}
      </header>

      {/* 拉失败时名单还留着，所以必须明说「这是旧的」——
          不然一份卡住的旧榜单和一个安静的直播间看起来完全一样 */}
      {s.error && <div className="side-card__warn">没更新上：{s.error}</div>}

      {/* 「在线用户」那一路单独挂了（多半是没登录）。榜上的人还在，
          但这栏会少一批「人在房间、只是没说话」的 —— 不说出来，
          用户会以为那批人真的不在。 */}
      {!s.error && s.onlineError && (
        <div className="side-card__note">在线名单没拿到（{s.onlineError}），现在只列榜上有互动的人</div>
      )}

      <div className="side-card__body">
        {s.items.length === 0 ? (
          <div className="side-card__empty">
            {s.fetching
              ? '正在拉取…'
              : s.error || (s.roomId ? '榜上暂时没人 — 观众进房间、发弹幕、投喂之后就会出现在这里' : '先到「连接」页连上直播间')}
          </div>
        ) : (
          <div className="vlist">
            {s.items.map((v, i) => (
              <div className="vlist__row" key={v.uid}>
                {/* 不在榜上的人没有名次 —— 这里必须画「-」而不是行号，
                    否则「第 7 名 0 贡献」看起来像是他真排第七 */}
                <span className={`vlist__no${v.onRank ? '' : ' is-dim'}`}>{v.onRank ? i + 1 : '-'}</span>
                <UserAvatar src={v.face} name={v.name} size={30} uid={v.uid} />
                <span className="vlist__name" title={v.name}>{v.name}</span>
                {v.guard ? (
                  <span className={`vlist__tag is-g${v.guardLevel}`}>{v.guard}</span>
                ) : v.medal?.name ? (
                  <span className="vlist__tag">
                    {v.medal.name} {v.medal.level}
                  </span>
                ) : null}
                {v.onRank && <span className="vlist__score">{v.score}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="side-card__foot">
        <div>在线的人和榜上的人并在一起，但仍不等于观看人数</div>
        {/* 这句是给「我刚发了弹幕怎么没上榜」准备的。B站那边的榜本身就有延迟，
            不写出来，用户只会认为功能坏了 */}
        <div>刚互动的人要过一会儿才上榜</div>
      </footer>
    </section>
  )
}
