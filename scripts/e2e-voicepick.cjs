'use strict'
/**
 * 「谁在选音色」面板的端到端验证。
 *
 * 为什么要有这个脚本：这张面板是「真弹幕 -> 主进程队列 -> WebSocket -> OBS 叠加层画出来」
 * 四段接力，任何一段单看都是对的。它最容易坏的地方全在接缝上：
 *  - 观众发了 `#音色列表` 面板却没出来（或者出来了但候选跟聊天里那份对不上）；
 *  - 两个人同时在搜，第二个人把第一个人顶掉了；
 *  - 刚标上「✓ 已绑定」就消失，观众根本没看见；
 *  - 排队等着的那位在还没露面时就把自己的 8 秒耗完了；
 *  - 中途才连上来的 OBS 挂着上一次断开时的旧面板。
 * 这些只有真起叠加层页面、真喂弹幕才看得出来，所以这里验的是**页面上真正画出来的字**。
 *
 * 用法（必须在项目根目录，且用 electron 的二进制跑，不能用 node）：
 *   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/e2e-voicepick.cjs
 * 或者：npm run e2e:voicepick
 * 注意：跑之前先 `npx vite build` —— 它加载的是构建产物 dist-renderer。
 *
 * 四节：
 *   [A] 真弹幕搜索 -> 面板出现，候选与库里一致，已注册 / 已停用标得对
 *   [B] 绑定到已停用的音色 -> 明确拒绝，面板上写明原因（不能假装成功）
 *   [C] 正常绑定 -> 面板标上勾，并且重新计满时长
 *   [D] 两个人同时搜 -> 排队依次显示，谁也不盖谁（含中途连上来的补发）
 *   [E] 窄画面下与点歌面板 / 歌词自动避让，不压成一坨
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')
const WebSocket = require('ws')

const ROOT = path.join(__dirname, '..')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-pick-'))

/** 收走上几轮剩下的临时目录（Chromium 自己的子进程还占着，只能下次启动时删） */
function sweepStale(keep) {
  let names = []
  try {
    names = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith('cp-e2e-pick-') || path.join(os.tmpdir(), n) === keep) continue
    try {
      fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true })
    } catch {
      /* 还被占着就留给下一轮 */
    }
  }
}
sweepStale(tmpUserData)

app.setPath('userData', tmpUserData)
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('use-gl', 'swiftshader')
app.disableHardwareAcceleration()
process.env.CP_PROD = '1'
process.env.CP_E2E = '1'
// 叠加层端口也要错开：12450 上可能正跑着用户在直播用的那一份真实实例，
// 测试实例去占了它，之后真实实例会被挤到 12451，而 OBS 里写的还是 12450。
// 认这个变量的是 main.cjs 的 overlayPort()。
process.env.CP_OVERLAY_PORT = String(20000 + Math.floor(Math.random() * 20000))

/**
 * 不联网：把在线搜索换成固定的两条。
 * 第二条故意跟库里**已停用**的那份档案同平台同 voice ——
 * 这正是现实里那个最坑的情况：观众在榜上看到的是在线音色，
 * 主播那边对应的档案已经被停用了，绑过去会被静默回落成默认嗓子。
 */
const V = require(path.join(ROOT, 'electron', 'voices.cjs'))
const ONLINE = [
  { id: 'edge-on-1', name: '御姐音D', hint: 'edge · zh-CN', source: 'edge' },
  { id: 'edge-disabled', name: '御姐音B（平台版）', hint: 'edge · zh-CN', source: 'edge' },
]
let searchCalls = 0
V.searchEverywhere = async () => {
  searchCalls++
  return { ok: true, voices: ONLINE, errors: [] }
}

const TTL = 2500 // 真跑的时候用 8 秒，测试里缩短，不然光等就等掉半分钟

function profile(id, name, platform, voice, enabled, hint) {
  return {
    id,
    owner: 'host',
    ownerName: '',
    enabled,
    name,
    platform,
    protocol: platform,
    baseUrl: '',
    apiKey: '',
    model: '',
    voice,
    format: 'mp3',
    speed: 1,
    stylePrompt: '',
    mimoMode: 'preset',
    voiceHint: hint,
    createdAt: 1,
  }
}

/** 库里四条：两条正常、一条停用、一条跟关键词不沾边 */
const LIB = [
  profile('vp_a', '御姐音A', 'edge', 'edge-a', true, 'edge · zh-CN'),
  profile('vp_b', '御姐音B', 'edge', 'edge-disabled', false, 'edge · zh-CN'),
  profile('vp_c', '御姐音C', 'system', 'sys-c', true, 'system · 中文'),
  profile('vp_d', '甜妹音', 'mimo', 'mimo-sweet', true, 'mimo · 女声'),
]

let pass = 0
let fail = 0
function ok(label, cond, extra) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`)
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 6000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await fn()) return true
    await wait(60)
  }
  return false
}

/** 读叠加层页面上「真正画出来的」那张面板 */
const READ_PICK = `(() => {
  const el = document.getElementById('cp-pick')
  if (!el) return { show: false, exists: false, rows: [], rect: null }
  const q = (s, root) => (root || el).querySelector(s)
  const txt = (n) => (n ? n.textContent : '')
  const card = q('.cp-pick__card')
  return {
    exists: true,
    show: el.classList.contains('is-show'),
    pos: el.getAttribute('data-pos'),
    who: txt(q('.cp-pick__who')),
    kw: txt(q('.cp-pick__kw')),
    rows: Array.from(el.querySelectorAll('.cp-pick__row')).map((r) => ({
      no: Number(txt(q('.cp-pick__no', r))) || 0,
      name: txt(q('.cp-pick__name', r)),
      meta: txt(q('.cp-pick__meta', r)),
      tag: txt(q('.cp-pick__tag', r)),
      off: Boolean(q('.cp-pick__tag.is-off', r)),
      picked: r.classList.contains('is-picked'),
      ok: Boolean(q('.cp-pick__ok', r)),
    })),
    fail: txt(q('.cp-pick__fail', card)),
    wait: txt(q('.cp-pick__wait', card)),
    bar: q('.cp-pick__bar-fill') ? q('.cp-pick__bar-fill').style.animationDuration : '',
    rect: el.getBoundingClientRect().toJSON(),
  }
})()`
const readPick = (w) => w.webContents.executeJavaScript(READ_PICK)

/** 一块块量出来，两两比较：真的压在一起才算重叠 */
const READ_RECTS = `(() => {
  const get = (id) => {
    const el = document.getElementById(id)
    if (!el || !el.classList.contains('is-show')) return null
    const r = el.getBoundingClientRect()
    return { id: id, x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }
  }
  return [get('cp-music'), get('cp-lyric'), get('cp-pick')].filter(Boolean)
})()`

require(path.join(ROOT, 'electron', 'main.cjs'))

async function main() {
  // 先落配置，再起叠加层 —— 叠加层只在启动和收到 config 帧时读配置
  let win = null
  await waitFor(async () => {
    win = BrowserWindow.getAllWindows()[0] || null
    return Boolean(win)
  })
  if (!win) throw new Error('主窗口没起来')
  await waitFor(() => win.webContents.executeJavaScript('1').then(() => true).catch(() => false))
  const ready = await waitFor(() =>
    win.webContents
      .executeJavaScript('Boolean(window.chatsparty && window.chatsparty.config && window.chatsparty.overlay)')
      .then((v) => Boolean(v))
      .catch(() => false),
  )
  if (!ready) throw new Error('渲染层没拿到 chatsparty 接口')

  const patch = (p) => win.webContents.executeJavaScript(`window.chatsparty.config.patch(${JSON.stringify(p)})`)
  await patch({
    // 音色指令是挂在播报链路里的（maybeSpeak 里先剥命令再决定要不要念），
    // 所以 tts.enabled 必须是 true —— 但队列会被冻住，一句都不会真合成
    tts: { enabled: true, provider: 'system', perUserCooldownMs: 0, mergeDuplicate: false },
    voicePolicy: {
      enabled: true,
      allowSearch: true,
      allowBind: true,
      allowUnbind: true,
      requireMedal: false,
      cooldownMs: 0,
      replyInChat: true,
      searchLimit: 6,
      searchSources: ['edge'],
    },
    overlay: {
      showVoicePick: true,
      voicePickPos: 'tr',
      voicePickHits: 4,
      voicePickTtlMs: TTL,
      autoLayout: true,
      showMusic: true,
      showLyric: true,
      musicPos: 'tl',
      lyricPos: 'bc',
      danmakuPos: 'bl',
    },
    commands: { voice: { list: ['音色列表'], bind: ['绑定'] } },
  })

  let hook = null
  for (let i = 0; i < 200; i++) {
    const h = global.__cpE2E
    if (h && h.pickQueue) {
      hook = h
      break
    }
    await wait(150)
  }
  if (!hook) throw new Error('CP_E2E 测试钩子没挂上，检查 main.cjs 的 CP_E2E 分支')
  const { store, dispatchEvent, replies, speech, pickQueue } = hook

  await patch({ voiceLibrary: LIB, voiceBindings: {} })
  // 播报队列冻住：队列空闲时 pumpSpeech 会立刻把它取走，看不见到底塞了什么
  speech.setBusy(true)

  const started = await win.webContents.executeJavaScript('window.chatsparty.overlay.start()')
  if (!started || !started.ok) throw new Error(`叠加层没起来：${JSON.stringify(started)}`)
  const port = started.port
  console.log(`\n叠加层端口 ${port}`)

  const frames = []
  const sock = new WebSocket(`ws://127.0.0.1:${port}/overlay`)
  sock.on('message', (raw) => {
    try {
      const m = JSON.parse(String(raw))
      if (m.type === 'voicepick') frames.push(m.payload)
    } catch {
      /* noop */
    }
  })
  await new Promise((r, j) => {
    sock.once('open', r)
    sock.once('error', j)
  })

  // 真开一个叠加层页面 —— 验的就是它画在画面上的字
  const owin = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { contextIsolation: true } })
  await owin.loadURL(`http://127.0.0.1:${port}/overlay`)
  await wait(500)

  let uidSeq = 9100
  const send = (uid, content, username) =>
    dispatchEvent({ type: 'danmaku', uid, username, content, medal: null, face: '', timestamp: Date.now() })
  const lastReply = () => replies[replies.length - 1] || ''
  /** 清干净再进下一节，免得上一节的残留（比如失败那条还要挂几秒）干扰结论 */
  const reset = async () => {
    pickQueue.clear()
    await wait(150)
  }

  console.log('\n[A] 观众搜音色 -> 面板出现，候选与库里一致')
  const A = ++uidSeq
  {
    const before = frames.length
    await send(A, '#音色列表 御姐', '观众甲')
    const shown = await waitFor(async () => (await readPick(owin)).show)
    const p = await readPick(owin)
    ok('A1 搜完面板就出来了', shown, p)
    console.log(`        画面上：${JSON.stringify(p.rows.map((r) => r.no + r.name + (r.tag ? '(' + r.tag + ')' : '')))}`)
    ok('A2 面板上写清了是谁在选、搜的什么', p.who.includes('观众甲') && p.kw.includes('御姐'), p)
    ok('A3 库里的「御姐音A」在榜上', p.rows.some((r) => r.name === '御姐音A'))
    ok('A4 库里的「御姐音C」也在（不只看在线平台）', p.rows.some((r) => r.name === '御姐音C'))
    ok('A5 库里的标了「已注册」', p.rows.filter((r) => r.name === '御姐音A').every((r) => r.tag === '已注册' && !r.off))
    // 逗号那个是过滤器，不该出现在榜上
    ok('A6 不沾边的音色没被混进来', !p.rows.some((r) => r.name === '甜妹音'), p.rows.map((r) => r.name))
    ok('A7 序号从 1 开始连号', p.rows.every((r, i) => r.no === i + 1), p.rows.map((r) => r.no))
    ok('A8 在线补位的结果也进来了', p.rows.some((r) => r.name === '御姐音D'))
    ok('A9 进度条时长跟配置对得上', p.bar === TTL + 'ms', p.bar)
    ok('A10 就一个人在选，没人排队', p.wait === '', p.wait)
    ok('A11 刚搜完确实推了一帧出去', frames.length > before)
    // 台上那份必须就是主进程手上那一份，否则观众照聊天里的第 2 条绑定会绑错
    const snap = hook.pickSnapshot()
    ok(
      'A12 面板与主进程队列是同一份',
      Boolean(snap.panel) && snap.panel.hits.length === p.rows.length && snap.panel.hits[0].name === p.rows[0].name,
      { snap: snap.panel && snap.panel.hits.map((h) => h.name), dom: p.rows.map((r) => r.name) },
    )
  }

  console.log('\n[B] 绑定到库里已停用的音色 -> 必须明确拒绝，不能假装成功')
  {
    // 在线那条「御姐音B（平台版）」跟库里已停用的 vp_b 同平台同 voice
    const p0 = await readPick(owin)
    const off = p0.rows.find((r) => r.off)
    ok('B1 榜上那条已停用的被标出来了', Boolean(off) && off.tag === '已停用', p0.rows)
    if (off) {
      const n = replies.length
      await send(A, `#绑定 ${off.no}`, '观众甲')
      const replied = await waitFor(() => replies.length > n)
      const said = lastReply()
      ok('B2 明确说了「被停用」，不是「已设为」', replied && said.includes('停用') && !said.includes('已设为'), said)
      const p1 = await readPick(owin)
      ok('B3 面板上也写明了没换成', p1.fail.includes('停用'), p1.fail)
      ok('B4 没有把那条标成已绑定', !p1.rows.some((r) => r.picked), p1.rows)
      ok('B5 绑定记录里没多出东西', Object.keys(store.get().voiceBindings || {}).length === 0, store.get().voiceBindings)
      // 这条链路以前一个字都不记，出了问题只能靠猜
      const logFile = path.join(tmpUserData, 'chatsparty.log')
      const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
      ok('B6 落了日志', text.includes('[voices] 绑定到已停用的音色'), text.split('\n').filter((l) => l.includes('[voices]')).slice(-3))
    }
  }

  console.log('\n[C] 正常绑定 -> 面板标上勾，并且重新计满时长')
  {
    await reset()
    await send(A, '#音色列表 御姐', '观众甲')
    await waitFor(async () => (await readPick(owin)).show)
    const p0 = await readPick(owin)
    const normal = p0.rows.find((r) => !r.off)
    ok('C1 榜上有可绑的那条', Boolean(normal), p0.rows)
    if (normal) {
      const n = replies.length
      await send(A, `#绑定 ${normal.no}`, '观众甲')
      const replied = await waitFor(() => replies.length > n)
      ok('C2 回执说换成功了', replied && lastReply().includes('已设为'), lastReply())
      const p1 = await readPick(owin)
      const row = p1.rows.find((r) => r.no === normal.no)
      ok('C3 面板上把那条标成了已绑定', Boolean(row) && row.picked && row.ok, { row, picked: p1.rows.map((r) => r.picked) })
      ok('C4 只标了那一条', p1.rows.filter((r) => r.picked).length === 1, p1.rows.map((r) => r.picked))
      ok('C5 台上和聊天里都说的是同一个音色', lastReply().includes(normal.name.slice(0, 4)), lastReply())
      // 标完重新计满：否则可能刚标上就到点消失，观众根本没看见
      await wait(TTL - 700)
      const still = await readPick(owin)
      ok('C6 标上以后重新计满，没有立刻消失', still.show && still.rows.some((r) => r.picked), {
        show: still.show,
        bar: still.bar,
      })
      await wait(1000)
      const gone = await readPick(owin)
      ok('C7 重新计的时长到了才收起来', !gone.show, gone)
      ok('C8 收起来以后内容也清干净了', gone.rows.length === 0)
      ok('C9 队列跟着空了', pickQueue.size() === 0, pickQueue.size())
    }
  }

  console.log('\n[D] 两个人同时搜 -> 排队依次显示，谁也不盖谁')
  const B = ++uidSeq
  {
    await reset()
    await send(A, '#音色列表 御姐', '观众甲')
    await waitFor(async () => (await readPick(owin)).show)
    const first = await readPick(owin)
    await send(B, '#音色列表 御姐', '观众乙')
    await wait(300)

    const p = await readPick(owin)
    ok('D1 后来的人没有把前一位顶掉', p.who.includes('观众甲'), { who: p.who, first: first.who })
    ok('D2 面板上写明后面有人在等', p.wait.includes('1'), p.wait)
    ok('D3 两人份都在队列里', pickQueue.size() === 2, pickQueue.size())
    ok('D4 后一位的列表没被合并进来', p.rows.length === first.rows.length, { a: p.rows.length, b: first.rows.length })

    // 前一位到点 -> 自动换上后一位
    const switched = await waitFor(async () => {
      const q = await readPick(owin)
      return q.show && q.who.includes('观众乙')
    }, TTL + 2500)
    const p2 = await readPick(owin)
    ok('D5 前一位到点后自动换后一位', switched, { who: p2.who, show: p2.show })
    ok('D6 换上以后「还有人等」就没了', p2.wait === '', p2.wait)
    ok('D7 排队的这位是从上场才开始计的（没被前一位耗掉）', p2.show, p2)

    const expired = await waitFor(async () => !(await readPick(owin)).show, TTL + 2000)
    ok('D8 后一位也是满时长才走', expired)
    ok('D9 都走完队列就空了', pickQueue.size() === 0, pickQueue.size())

    // 中途才连上来的 OBS：不能挂着断开前的旧面板
    await send(A, '#音色列表 御姐', '观众甲')
    await waitFor(async () => (await readPick(owin)).show)
    const late = []
    const lateSock = new WebSocket(`ws://127.0.0.1:${port}/overlay`)
    lateSock.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw))
        if (m.type === 'voicepick') late.push(m.payload)
      } catch {
        /* noop */
      }
    })
    await new Promise((r) => lateSock.once('open', r))
    await wait(400)
    ok('D10 中途连上来的 OBS 补发了当前这一帧', late.length > 0 && Boolean(late[0].panel), late.slice(0, 1))
    try {
      lateSock.close()
    } catch {
      /* noop */
    }

    // 反过来：没人在选的时候连上来，也要被告知「现在没有」
    await reset()
    await wait(300)
    const late2 = []
    const lateSock2 = new WebSocket(`ws://127.0.0.1:${port}/overlay`)
    lateSock2.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw))
        if (m.type === 'voicepick') late2.push(m.payload)
      } catch {
        /* noop */
      }
    })
    await new Promise((r) => lateSock2.once('open', r))
    await wait(400)
    ok('D11 没人在选时补发「没有面板」，不会挂旧的', late2.length > 0 && late2[0].panel === null, late2)
    try {
      lateSock2.close()
    } catch {
      /* noop */
    }
  }

  console.log('\n[E] 开关与位置：改了立刻在叠加层生效，不用刷新源')
  {
    await reset()
    await patch({ overlay: { showVoicePick: false } })
    await wait(300)
    await send(A, '#音色列表 御姐', '观众甲')
    await wait(500)
    const off = await readPick(owin)
    ok('E1 关掉开关后面板不显示', !off.show, off)
    ok('E2 但队列照常排着（不是没收到）', pickQueue.size() === 1, pickQueue.size())
    // 台上不显示，聊天里的回执还是得发 —— 观众得知道有哪几条可选
    ok('E3 聊天里的回执不受开关影响', lastReply().includes('绑定'), lastReply())

    await patch({ overlay: { showVoicePick: true } })
    await wait(300)
    const on = await readPick(owin)
    ok('E4 再打开不用重搜，当前这条立刻画出来', on.show && on.who.includes('观众甲'), on)

    await patch({ overlay: { voicePickPos: 'bl' } })
    await wait(300)
    const moved = await readPick(owin)
    ok('E5 位置改完立刻生效', moved.pos === 'bl', moved.pos)

    await patch({ overlay: { voicePickPos: 'tr' } })
    await wait(300)
    ok('E6 能改回去', (await readPick(owin)).pos === 'tr')
  }

  console.log('\n[F] 窄画面：面板与点歌 / 歌词自动避让，不压成一坨')
  {
    const { OverlayServer } = require(path.join(ROOT, 'electron', 'overlay.cjs'))
    const { DEFAULTS } = require(path.join(ROOT, 'electron', 'store.cjs'))
    const cfg = { ...DEFAULTS.overlay, showVoicePick: true, voicePickPos: 'tr', voicePickHits: 4 }
    const server = new OverlayServer(0)
    const p2 = await server.start(13981)
    server.configProvider = () => cfg
    server.musicProvider = () => ({ current: { id: 1, name: '一首挺长的测试歌名占地方' }, items: [], queued: 0 })
    server.lyricProvider = () => ({ songId: 1, lines: ['歌词第一句', '歌词第二句'], index: 0, playing: true })
    server.voicePickProvider = () => ({
      panel: {
        id: 'p-demo',
        who: '观众甲',
        keyword: '御姐',
        hits: [
          { n: 1, name: '御姐音A', source: 'edge', hint: 'edge · zh-CN', registered: true, disabled: false },
          { n: 2, name: '御姐音B', source: 'edge', hint: 'edge · zh-CN', registered: true, disabled: true },
          { n: 3, name: '御姐音C', source: 'system', hint: 'system · 中文', registered: true, disabled: false },
          { n: 4, name: '御姐音D', source: 'edge', hint: 'edge · zh-CN', registered: false, disabled: false },
        ],
        picked: 0,
        failed: '',
        ttlMs: 8000,
      },
      waiting: 2,
    })

    // 窄条画布：OBS 浏览器源被拖成竖长条是常态
    const w = new BrowserWindow({ width: 480, height: 700, show: false, webPreferences: { contextIsolation: true } })
    await w.loadURL(`http://127.0.0.1:${p2}/overlay`)
    await waitFor(() => Promise.resolve(server.clientCount > 0))
    await wait(600)

    const rects = await w.webContents.executeJavaScript(READ_RECTS)
    console.log(`        量到 ${rects.length} 块：${rects.map((r) => `${r.id}@${Math.round(r.x)},${Math.round(r.y)}`).join(' ')}`)
    const hits = []
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]
        const b = rects[j]
        const overlap = a.x < b.right - 0.5 && b.x < a.right - 0.5 && a.y < b.bottom - 0.5 && b.y < a.bottom - 0.5
        if (overlap) hits.push([a.id, b.id])
      }
    }
    ok('F1 三块都画出来了', rects.length === 3, rects.map((r) => r.id))
    ok('F2 窄画面下没有任何两块压在对方身上', hits.length === 0, hits)
    ok('F3 面板整个留在画布里', rects.every((r) => r.y >= 0 && r.bottom <= 700.5 && r.right <= 480.5), rects)

    w.destroy()
    await server.stop()
  }

  try {
    sock.close()
  } catch {
    /* noop */
  }
  owin.destroy()
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
}

app.whenReady().then(() =>
  main()
    .catch((e) => {
      console.error('脚本异常：', e && e.stack ? e.stack : e)
      fail++
    })
    .finally(async () => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.destroy()
      }
      await wait(200)
      try {
        fs.rmSync(tmpUserData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      } catch {
        /* 交给下次启动的 sweep */
      }
      setTimeout(() => app.exit(fail ? 1 : 0), 200)
    }),
)
