'use strict'

/**
 * 播报文案的规则。纯逻辑，不依赖 electron，`scripts/smoke.cjs` 能直接 require 来测。
 *
 * `shouldSpeakNow` 是播报前最后一道复核：
 * 播报规则是在「入队那一刻」求值的，但队列最多能堆 24 条。主播中途关掉播报
 * 或临时加了个屏蔽词，如果出队时不再复核一遍，已经排队的那些还会一条条念完 ——
 * 界面上开关明明已经关了，声音却还在响。
 *
 * `speakableName` 决定播报里怎么称呼这个人（B站默认昵称不念数字）。
 */

/** 手动试听不受「启用语音播报」开关限制，否则关掉播报就再也没法试听了 */
const MANUAL_TYPES = new Set(['manual', 'test', 'voice-test'])

/**
 * 没改过昵称的 B 站账号长这样：`bili_3706983133743519`。
 *
 * 念出来是一长串数字 —— 观众听不出这是谁，主播也记不住，纯粹在浪费播报时间。
 * 前缀来回就那几种（网页注册给的是 `bili_`，早期还有 `用户_` / `哔哩哔哩`），
 * 后面跟的是一串 uid 数字。纯数字的名字（`3706983133743519`）同理，也念不出所以然。
 */
const DEFAULT_NAME_RE = /^(?:bili|bilibili|哔哩哔哩|哔哩|用户|b站)[\s_\-.]*\d{4,}$/i
const DIGITS_ONLY_RE = /^\d{6,}$/

/** 没配自定义念法时用这个 */
const DEFAULT_NAME_TEXT = '一个b站用户'

/**
 * 播报里怎么称呼这个人。
 *
 * @param {string} raw 弹幕事件里的用户名
 * @param {{renameDefaultUser?:boolean, defaultUserName?:string}} [tts] 最新的 tts 配置
 * @returns {string} 可以直接念的名字（没改动的原样返回）
 */
function speakableName(raw, tts) {
  const t = tts || {}
  const name = String(raw == null ? '' : raw).trim()
  if (!name) return ''
  if (t.renameDefaultUser === false) return name
  if (!DEFAULT_NAME_RE.test(name) && !DIGITS_ONLY_RE.test(name)) return name
  const alias = String(t.defaultUserName == null ? '' : t.defaultUserName).trim()
  return alias || DEFAULT_NAME_TEXT
}

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

module.exports = {
  shouldSpeakNow,
  speakableName,
  MANUAL_TYPES,
  DEFAULT_NAME_RE,
  DEFAULT_NAME_TEXT,
}
