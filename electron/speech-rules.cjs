'use strict'

/**
 * 播报前最后一道复核。
 *
 * 播报规则是在「入队那一刻」求值的，但队列最多能堆 24 条。主播中途关掉播报
 * 或临时加了个屏蔽词，如果出队时不再复核一遍，已经排队的那些还会一条条念完 ——
 * 界面上开关明明已经关了，声音却还在响。
 */

/** 手动试听不受「启用语音播报」开关限制，否则关掉播报就再也没法试听了 */
const MANUAL_TYPES = new Set(['manual', 'test', 'voice-test'])

/**
 * @param {{text?:string, meta?:{type?:string}}} item 队列里的条目
 * @param {{enabled?:boolean, blockWords?:string}} tts 最新的 tts 配置
 * @returns {{drop:boolean, reason?:string}}
 */
function shouldSpeakNow(item, tts) {
  const t = tts || {}
  const text = String(item?.text || '')
  if (MANUAL_TYPES.has(item?.meta?.type)) return { drop: false }

  if (!t.enabled) return { drop: true, reason: '播报已关闭' }

  const words = String(t.blockWords || '')
    .split(/[,，\s]+/)
    .map((w) => w.trim())
    .filter(Boolean)
  const hit = words.find((w) => text.includes(w))
  if (hit) return { drop: true, reason: `命中屏蔽词「${hit}」` }

  return { drop: false }
}

module.exports = { shouldSpeakNow, MANUAL_TYPES }
