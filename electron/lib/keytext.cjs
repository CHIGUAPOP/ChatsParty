'use strict'

/**
 * API Key 的清洗与指纹。
 *
 * 为什么单独拎出来：从网页 / 文档里复制密钥，最容易一起带上这些看不见的东西 ——
 *   · 结尾空行、换行、制表符（粘进表单后肉眼完全看不出来）
 *   · 不换行空格 U+00A0、全角空格 U+3000（长得像空格，trim 又只处理半角）
 *   · 零宽字符 U+200B~U+200D、BOM U+FEFF（不可见，纯肉眼排查不可能）
 *   · 顺手抄下来的 `Authorization: Bearer ` 前缀、成对引号
 * 只要混进一个，平台就回 401 Invalid Token，而界面里显示得一模一样。
 *
 * 所以：入库前清洗一遍，报错时给指纹而不是给密钥原文。
 */

// 零宽 / BOM：直接删掉
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g
// 各种「假空格」：统一成普通空格，交给后面的 trim 处理
const WIDE_SPACE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g
// 控制字符：塞进 HTTP 头会被内核拒绝
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g
// 首尾的引号（含反引号、全角引号）与空白
const QUOTES_EDGE = /^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g

/**
 * 把用户粘进来的密钥洗成可以直接塞进请求头的形态。
 * 只做「清理噪音」，不改动密钥本身的有效字符。
 */
function normalizeKey(raw) {
  let s = String(raw == null ? '' : raw)
  s = s.replace(ZERO_WIDTH, '').replace(WIDE_SPACE, ' ').replace(CONTROL, '')
  // 整段粘贴 `Authorization: Bearer xxx` 的情况
  s = s.replace(/^\s*authorization\s*:\s*/i, '')
  s = s.replace(/^\s*bearer\s+/i, '')
  return s.replace(QUOTES_EDGE, '')
}

/**
 * 给密钥生成一个可以安全打在日志 / 界面里的指纹。
 * 永不返回完整密钥。
 * @returns {{len:number, fp:string, empty:boolean}}
 */
function describeKey(raw) {
  const s = normalizeKey(raw)
  if (!s) return { len: 0, fp: '（空）', empty: true }
  // 太短的密钥不打头尾，否则等于把整把放出来
  const fp = s.length <= 10 ? `${s.slice(0, 1)}***` : `${s.slice(0, 4)}…${s.slice(-4)}`
  return { len: s.length, fp, empty: false }
}

/** 界面上显示用的一行摘要，例如「长度 32 · ab12…9f3c」 */
function keySummary(raw) {
  const d = describeKey(raw)
  return d.empty ? '未填写' : `长度 ${d.len} · ${d.fp}`
}

/**
 * 密钥里有没有明显不对劲的地方（清洗前），用来当面提示用户，
 * 而不是让他自己去猜为什么 401。
 * @returns {string[]}
 */
function keyWarnings(raw) {
  const original = String(raw == null ? '' : raw)
  const out = []
  if (!original) return out
  // 注意：带 g 的正则 test 会带 lastIndex，这里一律用不带 g 的副本
  if (/[\u200B-\u200D\u2060\uFEFF]/.test(original)) out.push('含有零宽字符（不可见）')
  if (/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/.test(original)) out.push('含有全角/不换行空格')
  if (/[\u0000-\u001F\u007F-\u009F]/.test(original)) out.push('含有换行或控制字符')
  if (/^\s*authorization\s*:/i.test(original)) out.push('含有 Authorization: 前缀')
  if (/^\s*bearer\s+/i.test(original)) out.push('含有 Bearer 前缀')
  if (/^[\s"'`“”‘’]|[\s"'`“”‘’]$/.test(original)) out.push('首尾带引号或多个空白')
  return out
}

/**
 * 各平台官方密钥的「正常长度」。**留空 = 不定长，只做通用体检。**
 *
 * 这里踩过一次坑，记下来：曾经照着第三方文章把 Fish 定成 32 位，
 * 结果把一把 64 位的好 Key 报成「粘了两把」。后来拿真 Key 实测才清楚 ——
 * fish.audio 与 fishaudio.org 发的密钥长度都不一样（见过 51 / 64 位），两种都合法。
 * 官方从没公开过定长，所以：**没有实测证据就不要在这里写数字**。
 */
const KEY_LEN = {}

/**
 * 密钥「形状」对不对（长度层面）。和 keyWarnings 的分工：
 * keyWarnings 管字符脏不脏，这里管长度像不像。
 * @param {string} raw
 * @param {string} platform 平台 id（fish / openai / llm）
 * @returns {string[]}
 */
function keyShapeWarnings(raw, platform) {
  const s = normalizeKey(raw)
  if (!s) return []
  const expect = KEY_LEN[platform]
  const out = []
  if (!expect) {
    // 没有官方定长的平台，只拦一眼就能看出的离谱情况
    if (s.length < 16) out.push(`长度只有 ${s.length} 位，通常是没复制全`)
    return out
  }
  if (s.length === expect) return out
  if (s.length % expect === 0 && s.length > expect) {
    out.push(
      `长度 ${s.length} 位，正好是官方长度（${expect} 位）的 ${s.length / expect} 倍 —— ` +
        `很像复制时把 ${s.length / expect} 把 Key 粘在了一起`,
    )
  } else if (s.length < expect) {
    out.push(`长度 ${s.length} 位，短于官方的 ${expect} 位，多半是复制少了一段`)
  } else {
    out.push(`长度 ${s.length} 位，官方生成的是 ${expect} 位，形态对不上`)
  }
  return out
}

module.exports = { normalizeKey, describeKey, keySummary, keyWarnings, keyShapeWarnings, KEY_LEN }
