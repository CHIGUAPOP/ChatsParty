'use strict'
// session 用别名：同文件里 `session` 已经是 B站会话的变量了，撞名会直接编译不过
const { app, BrowserWindow, ipcMain, shell, dialog, session: electronSession } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const { Session, Wbi } = require('./lib/http.cjs')
const { BilibiliAPI } = require('./bilibili/api.cjs')
const { QrLogin, collectCredentials } = require('./bilibili/auth.cjs')
const { LiveClient } = require('./bilibili/live.cjs')
const { PROVIDERS, synthesize, listVoices, probeFish } = require('./tts.cjs')
const V = require('./voices.cjs')
const L = require('./llm.cjs')
const { shouldSpeakNow } = require('./speech-rules.cjs')
const { createSpeechControl } = require('./speech-control.cjs')
const NCM = require('./netease.cjs')
const net = require('./lib/net.cjs')
const { normalizeKey, describeKey, keySummary, keyWarnings, keyShapeWarnings } = require('./lib/keytext.cjs')
const { FaceResolver } = require('./faces.cjs')
const { Logger } = require('./log.cjs')
const { OverlayServer } = require('./overlay.cjs')
const { ConfigStore } = require('./store.cjs')
const pkg = require('../package.json')

// CP_PROD=1 可以在未打包时直接加载构建产物，方便验证生产路径
const isDev = !app.isPackaged && process.env.CP_PROD !== '1'
let win = null
let store = null
let session = null
let wbi = null
let api = null
let live = null
let overlay = null
let qrLogin = null
let log = null
// 网易云网页登录窗口（单例）。放在这里是为了关窗时能摘掉监听
let ncmWin = null
let ncmSession = null
// 是我们自己关的（登录成功）还是用户手动关的。用户手动关要通知界面解除「等待登录中」
let ncmClosedByUs = false
const NCM_LOGIN_PARTITION = 'persist:ncm-login'

// 播报队列和「跳过」状态机都在里面（electron/speech-control.cjs）
const speech = createSpeechControl()
let lastSpeakAt = 0

/* ------------------------------ 点歌 ------------------------------ */
// 队列放主进程：观众点歌是从弹幕来的，渲染进程可能根本没打开音乐页
const musicQueue = []
let musicCurrent = null

function musicSnapshot() {
  return { items: musicQueue.slice(), current: musicCurrent, queued: musicQueue.length }
}

function pushMusicState() {
  const snap = musicSnapshot()
  send('music:state', snap)
  // OBS 那边也要跟着变：换歌、有人点歌都得立刻反映到画面上
  if (overlay) overlay.broadcast('music', snap)
}

/** 取下一首来播。没有就置空 */
function musicAdvance() {
  musicCurrent = musicQueue.shift() || null
  return musicCurrent
}

/* ------------------------ 网易云网页登录 ------------------------ */

/** 登录窗口里用到的浏览器标识。带 Electron 字样容易被网站判成爬虫，伪装成普通 Chrome */
const NCM_LOGIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Cookie 罐里那份「登录凭证」有没有拿到。拿到就立刻存，不等用户点什么 */
async function tryCollectNeteaseCookie(reason) {
  if (!ncmSession) return false
  let jar = []
  try {
    jar = await ncmSession.cookies.get({ url: 'https://music.163.com' })
  } catch {
    return false
  }
  const cookie = NCM.cookieFromJar(jar)
  if (!cookie) return false

  store.patch({ music: { cookie } })
  log?.info('[music] 已从网页登录拿到 Cookie（' + reason + '）')
  // 顺手查一次账号，让界面能立刻显示「已登录 某某」，不用再点一次检测
  let account = null
  try {
    account = await NCM.accountInfo({ cookie, mode: (store.get().proxy?.mode === 'system' ? 'system' : 'direct') })
  } catch {
    /* 查不到不影响保存，界面会自己再查 */
  }
  send('music:login', {
    ok: true,
    cookie,
    nickname: account?.nickname || '',
    vip: Boolean(account?.vip),
  })
  closeNeteaseLogin()
  return true
}

function openNeteaseLoginWindow() {
  ncmSession = electronSession.fromPartition(NCM_LOGIN_PARTITION)

  // 登录页一写 Cookie 就会被通知到，比定时轮询及时得多
  const onCookieChanged = (event, cookie, cause, removed) => {
    if (removed || !cookie || cookie.name !== 'MUSIC_U') return
    tryCollectNeteaseCookie(cause === 'explicit' ? '页面写入' : '登录成功')
  }
  ncmSession.cookies.on('changed', onCookieChanged)

  const w = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    title: '登录网易云音乐 · ChatsParty',
    parent: win && !win.isDestroyed() ? win : undefined,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    ...appIcon(),
    webPreferences: {
      // 独立分区：和主窗口的 Cookie 隔开，也不会被别的站点串
      partition: NCM_LOGIN_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      // 官网自己的页面要跑脚本，不能禁；它不是我们渲染层，不存在注入风险
      sandbox: false,
    },
  })
  w.webContents.setUserAgent(NCM_LOGIN_UA)

  // 兜底：cookie 事件万一漏了，页面每次跳完转也再看一眼
  w.webContents.on('did-navigate', () => tryCollectNeteaseCookie('页面跳转'))
  w.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code === -102 || /CONNECTION|NAME_NOT_RESOLVED|TIMEOUT/i.test(String(desc))) {
      send('music:login', { ok: false, message: '打不开网易云官网，检查网络后重试' })
    }
  })

  w.on('closed', () => {
    if (ncmSession) {
      ncmSession.cookies.removeListener('changed', onCookieChanged)
      ncmSession = null
    }
    ncmWin = null
    // 用户半路把窗口关了（没登录成功）也要回一声，否则界面一直卡在「等待登录中」。
    // 登录成功那条路径是我们自己 close 的，ncmClosedByUs 为真，这里就不要再报「取消」。
    if (!ncmClosedByUs) send('music:login', { ok: false, cancelled: true, message: '已取消登录' })
    ncmClosedByUs = false
  })

  w.loadURL('https://music.163.com/#/login')
  return w
}

function closeNeteaseLogin() {
  if (ncmWin && !ncmWin.isDestroyed()) {
    ncmClosedByUs = true
    ncmWin.close()
  }
}

/** 点歌：从搜索结果里挑一首能播的，放进队列 */
function musicEnqueue(song, requester) {
  const cfg = store.get()
  const m = cfg.music || {}
  const max = Number(m.maxQueue) || 20
  if (musicQueue.length >= max) return { ok: false, reason: 'full' }
  musicQueue.push({
    id: Number(song.id),
    name: song.name || '',
    artists: song.artists || '',
    durationText: song.durationText || '',
    picUrl: song.picUrl || '',
    requester: requester || '',
    at: Date.now(),
  })
  // 队列空着并且开着自动播放 → 立刻开播
  if (!musicCurrent && m.autoPlay !== false) musicAdvance()
  pushMusicState()
  return { ok: true, position: musicQueue.length }
}
const lastTextAt = new Map()
const userLastSpeak = new Map()

// { 观众标识: 上次点歌时间 }，防止一个人把歌单刷满
const musicCooldown = new Map()

const faceQueue = []
let faceBusy = 0
// 头像 bytes 的解析结果，原 URL -> data URL，跨事件复用
let faces = null
const faceDispatched = new Set()

/**
 * B站图床有防盗链，界面这边（file:// 或 OBS 的 127.0.0.1）直接 <img src> 会拿到 403。
 * 统一由主进程带 Referer 抓回来转成 data: 地址，一个 URL 只抓一次。
 */
function ensureFace(src) {
  if (!src || faceDispatched.has(src)) return
  faceDispatched.add(src)
  if (!faces) faces = new FaceResolver()
  faces
    .resolve(src)
    .then((data) => {
      if (!data) {
        log?.warn('[face] 下载失败（图床防盗链或网络问题）', src.slice(0, 70))
        return
      }
      send('live:face', { src, data })
      if (overlay) overlay.broadcast('face', { src, data })
    })
    .catch(() => {})
}

// 观众最近一次搜索的结果，供「#绑定 3」这种按序号选；超过 5 分钟作废
const searchCache = new Map()
const SEARCH_TTL = 5 * 60 * 1000
// 命令冷却，防止有人连着刷把 API 额度打满。
// 键是「谁 + 哪条指令」：同一个人换完音色还能马上反悔，但同一条指令不能连刷。
const commandCooldown = new Map()
// 被冷却挡下时发过一次提示就别再发，否则刷屏的人能把回执刷满
const cooldownNotice = new Map()

/**
 * 命令冷却时长（毫秒）。
 * 界面上那个滑块的 min 就是 0，语义是「不限制」，所以这里不能再用 `|| 5000` ——
 * `0 || 5000` 等于 5000，用户把滑块拖到 0 却一点变化都看不到。
 */
function cooldownOf(policy) {
  const n = Number(policy?.cooldownMs)
  if (!Number.isFinite(n) || n < 0) return 5000
  return n
}
// 每天的音色设计额度，跨天自动重置
let designState = { date: '', used: 0 }
// 往直播间发回执要节流，发太快会被 B站判定刷屏
let lastReplyAt = 0

/* ------------------------------- 窗口 ------------------------------- */

/**
 * 窗口与任务栏图标。
 *
 * 开发时读仓库里的 `build/icon.png`；打包后这个文件不在 asar 里（exe 自带图标，
 * 由 electron-builder 用 `build/icon.ico` 烧进去），所以必须先 existsSync 兜一下——
 * 直接把不存在的路径交给 Electron，控制台会一直刷 "Failed to load image" 警告。
 */
function appIcon() {
  const p = path.join(__dirname, '..', 'build', 'icon.png')
  return fs.existsSync(p) ? { icon: p } : {}
}

function createWindow() {
  const cfg = store.get()
  win = new BrowserWindow({
    width: cfg.window?.width || 1180,
    height: cfg.window?.height || 780,
    minWidth: 960,
    minHeight: 640,
    title: 'ChatsParty · 弹幕姬',
    backgroundColor: '#101014',
    autoHideMenuBar: true,
    ...appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  win.on('resize', () => {
    const [w, h] = win.getSize()
    store.patch({ window: { width: w, height: h } })
  })

  if (isDev) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level === 'error' || level === 3 || level === 2) {
        console.log(`[renderer:${level}] ${message} @ ${sourceId}:${line}`)
      }
    })
    win.webContents.on('did-fail-load', (_e, code, desc) => console.log(`[renderer] 加载失败 ${code} ${desc}`))
    win.loadURL('http://127.0.0.1:5180')
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'))
  }
}

/**
 * 关窗后主进程的那几个定时器/队列还会再跑几拍，
 * 此时 webContents 已经没了，直接 send 会抛 "Render frame was disposed"。
 */
function send(channel, payload) {
  try {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  } catch {
    /* 窗口已经在关闭了，丢掉这一帧就行 */
  }
}

/**
 * 主进程自己改了配置时要回传给界面。
 * 界面上的 config 只在它自己调 patch 时才更新 —— 主进程（连接成功写入房间信息、
 * 兜底模型改写、叠加层端口顺延）改的那份，界面永远看不到，还一直显示旧值。
 */
function pushConfig() {
  send('config:changed', store.get())
}

/* ---------------------------- B站 会话初始化 ---------------------------- */

function ensureSession() {
  if (session) return
  session = new Session()
  wbi = new Wbi(session)
  api = new BilibiliAPI(wbi, session)
  api.onFaceMiss = (mid, why) => log?.warn('[face] 头像补查失败', { mid, why })

  const cred = store.get().credentials || {}
  const halfYear = 15552000
  const twoYear = 63072000
  if (cred.SESSDATA) {
    session.jar.set(`SESSDATA=${encodeURIComponent(cred.SESSDATA)}; Domain=.bilibili.com; Path=/; Max-Age=${halfYear}`)
  }
  if (cred.bili_jct) session.jar.set(`bili_jct=${cred.bili_jct}; Domain=.bilibili.com; Path=/; Max-Age=${halfYear}`)
  if (cred.DedeUserID) session.jar.set(`DedeUserID=${cred.DedeUserID}; Domain=.bilibili.com; Path=/; Max-Age=${halfYear}`)
  if (cred.buvid3) session.jar.set(`buvid3=${cred.buvid3}; Domain=.bilibili.com; Path=/; Max-Age=${twoYear}`)
  if (cred.buvid4) session.jar.set(`buvid4=${cred.buvid4}; Domain=.bilibili.com; Path=/; Max-Age=${twoYear}`)

  if (cred.SESSDATA) {
    log?.info('[auth] 恢复已保存凭据', {
      DedeUserID: cred.DedeUserID,
      savedAt: cred.savedAt ? new Date(cred.savedAt).toLocaleString('zh-CN') : 0,
    })
  }
  if (store.loadError) log?.error('[store] 上次保存的配置文件没能读回来', store.loadError)
}

/**
 * 把当前 Cookie 罐里的凭据落盘。
 *
 * 关键是「不破坏」：拿到的新值为空但本地已有值时保持原样。
 * 以前的写法无条件覆盖，任何一次在凭据还没建立时触发的保存，都会把登录状态洗掉。
 *
 * @param {'merge'|'overwrite'} policy merge=保留旧值，overwrite=无条件写（退出登录用）
 */
function persistCredentials(policy = 'merge') {
  const current = collectCredentials(session)
  const saved = store.get().credentials || {}
  const next = { ...current }

  if (policy === 'merge') {
    for (const k of ['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4']) {
      if (!next[k] && saved[k]) next[k] = saved[k]
    }
  }

  const had = Boolean(saved.SESSDATA)
  const has = Boolean(next.SESSDATA)
  // 既没有新增也没有变化就不用反复写盘
  if (policy === 'merge' && had === has && next.SESSDATA === saved.SESSDATA && next.bili_jct === saved.bili_jct) {
    return false
  }

  next.refreshToken = saved.refreshToken || ''
  next.savedAt = Date.now()
  const ok = store.patch({ credentials: next })
  if (store.saveError) {
    log?.error('[auth] 凭据保存失败', store.saveError)
    return false
  }
  log?.info('[auth] 凭据已写入', { has, DedeUserID: next.DedeUserID || '', ok: Boolean(ok) })
  // 连接页要显示「已保存到本机（时间）」，这份 savedAt 是主进程写的
  pushConfig()
  return true
}

/** 每次拿到「确实已登录」的响应都顺手补一次持久化，防止某次写入时机错过 */
function rememberIfLoggedIn(navData) {
  if (navData?.isLogin) persistCredentials('merge')
  return Boolean(navData?.isLogin)
}

/* ------------------------------ 头像补全 ------------------------------ */

function enqueueFace(uid, cb) {
  if (!uid) return cb?.('')
  faceQueue.push({ uid, cb })
  pumpFace()
}

function pumpFace() {
  while (faceBusy < 2 && faceQueue.length) {
    const job = faceQueue.shift()
    faceBusy++
    api
      .getUserFace(job.uid)
      .then((face) => job.cb?.(face))
      .catch(() => job.cb?.(''))
      .finally(() => {
        faceBusy--
        setTimeout(pumpFace, 120)
      })
  }
}

/* ------------------------------ 弹幕接入 ------------------------------ */

async function startLive(roomIdInput) {
  ensureSession()
  stopLive()

  const roomId = Number(String(roomIdInput).trim())
  if (!roomId) throw new Error('请填写直播间号')

  send('live:status', { status: 'connecting', roomId })
  let info
  try {
    info = await api.getRoomInfo(roomId)
  } catch (e) {
    send('live:status', { status: 'error', message: e.message })
    throw e
  }

  const realRoomId = info.room_id || roomId
  // 主播 uid：room/v1/Room/get_info 的 data.uid 就是主播 uid（已和 getInfoByRoom 的
  // room_info.uid 对过）。存进配置是为了「需要粉丝牌」这类开关能把主播本人放行 ——
  // 弹幕包里没有任何「我是主播」的标记，只能靠这个 uid 比对。
  const anchorUid = Number(info.uid) || 0
  const roomBefore = store.get().room || {}
  const sameAnchor = Number(roomBefore.anchorUid) === anchorUid
  store.patch({
    room: {
      roomId: String(roomId),
      realRoomId,
      title: info.title || '',
      anchorUid,
      // get_info **不返回** anchor_info（实测字段不存在，所以这里以前一直是空串），
      // 主播名得拿 uid 去 card 接口补；换房间时先清掉上一家的名字
      anchor: sameAnchor ? roomBefore.anchor || '' : '',
    },
  })
  // 房间标题/主播名是主进程拉到的，不回传的话顶栏和连接页一直显示上一次的
  pushConfig()
  // 补主播名：不阻塞连接，拿不到就算了（顶栏少一行字，不影响任何功能）
  if (anchorUid) {
    api
      .getUserName(anchorUid)
      .then((name) => {
        // 拿到的是不是当前房间的主播：这中间用户可能已经切房间了
        if (name && Number(store.get().room?.anchorUid) === anchorUid) {
          store.patch({ room: { anchor: name } })
          pushConfig()
        }
      })
      .catch(() => {})
  }

  const uid = Number(session.jar.get('DedeUserID') || 0)
  live = new LiveClient({ api, roomId: realRoomId, uid })

  live.on('status', (status) => send('live:status', { status, roomId: realRoomId }))
  live.on('popularity', (p) => send('live:popularity', { popularity: p }))
  live.on('error', (e) => send('live:error', { message: e.message || String(e) }))
  live.on('event', (ev) => onLiveEvent(ev))

  await live.start()
  return { realRoomId, title: info.title || '' }
}

function stopLive() {
  if (live) {
    live.stop()
    live = null
  }
  send('live:status', { status: 'idle' })
}

function onLiveEvent(ev) {
  // 头像兜底：弹幕消息不一定自带 face，异步补一次再推给前端
  if (ev.uid && !ev.face && ev.type === 'danmaku') {
    enqueueFace(ev.uid, (face) => {
      ev.face = face || ''
      dispatchEvent(ev)
    })
  } else {
    dispatchEvent(ev)
  }
}

function dispatchEvent(ev) {
  const enriched = { ...ev, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
  if (enriched.face) ensureFace(enriched.face)
  send('live:event', enriched)
  if (overlay) overlay.broadcast('event', enriched)
  maybeSpeak(enriched)
}

/* --------------------------- 音色绑定与命令 --------------------------- */

const REPLY_MAX = 20 // B站单条弹幕的字符上限，回执写长了发不出去

function clipReply(s, n = REPLY_MAX) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
}

/** 点歌触发词里挑一个用来教观众（可能配了多个，取第一个） */
function musicTriggerWord(cfg) {
  const list = Array.isArray(cfg?.music?.commands) ? cfg.music.commands.filter((x) => String(x || '').trim()) : []
  return list[0] || '点歌'
}

/**
 * 谁是「不受音色开关限制的人」。
 *
 * 房管的身份位在弹幕包里（info[2][2] → ev.isAdmin），这部分照旧。
 * **主播却没有任何标记**：实测当前协议下 DANMU_MSG 不带 identities（identity 字段只在
 * 进场事件里，而且是 packed 编码），主播自己身上也没有自己房间的粉丝牌（info[3] 为空）。
 * 所以主播只能靠 uid 比对认出来：房间信息里的主播 uid + 本机登录账号的 uid
 * （弹幕姬是主播自己开的，正常情况下这两个是同一个号）。
 *
 * 不这么做的话，一开「需要粉丝牌才能换音色」，主播连自己都换不了音色 ——
 * 而且报错文案还会说「要 N 级粉丝牌」，主播只会更懵：他哪来的自己房间的牌子。
 */
function privilegedUids() {
  const out = new Set()
  try {
    const own = Number(session?.jar.get('DedeUserID') || 0)
    if (own) out.add(own)
  } catch {
    /* 还没建会话就当作没登录 */
  }
  const anchor = Number(store.get()?.room?.anchorUid || 0)
  if (anchor) out.add(anchor)
  return out
}

function isPrivileged(ev) {
  if (ev?.isAdmin) return true
  // uid 0 是所有「没解出来」的兜底值，绝不能拿它去撞集合
  const uid = Number(ev?.uid) || 0
  if (!uid) return false
  return privilegedUids().has(uid)
}

/** 谁来播出都行，Key 不落到每条档案里，换 Key 时所有档案自动生效 */
function keyForPlatform(platform) {
  const cfg = store.get()
  if (platform === 'fish') return normalizeKey(cfg.platformKeys?.fish)
  if (platform === 'openai') return normalizeKey(cfg.platformKeys?.openai)
  return normalizeKey(cfg.tts?.apiKey)
}

/**
 * 当前实际会用的 Fish 音色。
 * 校验 Key 时要用它真合成一次 —— 合成接口少了 voiceId 只会回 400，
 * 那个 400 和 Key 没有任何关系，不带上音色就等于自己造一个假故障出来。
 */
function currentFishVoice(cfg) {
  if (cfg.tts?.provider === 'fish' && cfg.tts?.voice) return String(cfg.tts.voice)
  const hit = (cfg.voiceLibrary || []).find((p) => p.platform === 'fish' && p.voice && p.enabled !== false)
  return hit ? String(hit.voice) : ''
}

/**
 * 密钥入库前统一清洗。
 * 从网页复制密钥时经常连带零宽字符、换行、全角空格，甚至整段
 * `Authorization: Bearer xxx`。这些在界面上看不出任何区别，但一定会让平台回 401。
 * 所以这里直接洗干净存下来，并把「动了什么」告诉用户，别让他蒙在鼓里。
 */
function sanitizeSecrets(patch) {
  const notes = []
  if (!patch || typeof patch !== 'object') return notes
  const scrub = (raw, label) => {
    const warns = keyWarnings(raw)
    const clean = normalizeKey(raw)
    if (warns.length) notes.push(`${label} ${warns.join('、')}，已自动清理`)
    return clean
  }
  if (patch.platformKeys && typeof patch.platformKeys === 'object') {
    if (typeof patch.platformKeys.fish === 'string') {
      patch.platformKeys.fish = scrub(patch.platformKeys.fish, 'Fish Audio Key')
      keyShapeWarnings(patch.platformKeys.fish, 'fish').forEach((w) =>
        notes.push(`Fish Audio Key ${w}`),
      )
    }
    if (typeof patch.platformKeys.openai === 'string') patch.platformKeys.openai = scrub(patch.platformKeys.openai, 'OpenAI Key')
  }
  if (patch.tts && typeof patch.tts.apiKey === 'string') {
    patch.tts.apiKey = scrub(patch.tts.apiKey, 'TTS Key')
  }
  // 界面上承诺「粘贴时混进的零宽字符会在保存时自动清掉」，LLM 那把也得算进去
  if (patch.llm && typeof patch.llm.apiKey === 'string') {
    patch.llm.apiKey = scrub(patch.llm.apiKey, 'LLM Key')
  }
  // Cookie 不能按 Key 那套洗（它本身带空格和分号），但换行和零宽字符必须去掉
  if (patch.music && typeof patch.music.cookie === 'string') {
    const before = patch.music.cookie
    const clean = before.replace(/[\r\n\t]/g, '').replace(/[\u200b-\u200f\ufeff]/g, '').trim()
    if (clean !== before) {
      patch.music.cookie = clean
      notes.push('网易云 Cookie 里的换行或不可见字符已清掉')
    }
    // 只粘了 MUSIC_U 的值（没有「名=值」结构）也认，补上前缀，省得用户自己拼
    const cur = patch.music.cookie
    if (cur && !cur.includes('=') && !cur.includes(';')) {
      patch.music.cookie = `MUSIC_U=${cur}`
      notes.push('已把单独的 MUSIC_U 值补成完整 Cookie')
    }
  }
  return notes
}

function profileCfg(p) {
  const speed = Number(p.speed) || 1
  const cfg = store.get()
  return {
    provider: p.platform,
    protocol: p.protocol,
    // 平台地址以全局配置为准，换了镜像 / 中转时所有已注册音色一起生效
    baseUrl: cfg.platformBase?.[p.platform] || p.baseUrl,
    apiKey: keyForPlatform(p.platform),
    // 界面上统一指定的模型优先：换了模型不用把已注册的音色重新注册一遍
    model: cfg.platformModel?.[p.platform] || p.model,
    voice: p.voice,
    format: p.format,
    speed,
    volume: Number(cfg.tts?.volume) || 0.9,
    // 跟全局语音设置一致，别让配了音色的人改音高改了个寂寞
    pitch: cfg.tts?.pitch || '+0Hz',
    rate: `${speed >= 1 ? '+' : '-'}${Math.abs(Math.round((speed - 1) * 100))}%`,
    mimoMode: p.mimoMode || 'preset',
    designPrompt: p.designPrompt || '',
    cloneFile: p.cloneFile || '',
    proxy: cfg.proxy,
    platformBase: cfg.platformBase,
  }
}

/**
 * Fish 的合成可能是由兜底模型救回来的（付费模型 401 → 免费模型成功）。
 * 把救回来的那个模型记进配置，之后每条弹幕都直接用它 —— 否则每条都要先撞一次墙。
 */
function rememberFishModel(usedCfg, audio) {
  if (!audio || usedCfg?.provider !== 'fish' || !audio.fallback || !audio.model) return
  const cfg = store.get()
  if (String(cfg.platformModel?.fish || '') === audio.model) return
  store.patch({ platformModel: { fish: audio.model } })
  pushConfig() // 让音色页的「Fish 模型」下拉显示真正生效的那个
  log?.warn(`[fish] ${usedCfg.model} 被拒，已自动改用 ${audio.model} 并记录到配置`)
}

function currentProfileOf(uid) {
  const cfg = store.get()
  if (!cfg.voicePolicy?.enabled || uid == null) return null
  const pid = cfg.voiceBindings?.[uid] || cfg.voiceBindings?.[String(uid)]
  if (!pid) return null
  return (cfg.voiceLibrary || []).find((p) => p.id === pid && p.enabled !== false) || null
}

/** 同一个平台的同一个音色只留一条档案，不同观众共用 */
function ensureProfile(voice) {
  const cfg = store.get()
  const lib = cfg.voiceLibrary || []
  const exist = lib.find((p) => p.platform === voice.source && p.voice === voice.id && p.mimoMode !== 'design')
  if (exist) return exist
  const p = V.profileFromVoice({ source: voice.source, voice, cfg })
  store.patch({ voiceLibrary: [...lib, p] })
  sendLibraryChanged()
  return p
}

function bindProfile(uid, profile, name) {
  const cfg = store.get()
  const bindings = { ...(cfg.voiceBindings || {}) }
  bindings[uid] = profile.id
  store.patch({ voiceBindings: bindings })
  return true
}

function unbindUser(uid) {
  const cfg = store.get()
  const bindings = { ...(cfg.voiceBindings || {}) }
  const pid = bindings[uid] ?? bindings[String(uid)]
  if (pid != null) {
    delete bindings[uid]
    delete bindings[String(uid)]
  }
  // 观众自己设计的音色跟着一起删，公共音色的档案留着给别人用
  const lib = (cfg.voiceLibrary || []).filter((p) => !(pid && p.id === pid && p.owner === 'audience'))
  store.patch({ voiceBindings: bindings, voiceLibrary: lib })
  sendLibraryChanged()
  return Boolean(pid)
}

function sendLibraryChanged() {
  const cfg = store.get()
  // 音色库是用户自己攒出来的东西，丢了只能重来。每次变更都记一笔数量，
  // 下次真要出问题，日志里能直接看出「谁把它写没了」。
  log?.info(
    '[voices] 音色库变更',
    `库 ${(cfg.voiceLibrary || []).length}`,
    `绑定 ${Object.keys(cfg.voiceBindings || {}).length}`,
  )
  send('voices:changed', {
    library: cfg.voiceLibrary || [],
    bindings: cfg.voiceBindings || {},
  })
}

let replyChain = Promise.resolve()

/** 往直播间发命令回执。串行 + 节流，避免连发触发 B站刷屏风控。 */
function replyChat(text) {
  replyChain = replyChain.then(async () => {
    const cfg = store.get()
    if (!cfg.voicePolicy?.replyInChat) return
    const roomId = cfg.room?.realRoomId || Number(cfg.room?.roomId)
    if (!roomId || !session || !api) return
    try {
      const wait = Math.max(0, 2000 - (Date.now() - lastReplyAt))
      if (wait) await new Promise((r) => setTimeout(r, wait))
      await api.sendDanmaku({
        roomId,
        message: clipReply(text),
        color: 16777215,
        fontSize: 25,
        mode: 1,
      })
      lastReplyAt = Date.now()
    } catch (e) {
      console.warn('[voice-command] 回执发送失败：', e.message)
    }
  })
  return replyChain
}

async function pickVoiceForBind(ev, arg, policy) {
  const uid = ev.uid || 0
  const cache = searchCache.get(uid)
  const fresh = cache && Date.now() - cache.at < SEARCH_TTL ? cache.voices : null

  const num = Number(arg)
  if (arg && Number.isFinite(num) && num >= 1 && fresh) {
    return fresh[Math.floor(num) - 1] || null
  }
  const kw = String(arg).trim().toLowerCase()
  if (fresh) {
    const hit = fresh.find(
      (v) =>
        String(v.name).toLowerCase() === kw ||
        String(v.id).toLowerCase() === kw ||
        String(v.name).toLowerCase().includes(kw),
    )
    if (hit) return hit
  }
  // 上次搜索的结果不算了（或者压根没搜过），直接在线找
  const cfg = store.get()
  const local = V.findByName(cfg.voiceLibrary || [], arg)
  if (local) return { source: local.platform, id: local.voice, name: local.name }
  if (policy.allowSearch === false) return null
  const r = await V.searchEverywhere(policy.searchSources, { keyword: arg, limit: 1, cfg })
  return r.ok ? r.voices[0] || null : null
}

async function handleVoiceCommand(ev, cmd, policy) {
  const cfg = store.get()
  const uid = ev.uid || 0
  const name = ev.username || '观众'
  const need = cmd.kind === 'design' ? 'design' : cmd.kind === 'bind' ? 'bind' : cmd.kind === 'unbind' ? 'unbind' : ''
  const perm = V.checkPermission(ev, policy, { need, isPrivileged: isPrivileged(ev) })
  if (!perm.ok) {
    await replyChat(`${name}，${perm.reason}`)
    return
  }
  // 回执里提到的指令名必须跟着主播改过的名字走，否则主播改名后
  // 机器人教的还是旧词，观众照着发只会没反应
  const N = (kind) => V.primaryName(cfg, kind)

  switch (cmd.kind) {
    case 'help':
      await replyChat(`换音色：${policy.prefix}${N('list')} 关键词，再${policy.prefix}${N('bind')} 序号`)
      return

    case 'query': {
      const p = currentProfileOf(uid)
      await replyChat(p ? `${name}的音色：${p.name}` : `${name}还没绑定音色`)
      return
    }

    case 'list': {
      if (policy.allowSearch === false) {
        await replyChat('主播没开放音色搜索')
        return
      }
      const r = await V.searchEverywhere(policy.searchSources, {
        keyword: cmd.arg,
        limit: Number(policy.searchLimit) || 6,
        cfg,
      })
      if (!r.ok || !r.voices.length) {
        await replyChat(cmd.arg ? `没搜到「${clipReply(cmd.arg, 8)}」` : '暂时没有可用音色')
        return
      }
      searchCache.set(uid, { at: Date.now(), voices: r.voices })
      let line = ''
      for (let i = 0; i < r.voices.length; i++) {
        const piece = `${i + 1}${r.voices[i].name} `
        if (clipReply(line + piece + `${policy.prefix}${N('bind')}序号`).length > REPLY_MAX + 6) break
        line += piece
      }
      await replyChat(`${line.trim()}${policy.prefix}${N('bind')}序号`)
      return
    }

    case 'bind': {
      if (!cmd.arg) {
        await replyChat(`要指定哪个？发${policy.prefix}${N('list')} 关键词`)
        return
      }
      const voice = await pickVoiceForBind(ev, cmd.arg, policy)
      if (!voice) {
        await replyChat(`没找到「${clipReply(cmd.arg, 8)}」`)
        return
      }
      const profile = ensureProfile(voice)
      bindProfile(uid, profile)
      await replyChat(`${name}的音色已设为${clipReply(profile.name, 10)}`)
      // 立刻用新音色念一句，让观众听见效果
      previewBinding(profile, name)
      return
    }

    case 'design': {
      if (!cmd.arg) {
        await replyChat(`描述一下想要的声音，例如${policy.prefix}${N('design')} 温柔的御姐音`)
        return
      }
      const q = V.designQuota({ ...designState, limit: policy.dailyDesignLimit })
      if (!q.ok) {
        await replyChat('今天的音色设计额度用完了')
        return
      }
      if (!String(cfg.tts?.apiKey || '').trim()) {
        await replyChat('主播还没配置 MiMo 的 Key')
        return
      }
      designState = { date: q.today, used: q.used + 1 }
      // 先让文本大模型按公式把粗糙要求补全成一段结构化描述。
      // 失败（没填 Key / 超时 / Key 无效）一律回落到原话，绝不让观众的设计请求落空。
      let promptText = cmd.arg
      let expanded = false
      if (L.ready(cfg).ok) {
        try {
          const r = await L.expandDesign(cmd.arg, cfg)
          if (r.used && r.text) {
            promptText = r.text
            expanded = true
            log?.info('[design] LLM 扩写', `${cmd.arg.slice(0, 20)} → ${r.text.slice(0, 40)}`)
          }
        } catch (e) {
          log?.warn('[design] LLM 扩写失败，用原话兜底', e.message)
        }
      }
      // 写库之前重新读一次：命令是异步处理的，这中间主播可能刚在界面上注册了新音色，
      // 用开头那份快照去覆盖会把人家刚加的东西写没
      const fresh = store.get()
      const lib = fresh.voiceLibrary || []
      const mine = lib.find((p) => p.ownerUid === uid && p.mimoMode === 'design')
      const p = V.makeDesignProfile({
        ownerUid: uid,
        ownerName: name,
        prompt: promptText,
        rawPrompt: cmd.arg,
        expanded,
        tts: fresh.tts,
      })
      store.patch({
        voiceLibrary: [...lib.filter((x) => x.id !== (mine && mine.id)), p],
        voiceBindings: { ...(fresh.voiceBindings || {}), [uid]: p.id },
      })
      sendLibraryChanged()
      await replyChat(expanded ? `${name}的专属音色已生成：${clipReply(promptText, 24)}` : `${name}的专属音色已生成`)
      previewBinding(p, name)
      return
    }

    case 'unbind': {
      const done = unbindUser(uid)
      await replyChat(done ? `${name}已恢复默认音色` : `${name}本来就没绑定音色`)
      // 真解掉了才念：否则连刷「#删除音色」会一遍遍出声，成了刷屏工具
      if (done) previewDefault(name)
      return
    }
  }
}

/**
 * 观众发「点歌 歌名」时走这里。
 * 注意这里**不做**命令冷却（voicePolicy 那套 5 秒冷却是给音色指令的，点歌有自己的节流），
 * 否则一个人点完歌会连累他后面发的所有指令。
 */
async function handleMusicRequest(ev, keyword) {
  const cfg = store.get()
  const m = cfg.music || {}
  const kw = String(keyword || '').trim()
  if (!kw) return
  if (kw.length > (Number(m.maxKeywordLength) || 30)) return

  const name = ev.username || '观众'
  // 一个人刷屏点歌会把歌单塞满 —— 按人节流
  const id = ev.uid || ev.username || 'anon'
  const now = Date.now()
  const prev = musicCooldown.get(id) || 0
  const cd = Number(m.perUserCooldownMs) || 30000
  if (now - prev < cd) return
  musicCooldown.set(id, now)
  for (const [k, v] of musicCooldown) if (now - v > 600000) musicCooldown.delete(k)

  try {
    const songs = await NCM.searchMusic(kw, { limit: 5, cookie: m.cookie, mode: net.resolveMode('netease', cfg) })
    // 优先能播的；全都不能播就回一句，别塞进队列白等。
    // 这里要分清两种「点不了」：压根没搜到 vs 搜到了但受会员/付费限制 —— 后者用户换个版本就能解决
    const pick = songs.find((s) => s.playable) || null
    if (!pick) {
      if (m.replyInChat !== false) {
        const msg = songs.length
          ? `搜到了「${songs[0].name}」，但它需要会员或付费 —— 换个版本试试`
          : `没找到「${kw}」这首歌，换个名字试试`
        await replyChat(msg)
      }
      return
    }
    const r = musicEnqueue(pick, name)
    if (!r.ok) {
      if (m.replyInChat !== false) await replyChat('歌单满了，等主播放完几首再来')
      return
    }
    if (m.replyInChat !== false) {
      await replyChat(`已点歌：${pick.name} - ${pick.artists}（第 ${r.position} 位）`)
    }
    // 念一句，主播不用盯着屏幕也知道有人点了歌
    if (m.announce !== false && cfg.tts?.enabled) {
      if (speech.queue.length > 24) speech.queue.shift()
      speech.queue.push({
        text: `${name}点了一首${pick.name}`,
        style: cfg.tts.stylePrompt || '',
        meta: { type: 'music' },
      })
      pumpSpeech()
    }
  } catch (e) {
    console.warn('[music] 点歌失败：', e.message)
    if (m.replyInChat !== false) await replyChat('点歌服务这会儿不太顺，稍后再试')
  }
}

/** 绑定完成后念一句确认词，用的是新音色本身 */
function previewBinding(profile, name) {
  if (speech.queue.length > 24) speech.queue.shift()
  speech.queue.push({
    text: `${name}换音色了，现在是这样`,
    style: profile.stylePrompt || '',
    profile,
    meta: { type: 'voice-preview' },
  })
  pumpSpeech()
}

/**
 * 解绑之后用**全局默认音色**念一句。
 *
 * 换音色能立刻听见效果，解绑却只有一行文字回执 —— 观众（和主播）根本没法确认
 * 「默认音色到底回来没有」，只能靠下一条弹幕去猜。给个同样的一句，闭环才算合上。
 * profile 为 null 是有意的：这就是「回落到全局默认」那条路径本身。
 */
function previewDefault(name) {
  const t = store.get().tts || {}
  if (!t.enabled) return
  if (speech.queue.length > 24) speech.queue.shift()
  speech.queue.push({
    text: `${name}换回默认音色了，现在是这样`,
    style: t.stylePrompt || '',
    profile: null,
    meta: { type: 'voice-preview' },
  })
  pumpSpeech()
}

/* ------------------------------ 播报过滤 ------------------------------ */

function isBlocked(text, blockWords) {
  if (!blockWords) return false
  const words = String(blockWords)
    .split(/[,，\n]/)
    .map((w) => w.trim())
    .filter(Boolean)
  const lower = text.toLowerCase()
  return words.some((w) => lower.includes(w.toLowerCase()))
}

function buildSpeechText(ev, t) {
  const name = ev.username || '一位观众'
  switch (ev.type) {
    case 'danmaku':
      return t.readUsername ? `${name}说，${ev.content}` : ev.content
    case 'gift':
      return `感谢 ${name} 的 ${ev.giftName || '礼物'}`
    case 'guard':
      return `感谢 ${name} 开通 ${ev.giftName || '大航海'}`
    case 'superchat':
      return `${name} 的醒目留言，${ev.content}`
    case 'enter':
      return `欢迎 ${name} 进入直播间`
    default:
      return ''
  }
}

function maybeSpeak(ev) {
  const cfg = store.get()
  const t = cfg.tts || {}
  const policy = cfg.voicePolicy || {}
  if (!t.enabled) return
  if (ev.type === 'gift' && !t.readGift) return
  if (ev.type === 'guard' && !t.readGuard) return
  if (ev.type === 'superchat' && !t.readSuperchat) return
  if (ev.type === 'enter' && !t.readEnter) return
  if (ev.type === 'live' || ev.type === 'offline' || ev.type === 'other') return

  // 点歌弹幕不进播报队列（「点歌 七里香」被念出来很怪），单独处理
  if (ev.type === 'danmaku' && cfg.music?.enabled) {
    const kw = NCM.parseMusicCommand(ev.content, cfg.music.commands)
    if (kw !== null) {
      if (kw) {
        handleMusicRequest(ev, kw).catch((e) => console.warn('[music] 点歌失败：', e.message))
      } else if (cfg.music?.replyInChat !== false) {
        // 用主播自己设的触发词，别教一个已经被改掉的旧词
        replyChat(`想点什么歌？发「${musicTriggerWord(cfg)} 歌名」`)
      }
      return
    }
  }

  // 命令弹幕不进播报队列，先处理掉；顺便做冷却，防止连刷把 API 打满
  if (policy.enabled && ev.type === 'danmaku') {
    const cmd = V.parseCommand(ev.content, { prefix: policy.prefix, names: cfg.commands?.voice })
    if (cmd) {
      const id = ev.uid || ev.username || 'anon'
      const now = Date.now()
      const cd = cooldownOf(policy)
      // 冷却是**按指令**算的，不是按人算的。
      //
      // 以前按人算，于是「刚换完音色想撤销」这条最自然的操作会被吃掉：
      // 观众发完 #换音色，5 秒内再发 #删除音色 直接静默丢弃 —— 没回执、没反应，
      // 看起来就是「删除音色指令坏了」。可这两条指令一条在读配置、一条在写配置，
      // 谁也不该挡住谁；真正要防的是同一条指令被连刷打满 API。
      const key = `${id}|${cmd.kind}`
      const prev = commandCooldown.get(key) || 0
      if (cd > 0 && now - prev < cd) {
        // 挡下来可以，但不能一声不吭：观众只会以为指令坏了，然后一直重发。
        // 提示本身也要限流，否则刷屏的人反而把回执刷满。
        const lastNotice = cooldownNotice.get(id) || 0
        if (now - lastNotice >= 10000) {
          cooldownNotice.set(id, now)
          const left = Math.max(1, Math.ceil((cd - (now - prev)) / 1000))
          replyChat(`慢一点，${policy.prefix}${V.primaryName(cfg, cmd.kind)} 还要等 ${left} 秒`)
        }
        return
      }
      commandCooldown.set(key, now)
      for (const [k, v] of commandCooldown) if (now - v > 60000) commandCooldown.delete(k)
      for (const [k, v] of cooldownNotice) if (now - v > 60000) cooldownNotice.delete(k)
      handleVoiceCommand(ev, cmd, policy).catch((e) => {
        console.warn('[voice-command] 处理失败：', e.message)
      })
      return
    }
  }

  // 绑了音色的人走他的平台，没绑的回落全局默认
  const profile = policy.enabled ? currentProfileOf(ev.uid) : null

  let text = buildSpeechText(ev, t)
  if (!text) return
  text = text.replace(/\[[^\]]{1,12}\]/g, '').replace(/\s+/g, ' ').trim()
  if (!text) return
  if (isBlocked(text, t.blockWords)) return

  const max = Number(t.maxLength) || 60
  if (text.length > max) text = text.slice(0, max)

  const now = Date.now()

  if (t.mergeDuplicate) {
    const prev = lastTextAt.get(text)
    if (prev && now - prev < 20000) return
    lastTextAt.set(text, now)
    for (const [k, v] of lastTextAt) if (now - v > 60000) lastTextAt.delete(k)
  }

  if (ev.uid && t.perUserCooldownMs) {
    const last = userLastSpeak.get(ev.uid) || 0
    if (now - last < Number(t.perUserCooldownMs)) return
    userLastSpeak.set(ev.uid, now)
  }

  if (speech.queue.length > 24) speech.queue.shift()
  speech.queue.push({
    text,
    style: profile && profile.stylePrompt ? profile.stylePrompt : t.stylePrompt,
    profile: profile || null,
    meta: { type: ev.type, username: ev.username, voiceName: profile?.name || '' },
  })
  pumpSpeech()
}

/** 把存储里的 tts 配置整理成适配层需要的形状（语速换算成各家协议要的写法） */
function ttsCfg(t) {
  const speed = Number(t.speed) || 1
  const cfg = store.get()
  return {
    provider: t.provider,
    protocol: t.protocol,
    baseUrl: cfg.platformBase?.[t.provider] || t.baseUrl,
    // 语音页自己填的 Key 优先；没填的话补位用「音色」页里那把，
    // 否则在那边保存的 Fish / OpenAI Key 对全局默认播报完全不起作用
    apiKey: t.apiKey || keyForPlatform(t.provider),
    model: t.model,
    voice: t.voice,
    format: t.format,
    speed,
    volume: t.volume,
    pitch: t.pitch || '+0Hz',
    // Edge 用百分号字符串，系统语音用 -10~10
    rate: `${speed >= 1 ? '+' : '-'}${Math.abs(Math.round((speed - 1) * 100))}%`,
    // 外网请求走哪条网络栈（lib/net.cjs）
    proxy: cfg.proxy,
    platformBase: cfg.platformBase,
  }
}

function pumpSpeech() {
  if (speech.busy || !speech.queue.length) return
  speech.setBusy(true)
  const item = speech.queue.shift()
  runSpeech(item).finally(() => {
    speech.setBusy(false)
    setTimeout(pumpSpeech, 50)
  })
}

async function runSpeech(item) {
  const t = store.get().tts || {}
  // 上一轮留下的跳过标记不该影响这一条
  speech.begin(item.text)
  // 入队那一刻的开关可能已经改了：主播关掉播报 / 临时加了屏蔽词之后，
  // 队列里剩下的那些不该继续念完（队列最多 24 条，不复核的话能念小半分钟）
  const verdict = shouldSpeakNow(item, t)
  if (verdict.drop) {
    speech.finish()
    return
  }
  const gap = Number(t.minIntervalMs) || 700
  const wait = Math.max(0, gap - (Date.now() - lastSpeakAt))
  if (wait) await new Promise((r) => setTimeout(r, wait))

  send('tts:state', { state: 'loading', text: item.text })
  try {
    // 有人绑了自己的音色就用他那份配置，否则回落全局默认
    const usedCfg = item.profile ? profileCfg(item.profile) : ttsCfg(t)
    const audio = await synthesize(usedCfg, item.text, item.style)
    // 合成期间用户点了跳过 —— 这条就别播了（标记在这里消费掉，不会误伤下一条）
    if (speech.consumeSkip()) {
      send('tts:state', { state: 'idle' })
      return
    }
    // 兜底模型顶上了：记下来，下次直接用它，别每条弹幕都先白撞一次付费模型
    rememberFishModel(usedCfg, audio)
    lastSpeakAt = Date.now()

    const done = speech.waitPlayback()
    send('tts:play', { ...audio, text: item.text, meta: item.meta, volume: t.volume })
    speech.markPlaying()
    send('tts:state', { state: 'playing', text: item.text })
    await done
  } catch (e) {
    log?.warn('[tts] 播报失败', `${item.profile?.platform || 'default'}`, e.message || String(e))
    send('tts:error', { message: e.message || String(e), text: item.text })
  } finally {
    speech.finish()
    send('tts:state', { state: 'idle' })
  }
}

/* ------------------------------- IPC ------------------------------- */

function registerIpc() {
  ipcMain.handle('config:get', () => store.get())
  ipcMain.handle('config:patch', async (_e, patch) => {
    const before = store.get().overlay?.port
    // 密钥先洗干净再落盘，脏字符是「Key 明明填对了却 401」的头号原因
    const secretNotes = sanitizeSecrets(patch)
    const next = store.patch(patch || {})
    if (secretNotes.length) {
      log?.info('[config] 密钥已清洗', secretNotes.join('；'))
      send('config:notice', { messages: secretNotes })
    }
    // 叠加层设置改了要立刻推给已连接的 OBS 页面
    if (patch && patch.overlay && overlay) overlay.broadcast('config', next.overlay)
    // 改端口要重启服务，否则界面显示的地址和实际监听的对不上
    if (patch && patch.overlay && Number(next.overlay?.port) !== Number(before) && overlay) {
      await overlay.stop()
      overlay = null
      try {
        const p = await ensureOverlay(Number(next.overlay.port) || 12450)
        // 端口被占时会自动顺延，界面上要显示真正监听的那个
        if (Number(p) !== Number(next.overlay.port)) store.patch({ overlay: { port: p } })
        pushConfig()
      } catch (e) {
        sendOverlayStatus(e.message)
      }
      sendOverlayStatus()
    }
    return store.get()
  })
  ipcMain.handle('config:reset', () => store.reset())

  ipcMain.handle('tts:providers', () => PROVIDERS)

  ipcMain.handle('bili:qr:generate', async () => {
    ensureSession()
    await api.ensureBuvid() // 登录流程要有设备指纹，否则 B站可能拒发 Cookie
    qrLogin = new QrLogin(session)
    return qrLogin.generate()
  })

  ipcMain.handle('bili:qr:poll', async () => {
    ensureSession()
    if (!qrLogin) throw new Error('请先生成二维码')
    try {
      const r = await qrLogin.startPolling((status, message) => {
        send('bili:qr:status', { status, message })
      })
      // 登录成功这里一定有一份完整凭据；再存一次，这次允许覆盖（扫码拿到的就是最新的）
      persistCredentials('overwrite')
      const info = await getLoginInfo()
      send('bili:login', info)
      return { ok: true, info }
    } catch (e) {
      throw e
    }
  })

  ipcMain.handle('bili:login:info', async () => {
    ensureSession()
    return getLoginInfo()
  })

  ipcMain.handle('bili:logout', async () => {
    log?.info('[auth] 退出登录')
    if (session) session.jar.clear()
    store.patch({
      credentials: { SESSDATA: '', bili_jct: '', DedeUserID: '', buvid3: '', buvid4: '', refreshToken: '', savedAt: 0 },
    })
    return { ok: true }
  })

  ipcMain.handle('live:start', async (_e, roomId) => {
    try {
      const r = await startLive(roomId)
      return { ok: true, ...r }
    } catch (e) {
      return { ok: false, message: e.message || String(e) }
    }
  })

  ipcMain.handle('live:stop', () => {
    stopLive()
    return { ok: true }
  })

  ipcMain.handle('live:send', async (_e, text) => {
    ensureSession()
    const cfg = store.get()
    const roomId = cfg.room?.realRoomId || Number(cfg.room?.roomId)
    if (!roomId) throw new Error('还没有连接到直播间')
    try {
      await api.sendDanmaku({
        roomId,
        message: String(text || '').slice(0, 30),
        color: cfg.danmaku?.sendColor ?? 16777215,
        fontSize: cfg.danmaku?.sendFontSize ?? 25,
        mode: cfg.danmaku?.sendMode ?? 1,
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e.message || String(e) }
    }
  })

  // 音色列表：Edge 拉在线音色表，系统语音读本机注册表
  ipcMain.handle('tts:voices', async (_e, provider, force) => {
    try {
      return { ok: true, voices: await listVoices(provider, { force: Boolean(force) }) }
    } catch (e) {
      return { ok: false, message: e.message || String(e) }
    }
  })

  ipcMain.handle('tts:test', async () => {
    const t = store.get().tts || {}
    const started = Date.now()
    const audio = await synthesize(
      ttsCfg(t),
      '语音播报测试成功，你现在可以听到我的声音了。',
      t.stylePrompt,
    )
    // 直接播放，省得测完还不知道效果
    send('tts:play', { ...audio, text: '语音播报测试成功', meta: { type: 'test' }, volume: t.volume })
    return { ...audio, latency: Date.now() - started }
  })

  ipcMain.handle('tts:speak', async (_e, text) => {
    if (speech.queue.length > 24) speech.queue.shift()
    speech.queue.push({ text: String(text || '').slice(0, 200), style: store.get().tts?.stylePrompt || '', meta: { type: 'manual' } })
    pumpSpeech()
    return { ok: true }
  })

  ipcMain.on('tts:ack', () => {
    speech.ack()
  })

  /**
   * 跳过当前这条播报。
   * 两种时机要分开处理：
   *  - 正在播放 → 直接放行队列，音频由渲染进程停掉
   *  - 正在合成（还没播出来）→ 打标记，合成完直接丢掉，别再推给渲染进程
   */
  ipcMain.handle('tts:skip', () => {
    const r = speech.requestSkip()
    // 告诉渲染进程把声音停掉（它自己不要再 ack，队列这边已经放行了）
    send('tts:skip', {})
    if (r.skipped) log?.info('[tts] 跳过当前播报')
    return r
  })

  /** 清空待播队列（堆积太多时用），当前这条也一起跳过 */
  ipcMain.handle('tts:clear', () => {
    const r = speech.clearQueue()
    send('tts:skip', {})
    log?.info('[tts] 清空播报队列', r.cleared)
    return r
  })

  // 渲染进程切页面后会重新问一次：现在还在念吗、念的是什么
  ipcMain.handle('tts:queue', () => speech.snapshot())

  /* ------------------------------ 点歌 ------------------------------ */

  function musicOpts() {
    const cfg = store.get()
    return { cookie: cfg.music?.cookie || '', mode: net.resolveMode('netease', cfg) }
  }

  ipcMain.handle('music:search', async (_e, keyword, limit) => {
    const cfg = store.get()
    return NCM.searchMusic(keyword, { limit: limit || 10, ...musicOpts() })
  })

  // 播放链接只在真要播的那一刻取：地址 20 分钟就过期
  ipcMain.handle('music:url', async (_e, id) => {
    const cfg = store.get()
    return NCM.songUrl(id, { br: cfg.music?.br || 320000, ...musicOpts() })
  })

  ipcMain.handle('music:lyric', async (_e, id) => NCM.lyric(id, musicOpts()))

  // 登录态只有这里能查（要带上 Cookie 去问网易云），界面上单独放一个按钮触发
  ipcMain.handle('music:account', async () => NCM.accountInfo(musicOpts()))

  ipcMain.handle('music:check', async () => {
    const cfg = store.get()
    return NCM.check({ br: cfg.music?.br, ...musicOpts() })
  })

  ipcMain.handle('music:state', () => musicSnapshot())

  ipcMain.handle('music:enqueue', (_e, song, requester) => musicEnqueue(song, requester))

  /** 主播手动开始播队列第一首 */
  ipcMain.handle('music:play', () => {
    if (!musicCurrent) musicAdvance()
    pushMusicState()
    return musicSnapshot()
  })

  /** 播完 / 切歌 */
  ipcMain.handle('music:next', () => {
    musicAdvance()
    pushMusicState()
    return musicSnapshot()
  })

  ipcMain.handle('music:remove', (_e, index) => {
    if (Number.isInteger(index) && index >= 0 && index < musicQueue.length) musicQueue.splice(index, 1)
    pushMusicState()
    return musicSnapshot()
  })

  ipcMain.handle('music:clear', () => {
    musicQueue.length = 0
    pushMusicState()
    return musicSnapshot()
  })

  /* ------------------------ 网易云网页登录 ------------------------ */

  /**
   * 开一个窗口让用户直接登录网易云，登录成功自动把 Cookie 存进配置。
   *
   * 为什么不去逆向它的扫码接口：unikey 能拿到，但 qrcode/create 和 qrcode/check
   * 实测全是 404（官方路径已经变了），自己拼出来的二维码扫了也没地方验状态。
   * 而程序本身就是 Chromium —— 直接用真窗口打开官网登录页，
   * 登录完从 session 的 Cookie 罐里读 MUSIC_U，走的是官方自己的流程，最稳。
   * 扫码、手机号、账号密码哪种方式登录都行，只要页面登录成功就会触发。
   */
  ipcMain.handle('music:login', async () => {
    if (ncmWin && !ncmWin.isDestroyed()) {
      ncmWin.focus()
      return { ok: true, opened: true }
    }
    try {
      ncmWin = openNeteaseLoginWindow()
      return { ok: true, opened: true }
    } catch (e) {
      return { ok: false, message: String(e?.message || e) }
    }
  })

  ipcMain.handle('music:loginCancel', () => {
    closeNeteaseLogin()
    return { ok: true }
  })

  /* ---------------------------- 音色库 ---------------------------- */

  ipcMain.handle('voices:search', async (_e, source, keyword, opts) => {
    const cfg = store.get()
    const policy = cfg.voicePolicy || {}
    const sources = !source || source === 'all' ? policy.searchSources || ['mimo'] : [source]
    const r = await V.searchEverywhere(sources, {
      keyword: String(keyword || ''),
      limit: Number((opts && opts.limit) || policy.searchLimit || 12),
      cfg,
      force: Boolean(opts && opts.force),
    })
    return r
  })

  ipcMain.handle('voices:library', () => {
    const cfg = store.get()
    return { library: cfg.voiceLibrary || [], bindings: cfg.voiceBindings || {} }
  })

  /**
   * 外网连通性体检。用 DNS → TCP → HTTP 三步把「域名被污染」「代理没生效」
   * 「Key 不对」区分开，省得看到一句 fetch failed 不知道从哪下手。
   */
  ipcMain.handle('voices:netcheck', async (_e, which) => {
    const cfg = store.get()
    const mode = cfg.proxy?.mode || 'auto'
    const targets = []
    const want = which && which !== 'all' ? [which] : ['fish', 'openai', 'mimo']
    for (const id of want) {
      const base = String(cfg.platformBase?.[id] || '').trim() || V.DEFAULT_BASE[id]
      if (!base) continue
      targets.push({
        id,
        label: { fish: 'Fish Audio', openai: 'OpenAI', mimo: '小米 MiMo' }[id] || id,
        base,
        mode: net.resolveMode(id, cfg),
      })
    }
    const results = []
    for (const t of targets) {
      const r = await net.checkEndpoint(t.base, { mode: t.mode, timeoutMs: 8000 })
      results.push({ ...t, ...r, modeSource: mode })
    }
    return { results, mode }
  })

  /**
   * 单独验一把 Key：不合成、不产生费用，只问平台「这把钥匙认不认」。
   * 「连通性自检」只能说明网络通不通，说不清 Key 对不对，这里补上后半段。
   */
  ipcMain.handle('voices:keycheck', async (_e, source) => {
    const cfg = store.get()
    const id = String(source || 'fish')
    const isLlm = id === 'llm'
    const label = isLlm ? L.providerOf(cfg).label : { fish: 'Fish Audio', openai: 'OpenAI' }[id] || id
    const key = isLlm ? L.keyFor(cfg) : keyForPlatform(id)
    const info = describeKey(key)
    if (!key) {
      return { ok: false, source: id, label, key: info, status: 0, message: `还没填写 ${label} 的 API Key` }
    }
    const base = isLlm
      ? L.baseFor(cfg)
      : String(cfg.platformBase?.[id] || '').trim().replace(/\/+$/, '') || V.DEFAULT_BASE[id] || ''
    if (!base) return { ok: false, source: id, label, key: info, status: 0, message: '这个平台没有接口地址' }

    /**
     * Fish 必须真合成一次才算验过。
     * 只读接口（/voices、/speech/tts/capabilities）在 Key 不对时也可能给 200，
     * 于是界面显示「校验通过」，一合成就 401 —— 用户看到的就是「明明认了又不让用」。
     * 所以这里先查账户接口验身份、再拿两个字的文本真去合成，两步分开报。
     */
    if (id === 'fish') {
      const probe = await probeFish({
        apiKey: key,
        baseUrl: base,
        model: cfg.platformModel?.fish || 's2.1-pro-free',
        // 音色可以不带：这家平台不给 reference_id 也能出声（用默认音色）。
        // 但绑了就顺带一起验，音色 id 失效能当场发现。
        voice: currentFishVoice(cfg),
        proxy: cfg.proxy,
      })
      log?.info(`[keycheck] Fish 合成实测 ok=${probe.ok}`, probe.message)
      return {
        ok: probe.ok,
        source: id,
        label,
        key: info,
        status: probe.ok ? 200 : Number(probe.tried?.[0]?.status) || 0,
        message: probe.message,
        workingModel: probe.workingModel,
        tried: probe.tried,
        account: probe.account,
      }
    }

    // 其余平台挑一个「必须带 Key 才能过」的轻量 GET：拿 200 就说明 Key 是有效的
    const url = `${base}/models`
    let res
    try {
      res = await net.httpJson(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        timeoutMs: 15000,
        mode: net.resolveMode(isLlm ? L.providerOf(cfg).id : id, cfg),
      })
    } catch (e) {
      log?.warn(`[keycheck] ${label} 请求失败`, e.message)
      return { ok: false, source: id, label, key: info, status: 0, message: e.message || String(e) }
    }
    if (res.ok) {
      log?.info(`[keycheck] ${label} 通过`, keySummary(key))
      return {
        ok: true,
        source: id,
        label,
        key: info,
        status: res.status,
        message: `${label} 认这把 Key（HTTP ${res.status}）· ${keySummary(key)}`,
      }
    }
    log?.warn(`[keycheck] ${label} 未通过 HTTP ${res.status}`, keySummary(key))
    return {
      ok: false,
      source: id,
      label,
      key: info,
      status: res.status,
      message: net.describeHttpError(res.status, res.text, { label, keySummary: keySummary(key) }),
    }
  })

  /* ---------------------------- 文本大模型 ---------------------------- */

  // 供应商清单（含默认地址 / 默认模型），界面上的下拉框直接吃这个
  ipcMain.handle('llm:providers', () => ({
    providers: Object.values(L.LLM_PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      baseUrl: p.baseUrl,
      defaultModel: p.defaultModel,
      keyUrl: p.keyUrl,
      note: p.note,
    })),
    formula: L.DESIGN_FORMULA,
    template: L.defaultTemplate(),
  }))

  // 在线拉模型列表。模型名是唯一没法写死的东西 —— 各家随时上下架
  ipcMain.handle('llm:models', async () => {
    const cfg = store.get()
    const r = await L.listModels(cfg)
    log?.info(`[llm] 模型列表 ${r.provider} ok=${r.ok} 共 ${r.models.length} 个`, r.message || '')
    return r
  })

  // 验 Key + 验模型名。列表接口不通时会退化成发一句话看能不能出字
  ipcMain.handle('llm:check', async () => {
    const cfg = store.get()
    const r = await L.check(cfg)
    log?.info(`[llm] 自检 ok=${r.ok}`, r.message || '')
    return r
  })

  // 界面上试扩写：不用等直播间有人发命令也能看到补全效果
  ipcMain.handle('llm:expand', async (_e, rough) => {
    const cfg = store.get()
    try {
      const r = await L.expandDesign(rough, cfg)
      if (!r.used) return { ...r, message: r.message || '没走 LLM，用的原话' }
      return r
    } catch (e) {
      const message = e.message || String(e)
      log?.warn('[llm] 扩写失败', message)
      return { ok: false, used: false, text: String(rough || ''), message }
    }
  })

  ipcMain.handle('voices:add', (_e, source, voice) => {
    if (!voice || !voice.id) throw new Error('缺少音色 id')
    return ensureProfile({ source, id: voice.id, name: voice.name, hint: voice.hint })
  })

  ipcMain.handle('voices:save', (_e, profile) => {
    if (!profile || !profile.id) throw new Error('缺少音色档案 id')
    const cfg = store.get()
    const lib = cfg.voiceLibrary || []
    const next = lib.map((p) => (p.id === profile.id ? { ...p, ...profile, id: p.id } : p))
    store.patch({ voiceLibrary: next })
    sendLibraryChanged()
    return next.find((p) => p.id === profile.id) || null
  })

  ipcMain.handle('voices:remove', (_e, id) => {
    const cfg = store.get()
    const bindings = { ...(cfg.voiceBindings || {}) }
    for (const [uid, pid] of Object.entries(bindings)) if (pid === id) delete bindings[uid]
    store.patch({
      voiceLibrary: (cfg.voiceLibrary || []).filter((p) => p.id !== id),
      voiceBindings: bindings,
    })
    sendLibraryChanged()
    return { ok: true }
  })

  ipcMain.handle('voices:bind', (_e, uid, profileId) => {
    const cfg = store.get()
    const bindings = { ...(cfg.voiceBindings || {}) }
    if (profileId) bindings[uid] = profileId
    else delete bindings[uid]
    store.patch({ voiceBindings: bindings })
    sendLibraryChanged()
    return { ok: true }
  })

  ipcMain.handle('voices:unbind', (_e, uid) => {
    // unbindUser 内部已经推过一次库变更事件，界面会自己刷新
    unbindUser(uid)
    return { ok: true }
  })

  // 用指定音色念一句固定的试听词
  ipcMain.handle('voices:test', async (_e, payload) => {
    const started = Date.now()
    const cfg = store.get()
    let synthCfg
    if (payload && payload.profileId) {
      const p = (cfg.voiceLibrary || []).find((x) => x.id === payload.profileId)
      if (!p) throw new Error('这个音色不在库里')
      synthCfg = profileCfg(p)
    } else if (payload && payload.source && payload.voice) {
      synthCfg = profileCfg(
        V.profileFromVoice({ source: payload.source, voice: payload.voice, cfg }),
      )
    } else {
      throw new Error('要试听哪个音色？')
    }
    const audio = await synthesize(synthCfg, '音色试听，大家好，我是你的新声音。', '').catch((e) => {
      // 试听失败是用户最需要线索的地方，落一份日志，省得只能看到界面上一句话
      log?.warn(
        '[voices:test] 失败',
        `${synthCfg.provider}(${synthCfg.model || ''}) key=${keySummary(synthCfg.apiKey)}`,
        e.message || String(e),
      )
      throw e
    })
    send('tts:play', { ...audio, text: '音色试听', meta: { type: 'voice-test' }, volume: cfg.tts?.volume })
    log?.info('[voices:test] 合成成功', payload?.profileId || `${payload?.source}:${payload?.voice?.id || ''}`)
    return { latency: Date.now() - started }
  })

  ipcMain.handle('overlay:start', async () => {
    ensureSession()
    const port = Number(store.get().overlay?.port) || 12450
    try {
      const p = await ensureOverlay(port)
      store.patch({ overlay: { enabled: true, userStopped: false, port: p } })
      sendOverlayStatus()
      return { ok: true, port: p }
    } catch (e) {
      sendOverlayStatus(e.message)
      return { ok: false, message: e.message || String(e) }
    }
  })

  ipcMain.handle('overlay:stop', async () => {
    if (overlay) await overlay.stop()
    overlay = null
    store.patch({ overlay: { enabled: false, userStopped: true } })
    sendOverlayStatus()
    return { ok: true }
  })

  ipcMain.handle('overlay:open', async () => {
    const port = Number(store.get().overlay?.port) || 12450
    await shell.openExternal(`http://127.0.0.1:${port}/overlay`)
    return { ok: true }
  })

  /** 往叠加层推一条假消息，用来确认 OBS 那边到底通没通 */
  ipcMain.handle('overlay:test', () => {
    if (!overlay || !overlay.clientCount) {
      return { ok: false, clients: overlay ? overlay.clientCount : 0 }
    }
    const ev = {
      id: `test-${Date.now()}`,
      type: 'danmaku',
      username: 'ChatsParty',
      content: '叠加层测试消息 —— 看到这条就说明链路通了',
      // 故意带一个真实头像地址：顺手把「抓回来 -> 回填」这一路也验掉
      face: 'https://i2.hdslb.com/bfs/face/ef0457addb24141e15dfac6fbf45293ccf1e32ab.jpg',
      medal: null,
      timestamp: Date.now(),
    }
    overlay.broadcast('event', ev)
    ensureFace(ev.face)
    return { ok: true, clients: overlay.clientCount }
  })

  /** 用主进程自己去拉一次叠加层页面，能拿到 HTML 就说明本地服务是活的 */
  ipcMain.handle('overlay:selfcheck', async () => {
    const port = Number(store.get().overlay?.port) || 12450
    const url = `http://127.0.0.1:${port}/overlay`
    const out = { url, running: Boolean(overlay), port, clients: overlay ? overlay.clientCount : 0 }
    if (!overlay) {
      out.ok = false
      out.message = '叠加层服务没在跑，点上面的「启动」'
      return out
    }
    try {
      const r = await net.httpRequest(url, { timeoutMs: 5000, mode: 'direct' })
      out.ok = r.ok
      out.http = r.status
      out.message = r.ok
        ? out.clients
          ? `服务正常，且已有 ${out.clients} 个连接（OBS 已连上）`
          : '服务正常，但还没有客户端连上 —— 检查 OBS 浏览器源的 URL 是否一致'
        : `HTTP ${r.status}`
    } catch (e) {
      out.ok = false
      out.message = `本地服务访问不了：${e.message}`
    }
    return out
  })

  /**
   * 「关于」页用。version 走 app.getVersion()：开发时读 package.json，
   * 打包后读 exe 的版本信息 —— 所以升级后不用改代码，数字自己跟着变。
   */
  ipcMain.handle('app:info', () => ({
    // app.getName() / getVersion() 在未打包时给的是 Electron 自己的名字和版本
    // （实测返回 "Electron" 与 "33.4.11"），显示出来会误导，所以统一读 package.json。
    // 打包后 electron-builder 也是拿同一个 version 写进 exe，两边一致。
    name: pkg.productName || pkg.name,
    version: pkg.version,
    electron: process.versions.electron || '',
    chrome: process.versions.chrome || '',
    node: process.versions.node || '',
    platform: `${process.platform}-${process.arch}`,
  }))

  /**
   * 外链一律交给系统默认浏览器。
   * 渲染层不能直接开窗口，所以这里做一道协议白名单：只放行 http(s)，
   * 挡掉 file:// / 自定义协议，避免被喂一个本地路径或协议处理器链接。
   */
  ipcMain.handle('app:openExternal', async (_e, url) => {
    let u
    try {
      u = new URL(String(url || ''))
    } catch {
      return { ok: false, message: '链接无效' }
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return { ok: false, message: `不支持的协议：${u.protocol}` }
    }
    try {
      await shell.openExternal(u.href)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e?.message || '打不开链接' }
    }
  })

  ipcMain.handle('app:diagnostics', () => {
    const cred = store.get().credentials || {}
    return {
      hasCredentials: Boolean(cred.SESSDATA && cred.bili_jct),
      savedAt: Number(cred.savedAt) || 0,
      uid: cred.DedeUserID || '',
      loadError: store.loadError || '',
      saveError: store.saveError || '',
      logPath: log ? log.file : '',
      // 上一版配置的备份，出事了能从这里捞回来
      backupPath: store.file ? `${store.file}.bak` : '',
      voiceCount: (store.get().voiceLibrary || []).length,
      bindingCount: Object.keys(store.get().voiceBindings || {}).length,
    }
  })

  ipcMain.handle('app:exportLog', async () => {
    const res = await dialog.showSaveDialog(win, {
      title: '导出配置',
      defaultPath: 'chatsparty-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (res.canceled || !res.filePath) return { ok: false }
    const safe = JSON.parse(JSON.stringify(store.get()))
    if (safe.credentials) {
      safe.credentials.SESSDATA = safe.credentials.SESSDATA ? '***' : ''
      safe.credentials.bili_jct = safe.credentials.bili_jct ? '***' : ''
    }
    if (safe.tts) safe.tts.apiKey = safe.tts.apiKey ? '***' : ''
    fs.writeFileSync(res.filePath, JSON.stringify(safe, null, 2), 'utf8')
    return { ok: true, path: res.filePath }
  })
}

function sendOverlayStatus(error) {
  const port = Number(store.get().overlay?.port) || 12450
  send('overlay:status', {
    enabled: Boolean(overlay),
    port,
    url: `http://127.0.0.1:${port}/overlay`,
    clients: overlay ? overlay.clientCount : 0,
    error: error || '',
  })
}

/**
 * 起叠加层服务。端口被占会自动往后顺延，并且把「有几个连接」实时推给界面 ——
 * 之前只显示「运行中」，OBS 到底连没连上完全看不出来。
 */
async function ensureOverlay(port) {
  if (!overlay) {
    overlay = new OverlayServer(port)
    overlay.configProvider = () => store.get().overlay
    overlay.faceProvider = () => (faces ? [...faces.cache].map(([src, data]) => ({ src, data })) : [])
    overlay.musicProvider = () => musicSnapshot()
    overlay.onClientsChange = () => sendOverlayStatus()
  }
  return overlay.start(Number(port) || 12450)
}

async function getLoginInfo() {
  try {
    const nav = await session.getJSON('https://api.bilibili.com/x/web-interface/nav')
    if (!nav || nav.code !== 0) return { isLogin: false }
    const d = nav.data || {}
    const info = {
      isLogin: Boolean(d.isLogin),
      mid: d.mid || 0,
      uname: d.uname || '',
      face: d.face || '',
      level: d.level_info?.current_level || 0,
    }
    // 确认在线就补一次持久化；凭据却已经被判失效时把原因带给界面，而不是让它悄悄变成匿名
    rememberIfLoggedIn(info)
    if (!info.isLogin && store.get().credentials?.SESSDATA) {
      info.expired = true
      log?.warn('[auth] 本机保存的凭据已失效，需要重新扫码')
    }
    if (info.face) ensureFace(info.face)
    return info
  } catch (e) {
    log?.warn('[auth] 登录状态查询失败', e.message)
    return { isLogin: false }
  }
}

/* ------------------------------- 启动 ------------------------------- */

app.disableHardwareAcceleration()
// 部分无 GPU / 受限环境下 Chromium 的 GPU 进程起不来会直接崩掉，这里强制走软件渲染。
// 注意别加 --disable-software-rasterizer：--disable-gpu 之后就靠 SwiftShader 顶上，
// 把它一起禁掉会让 GPU 进程初始化失败，Chromium 直接 FATAL 退出（整机黑屏）。
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-gpu-sandbox')

/**
 * 只允许一个实例。
 *
 * 两个实例会同时读写同一份 chatsparty.enc，而后启动的那个在启动阶段就会
 * 把「它启动那一刻读到的配置」整份写回去（叠加层端口、登录自检都会触发保存），
 * 于是另一个实例期间的改动 —— 音色库、绑定、房间号 —— 会被整段覆盖回旧版本。
 * 表现就是「我明明注册了音色，重开却没了」。所以第二个实例直接退出，
 * 顺便把已有窗口拉到前台，用户不会以为「点了没反应」。
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(bootstrap)
}

/** 主进程启动流程。抽出来是为了让上面的「单实例」判断保持扁平。 */
function bootstrap() {
  log = new Logger(app.getPath('userData'))
  log.info('[app] 启动', process.version, 'packaged=', app.isPackaged)
  store = new ConfigStore()
  if (store.loadError) log.error('[store] 配置读取失败，已回退默认值', store.loadError)
  // 启动时把「载入到了什么」写进日志：配置被另一个实例盖掉时，这一行是唯一证据
  const boot = store.get()
  log.info(
    '[store] 已载入',
    `音色库 ${(boot.voiceLibrary || []).length}`,
    `绑定 ${Object.keys(boot.voiceBindings || {}).length}`,
    `房间 ${boot.room?.roomId || '-'}`,
    `凭据 ${boot.credentials?.SESSDATA ? '有' : '无'}`,
    `Fish Key ${keySummary(boot.platformKeys?.fish) || '无'}`,
  )
  registerIpc()
  createWindow()

  // 有存过的凭据就立刻验一次，顺带把登录状态推给界面，不用等用户点开连接页
  verifyStoredLogin()

  // 叠加层是纯本地服务，开销可以忽略，所以默认就拉起来 ——
  // 之前要手动点「启动」，忘了点就会以为「OBS 没效果」。除非用户主动停过。
  if (store.get().overlay?.userStopped !== true) {
    ensureOverlay(Number(store.get().overlay?.port) || 12450)
      .then((p) => {
        store.patch({ overlay: { enabled: true, port: p } })
        sendOverlayStatus()
      })
      .catch((e) => sendOverlayStatus(e.message))
  } else {
    sendOverlayStatus()
  }

  // 上次勾了自动连接就顺手接上
  const room = store.get().room
  if (room?.autoConnect && room?.roomId) {
    setTimeout(() => {
      startLive(room.roomId).catch(() => {
        /* 失败会通过 live:status 推送到界面 */
      })
    }, 1500)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // CP_E2E=1 时自动推一条带头像的测试弹幕，给端到端脚本用，正常启动不会走到
  if (process.env.CP_E2E === '1') {
    setTimeout(() => {
      const ev = {
        id: `e2e-${Date.now()}`,
        type: 'danmaku',
        username: '端到端测试',
        content: '这条是自检消息',
        face: 'https://i2.hdslb.com/bfs/face/ef0457addb24141e15dfac6fbf45293ccf1e32ab.jpg',
        medal: null,
        timestamp: Date.now(),
      }
      dispatchEvent(ev)
    }, 6000)
    // 弹幕指令（#绑定 / #删除音色 这类）只有真实弹幕事件才走得到，而直播连接在测试里
    // 没法起。把派发口和 store 挂到 global 上，端到端脚本才能复现「观众发一条弹幕」。
    // 回执本来要发到直播间，测试里没有直播间，所以顺手截一份下来供断言。
    // 只在 CP_E2E=1 时存在，正常启动不会走到这里。
    const replies = []
    const rawReply = replyChat
    replyChat = (text) => {
      replies.push(String(text))
      return rawReply(text)
    }
    global.__cpE2E = {
      dispatchEvent,
      store,
      replies,
      speech,
      currentProfileOf,
      /**
       * 假装本机登录着某个 B 站账号（= 主播自己扫的码）。
       * 「需要粉丝牌」门槛要靠 uid 认出主播，而登录态只有真扫码才有，
       * 测试里没法获得，所以留这个口子把这条路径也验上。
       */
      setOwnUid(uid) {
        ensureSession()
        session.jar.set(`DedeUserID=${Number(uid) || 0}; Domain=.bilibili.com; Path=/; Max-Age=3600`)
      },
    }
  }
}

/**
 * 启动时检查上次保存的凭据还灵不灵。
 * 不验的话，凭据失效的表现只是「弹幕变成匿名用户」，界面上完全看不出原因。
 */
function verifyStoredLogin() {
  const cred = store.get().credentials
  if (!cred || !cred.SESSDATA) return
  ensureSession()
  getLoginInfo()
    .then((info) => {
      send('bili:login', info)
      log.info('[auth] 启动自检：', info.isLogin ? `已登录 ${info.uname}` : '凭据失效')
    })
    .catch((e) => log.warn('[auth] 启动自检失败', e.message))
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopLive()
  if (overlay) overlay.stop()
})
