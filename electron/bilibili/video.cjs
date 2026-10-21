'use strict'

/**
 * B 站视频（BV 号）相关。
 *
 * 观众在弹幕里发「点歌 BV1xx411c7mD」或者主播在点歌页粘个链接，
 * 就把这个视频当成一「首」歌塞进同一个队列 —— 所以这里负责：
 * 认出 BV 号、查基本信息（标题 / UP 主 / 封面 / 时长 / cid）、
 * 以及取**能直接喂 <video> 的整条播放地址**（videoPlayUrl）。
 *
 * 播放地址走 platform=html5 的网页端老接口（免 wbi 签名），拿到的是
 * 音视频混流的单条 mp4，渲染层的原生 <video> 直接播它 —— 暂停、进度、
 * 音量都是真控件。这条路要是哪天被 B 站堵了，取流失败会提示并跳下一首，
 * 队列不停摆。
 */

const net = require('../lib/net.cjs')

/** BV 号：BV + 10 位大小写字母数字（B 站的 BV 号是 base58，不含 0/I/O/l） */
const BVID_RE = /BV[0-9A-Za-z]{10}/g

/**
 * 可选清晰度（B 站的 qn 码）。
 *
 * 这张表是**请求用的档位**，不是「一定能拿到」：服务端按视频本身有的清晰度
 * 和当前身份（游客 / 登录 / 大会员）夹一次，结果在返回值的 `quality` 和
 * `accept_quality` 里。实测 platform=html5 这条老接口大多只认 16 和 64，
 * 要 1080P 也会被夹回 720P —— 所以界面上要显示实际拿到的那一档。
 *
 * 界面（src/pages/MusicPage.tsx 的 QUALITY_OPTIONS）跟这张表是镜像，
 * smoke 有断言盯着两边逐行一致。
 */
const QUALITY_OPTIONS = [
  { qn: 16, label: '360P' },
  { qn: 32, label: '480P' },
  { qn: 64, label: '720P' },
  { qn: 74, label: '720P60' },
  { qn: 80, label: '1080P' },
  { qn: 116, label: '1080P60' },
  { qn: 120, label: '4K' },
]

/** 认不出 / 没传就退回默认档（720P） */
function normalizeQuality(qn) {
  const n = Number(qn)
  return QUALITY_OPTIONS.some((o) => o.qn === n) ? n : 64
}

/** qn 码 → 「720P」这种给人看的字 */
function qualityLabel(qn) {
  const hit = QUALITY_OPTIONS.find((o) => o.qn === Number(qn))
  return hit ? hit.label : ''
}

/**
 * 从一段文本里抠出 BV 号。
 * 支持：裸 BV 号、`bilibili.com/video/BVxxx`、`?bvid=BVxxx`、以及带分 P 的链接。
 * 拿不到返回 null。
 */
function parseBvid(text) {
  const s = String(text || '')
  if (!s) return null
  // 先认链接里的 bvid 参数，再退回全文本里第一个长得像 BV 号的串
  const q = /[?&]bvid=(BV[0-9A-Za-z]{10})/i.exec(s)
  if (q) return q[1]
  const m = s.match(BVID_RE)
  return m && m[0] ? m[0] : null
}

/** 分 P：?p=2。默认是第 1 P */
function parsePage(text) {
  const m = /[?&]p=(\d{1,4})/.exec(String(text || ''))
  const n = m ? Number(m[1]) : 1
  return Number.isFinite(n) && n > 0 ? n : 1
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p2 = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p2(mm)}:${p2(ss)}` : `${mm}:${p2(ss)}`
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/**
 * 查一条视频的基本信息。
 *
 * **带登录身份查**：应用启动时就扫码登录过 B 站，那份凭据要复用 ——
 * 有些视频（会员专属、充电专属）游客查不到标题和 cid，带 Cookie 才能拿全。
 *
 * @param {string} bvid BV 号或视频链接
 * @param {{session?: {getJSON:Function}, mode?: string}} opts
 * @returns {Promise<{bvid:string, aid:number, cid:number, title:string, up:string, pic:string, duration:number, durationText:string}>}
 */
async function videoInfo(bvid, opts = {}) {
  const id = parseBvid(bvid)
  if (!id) throw new Error('没认出 BV 号 —— 发「点歌 BV号」或者贴视频链接')
  const page = parsePage(bvid) || 1
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(id)}`
  const headers = {
    // 不给 Referer 会被当成爬虫直接 -352
    Referer: 'https://www.bilibili.com/',
    'User-Agent': UA,
  }
  // 有登录会话就用会话发（自动带上 Cookie），没有就退回裸请求（游客也能查普通视频）
  const res = opts.session
    ? { ok: true, data: await opts.session.getJSON(url, { headers }) }
    : await net.httpJson(url, { timeoutMs: 15000, mode: opts.mode || 'system', headers })
  const d = res.data
  if (!res.ok || !d || d.code !== 0) {
    const msg = (d && (d.message || '')) || ''
    if (d && d.code === -404) throw new Error('这个 BV 号不存在（稿件已删除或号码写错了）')
    if (d && d.code === -352) throw new Error('被 B 站风控挡了一下，稍后再试')
    throw new Error(msg || `查不到这个视频（${res.status}）`)
  }
  const v = d.data || {}
  const pages = Array.isArray(v.pages) ? v.pages : []
  // 多 P 稿件：取 ?p=n 指定的那一 P，没有就第一 P
  const p = pages[Math.min(page, pages.length || 1) - 1] || null
  const cid = Number(p?.cid || v.cid || 0)
  if (!cid) throw new Error('这个视频没有可播放的分 P')
  return {
    bvid: v.bvid || id,
    aid: Number(v.aid || 0),
    cid,
    title: v.title || '未命名视频',
    up: v.owner?.name || '',
    pic: v.pic || '',
    duration: Number(p?.duration || v.duration || 0),
    durationText: fmtDuration(p?.duration || v.duration || 0),
    page: page,
  }
}

/**
 * 取一条**能直接喂给 <video> 标签**的播放地址（音频轨在内），用来给视频出声。
 *
 * 为什么需要它：画面用的是官方内嵌播放器（iframe），跨域 —— 我们既读不到它的
 * progress，也碰不到它的音量。主播要一个「能拖的音量」就只剩一条路：
 * 让内嵌播放器静音（URL 上带 muted=1），再由渲染层自己放一路同内容的音频出声。
 *
 * 为什么是 platform=html5：这个参数走的是网页端的老接口，**不校验 wbi 签名**，
 * 拿到的是一个 mp4（音频轨在里面，`<video>` 直接能播）。实测 BV1GJ411x7h7 →
 * 200 / code 0 / durl[1] / quality 64。
 *
 * 这条路未必永远有效（B 站改过好几次），所以**失败是允许的**：拿不到就退回
 * 「让内嵌播放器自己出声、音量去播放器里调」，视频照看不误。调用方把这里的
 * 报错当日志看就行，别当致命错误。
 *
 * @param {{bvid?:string, cid?:number|string}} item
 * @param {{session?: {getJSON:Function}, mode?: string, qn?: number|string}} opts
 *   opts.qn 是**请求的清晰度**（见 QUALITY_OPTIONS），不传按默认档（720P）。
 * @returns {Promise<{url:string, quality?:number, qualityLabel?:string, accept?:number[], requested?:number}>}
 *   quality 是**实际拿到**的那档 —— 可能被服务端夹低，界面显示它才不会骗人。
 */
async function videoPlayUrl(item, opts = {}) {
  const bvid = parseBvid((item && (item.bvid || item)) || '')
  const cid = Number(item && item.cid) || 0
  if (!bvid) throw new Error('缺 BV 号，取不了播放地址')
  const qn = normalizeQuality(opts.qn)
  const qs = [
    `bvid=${encodeURIComponent(bvid)}`,
    `cid=${cid}`,
    'platform=html5',
    'high_quality=1',
    `qn=${qn}`,
    'otype=json',
  ].join('&')
  const url = `https://api.bilibili.com/x/player/playurl?${qs}`
  const headers = {
    Referer: `https://www.bilibili.com/video/${bvid}`,
    'User-Agent': UA,
  }
  const res = opts.session
    ? { ok: true, data: await opts.session.getJSON(url, { headers }) }
    : await net.httpJson(url, { timeoutMs: 15000, mode: opts.mode || 'system', headers })
  const d = res.data
  if (!res.ok || !d || d.code !== 0) {
    const msg = (d && (d.message || '')) || ''
    if (d && d.code === -352) throw new Error('被 B 站风控挡了一下（拿不到音频流）')
    throw new Error(msg || `取播放地址失败（${res.status}）`)
  }
  const body = d.data || {}
  const accept = Array.isArray(body.accept_quality) ? body.accept_quality.slice() : []
  const got = () => ({
    requested: qn,
    accept,
    quality: Number(body.quality) || 0,
    qualityLabel: qualityLabel(Number(body.quality) || 0),
  })
  // html5 这条路给的是 durl（单文件 mp4，音视频都在里面）
  const durl = Array.isArray(body.durl) ? body.durl[0] : null
  if (durl && durl.url) return { url: durl.url, ...got() }
  // 万一只给了 DASH（接口变了），就从里面挑一条音频 —— 我们只要声音
  const dash = body.dash || {}
  const audio = Array.isArray(dash.audio) && dash.audio.length ? dash.audio[0] : null
  if (audio && (audio.baseUrl || audio.base_url)) {
    return { url: audio.baseUrl || audio.base_url, ...got() }
  }
  throw new Error('这个视频没给到可用的播放地址（可能是会员 / 充电专属）')
}

module.exports = {
  parseBvid,
  parsePage,
  fmtDuration,
  videoInfo,
  videoPlayUrl,
  BVID_RE,
  QUALITY_OPTIONS,
  normalizeQuality,
  qualityLabel,
}
