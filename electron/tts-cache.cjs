'use strict'

/**
 * TTS 结果缓存。
 *
 * 目的：直播间里「你好」「666」「主播好帅」这类句子会反复出现，每次都付钱重新合成很浪费。
 * 所以把「同一套音色配置 + 同一句话」产出的音频存到本地，TTL 内再遇到就直接放本地那份。
 *
 * 两条关键规则：
 *  1. **滑动过期**：命中一次就把保存时间刷成现在 —— 常用句子会被一直续期，冷句子自然过期。
 *     这就是「常用音色句子不重复生成」的实现方式。
 *  2. **过期按本机时间戳比**：savedAt + ttl < Date.now() 即过期。不依赖定时器，
 *     断电 / 关软件期间不会偷偷失效；反过来，把系统时间往回调也不会让它提前作废。
 *
 * 磁盘布局：<dir>/index.json（索引）+ <dir>/<hash>.bin（音频二进制）
 * 索引里只存 apiKey 的哈希指纹，绝不写明文密钥。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const VERSION = 1
/** 写索引的节流间隔。命中会改时间戳，太频繁挨次落盘没必要 */
const SAVE_DEBOUNCE_MS = 1500
/** 条数上限兜底：就算每条都很小，也不能让索引无限膨胀 */
const MAX_ENTRIES = 4000
/** 合成结果小于这个字节数基本不是音频（多半是接口把错误文本当音频返回了），不进缓存 */
const MIN_AUDIO_BYTES = 32

/** 取哈希前 n 位做指纹。用于 cloneFile（可能是很长的 data URI）和 apiKey */
function fingerprint(s, n = 12) {
  if (!s) return ''
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n)
}

/**
 * 缓存键。凡是会影响音频内容的字段都要进来，反之不能进来：
 *  - proxy（走哪条网络栈）不影响音频 → 不进
 *  - platformBase 已经体现在 baseUrl → 不进
 *  - volume 只有 SAPI 会**嵌进音频**，其他协议的音量是播放端才生效的 → 只对 sapi/system 纳入
 */
function cacheKeyOf({ cfg, text, style }) {
  const c = cfg || {}
  const sapiish = c.protocol === 'sapi' || c.provider === 'system'
  const sig = {
    provider: c.provider || '',
    protocol: c.protocol || '',
    baseUrl: c.baseUrl || '',
    model: c.model || '',
    voice: c.voice || '',
    format: c.format || '',
    rate: c.rate || '',
    speed: c.speed ?? '',
    pitch: c.pitch || '',
    mimoMode: c.mimoMode || '',
    designPrompt: c.designPrompt || '',
    // 参考音频（音色克隆）本身是一大段 data URI，取指纹即可区分
    cloneRef: fingerprint(c.cloneFile),
    volume: sapiish ? c.volume ?? '' : '',
    // 换了一个账号（哪怕是同一个服务）产出的音频不一定一样，按账号分开缓存；
    // 但只存指纹，绝不把密钥写进索引文件
    keyFp: fingerprint(c.apiKey, 16),
    text: String(text || ''),
    style: String(style || ''),
  }
  return crypto.createHash('sha256').update(JSON.stringify(sig)).digest('hex').slice(0, 32)
}

function safeName(hash) {
  return `${hash}.bin`
}

function createTtsCache({ dir, logger } = {}) {
  const indexFile = path.join(dir, 'index.json')
  let entries = {} // hash -> { bytes, createdAt, savedAt, hits, mime, text, voice, protocol }
  let hits = 0
  let putCount = 0
  let dirty = false
  let timer = null
  let loaded = false

  const info = (m) => {
    try {
      logger?.info?.(m)
    } catch {}
  }
  const warn = (m) => {
    try {
      logger?.warn?.(m)
    } catch {}
  }

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true })
  }

  function load() {
    ensureDir()
    try {
      if (!fs.existsSync(indexFile)) {
        // 首次运行：索引还没有是正常的
        entries = {}
        hits = 0
        putCount = 0
      } else {
        const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
        if (raw && raw.version === VERSION && raw.entries && typeof raw.entries === 'object') {
          entries = raw.entries
          hits = Number(raw.hits) || 0
          putCount = Number(raw.putCount) || 0
        } else {
          throw new Error('结构不符')
        }
      }
    } catch (e) {
      // 索引坏了不要连带把整个缓存目录删掉，挪一边留证，然后从头开始
      const bak = `${indexFile}.corrupt-${Date.now()}`
      try {
        fs.renameSync(indexFile, bak)
      } catch {}
      warn(`[tts-cache] 索引损坏已重置：${e.message}，旧文件留在 ${bak}`)
      entries = {}
      hits = 0
      putCount = 0
    }

    // 清理放在最后、且**无论索引在不在**都要跑：
    // 只写了一半音频就崩 / 索引被人删了之后，目录里会留下没有主人占着的 .bin，
    // 早点扫掉，别让它在磁盘上一直堆着。
    // 清孤儿：索引里没有的 .bin（上次写一半崩了 / 被外部动过）
    let orphan = 0
    const keep = new Set(Object.keys(entries))
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.bin')) continue
        const hash = f.slice(0, -4)
        if (keep.has(hash)) continue
        try {
          fs.unlinkSync(path.join(dir, f))
          orphan++
        } catch {}
      }
    } catch {}
    // 反过来：索引里有但文件没了 → 直接摘掉，别等到命中才报错
    let dropped = 0
    for (const h of Object.keys(entries)) {
      if (!fs.existsSync(path.join(dir, safeName(h)))) {
        delete entries[h]
        dropped++
      }
    }
    if (orphan || dropped) {
      info(`[tts-cache] 载入时清理：孤儿 ${orphan} 个，缺失 ${dropped} 条`)
      markDirty()
    }
    loaded = true
  }

  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!dirty) return
    dirty = false
    ensureDir()
    const tmp = `${indexFile}.tmp-${process.pid}`
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, hits, putCount, entries }))
      fs.renameSync(tmp, indexFile)
    } catch (e) {
      warn(`[tts-cache] 索引写入失败：${e.message}`)
      try {
        fs.unlinkSync(tmp)
      } catch {}
    }
  }

  function markDirty() {
    dirty = true
    if (timer) return
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS)
    // 别因为这个定时器把进程拖住
    if (typeof timer.unref === 'function') timer.unref()
  }

  /**
   * 命中返回 { base64, mime, hits }，未命中返回 null。
   * 命中会刷新保存时间戳（滑动过期）—— 这就是「常用句子一直续期」的地方。
   */
  function get(input) {
    if (!loaded) load()
    const hash = cacheKeyOf(input)
    const e = entries[hash]
    if (!e) return null
    const file = path.join(dir, safeName(hash))
    let buf
    try {
      buf = fs.readFileSync(file)
    } catch {
      delete entries[hash]
      markDirty()
      return null
    }
    // 尺寸对不上说明文件被写坏过，宁可再生一次也别放错声音
    if (e.bytes && buf.length !== e.bytes) {
      delete entries[hash]
      try {
        fs.unlinkSync(file)
      } catch {}
      markDirty()
      return null
    }
    e.savedAt = Date.now()
    e.hits = (Number(e.hits) || 0) + 1
    hits++
    markDirty()
    info(`[tts-cache] 命中 ${hash} 「${String(e.text || '').slice(0, 12)}」第 ${e.hits} 次`)
    return { base64: buf.toString('base64'), mime: e.mime || 'audio/wav', hits: e.hits }
  }

  /** 存一份。audio 需带 { base64, mime } */
  function put(input, audio) {
    if (!loaded) load()
    const b64 = String(audio?.base64 || '')
    if (!b64) return false
    const buf = Buffer.from(b64, 'base64')
    if (buf.length < MIN_AUDIO_BYTES) return false

    const hash = cacheKeyOf(input)
    const file = path.join(dir, safeName(hash))
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    try {
      ensureDir()
      fs.writeFileSync(tmp, buf)
      // 原子替换：写到一半被打断也不会留下半个音频
      fs.renameSync(tmp, file)
    } catch (e) {
      warn(`[tts-cache] 写入失败：${e.message}`)
      try {
        fs.unlinkSync(tmp)
      } catch {}
      return false
    }
    const now = Date.now()
    const prev = entries[hash]
    entries[hash] = {
      bytes: buf.length,
      createdAt: prev?.createdAt || now,
      savedAt: now,
      hits: prev?.hits || 0,
      mime: audio.mime || 'audio/wav',
      // 只是给「清理 / 排查」看的摘要，不参与任何逻辑
      text: String(input.text || '').slice(0, 24),
      voice: String(input.cfg?.voice || ''),
      protocol: String(input.cfg?.protocol || input.cfg?.provider || ''),
    }
    putCount++
    markDirty()
    return true
  }

  /**
   * 清理。policy: { ttlMs, maxBytes }
   *  - 过期：savedAt + ttlMs < now（ttlMs<=0 视为不过期）
   *  - 超限：总容量超 maxBytes 时按 savedAt 最旧的先删，删到 80% 水位，
   *    避免每次都贴着边界、来一条删一条
   * 返回 { removed, bytes }
   */
  function prune({ ttlMs = 0, maxBytes = 0 } = {}) {
    if (!loaded) load()
    const now = Date.now()
    let removed = 0
    let bytes = 0

    const drop = ([hash, e]) => {
      delete entries[hash]
      removed++
      bytes += Number(e?.bytes) || 0
      try {
        fs.unlinkSync(path.join(dir, safeName(hash)))
      } catch {}
    }

    if (ttlMs > 0) {
      for (const item of Object.entries(entries)) {
        const savedAt = Number(item[1]?.savedAt) || 0
        if (savedAt + ttlMs < now) drop(item)
      }
    }

    let total = 0
    for (const e of Object.values(entries)) total += Number(e?.bytes) || 0
    let count = Object.keys(entries).length

    if ((maxBytes > 0 && total > maxBytes) || count > MAX_ENTRIES) {
      const rest = Object.entries(entries).sort((a, b) => (a[1]?.savedAt || 0) - (b[1]?.savedAt || 0))
      const target = maxBytes > 0 ? Math.floor(maxBytes * 0.8) : 0
      for (const item of rest) {
        if (count <= MAX_ENTRIES && (maxBytes <= 0 || total <= target)) break
        const b = Number(item[1]?.bytes) || 0
        total -= b
        count--
        drop(item)
      }
    }

    if (removed) {
      markDirty()
      info(`[tts-cache] 清理 ${removed} 条，回收 ${(bytes / 1024 / 1024).toFixed(2)} MB`)
    }
    return { removed, bytes }
  }

  function stats() {
    if (!loaded) load()
    const list = Object.values(entries)
    const bytes = list.reduce((s, e) => s + (Number(e?.bytes) || 0), 0)
    const times = list.map((e) => Number(e?.savedAt) || 0).filter(Boolean)
    return {
      entries: list.length,
      bytes,
      hits,
      putCount,
      // 最久没被碰到的一条：直观反映「多久没人再说过这句话」
      oldestSavedAt: times.length ? Math.min(...times) : 0,
      newestSavedAt: times.length ? Math.max(...times) : 0,
      dir,
    }
  }

  function clear() {
    if (!loaded) load()
    const n = Object.keys(entries).length
    let bytes = 0
    for (const hash of Object.keys(entries)) {
      bytes += Number(entries[hash]?.bytes) || 0
      try {
        fs.unlinkSync(path.join(dir, safeName(hash)))
      } catch {}
      delete entries[hash]
    }
    // 目录里可能还有索引没记到的残留文件，一并扫掉
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.bin')) {
          try {
            fs.unlinkSync(path.join(dir, f))
          } catch {}
        }
      }
    } catch {}
    hits = 0
    putCount = 0
    dirty = true
    flush()
    return { cleared: n, bytes }
  }

  return { get, put, prune, stats, clear, flush, load, cacheKeyOf, dir }
}

module.exports = { createTtsCache, cacheKeyOf, VERSION, MAX_ENTRIES }
