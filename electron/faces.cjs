'use strict'
const { UA } = require('./lib/http.cjs')

/**
 * 头像解析器。
 *
 * B站图床（i0/i1/i2.hdslb.com）有防盗链：请求来源不是 bilibili 系域名时返回 403。
 * 我们的界面在生产模式是 file:// 加载的，OBS 叠加层是 127.0.0.1，两种情况都过不了校验，
 * 所以头像必须自己带 Referer 抓回来，转成 data: 地址再交给界面显示。
 *
 * 顺带用 B站图床的裁剪参数把头像压到 96×96 的 webp（约 2.7KB，比原图 50KB 小一个数量级）。
 */

const THUMB = '@96w_96h_1c.webp'
const TIMEOUT = 12000
const MAX_BYTES = 1024 * 1024
const CONCURRENCY = 4

function normalize(raw) {
  let u = String(raw || '').trim()
  if (!u) return ''
  if (u.startsWith('//')) u = 'https:' + u
  if (!/^https?:\/\//i.test(u)) return ''
  // 已有裁剪参数或带鉴权查询串的不要再加后缀，会破坏签名
  if (u.includes('@') || u.includes('?')) return u
  return u + THUMB
}

class FaceResolver {
  constructor() {
    this.cache = new Map() // 原 URL -> data URL
    this.pending = new Map() // 原 URL -> Promise
    this.failed = new Set()
    this.queue = []
    this.busy = 0
  }

  /**
   * 取一个可以直接塞进 <img src> 的地址。
   * 已经解析过的同步返回；没解析过的返回原值（渲染方可以先占个位）。
   */
  cached(raw) {
    return raw ? this.cache.get(raw) || '' : ''
  }

  /**
   * 异步解析。重复请求同一个 URL 会复用同一个 Promise，不会重复打网络。
   * @returns {Promise<string>} data URL，失败返回 ''
   */
  resolve(raw) {
    if (!raw) return Promise.resolve('')
    const hit = this.cache.get(raw)
    if (hit) return Promise.resolve(hit)
    if (this.failed.has(raw)) return Promise.resolve('')

    const inflight = this.pending.get(raw)
    if (inflight) return inflight

    const task = this.enqueue(raw)
    this.pending.set(raw, task)
    return task
  }

  enqueue(raw) {
    return new Promise((resolveInner) => {
      this.queue.push({ raw, resolveInner })
      this.pump()
    })
  }

  pump() {
    while (this.busy < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()
      this.busy++
      this.fetchOne(job.raw)
        .then((dataUrl) => {
          if (dataUrl) this.cache.set(job.raw, dataUrl)
          else this.failed.add(job.raw)
          this.pending.delete(job.raw)
          job.resolveInner(dataUrl)
        })
        .finally(() => {
          this.busy--
          this.pump()
        })
    }
  }

  async fetchOne(raw) {
    const url = normalize(raw)
    if (!url) return ''
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          // 防盗链就看这两个头
          Referer: 'https://www.bilibili.com/',
          'User-Agent': UA,
          Accept: 'image/webp,image/*,*/*;q=0.8',
        },
      })
      if (!res.ok) return ''
      const mime = String(res.headers.get('content-type') || '').split(';')[0].trim()
      if (!mime.startsWith('image/')) return ''
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length || buf.length > MAX_BYTES) return ''
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch {
      return ''
    } finally {
      clearTimeout(timer)
    }
  }
}

module.exports = { FaceResolver, normalize }
