'use strict'
const { EventEmitter } = require('node:events')
const zlib = require('node:zlib')
const WebSocket = require('ws')

const OP_HEARTBEAT = 2
const OP_HEARTBEAT_REPLY = 3
const OP_MESSAGE = 5
const OP_AUTH = 7
const OP_AUTH_REPLY = 8

const HEADER_LEN = 16

function encodePacket(body, op, protover = 1, seq = 1) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  const header = Buffer.alloc(HEADER_LEN)
  header.writeUInt32BE(HEADER_LEN + payload.length, 0)
  header.writeUInt16BE(HEADER_LEN, 4)
  header.writeUInt16BE(protover, 6)
  header.writeUInt32BE(op, 8)
  header.writeUInt32BE(seq, 12)
  return Buffer.concat([header, payload])
}

/** 一个 brotli/zlib 包里可能套着多个子包，递归拆开 */
function decodeBuffer(buf, out = []) {
  let offset = 0
  while (offset + HEADER_LEN <= buf.length) {
    const len = buf.readUInt32BE(offset)
    if (len < HEADER_LEN || offset + len > buf.length) break
    const headerLen = buf.readUInt16BE(offset + 4)
    const protover = buf.readUInt16BE(offset + 6)
    const op = buf.readUInt32BE(offset + 8)
    const seq = buf.readUInt32BE(offset + 12)
    const body = buf.subarray(offset + (headerLen || HEADER_LEN), offset + len)
    offset += len

    if (protover === 2) {
      try {
        decodeBuffer(zlib.inflateSync(body), out)
        continue
      } catch {
        /* 解压失败就当纯文本处理 */
      }
    } else if (protover === 3) {
      try {
        decodeBuffer(zlib.brotliDecompressSync(body), out)
        continue
      } catch {
        /* 同上 */
      }
    }
    out.push({ op, seq, protover, body })
  }
  return out
}

function safeParse(buf) {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

/* ------------------------- INTERACT_WORD_V2 的 pb ------------------------- */

/**
 * INTERACT_WORD_V2（B站现在推的进场消息）把用户信息放在 data.pb 里，
 * 是一段 base64 编码的 protobuf，不是 JSON —— 直接读 data.uname 只会拿到 undefined，
 * 界面就会显示成「匿名用户」。这里手写一个最小解码器，只认必需的几个字段号。
 *
 * proto 结构（proto3，字段号固定）：
 *   uint64 uid = 1; string uname = 2; string uname_color = 3;
 *   repeated uint64 identities = 4; uint64 msg_type = 5;
 *   uint64 roomid = 6; uint64 timestamp = 7; uint64 score = 8;
 */
function readVarint(buf, start) {
  let value = 0n
  let shift = 0n
  let i = start
  while (i < buf.length) {
    const b = buf[i++]
    value |= BigInt(b & 0x7f) << shift
    if (!(b & 0x80)) return { value, next: i }
    shift += 7n
    if (shift > 70n) break
  }
  return null
}

function decodeInteractWordV2(base64) {
  if (typeof base64 !== 'string' || !base64) return null
  let buf
  try {
    buf = Buffer.from(base64, 'base64')
  } catch {
    return null
  }
  if (!buf || buf.length === 0) return null

  const out = { uid: 0, uname: '', unameColor: '', identities: [], msgType: 0, roomid: 0, timestamp: 0 }
  let i = 0
  while (i < buf.length) {
    const key = readVarint(buf, i)
    if (!key) break
    i = key.next
    const field = Number(key.value >> 3n)
    const wire = Number(key.value & 7n)
    if (field === 0) break

    if (wire === 0) {
      const v = readVarint(buf, i)
      if (!v) break
      i = v.next
      const n = Number(v.value)
      if (field === 1) out.uid = n
      else if (field === 4) out.identities.push(n)
      else if (field === 5) out.msgType = n
      else if (field === 6) out.roomid = n
      else if (field === 7) out.timestamp = n
    } else if (wire === 2) {
      const len = readVarint(buf, i)
      if (!len) break
      i = len.next
      const end = i + Number(len.value)
      if (end > buf.length) break
      const chunk = buf.subarray(i, end)
      i = end
      if (field === 2) out.uname = chunk.toString('utf8')
      else if (field === 3) out.unameColor = chunk.toString('utf8')
    } else if (wire === 5) {
      i += 4
    } else if (wire === 1) {
      i += 8
    } else {
      break // 遇到不认识的 wire type 就停，别把后面解成垃圾
    }
  }
  return out
}

/** identities 里的身份位：1 房管、2 主播 */
function identitiesToRole(list) {
  const arr = list || []
  return { isAdmin: arr.includes(1), isAnchor: arr.includes(2) }
}

function pickExtra(info0) {
  // 旧格式：info[0] 是数组，第 15 项是 { extra: "<json>" }
  if (Array.isArray(info0)) {
    for (let i = info0.length - 1; i >= 0; i--) {
      const v = info0[i]
      if (v && typeof v === 'object' && typeof v.extra === 'string') {
        try {
          return JSON.parse(v.extra)
        } catch {
          return null
        }
      }
    }
    return null
  }
  return info0 && typeof info0 === 'object' ? info0 : null
}

function normalizeDanmaku(raw) {
  const info = raw.info || []
  const meta = pickExtra(info[0])
  const legacyUser = Array.isArray(info[2]) ? info[2] : null
  const legacyMedal = Array.isArray(info[3]) ? info[3] : null
  const legacyUl = Array.isArray(info[4]) ? info[4] : null

  const userObj = (meta && meta.user) || {}
  const base = userObj.base || {}

  const uid = userObj.uid ?? (legacyUser ? legacyUser[0] : 0)
  const username = base.name || (legacyUser ? legacyUser[1] : '') || ''
  const face = base.face || userObj.face || ''
  const isAdmin = Boolean(userObj.admin ?? (legacyUser ? legacyUser[2] : 0))

  let medal = null
  if (userObj.medal && userObj.medal.name) {
    medal = {
      name: userObj.medal.name,
      level: userObj.medal.level,
      anchorName: userObj.medal.anchor_name || userObj.medal.anchor_uname || '',
      color: userObj.medal.medal_color || userObj.medal.color || 0,
    }
  } else if (legacyMedal && legacyMedal[1]) {
    medal = {
      name: legacyMedal[1],
      level: legacyMedal[0],
      anchorName: legacyMedal[2] || '',
      color: legacyMedal[7] || legacyMedal[8] || 0,
    }
  }

  const level = userObj?.wealth?.level ?? (legacyUl ? legacyUl[0] : 0)
  const content = typeof info[1] === 'string' ? info[1] : meta?.content || ''
  const color = Array.isArray(info[0]) ? info[0][3] : meta?.color || 16777215

  return {
    type: 'danmaku',
    uid: Number(uid) || 0,
    username: String(username || '').trim(),
    face: String(face || ''),
    content: String(content || ''),
    medal,
    level: Number(level) || 0,
    isAdmin,
    color: Number(color) || 16777215,
    emots: meta?.emots || null,
    dmType: meta?.dm_type ?? 0,
    emojiUrl: meta?.emoji_img_url || '',
    timestamp: Date.now(),
  }
}

function normalizeEvent(raw) {
  const cmd = raw.cmd
  const d = raw.data || {}

  switch (cmd) {
    case 'DANMU_MSG':
      return normalizeDanmaku(raw)

    case 'SEND_GIFT':
      return {
        type: 'gift',
        uid: d.uid || 0,
        username: d.uname || '',
        face: d.face || '',
        content: `${d.action || '投喂'} ${d.giftName || ''} ×${d.num || 1}`,
        giftName: d.giftName || '',
        num: d.num || 1,
        price: (d.total_coin || 0) / 1000,
        coinType: d.coin_type || 'silver',
        timestamp: Date.now(),
      }

    case 'GUARD_BUY':
      return {
        type: 'guard',
        uid: d.uid || 0,
        username: d.username || '',
        face: '',
        content: `开通${d.gift_name || '大航海'} ×${d.num || 1}`,
        giftName: d.gift_name || '',
        num: d.num || 1,
        price: (d.price || 0) / 1000,
        timestamp: Date.now(),
      }

    case 'USER_TOAST_MSG':
      return {
        type: 'guard',
        uid: d.uid || 0,
        username: d.username || '',
        face: '',
        content: d.toast_msg || `开通${d.role_name || '大航海'}`,
        giftName: d.role_name || '',
        num: d.num || 1,
        price: (d.price || 0) / 1000,
        timestamp: Date.now(),
      }

    case 'SUPER_CHAT_MESSAGE':
    case 'SUPER_CHAT_MESSAGE_JPN':
      return {
        type: 'superchat',
        uid: d.uid || 0,
        username: d.user_info?.uname || '',
        face: d.user_info?.face || '',
        content: d.message || d.message_trans || '',
        price: d.price || 0,
        timestamp: Date.now(),
      }

    case 'INTERACT_WORD_V2': {
      // 用户信息在 base64 protobuf 里，见 decodeInteractWordV2
      const pb = decodeInteractWordV2(d.pb) || {}
      const role = identitiesToRole(pb.identities)
      const msgType = Number(d.msg_type ?? pb.msgType) || 1
      return {
        type: 'enter',
        uid: Number(d.uid || pb.uid || 0),
        username: String(d.uname || pb.uname || '').trim(),
        unameColor: pb.unameColor || d.uname_color || '',
        face: d.face || '',
        medal: d.fans_medal?.medal_name
          ? { name: d.fans_medal.medal_name, level: d.fans_medal.medal_level, anchorName: '' }
          : null,
        isAdmin: role.isAdmin || Boolean(d.identities?.includes(1)),
        content: msgType === 2 ? '关注了直播间' : msgType === 3 ? '分享了直播间' : '进入了直播间',
        timestamp: Date.now(),
      }
    }

    case 'INTERACT_WORD': {
      const msgType = Number(d.msg_type) || 1
      return {
        type: 'enter',
        uid: Number(d.uid || 0),
        username: String(d.uname || '').trim(),
        unameColor: d.uname_color || '',
        face: d.face || '',
        medal: d.fans_medal?.medal_name
          ? { name: d.fans_medal.medal_name, level: d.fans_medal.medal_level, anchorName: '' }
          : null,
        isAdmin: Boolean(d.identities?.includes(1)),
        content: msgType === 2 ? '关注了直播间' : msgType === 3 ? '分享了直播间' : '进入了直播间',
        timestamp: Date.now(),
      }
    }

    case 'LIVE':
      return { type: 'live', content: '直播开始', timestamp: Date.now() }
    case 'PREPARING':
      return { type: 'offline', content: '直播结束', timestamp: Date.now() }

    default:
      return null
  }
}

class LiveClient extends EventEmitter {
  constructor({ api, roomId, uid = 0 }) {
    super()
    this.api = api
    this.roomId = Number(roomId)
    this.uid = Number(uid) || 0
    this.ws = null
    this.heartbeatTimer = null
    this.reconnectTimer = null
    this.attempt = 0
    this.running = false
    this.manualStop = false
    this.popularity = 0
  }

  async start() {
    if (this.running) return
    this.running = true
    this.manualStop = false
    await this.connect()
  }

  async connect() {
    if (!this.running) return
    this.clearSocket()

    let info
    try {
      info = await this.api.getDanmuInfo(this.roomId)
    } catch (e) {
      this.emit('error', e)
      this.scheduleReconnect()
      return
    }

    const url = info.hosts[0]
    let ws
    try {
      ws = new WebSocket(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Origin: 'https://live.bilibili.com',
        },
        handshakeTimeout: 10000,
      })
    } catch (e) {
      this.emit('error', e)
      this.scheduleReconnect()
      return
    }

    this.ws = ws

    ws.on('open', () => {
      this.attempt = 0
      const buvid = this.api.session.jar.get('buvid3')
      const auth = {
        uid: this.uid,
        roomid: this.roomId,
        protover: 3,
        buvid,
        platform: 'web',
        type: 2,
        key: info.token,
      }
      ws.send(encodePacket(JSON.stringify(auth), OP_AUTH, 1))
      this.startHeartbeat()
      this.emit('status', 'connected')
    })

    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      this.handleFrame(buf)
    })

    ws.on('close', () => {
      this.stopHeartbeat()
      this.emit('status', 'disconnected')
      if (!this.manualStop) this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      this.emit('error', err)
      try {
        ws.terminate()
      } catch {
        /* noop */
      }
    })
  }

  handleFrame(buf) {
    for (const pkt of decodeBuffer(buf)) {
      if (pkt.op === OP_AUTH_REPLY) {
        const body = safeParse(pkt.body)
        if (body && body.code === 0) this.emit('status', 'authenticated')
        else {
          this.emit('error', new Error(`弹幕服务器鉴权失败：${body ? body.message || body.code : '未知'}`))
          try {
            this.ws?.close()
          } catch {
            /* noop */
          }
        }
      } else if (pkt.op === OP_HEARTBEAT_REPLY) {
        if (pkt.body.length >= 4) this.popularity = pkt.body.readUInt32BE(0)
        this.emit('popularity', this.popularity)
      } else if (pkt.op === OP_MESSAGE) {
        const body = safeParse(pkt.body)
        if (!body) continue
        const cmds = Array.isArray(body) ? body : [body]
        for (const c of cmds) {
          // 原始消息留一份，方便排查新出现的 cmd 或字段变化
          if (this.listenerCount('raw')) this.emit('raw', c)
          const ev = normalizeEvent(c)
          if (ev) this.emit('event', ev)
        }
      }
    }
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(encodePacket('[object Object]', OP_HEARTBEAT, 1))
        } catch {
          /* noop */
        }
      }
    }, 30000)
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  scheduleReconnect() {
    if (!this.running || this.manualStop || this.reconnectTimer) return
    this.attempt = Math.min(this.attempt + 1, 6)
    const delay = Math.min(1000 * 2 ** (this.attempt - 1), 30000)
    this.emit('status', 'reconnecting')
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      await this.connect()
    }, delay)
  }

  clearSocket() {
    this.stopHeartbeat()
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        this.ws.terminate()
      } catch {
        /* noop */
      }
      this.ws = null
    }
  }

  stop() {
    this.running = false
    this.manualStop = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearSocket()
  }
}

module.exports = {
  LiveClient,
  encodePacket,
  decodeBuffer,
  normalizeEvent,
  normalizeDanmaku,
  decodeInteractWordV2,
}
