'use strict'
/**
 * 表情图册：把弹幕里的「[表情名]」换成图片。
 *
 * 为什么需要它 —— 弹幕包里的 `meta.emots` 只在**发送端带了表情数据**时才出现，
 * 而且不同来源的下发键名并不统一：收藏集（`pkg_type=3`）给的 `emoji` 自带方括号
 * （`[dog]`），通用表情给的没有（`啊`）。只认 `emots[名字]` 这一种写法，
 * 双方一旦对不上，整条弹幕就退回成纯文字 —— 表现就是「表情包显示成了文字」。
 *
 * 所以这里维护一份「名字 → 图片」的全量图册，两个来源合并：
 *   1. 直播间表情面板（通用 / 粉丝团 / 收藏集 / 装扮表情）—— 弹幕里用的就是这些
 *   2. 评论表情面板（小黄脸、收藏的表情包）—— 补上直播间面板拿不到的包
 *
 * 名字一律剥掉方括号再做键，查的时候两边都归一，格式差异就吃掉了。
 * 图册只存在内存里：拿不到就空着（发不出去弹幕图，但绝不影响弹幕本身）。
 */

// 直播间表情面板。**要登录**，游客返回 -101
const LIVE_PANEL = 'https://api.live.bilibili.com/xlive/web-ucenter/v2/emoticon/GetEmoticons'
// 评论表情面板。同样是登录态接口
const REPLY_PANEL = 'https://api.bilibili.com/x/emote/user/panel/web'

/** 表情名最长多少字。`[春卷饭10周年表情包_再见吧]` 已经有 14 个字，别掐太紧 */
const MAX_NAME = 24

/** 图册多久重新拉一次。表情包极少变，拉太勤只是白白撞风控 */
const TTL_MS = 30 * 60 * 1000

/** 拉失败之后多久再试（别每来一条弹幕就撞一次） */
const RETRY_MS = 60 * 1000

/**
 * 名字归一：`[dog]` 和 `dog` 是同一个表情，统一成不带方括号的重名。
 * 首尾空白一并去掉 —— 有些包下发的 `descript` 带尾空格。
 */
function normName(raw) {
  const s = String(raw == null ? '' : raw).trim()
  const m = /^\[([^\]]{1,24})\]$/.exec(s)
  return (m ? m[1] : s).trim()
}

/** B 站图床认 Referer：第三方站点带 Referer 会 403。统一升 https，渲染端还要 no-referrer */
function normUrl(raw) {
  const u = String(raw || '').trim()
  if (!u) return ''
  return u.replace(/^http:\/\//, 'https://')
}

function entryOf(url, width, height) {
  const src = normUrl(url)
  if (!src) return null
  return { url: src, w: Number(width) || 0, h: Number(height) || 0 }
}

/**
 * 直播面板 → [[名字, {url,w,h}], ...]
 * 包结构：`data.data[].emoticons[]`，条目字段是 `emoji`（名字）/`url`/`width`/`height`
 */
function parseLivePanel(res) {
  const out = []
  const pkgs = (res && res.data && res.data.data) || []
  for (const p of pkgs) {
    for (const e of p.emoticons || []) {
      const name = normName(e.emoji || e.descript)
      const item = entryOf(e.url, e.width, e.height)
      if (name && item) out.push([name, item])
    }
  }
  return out
}

/**
 * 评论面板 → [[名字, {url,w,h}], ...]
 * 包结构：`data.packages[].emote[]`，条目字段是 `text`（`[doge_金箍]`）/`url`
 * `meta.alias` 是「金箍」这种短名，有的人就按短名发，一并收进来
 */
function parseReplyPanel(res) {
  const out = []
  const pkgs = (res && res.data && res.data.packages) || []
  for (const p of pkgs) {
    for (const e of p.emote || []) {
      const item = entryOf(e.url)
      if (!item) continue
      const name = normName(e.text)
      if (name) out.push([name, item])
      const alias = normName(e.meta && e.meta.alias)
      if (alias && alias !== name) out.push([alias, item])
    }
  }
  return out
}

/**
 * 合并成一张表。
 *
 * 顺序即优先级：**后合并的覆盖先合并的**。直播间表情放最后 ——
 * 弹幕里出现的 `[dog]` 优先解释成直播那只，评论面板只负责补漏。
 *
 * 键同时留一份小写形式（`Doge` / `doge` 这种大小写差异不值得我们再维护一张表）。
 */
function mergeBook(lists) {
  const book = {}
  for (const list of lists) {
    for (const [name, item] of list) {
      book[name] = item
      const low = name.toLowerCase()
      if (low !== name) book[low] = item
    }
  }
  return book
}

class EmoticonBook {
  constructor({ getSession, log } = {}) {
    this.getSession = getSession || (() => null)
    this.log = log || null
    this.book = {}
    this.at = 0
    this.roomId = 0
    this.pending = null
    /**
     * 取 JSON 的实现。默认走会话（带 Cookie / wbi / buvid），
     * 测试里可以整个换掉 —— 两个面板都要登录态，e2e 的临时 userData 永远没登录。
     */
    this.fetchJson = null
    /** 图册换代时调（主进程接上去推给界面和叠加层） */
    this.onChange = null
  }

  get() {
    return this.book
  }

  get size() {
    return Object.keys(this.book).length
  }

  /**
   * 拉一遍图册。
   *
   * @param {number} roomId 真实房间号（0 表示还不知道，只拉评论面板）
   * @param {{force?: boolean}} opts
   * @returns {Promise<boolean>} 图册是否真的变了
   */
  async refresh(roomId, { force = false } = {}) {
    if (this.pending) return this.pending
    const now = Date.now()
    const room = Number(roomId) || 0
    // 换房间必须重拉：收藏集/粉丝团表情是按房间给的，沿用上一家的图册会画错图
    const roomChanged = room !== this.roomId
    if (!force && !roomChanged && now - this.at < TTL_MS) return false
    const session = this.getSession()
    const getJSON = this.fetchJson || (session ? (url) => session.getJSON(url) : null)
    if (!getJSON) return false

    this.pending = (async () => {
      const lists = []
      let failed = 0
      // 评论面板先合（优先级低），直播间表情后合（覆盖同名）
      try {
        const reply = await getJSON(`${REPLY_PANEL}?business=reply`)
        if (reply && reply.code === 0) lists.push(parseReplyPanel(reply))
        else failed++
      } catch {
        failed++
      }
      if (roomId) {
        try {
          const live = await getJSON(`${LIVE_PANEL}?platform=pc&room_id=${roomId}`)
          if (live && live.code === 0) lists.push(parseLivePanel(live))
          else failed++
        } catch {
          failed++
        }
      }

      const next = mergeBook(lists)
      const before = JSON.stringify(this.book)
      const after = JSON.stringify(next)
      // 一个都没拿到（没登录 / 网络不通）：保持旧图册，一分钟后再试
      if (!Object.keys(next).length) {
        this.at = Date.now() - TTL_MS + RETRY_MS
        if (failed && this.log) this.log.warn('[emoticon] 表情图册拉取失败（不影响弹幕）')
        return false
      }
      this.book = next
      this.at = Date.now()
      this.roomId = room
      if (before === after) return false
      if (this.log) this.log.info('[emoticon] 表情图册已更新', { count: this.size, roomId: roomId || 0 })
      try {
        this.onChange?.(this.book)
      } catch {
        /* 推给界面失败不该影响图册本身 */
      }
      return true
    })()

    try {
      return await this.pending
    } finally {
      this.pending = null
    }
  }

  /** 只清空内存（退出登录 / 切账号时用） */
  reset() {
    this.book = {}
    this.at = 0
    this.roomId = 0
  }
}

module.exports = {
  LIVE_PANEL,
  REPLY_PANEL,
  MAX_NAME,
  TTL_MS,
  RETRY_MS,
  normName,
  normUrl,
  parseLivePanel,
  parseReplyPanel,
  mergeBook,
  EmoticonBook,
}
