'use strict'
const crypto = require('node:crypto')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 轻量 Cookie Jar：按 name+domain 存储，按请求 host 做后缀匹配后回传。
 * 只服务 bilibili 系域名，够用且行为可控。
 */
class CookieJar {
  constructor() {
    this.store = new Map()
  }

  key(name, domain) {
    return `${name}@${domain.replace(/^\./, '')}`
  }

  set(raw) {
    if (!raw) return
    const [pair, ...attrs] = raw.split(';')
    const idx = pair.indexOf('=')
    if (idx < 0) return
    const name = pair.slice(0, idx).trim()
    let value = pair.slice(idx + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (!name) return

    let domain = ''
    let maxAge = null
    let expires = null
    for (const a of attrs) {
      const p = a.indexOf('=')
      const k = p < 0 ? a.trim().toLowerCase() : a.slice(0, p).trim().toLowerCase()
      const v = p < 0 ? '' : a.slice(p + 1).trim()
      if (k === 'domain') domain = v
      else if (k === 'max-age') maxAge = Number(v)
      else if (k === 'expires') expires = new Date(v)
    }
    if (!domain) domain = 'bilibili.com'
    if (name === 'SESSDATA' || name === 'bili_jct') value = decodeURIComponent(value)

    const rec = { name, value, domain: domain.replace(/^\./, '') }
    if (maxAge === 0) {
      this.store.delete(this.key(name, domain))
      return
    }
    if (maxAge != null) rec.expiry = Date.now() + maxAge * 1000
    if (expires && !Number.isNaN(expires.getTime())) rec.expiry = expires.getTime()
    this.store.set(this.key(name, domain), rec)
  }

  setAll(headers) {
    for (const c of headers) this.set(c)
  }

  getHeader(url) {
    let host
    try {
      host = new URL(url).hostname
    } catch {
      return ''
    }
    const now = Date.now()
    const out = []
    for (const rec of this.store.values()) {
      if (rec.expiry && rec.expiry < now) continue
      if (host === rec.domain || host.endsWith('.' + rec.domain)) out.push(`${rec.name}=${rec.value}`)
    }
    return out.join('; ')
  }

  get(name, domain = 'bilibili.com') {
    const rec = this.store.get(this.key(name, domain))
    if (!rec) {
      for (const r of this.store.values()) if (r.name === name) return r.value
      return ''
    }
    return rec.value
  }

  toObject() {
    const out = {}
    for (const rec of this.store.values()) {
      if (rec.expiry && rec.expiry < Date.now()) continue
      out[rec.name] = rec.value
    }
    return out
  }

  clear() {
    this.store.clear()
  }
}

class Session {
  constructor(jar) {
    this.jar = jar || new CookieJar()
  }

  /**
   * 手动跟随重定向发起请求，逐跳收集 Set-Cookie。
   * Node fetch 默认跟随重定向，拿不到中间跳的 Cookie，登录流程必须自己走。
   */
  async request(url, options = {}) {
    const { method = 'GET', headers = {}, body, maxRedirects = 5, timeout = 15000 } = options
    let current = url
    let res

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        res = await fetch(current, {
          method,
          redirect: 'manual',
          signal: ctrl.signal,
          headers: {
            'User-Agent': UA,
            Accept: 'application/json, text/plain, */*',
            Referer: 'https://www.bilibili.com/',
            Origin: 'https://www.bilibili.com',
            ...headers,
            Cookie: this.jar.getHeader(current),
          },
          body,
        })
      } finally {
        clearTimeout(timer)
      }

      const setCookie =
        typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
      if (setCookie.length) this.jar.setAll(setCookie)

      const loc = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && loc && hop < maxRedirects) {
        current = new URL(loc, current).toString()
        continue
      }
      return res
    }
    return res
    }

  async getJSON(url, options = {}) {
    const res = await this.request(url, options)
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`响应不是合法 JSON：${text.slice(0, 120)}`)
    }
  }
}

/* ---------------------------------- wbi 签名 --------------------------------- */

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9,
  42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0,
  1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

function getMixinKey(orig) {
  let s = ''
  for (const i of MIXIN_KEY_ENC_TAB) s += orig[i]
  return s.slice(0, 32)
}

function filterValue(v) {
  return String(v).replace(/[!'()*]/g, '')
}

class Wbi {
  constructor(session) {
    this.session = session
    this.cached = null
    this.fetchedAt = 0
  }

  async keys() {
    const now = Date.now()
    if (this.cached && now - this.fetchedAt < 6 * 3600 * 1000) return this.cached
    const nav = await this.session.getJSON('https://api.bilibili.com/x/web-interface/nav')
    const img = nav?.data?.wbi_img
    if (!img?.img_url || !img?.sub_url) throw new Error('未能从 nav 接口取得 wbi 密钥')
    const imgKey = img.img_url.split('/').pop().split('.')[0]
    const subKey = img.sub_url.split('/').pop().split('.')[0]
    this.cached = getMixinKey(imgKey + subKey)
    this.fetchedAt = now
    return this.cached
  }

  /** 给参数加上 w_rid / wts，返回可直接拼在 URL 后的查询串 */
  async sign(params) {
    const mixinKey = await this.keys()
    const clean = {}
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue
      clean[k] = filterValue(v)
    }
    clean.wts = Math.floor(Date.now() / 1000)
    const keys = Object.keys(clean).sort()
    const query = keys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean[k])}`)
      .join('&')
    const wRid = crypto.createHash('md5').update(query + mixinKey, 'utf8').digest('hex')
    return `${query}&w_rid=${wRid}`
  }

  async url(base, params) {
    const query = await this.sign(params)
    return `${base}?${query}`
  }
}

module.exports = { UA, CookieJar, Session, Wbi }
