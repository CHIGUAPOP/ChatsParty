import React from 'react'

/**
 * 在线观众（高能榜）面板的位置选项。
 * 和音色面板一样是个列表，摆到横向居中的位置会跟弹幕抢地方，所以只给四个角。
 */
export const VIEWERS_POS = [
  { value: 'bl', label: '左下' },
  { value: 'br', label: '右下' },
  { value: 'tl', label: '左上' },
  { value: 'tr', label: '右上' },
]

export const VIEWERS_COUNT_OPTIONS = [3, 5, 8, 10, 15, 20].map((n) => ({ value: String(n), label: `${n} 人` }))

/** 编的样例。故意把大航海三档和粉丝牌都摆上，好看出标签长什么样 */
const SAMPLE = [
  { name: 'Flame-エクレール', score: 13017, guard: '', guardLevel: 0, medal: '囚人 21' },
  { name: '不想上班的鱼', score: 8420, guard: '舰长', guardLevel: 3, medal: '' },
  { name: '熬夜冠军', score: 5310, guard: '', guardLevel: 0, medal: '老观众 12' },
  { name: '柠檬气泡水', score: 2870, guard: '提督', guardLevel: 2, medal: '' },
  { name: '路过的猫', score: 640, guard: '', guardLevel: 0, medal: '' },
]

/**
 * 在线观众面板预览。
 * 和歌词、音色预览一个套路：DOM 结构与 class 名照抄 overlay/index.html，
 * 所以这里什么顺序、什么配色，OBS 里就是什么样。**不套整体缩放**。
 *
 * 头像是占位首字母，不是真头像 —— 预览台里没必要为了像去拉一遍图床。
 */
export default function ViewersPreview({ pos, count = 5 }: { pos?: string; count?: number }) {
  const n = Math.min(Math.max(Number(count) || 5, 1), SAMPLE.length)
  return (
    <div className="viewers-stage">
      <div className="cp-viewers is-show" data-pos={pos || 'bl'}>
        <div className="cp-viewers__card">
          <div className="cp-viewers__head">
            <span>高能榜</span>
            <span className="cp-viewers__num">954 人在线</span>
          </div>
          {SAMPLE.slice(0, n).map((v, i) => (
            <div className="cp-vrow" key={v.name}>
              <span className="cp-vrow__no">{i + 1}</span>
              <span className="cp-vrow__face">{v.name.slice(0, 1)}</span>
              <span className="cp-vrow__name">{v.name}</span>
              {v.guard ? (
                <span className={`cp-vrow__guard is-g${v.guardLevel}`}>{v.guard}</span>
              ) : v.medal ? (
                <span className="cp-vrow__guard">{v.medal}</span>
              ) : null}
              <span className="cp-vrow__score">{v.score}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
