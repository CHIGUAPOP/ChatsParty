import React from 'react'

/**
 * 音色选择面板的位置选项。
 * 这是个列表，摆到横向居中的位置会跟弹幕抢地方，所以只给四个角。
 */
export const PICK_POS = [
  { value: 'tr', label: '右上' },
  { value: 'tl', label: '左上' },
  { value: 'br', label: '右下' },
  { value: 'bl', label: '左下' },
]

export const PICK_HIT_OPTIONS = [2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `${n} 条` }))

/** 编的样例数据，故意把「已注册 / 已停用 / 已选中」三种状态都摆上 */
const SAMPLE = [
  { name: '萨雷娅', meta: 'fish · 中文/御姐', tag: '已注册', off: false },
  { name: '御姐音', meta: 'edge · 中文 (zh-CN)', tag: '', off: false },
  { name: '温柔姐姐', meta: 'mimo · 中文/温柔', tag: '', off: false },
  { name: '电台女声', meta: 'fish · 中文/旁白', tag: '已停用', off: true },
  { name: '软软', meta: 'system · 中文', tag: '', off: false },
  { name: '御姐·低音', meta: 'fish · 中文/低音', tag: '', off: false },
]

/**
 * 音色选择面板预览。
 * 和歌词预览一个套路：DOM 结构与 class 名照抄 overlay/index.html，
 * 所以这里什么样 OBS 里就什么样。**不套用整体缩放** —— 预览台小得多，
 * 真按比例放进来 200% 会直接溢出；它只负责表现位置、序号、标记这些。
 */
export default function VoicePickPreview({ pos, hits = 4 }: { pos?: string; hits?: number }) {
  const count = Math.min(Math.max(Number(hits) || 4, 1), SAMPLE.length)
  const picked = 2
  return (
    <div className="pick-stage">
      <div className="cp-pick is-show" data-pos={pos || 'tr'}>
        <div className="cp-pick__card">
          <div className="cp-pick__head">
            <span className="cp-pick__who">小明 在选音色</span>
            <span className="cp-pick__kw">「御姐」</span>
          </div>
          {SAMPLE.slice(0, count).map((h, i) => {
            const n = i + 1
            return (
              <div
                key={h.name}
                className={`cp-pick__row${n === picked ? ' is-picked' : ''}${h.off ? ' is-off' : ''}`}
              >
                <span className="cp-pick__no">{n}</span>
                <span className="cp-pick__name">{h.name}</span>
                <span className="cp-pick__meta">{h.meta}</span>
                {h.tag ? <span className={`cp-pick__tag${h.off ? ' is-off' : ''}`}>{h.tag}</span> : null}
                {n === picked ? <span className="cp-pick__ok">✓ 已绑定</span> : null}
              </div>
            )
          })}
          <div className="cp-pick__wait">后面还有 1 位在等</div>
          <div className="cp-pick__bar">
            <div className="cp-pick__bar-fill" style={{ animation: 'none', width: '62%' }} />
          </div>
        </div>
      </div>
    </div>
  )
}
