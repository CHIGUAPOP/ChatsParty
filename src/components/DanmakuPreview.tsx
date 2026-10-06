import React from 'react'

/**
 * 弹幕可以堆在四个角。选哪一侧，头像就跟着挪到哪一侧、文字也往哪一侧对齐，
 * 所以选项里把「头像在左/右」一并写出来，省得选完才发现方向不对。
 * 取值与 store 默认值、overlay/index.html 的 DANMAKU_POS 三处必须一致。
 */
export const DANMAKU_POS = [
  { value: 'tl', label: '左上 · 头像在左' },
  { value: 'tr', label: '右上 · 头像在右' },
  { value: 'bl', label: '左下 · 头像在左' },
  { value: 'br', label: '右下 · 头像在右' },
]

export function normalizeDanmakuPos(v: unknown): string {
  return typeof v === 'string' && DANMAKU_POS.some((p) => p.value === v) ? v : 'br'
}

/*
 * 三条示例，顺序刻意按「旧 → 新」排列，与真实叠加层里 appendChild 的顺序一致：
 * DOM 末尾那条就是最新到的。底下 CSS 会用 column / column-reverse 决定它显示在
 * 最上面还是最下面，因此这里只要照着时间顺序写死即可，不用自己算正反。
 */
const DEMO = [
  { name: '夜阑', text: '这条是最早到的，会被后来的挤走', medal: null, latest: false },
  { name: '路过的鱼', text: '前排围观，主播加油', medal: '小电视 · 21', latest: false },
  { name: '喵星人', text: '最新一条，紧贴你选的那个角', medal: null, latest: true },
]

export default function DanmakuPreview({ pos }: { pos?: unknown }) {
  const p = normalizeDanmakuPos(pos)
  return (
    <div className="dm-preview" data-pos={p}>
      {DEMO.map((it, i) => (
        <div className={`dm-preview__item${it.latest ? ' is-latest' : ''}`} key={i}>
          <div className="dm-preview__face" />
          <div className="dm-preview__body">
            <div className="dm-preview__head">
              <span className="dm-preview__name">{it.name}</span>
              {it.medal && <span className="dm-preview__medal">{it.medal}</span>}
            </div>
            <div className="dm-preview__text">{it.text}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
