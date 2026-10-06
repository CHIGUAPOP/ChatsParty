'use strict'

/**
 * Microsoft Edge「大声朗读」TTS。
 *
 * 免费、无需 API Key，中文音色质量接近商用水平（晓晓/云希/云扬等）。
 * 协议：wss + Sec-MS-GEC 签名（DRM 令牌，5 分钟一档，需要 SHA256），
 * 输出 audio-24khz-48kbitrate-mono-mp3。
 *
 * 消息格式（与 edge-tts 保持一致）：
 *   → 文本帧 speech.config：X-Timestamp / Content-Type: application/json / Path:speech.config
 *   → 文本帧 ssml：X-RequestId / Content-Type: application/ssml+xml / X-Timestamp（末尾带 Z，微软的怪癖）/ Path:ssml
 *   ← 文本帧 Path:turn.start / audio.metadata / turn.end
 *   ← 二进制帧：前 2 字节大端 = 头长，随后是头，再后面才是 mp3 数据
 */

const crypto = require('node:crypto')
const WebSocket = require('ws')

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const CHROMIUM_FULL_VERSION = '143.0.3650.75'
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0]
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`
const BASE_HOST = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud'
const WSS_URL = `wss://${BASE_HOST}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
const VOICE_LIST_URL = `https://${BASE_HOST}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`
const WIN_EPOCH = 11644473600
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'

/** 系统时钟偏移量（秒）。服务端 403 时用 Date 头校正一次。 */
let clockSkewSeconds = 0

function randHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex')
}

function uuidNoDash() {
  return crypto.randomUUID().replace(/-/g, '')
}

/** Windows file time 时间戳，向下取整到 5 分钟，再 SHA256 */
function generateSecMsGec() {
  let ticks = Date.now() / 1000 + clockSkewSeconds + WIN_EPOCH
  ticks -= ticks % 300
  ticks *= 1e7
  return crypto
    .createHash('sha256')
    .update(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase()
}

function wsHeaders(extra) {
  return {
    'User-Agent':
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    Cookie: `muid=${randHex(16).toUpperCase()};`,
    ...(extra || {}),
  }
}

/** 微软格式的时间字符串，例如 Tue Sep 26 2023 12:34:56 GMT+0000 (Coordinated Universal Time) */
function edgeTimestamp(ms = Date.now()) {
  const d = new Date(ms)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  )
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 在偏移量前先读一次服务端 Date 头，纠正本机时钟偏差（Sec-MS-GEC 对时间很敏感） */
async function syncClock() {
  try {
    const res = await fetch(`${VOICE_LIST_URL}`, {
      headers: wsHeaders({ Authority: 'speech.platform.bing.com' }),
      signal: AbortSignal.timeout(8000),
    })
    const date = res.headers.get('date')
    if (!date) return false
    const server = Date.parse(date)
    if (!Number.isFinite(server)) return false
    clockSkewSeconds = (server - Date.now()) / 1000
    return true
  } catch {
    return false
  }
}

/**
 * 拆一个 Edge 二进制帧。
 * 结构：[2 字节大端头长][头文本][mp3 数据]，头文本不含结尾空行，音频起点 = 2 + 头长。
 * @returns {{path:string, audio:Buffer}}
 */
function splitAudioFrame(frame) {
  const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame)
  if (buf.length < 2) return { path: '', audio: Buffer.alloc(0) }
  const headerLen = buf.readUInt16BE(0)
  const start = 2 + headerLen
  if (start > buf.length) return { path: '', audio: Buffer.alloc(0) }
  const head = buf.subarray(2, start).toString('utf8')
  const path = (head.match(/Path:\s*([^\r\n]+)/i) || [])[1] || ''
  return { path: path.trim(), audio: buf.subarray(start) }
}

/**
 * 单次合成。
 * @returns {Promise<{base64:string, mime:string}>}
 */
function synthesizeOnce(cfg, text, style) {
  return new Promise((resolve, reject) => {
    const connectId = uuidNoDash()
    const url =
      `${WSS_URL}&ConnectionId=${connectId}` +
      `&Sec-MS-GEC=${generateSecMsGec()}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`

    let settled = false
    const chunks = []
    const ws = new WebSocket(url, {
      headers: wsHeaders(),
      perMessageDeflate: true,
      handshakeTimeout: 15000,
    })

    const finish = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
      if (err) reject(err)
      else resolve(value)
    }

    const timer = setTimeout(() => {
      if (chunks.length) finish(null, { base64: Buffer.concat(chunks).toString('base64'), mime: 'audio/mpeg' })
      else finish(new Error('Edge 语音合成超时（30 秒无音频返回）'))
    }, 30000)

    ws.on('unexpected-response', async (_req, res) => {
      const body = []
      res.on('data', (d) => body.push(d))
      res.on('end', async () => {
        if (res.statusCode === 403 && !cfg.__retried) {
          // 十有八九是本机时钟偏差导致签名过期，校时后重试一次
          const ok = await syncClock()
          if (ok) {
            try {
              const r = await synthesizeOnce({ ...cfg, __retried: true }, text, style)
              return finish(null, r)
            } catch (e) {
              return finish(e)
            }
          }
        }
        finish(new Error(`Edge 语音返回 ${res.statusCode}${body.length ? `：${Buffer.concat(body).toString().slice(0, 160)}` : ''}`))
      })
    })

    ws.on('error', (e) => finish(new Error(`Edge 语音连接失败：${e.message}`)))

    ws.on('open', () => {
      // 1. speech.config
      ws.send(
        `X-Timestamp:${edgeTimestamp()}\r\n` +
          'Content-Type:application/json; charset=utf-8\r\n' +
          'Path:speech.config\r\n\r\n' +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`
      )

      // 2. ssml
      const voice = cfg.voice || 'zh-CN-XiaoxiaoNeural'
      const rate = cfg.rate || '+0%'
      const pitch = cfg.pitch || '+0Hz'
      const volume = cfg.localVolume || '+0%'
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${escapeXml(voice)}'>` +
        `<prosody pitch='${escapeXml(pitch)}' rate='${escapeXml(rate)}' volume='${escapeXml(volume)}'>` +
        `${escapeXml(text)}` +
        '</prosody></voice></speak>'

      ws.send(
        `X-RequestId:${uuidNoDash()}\r\n` +
          'Content-Type:application/ssml+xml\r\n' +
          `X-Timestamp:${edgeTimestamp()}Z\r\n` + // 末尾的 Z 是微软的怪癖，别删
          'Path:ssml\r\n\r\n' +
          ssml
      )
    })

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const { path, audio } = splitAudioFrame(data)
        if (/^audio$/i.test(path) && audio.length) chunks.push(Buffer.from(audio))
        return
      }

      const textFrame = data.toString('utf8')
      if (/Path:\s*turn\.end/i.test(textFrame)) {
        if (!chunks.length) return finish(new Error('Edge 语音没有返回音频数据'))
        finish(null, { base64: Buffer.concat(chunks).toString('base64'), mime: 'audio/mpeg' })
      }
    })

    ws.on('close', () => {
      if (!settled) {
        if (chunks.length) finish(null, { base64: Buffer.concat(chunks).toString('base64'), mime: 'audio/mpeg' })
        else finish(new Error('Edge 语音连接被关闭，未收到音频'))
      }
    })
  })
}

async function synthesize(cfg, text, style) {
  // 风格指令在 Edge 协议里没有等价位置，拼接到正文前由语音合成本身处理（保持简短）
  const finalText = text
  void style
  return synthesizeOnce(cfg, finalText, style)
}

let voiceCache = { at: 0, list: null }

async function listVoices({ force } = {}) {
  if (!force && voiceCache.list && Date.now() - voiceCache.at < 6 * 3600 * 1000) return voiceCache.list
  const res = await fetch(VOICE_LIST_URL, {
    headers: wsHeaders({ Authority: 'speech.platform.bing.com' }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`获取 Edge 音色列表失败：HTTP ${res.status}`)
  const raw = await res.json()
  const list = raw
    .filter((v) => /Neural$/.test(v.ShortName || ''))
    .map((v) => ({
      id: v.ShortName,
      label: `${v.FriendlyName || v.ShortName}${v.Gender ? ` · ${v.Gender === 'Female' ? '女' : '男'}` : ''}`,
      locale: v.Locale,
      gender: v.Gender,
    }))
  voiceCache = { at: Date.now(), list }
  return list
}

module.exports = { synthesize, listVoices, splitAudioFrame, VOICE_LIST_URL }
