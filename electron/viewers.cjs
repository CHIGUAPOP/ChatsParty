'use strict'

/**
 * 在线观众（B站「高能榜」+「在线用户」）的纯逻辑：分页合并、去重、排序、刷新节奏。
 *
 * 这里有两份名单，别搞混：
 * 1. **高能榜**（`getOnlineGoldRank`）：当前在线、且**有过互动**（发弹幕 / 投喂 /
 *    点赞）的人，按贡献值排行。**匿名就能调**，号没登录也能用。
 * 2. **在线用户**（`getOnlineRank`）：人在房间里就算，**没有贡献值**。
 *    网页端「房间观众」里排名栏显示「-」、贡献值 0 的那批人就是他们。
 *    **这个接口要登录态**，未登录返回 -101。
 *
 * 合起来才等于网页端看到的那份「房间观众」。但仍然**不等于观看人数** ——
 * 挂着不动的纯潜水观众两边都不出现，所以界面上必须写清楚。
 *
 * 这个模块不 require electron，smoke 可以直接测。
 */

/** 一页最多回 50 条 —— 传 1000 也只回 50，别在这上面浪费参数 */
const RANK_PAGE_SIZE = 50
/**
 * 连翻两页就够。实测第三页起就是空的，多数房间连第二页都到不满；
 * 再往后翻只是白挨风控。
 */
const RANK_PAGES = 2
const MAX_ITEMS = RANK_PAGE_SIZE * RANK_PAGES

/** 舰长等级 -> 名字。0 表示没有大航海 */
const GUARD_NAMES = ['', '总督', '提督', '舰长']

/**
 * 刷新间隔的上下限。
 * 下限 10 秒：这个接口有风控（-352），B站自己页面上也是十几秒才刷一次。
 * 上限 10 分钟：再长就不叫「在线观众」了，只是个历史快照。
 */
const MIN_INTERVAL_MS = 10 * 1000
const MAX_INTERVAL_MS = 10 * 60 * 1000
const DEFAULT_INTERVAL_MS = 20 * 1000

function clampInterval(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(n)))
}

function guardName(level) {
  const n = Number(level) || 0
  return GUARD_NAMES[n] || ''
}

/** 一条榜单记录 -> 界面要的那几个字段。没有 uid 的没法去重、也没法显示，直接扔掉 */
function normalizeRankItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const uid = Number(raw.uid) || 0
  if (!uid) return null
  const m = raw.medalInfo
  const medal = m && m.medalName ? { name: String(m.medalName), level: Number(m.level) || 0 } : null
  return {
    uid,
    name: String(raw.name || '').trim() || '匿名用户',
    face: String(raw.face || ''),
    score: Number(raw.score) || 0,
    guardLevel: Number(raw.guard_level) || 0,
    guard: guardName(raw.guard_level),
    wealthLevel: Number(raw.wealth_level) || 0,
    medal,
    onRank: true,
  }
}

/**
 * 「在线用户」接口（getOnlineRank）的一条记录。
 *
 * 和上面的区别：**这些人没有贡献值**，只是「人在房间里」。B站就是这么给的 ——
 * 只有 uid / name / face，没有 score、没有粉丝牌、没有大航海。
 * 网页端「房间观众」里那些排在最下面、排名那一栏显示「-」、贡献值 0 的，
 * 就是这批人。
 */
function normalizeOnlineItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const uid = Number(raw.uid) || 0
  if (!uid) return null
  const m = raw.medalInfo
  const medal = m && m.medalName ? { name: String(m.medalName), level: Number(m.level) || 0 } : null
  return {
    uid,
    name: String(raw.name || raw.uname || '').trim() || '匿名用户',
    face: String(raw.face || ''),
    score: 0,
    guardLevel: Number(raw.guard_level) || 0,
    guard: guardName(raw.guard_level),
    wealthLevel: 0,
    medal,
    onRank: false,
  }
}

/**
 * 从「在线用户」响应里把那份名单挑出来。
 *
 * 不写死键名：这个接口的数组键在 B站 的各个版本里叫过不同的名字，
 * 而它旁边的 onlineNum / ownInfo 都是对象，**唯一一个「装着带 uid 的对象的数组」**
 * 就是名单本身。以后 B站 改名字这里也不会瞎掉。
 */
function pickOnlineList(data) {
  if (!data || typeof data !== 'object') return []
  if (Array.isArray(data.OnlineRankItem)) return data.OnlineRankItem
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.some((it) => it && typeof it === 'object' && Number(it.uid) > 0)) return v
  }
  return []
}

/** 「在线用户」响应 -> { onlineNum, items } */
function mergeOnlineRank(response, limit = MAX_ITEMS) {
  const d = response && response.data ? response.data : response
  if (!d || typeof d !== 'object') return { onlineNum: 0, items: [] }
  const byUid = new Map()
  for (const raw of pickOnlineList(d)) {
    const norm = normalizeOnlineItem(raw)
    if (norm) byUid.set(norm.uid, norm)
  }
  const cap = Math.max(1, Number(limit) || MAX_ITEMS)
  return { onlineNum: Number(d.onlineNum) || 0, items: [...byUid.values()].slice(0, cap) }
}

/**
 * 把「高能榜」和「在线用户」并成一份给界面看的列表。
 *
 * 榜上的人在前（按贡献值降序），只在「在线用户」里出现的人接在后面 ——
 * 和网页端「房间观众」的排法一致：有排名的显示排名和贡献值，
 * 没上榜的排名那栏是「-」、贡献值 0。
 *
 * 同一个人两份都在时只留榜上那条：榜上那条有贡献值和粉丝牌，
 * 是信息更多的那个版本。
 */
function combineViewers(goldItems, onlineItems, limit = MAX_ITEMS) {
  const cap = Math.max(1, Number(limit) || MAX_ITEMS)
  const seen = new Set()
  const out = []
  for (const it of Array.isArray(goldItems) ? goldItems : []) {
    if (!it || seen.has(it.uid)) continue
    seen.add(it.uid)
    out.push(it)
  }
  for (const it of Array.isArray(onlineItems) ? onlineItems : []) {
    if (!it || seen.has(it.uid)) continue
    seen.add(it.uid)
    out.push(it)
  }
  return out.slice(0, cap)
}

/**
 * 把若干页响应并成一份名单。
 *
 * 榜单是实时在变的，翻页之间会有人升有人降 —— 同一个人可能同时出现在两页里，
 * 所以按 uid 去重，留贡献值高的那一条（重复出现通常说明两次之间他又互动了）。
 *
 * onlineNum 取各页里最大的那个：它是「当前在线人数」，翻页期间只小幅波动，
 * 取最大既更接近真实值，也避免最后一页恰好拿到 0（房间刚开播时页与页之间会跳）。
 */
function mergeRankPages(responses, limit = MAX_ITEMS) {
  let onlineNum = 0
  const byUid = new Map()
  for (const raw of Array.isArray(responses) ? responses : []) {
    const d = raw && raw.data ? raw.data : raw
    if (!d || typeof d !== 'object') continue
    const n = Number(d.onlineNum)
    if (Number.isFinite(n) && n > onlineNum) onlineNum = n
    const list = Array.isArray(d.OnlineRankItem) ? d.OnlineRankItem : []
    for (const item of list) {
      const norm = normalizeRankItem(item)
      if (!norm) continue
      const prev = byUid.get(norm.uid)
      if (!prev || norm.score > prev.score) byUid.set(norm.uid, norm)
    }
  }
  const items = [...byUid.values()].sort((a, b) => b.score - a.score)
  const cap = Math.max(1, Number(limit) || MAX_ITEMS)
  return { onlineNum, items: items.slice(0, cap) }
}

/**
 * 把接口的 code 翻成人话。
 *
 * -352 是这套接口最常见的坑：间隔调太短、或者短时间反复手点刷新就会撞上，
 * 表现得像是「功能坏了」，其实等一两分钟就好 —— 文案里必须说清楚这一点，
 * 否则用户只会一遍遍地点刷新，把风控拖得更长。
 */
function translateRankError(code, message) {
  switch (Number(code)) {
    case -352:
      return '被 B 站风控拦了（-352），把刷新间隔调大些、等一两分钟再试'
    case -412:
      return '请求被拦截（-412），稍后再试'
    case -101:
      return '登录状态失效了，重新扫码登录一下'
    case -400:
      return `请求参数有问题：${message || ''}`
    default:
      return message || `高能榜获取失败（code ${code}）`
  }
}

module.exports = {
  RANK_PAGE_SIZE,
  RANK_PAGES,
  MAX_ITEMS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  GUARD_NAMES,
  clampInterval,
  guardName,
  normalizeRankItem,
  normalizeOnlineItem,
  pickOnlineList,
  mergeRankPages,
  mergeOnlineRank,
  combineViewers,
  translateRankError,
}
