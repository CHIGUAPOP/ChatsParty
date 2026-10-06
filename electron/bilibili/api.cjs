'use strict'
const { Session, CookieJar } = require('../lib/http.cjs')

const API = {
  nav: 'https://api.bilibili.com/x/web-interface/nav',
  spi: 'https://api.bilibili.com/x/frontend/finger/spi',
  roomInfo: 'https://api.live.bilibili.com/room/v1/Room/get_info',
  danmuInfo: 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo',
  sendMsg: 'https://api.live.bilibili.com/msg/send',
  userCard: 'https://api.bilibili.com/x/web-interface/card',
}

class BilibiliAPI {
  constructor(wbi, session) {
    this.wbi = wbi
    this.session = session || new Session()
    this.buvidChecked = false
    // 补查失败的回调（给日志用）。不直接 throw 是为了不影响调用方的事件分发
    this.onFaceMiss = null
  }

  /** 未登录状态下 B 站不下发 buvid3，wbi 签名会失败，这里主动补一个设备指纹 */
  async ensureBuvid() {
    if (this.buvidChecked) return
    this.buvidChecked = true
    const has = this.session.jar.get('buvid3')
    if (has) return
    try {
      const res = await this.session.getJSON(API.spi)
      const b3 = res?.data?.b_3
      const b4 = res?.data?.b_4
      if (b3) {
        this.session.jar.set(`buvid3=${b3}; Domain=.bilibili.com; Path=/; Max-Age=31536000`)
        if (b4) this.session.jar.set(`buvid4=${b4}; Domain=.bilibili.com; Path=/; Max-Age=31536000`)
      }
    } catch {
      /* 拿不到就用游客模式继续，弹幕接口对 buvid3 的要求并非总是强制 */
    }
  }

  async getRoomInfo(roomId) {
    await this.ensureBuvid()
    const url = await this.wbi.url(API.roomInfo, { room_id: roomId })
    const res = await this.session.getJSON(url)
    if (res.code !== 0) throw new Error(`房间信息获取失败：${res.message || res.code}`)
    return res.data
  }

  async getDanmuInfo(roomId) {
    await this.ensureBuvid()
    const url = await this.wbi.url(API.danmuInfo, { id: roomId, type: 0 })
    const res = await this.session.getJSON(url)
    if (res.code !== 0) throw new Error(`弹幕服务器信息获取失败：${res.message || res.code}`)
    const d = res.data || {}
    const host = (d.host_list || [])[0]
    if (!host || !d.token) throw new Error('弹幕服务器信息不完整，请检查房间号')
    const nodes = (d.host_list || [])
      .map((h) => `wss://${h.host}:${h.wss_port || 443}/sub`)
      .filter((_, i) => i < 3)
    return { token: d.token, hosts: nodes.length ? nodes : [`wss://${host.host}:${host.wss_port || 443}/sub`] }
  }

  /**
   * 发送弹幕。开放平台没有发送能力，只能走这个 web 接口。
   * 必须带 SESSDATA + bili_jct，roomid 必须是真实房间号。
   */
  async sendDanmaku({ roomId, message, color = 16777215, fontSize = 25, mode = 1 }) {
    const csrf = this.session.jar.get('bili_jct')
    if (!csrf) throw new Error('未登录，无法发送弹幕（缺少 bili_jct）')
    const body = new URLSearchParams({
      bubble: '0',
      msg: message,
      color: String(color),
      mode: String(mode),
      room_type: '0',
      jumpfrom: '0',
      fontsize: String(fontSize),
      rnd: String(Math.floor(Date.now() / 1000)),
      roomid: String(roomId),
      csrf,
      csrf_token: csrf,
    })
    const res = await this.session.getJSON(API.sendMsg, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Referer: `https://live.bilibili.com/${roomId}`,
      },
    })
    if (res.code !== 0) {
      const msg = res.message || res.msg || String(res.code)
      throw new Error(translateSendError(res.code, msg))
    }
    return res.data
  }

  /** 头像兜底查询：DANMU_MSG 不带头像时用 uid 补一次，带缓存防止被风控 */
  async getUserFace(mid) {
    if (!mid) return ''
    if (this.faceCache.has(mid)) return this.faceCache.get(mid)
    try {
      const url = await this.wbi.url(API.userCard, { mid, photo: 'false' })
      const res = await this.session.getJSON(url)
      const face = res?.data?.card?.face || ''
      // 失败也记进缓存，避免同一个失败的 uid 反复打接口把 IP 打进风控
      this.faceCache.set(mid, face)
      if (!face) this.onFaceMiss?.(mid, `card 没返回头像 code=${res?.code} ${res?.message || ''}`)
      return face
    } catch (e) {
      this.faceCache.set(mid, '')
      this.onFaceMiss?.(mid, e.message || String(e))
      return ''
    }
  }

  /**
   * 昵称查询。只有一个用途：连接房间时补主播名。
   * 因为 room/v1/Room/get_info **不返回 anchor_info**（实测这个字段根本不存在），
   * 只有 uid 可用，名字得回card 接口拿。
   * 失败只返回空串 —— 顶栏少一行字，不该影响连接本身。
   */
  async getUserName(mid) {
    if (!mid) return ''
    if (this.nameCache.has(mid)) return this.nameCache.get(mid)
    try {
      const url = await this.wbi.url(API.userCard, { mid, photo: 'false' })
      const res = await this.session.getJSON(url)
      const name = res?.data?.card?.name || ''
      this.nameCache.set(mid, name)
      return name
    } catch {
      return ''
    }
  }
}

BilibiliAPI.prototype.faceCache = new Map()
BilibiliAPI.prototype.nameCache = new Map()

function translateSendError(code, msg) {
  switch (code) {
    case -101:
      return '登录已失效，请重新扫码登录'
    case -111:
      return 'csrf 校验失败，请重新扫码登录'
    case -400:
      return `请求被拒绝：${msg}`
    case -403:
      return '账号被限制发言或不在该直播间'
    case 11000:
      return '弹幕内容不合法，可能被屏蔽词命中'
    case 11001:
      return '发送过于频繁，请稍后再试'
    case 11002:
      return '该房间已开启禁言'
    default:
      return msg || `发送失败（code ${code}）`
  }
}

module.exports = { BilibiliAPI, CookieJar, Session, API }
