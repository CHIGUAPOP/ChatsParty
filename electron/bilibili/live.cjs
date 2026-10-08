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

/* ------------------------- SEND_GIFT_V2 的 pb ------------------------- */

/**
 * `SEND_GIFT_V2`（B站现在推的礼物消息）整包只有两个字段：
 *
 *   { "dmscore": 560, "pb": "<base64 protobuf>" }
 *
 * 礼物名、数量、金额、送礼人**全在那段 base64 里** —— 这就是
 * 「送了礼物但历史/播报都没有」的真正原因：不是包没到，是扁平字段一个都不存在。
 * 老的 `SEND_GIFT` 是 JSON，新的是 pb，两套都得认。
 *
 * 这里手写一个最小 protobuf 读取器。不引 protobufjs 是因为：
 * ① 打包体积白涨；② B站 的包会加字段，按 .proto 严格解反而更容易炸。
 */

/**
 * 解一层消息，得到 `字段号 -> 值[]`。
 * 值是 BigInt（varint）或 Buffer（length-delimited）。
 * 碰到不认识的 wire type 直接停 —— 把后面的字节硬啃成字段只会解出垃圾。
 */
function readFields(buf) {
  const out = new Map()
  const push = (f, v) => {
    const a = out.get(f)
    if (a) a.push(v)
    else out.set(f, [v])
  }
  let i = 0
  while (i < buf.length) {
    const key = readVarint(buf, i)
    if (!key) break
    i = key.next
    const field = Number(key.value >> 3n)
    const wire = Number(key.value & 7n)
    if (!field) break
    if (wire === 0) {
      const v = readVarint(buf, i)
      if (!v) break
      i = v.next
      push(field, v.value)
    } else if (wire === 2) {
      const len = readVarint(buf, i)
      if (!len) break
      i = len.next
      const end = i + Number(len.value)
      if (end > buf.length) break
      push(field, buf.subarray(i, end))
      i = end
    } else if (wire === 5) {
      i += 4
    } else if (wire === 1) {
      i += 8
    } else {
      break
    }
  }
  return out
}

/** 取最后一个 varint（repeated 字段里最后那个才是有效值） */
function fNum(m, f) {
  const a = m.get(f)
  if (!a || !a.length) return 0
  const v = a[a.length - 1]
  return typeof v === 'bigint' ? Number(v) : 0
}

/** 取最后一个字符串字段 */
function fStr(m, f) {
  const a = m.get(f)
  if (!a || !a.length) return ''
  const v = a[a.length - 1]
  return Buffer.isBuffer(v) ? v.toString('utf8').trim() : ''
}

/** 取最后一个子消息 */
function fBuf(m, f) {
  const a = m.get(f)
  if (!a || !a.length) return null
  const v = a[a.length - 1]
  return Buffer.isBuffer(v) ? v : null
}

/**
 * 解 SEND_GIFT_V2 的 pb。字段号是照着真实包对出来的（见 smoke 里钉住的那个样本）：
 *
 * 顶层： 1 uid / 2 uname / 3 face / 8 粉丝牌 / 10 礼物本体
 * 礼物本体（10）： 1 giftId / 2 giftName / 3 数量 / 5 单价 / 6 折后单价 /
 *                  8 coin_type / 10 时间戳(秒) / 14 总价 / 18 动作
 * 粉丝牌（8）：   1 牌子所属主播 uid / 5 等级 / 6 牌子名
 *
 * 单价和总价分开取：连击送 10 个的时候 `num=10`、`总价 = 单价×10`，
 * 只认其中一个都会把「¥1」和「¥10」搞混。
 */
function decodeSendGiftV2(base64) {
  if (typeof base64 !== 'string' || !base64) return null
  let buf
  try {
    buf = Buffer.from(base64, 'base64')
  } catch {
    return null
  }
  if (!buf || buf.length === 0) return null

  const top = readFields(buf)
  const uid = fNum(top, 1)
  const uname = fStr(top, 2)
  if (!uid && !uname) return null

  const gift = fBuf(top, 10) ? readFields(fBuf(top, 10)) : new Map()
  const medalRaw = fBuf(top, 8) ? readFields(fBuf(top, 8)) : new Map()

  const num = Math.max(1, fNum(gift, 3) || 1)
  const unit = fNum(gift, 6) || fNum(gift, 5)
  const medalName = fStr(medalRaw, 6)

  return {
    uid,
    uname,
    face: fStr(top, 3),
    giftId: fNum(gift, 1),
    giftName: fStr(gift, 2),
    num,
    /**
     * 总价（金瓜子）。
     *
     * 字段 14 是总价，6/5 是折后价/原价（单价）。**实测抓到的样本全是 ×1**，
     * 两种解释算出来一样，没法靠样本把两者彻底区分开 —— 所以这里
     * 「14 优先、单价×数量兜底」，两种解释下结果都一致，不会算出两个数。
     */
    totalCoin: fNum(gift, 14) || unit * num,
    coinType: fStr(gift, 8) || 'silver',
    action: fStr(gift, 18) || '投喂',
    timestamp: fNum(gift, 10) * 1000 || Date.now(),
    medal: medalName
      ? { name: medalName, level: fNum(medalRaw, 5), anchorUid: fNum(medalRaw, 1) }
      : null,
  }
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

/**
 * 礼物包。
 *
 * **老包是 `SEND_GIFT`，B站 现在推的是 `SEND_GIFT_V2`** ——
 * 这是「送了礼物但历史/播报都没有」的根因：包一直有到，只是没人接。
 *
 * 两者字段基本一致（`uid / uname / face / giftName / num / total_coin / coin_type`），
 * 所以共用一套解析。每个字段都留了从 `batch_combo_send` / `combo_send` 取的兜底 ——
 * 连击礼包有时候只在那边放名字和数量，读漏了就会显示成「投喂 ×0」。
 */
function normalizeGift(d) {
  const combo = d.batch_combo_send || d.combo_send || {}
  const giftName = String(d.giftName || d.gift_name || combo.gift_name || '').trim()
  const count = Math.max(1, Number(d.num ?? d.gift_num ?? combo.gift_num) || 1)
  // total_coin 的单位是金瓜子，1000 = 1 元
  const coin = Number(d.total_coin ?? d.combo_total_coin ?? 0) || 0
  return {
    type: 'gift',
    uid: Number(d.uid ?? combo.uid) || 0,
    username: String(d.uname || combo.uname || ''),
    face: String(d.face || ''),
    content: `${d.action || combo.action || '投喂'} ${giftName} ×${count}`,
    giftName,
    num: count,
    price: coin / 1000,
    coinType: String(d.coin_type || 'silver'),
    timestamp: Date.now(),
  }
}

function normalizeEvent(raw) {
  const cmd = raw.cmd
  const d = raw.data || {}

  switch (cmd) {
    case 'DANMU_MSG':
      return normalizeDanmaku(raw)

    // B站 现在推的是 SEND_GIFT_V2 —— 气泡里**只有** { dmscore, pb }，
    // 礼物名/数量/金额/送礼人全在那段 base64 protobuf 里（见 decodeSendGiftV2）。
    // 「送了礼物什么都没显示」的根因就是这里：扁平字段一个都不存在，
    // 不是包没到，是没人解。
    case 'SEND_GIFT_V2': {
      const pb = decodeSendGiftV2(d.pb)
      if (pb) {
        return {
          type: 'gift',
          uid: pb.uid,
          username: pb.uname,
          face: pb.face,
          content: `${pb.action} ${pb.giftName} ×${pb.num}`,
          giftName: pb.giftName,
          num: pb.num,
          price: pb.totalCoin / 1000,
          coinType: pb.coinType,
          medal: pb.medal,
          timestamp: pb.timestamp,
        }
      }
      // 没有 pb（老连接、回放、字段又变了）时退回扁平字段那条路 ——
      // 显示得糙一点，总好过整条消失
      return normalizeGift(d)
    }

    // 老的 JSON 包，留着兼容
    case 'SEND_GIFT':
      return normalizeGift(d)

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
  decodeSendGiftV2,
}
