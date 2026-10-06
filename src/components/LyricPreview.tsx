import React from 'react'

/**
 * 歌词位置选项。歌词默认贴底居中，像字幕；也允许摆到四个角。
 * 弹幕只能选四角（它要往一侧堆），歌词是横向居中的一段话，所以多了上下居中。
 */
export const LYRIC_POS = [
  { value: 'bc', label: '底部居中' },
  { value: 'tc', label: '顶部居中' },
  { value: 'tl', label: '左上' },
  { value: 'tr', label: '右上' },
  { value: 'bl', label: '左下' },
  { value: 'br', label: '右下' },
]

export const LYRIC_LINE_OPTIONS = [1, 2, 3, 4].map((n) => ({
  value: String(n),
  label: n === 1 ? '只显示当前句' : `${n} 行`,
}))

const SAMPLE = ['这是一句正在唱的歌词', '下一句提前露出来给你看', '再往后的一句']

/**
 * 歌词位置预览。
 * 和弹幕预览一个套路：DOM 结构和 class 名照抄 overlay/index.html，
 * 所以这里什么样 OBS 里就什么样。
 * 注意预览**不套用整体缩放** —— 预览台比 1920×1080 小得多，真按比例放进来
 * 200% 时会直接溢出；它只负责表现位置与对齐。
 */
export default function LyricPreview({ pos, lines = 2 }: { pos?: string; lines?: number }) {
  const total = Math.min(Math.max(Number(lines) || 1, 1), SAMPLE.length)
  return (
    <div className="lyric-stage">
      <div className="cp-lyric is-show" data-pos={pos || 'bc'}>
        {SAMPLE.slice(0, total).map((t, i) => (
          <div key={i} className={`cp-lyric__line${i === 0 ? ' is-cur' : ''}`}>
            {t}
          </div>
        ))}
      </div>
    </div>
  )
}
