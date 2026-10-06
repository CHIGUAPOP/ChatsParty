'use strict'
const { Session } = require('../lib/http.cjs')
const QRCode = require('qrcode')

const GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'

const STATUS = {
  0: 'success',
  86038: 'expired',
  86090: 'scanned',
  86101: 'waiting',
}

/**
 * 扫码登录：生成二维码 → 轮询 → 成功后把 SESSDATA/bili_jct/DedeUserID 收进 Cookie Jar。
 * 用户只需要用手机 B站 App 扫一下，不需要手动复制任何 Cookie。
 */
class QrLogin {
  constructor(session) {
    this.session = session || new Session()
    this.qrcodeKey = ''
    this.timer = null
  }

  async generate() {
    const res = await this.session.getJSON(GENERATE)
    if (res.code !== 0) throw new Error(`二维码生成失败：${res.message || res.code}`)
    this.qrcodeKey = res.data.qrcode_key
    const dataUrl = await QRCode.toDataURL(res.data.url, {
      margin: 1,
      width: 320,
      color: { dark: '#101014', light: '#FFFFFF' },
    })
    return { qrcodeKey: this.qrcodeKey, url: res.data.url, dataUrl }
  }

  /** 轮询一次，返回 { status, cookies? } */
  async pollOnce() {
    if (!this.qrcodeKey) throw new Error('请先生成二维码')
    const url = `${POLL}?qrcode_key=${encodeURIComponent(this.qrcodeKey)}`
    const res = await this.session.getJSON(url)
    if (res.code !== 0) throw new Error(`轮询失败：${res.message || res.code}`)
    const d = res.data || {}
    const status = STATUS[d.code] || 'unknown'

    if (status === 'success') {
      // 部分版本直接把凭据挂在回调 URL 的 query 上
      if (d.url) harvestFromUrl(this.session, d.url)
      // 再访问一次回调地址，让服务端通过 Set-Cookie 下发完整 Cookie
      if (d.url) await this.followCallback(d.url)
      const cookies = collectCredentials(this.session)
      if (!cookies.SESSDATA || !cookies.bili_jct) {
        throw new Error('登录回调未下发了完整 Cookie，请重试一次')
      }
      return { status, cookies, refreshToken: d.refresh_token || '' }
    }
    return { status, message: d.message || '' }
  }

  async followCallback(url) {
    try {
      await this.session.request(url, {
        headers: { Referer: 'https://www.bilibili.com/' },
        maxRedirects: 6,
      })
    } catch (e) {
      // 回调地址可能指向 biligame 域，跨域失败不影响主域 Cookie，忽略
      if (!/abort|timeout|fetch failed/i.test(String(e.message))) throw e
    }
  }

  /**
   * 持续轮询直到成功/过期。onUpdate(status, message) 用于把状态推给界面。
   */
  startPolling(onUpdate, intervalMs = 1500, timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const tick = async () => {
        try {
          const r = await this.pollOnce()
          onUpdate?.(r.status, r.message)
          if (r.status === 'success') {
            this.stop()
            resolve(r)
            return
          }
          if (r.status === 'expired') {
            this.stop()
            reject(new Error('二维码已失效，请点击刷新'))
            return
          }
        } catch (e) {
          this.stop()
          reject(e)
          return
        }
        if (Date.now() > deadline) {
          this.stop()
          reject(new Error('二维码超时，请点击刷新'))
          return
        }
      }
      this.timer = setInterval(tick, intervalMs)
      tick()
    })
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

/** 从回调 URL 的 query 里抢救凭据（老版本下发方式） */
function harvestFromUrl(session, url) {
  try {
    const u = new URL(url)
    for (const name of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']) {
      const v = u.searchParams.get(name)
      if (v) session.jar.set(`${name}=${v}; Domain=.bilibili.com; Path=/; Max-Age=15552000`)
    }
  } catch {
    /* 非法 URL 就跳过，兜底还有 Set-Cookie 路径 */
  }
}

function collectCredentials(session) {
  const all = session.jar.toObject()
  return {
    SESSDATA: all.SESSDATA || '',
    bili_jct: all.bili_jct || '',
    DedeUserID: all.DedeUserID || '',
    buvid3: all.buvid3 || '',
    buvid4: all.buvid4 || '',
  }
}

module.exports = { QrLogin, collectCredentials }
