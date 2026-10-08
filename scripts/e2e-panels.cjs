'use strict'
/**
 * 「一块一个 OBS 源」的端到端验证。
 *
 * 为什么要有这个脚本：拆开用的价值全在**源与源之间不互相串**上 ——
 * 歌词源里冒出一条弹幕、或者点歌源里挂着一行歌词，光看代码是看不出来的
 * （每一块自己的渲染逻辑都是对的，问题出在「谁该画」这一层）。
 * 所以这里真起叠加层服务、真开浏览器窗口、真推四种帧，然后从**每个页面画出来的东西**
 * 回头看结论。
 *
 * 它不需要主进程，也不需要 vite build：这一段只跟 overlay/ 这一个静态页打交道。
 *
 * 用法（项目根目录，用 electron 的二进制跑）：
 *   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/e2e-panels.cjs
 * 或者：npm run e2e:panels
 *
 * 四节：
 *   [A] 地址路由：/overlay/xxx 都回那份页面，认不得的回落「全部」
 *   [B] 各画各的：六个源同时开着，推同一批帧，验每块只出现自己那一份
 *   [C] 窄源：单块能吃满整个源（压过「三块同挤画布」时定的百分比上限）
 *   [D] 老地址与兜底：/overlay 仍是「几块齐全」
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-panels-'))

app.setPath('userData', tmpUserData)
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('use-gl', 'swiftshader')
app.disableHardwareAcceleration()
process.env.CP_PROD = '1'
process.env.CP_E2E = '1'

const { OverlayServer } = require(path.join(ROOT, 'electron', 'overlay.cjs'))
const { DEFAULTS } = require(path.join(ROOT, 'electron', 'store.cjs'))

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
    await wait(80)
  }
  return false
}

/** 一次 GET，把状态码 / 类型 / 缓存头 / 正文都拿回来 */
function get(port, pathname) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => {
        body += d
      })
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          type: res.headers['content-type'] || '',
          cache: res.headers['cache-control'] || '',
          body,
        }),
      )
    })
    req.on('error', (e) => resolve({ status: 0, error: String(e.message || e) }))
    req.end()
  })
}

/**
 * 页面画出来的东西。以**渲染结果**为准 ——
 * 只查 class 是不够的：`.cp-lyric` 不带 is-show 时是 display:none，
 * 那才是「没画」的真正含义。
 */
const READ = `(() => {
  const app = document.getElementById('app')
  const lyric = document.querySelector('.cp-lyric')
  const music = document.querySelector('.cp-music')
  const pick = document.querySelector('.cp-pick')
  const viewers = document.querySelector('.cp-viewers')
  const status = document.getElementById('cp-status')
  const vis = (n) => Boolean(n) && getComputedStyle(n).display !== 'none'
  const cap = (n) => (n ? getComputedStyle(n).maxHeight : '')
  const item = app ? app.querySelector('.cp-item') : null
  return {
    panel: document.documentElement.getAttribute('data-panel'),
    isPanel: document.documentElement.classList.contains('is-panel'),
    isNarrow: document.documentElement.classList.contains('is-narrow'),
    viewW: window.innerWidth,
    viewH: window.innerHeight,
    danmakuCount: app ? app.querySelectorAll('.cp-item').length : -1,
    danmakuText: app ? Array.from(app.querySelectorAll('.cp-item .cp-text')).map((n) => n.textContent) : [],
    danmakuRight: item ? Math.round(item.getBoundingClientRect().right) : -1,
    danmakuLeft: item ? Math.round(item.getBoundingClientRect().left) : -1,
    danmakuPos: app ? app.getAttribute('data-pos') : '',
    lyricShown: vis(lyric),
    lyricLines: lyric ? Array.from(lyric.querySelectorAll('.cp-lyric__line')).map((n) => n.textContent) : [],
    lyricWidth: lyric ? Math.round(lyric.offsetWidth) : -1,
    lyricPos: lyric ? lyric.getAttribute('data-pos') : '',
    musicShown: vis(music),
    musicText: music ? music.textContent : '',
    pickShown: vis(pick),
    pickText: pick ? pick.textContent : '',
    viewersShown: vis(viewers),
    viewersText: viewers ? viewers.textContent : '',
    viewersPos: viewers ? viewers.getAttribute('data-pos') : '',
    caps: { lyric: cap(lyric), music: cap(music), pick: cap(pick), viewers: cap(viewers) },
    statusShown: status ? status.classList.contains('is-show') : false,
    statusBad: status ? status.classList.contains('is-bad') : false,
    statusText: status ? status.textContent : '',
  }
})()`
const read = (w) => w.webContents.executeJavaScript(READ)

/** 推五种帧各一条 —— 每块都有自己的事要画，才验得出「串没串」 */
function pushAll(server) {
  server.broadcast('event', {
    id: 'e-1',
    type: 'danmaku',
    username: '测试观众',
    content: '弹幕内容一号',
    medal: null,
    timestamp: Date.now(),
  })
  server.broadcast('music', {
    current: null,
    items: [{ id: 1, name: '测试歌一号', requester: '小明' }],
    queued: 1,
  })
  server.broadcast('lyric', {
    songId: 0,
    lines: ['测试歌词第一句', '测试歌词第二句'],
    times: [0, 1],
    index: 0,
    playing: true,
  })
  server.broadcast('voicepick', {
    panel: {
      id: 'p-1',
      who: '小红',
      keyword: '萝莉',
      hits: [{ n: 1, name: '音色甲', source: 'edge', hint: 'edge · zh-CN', registered: true, disabled: false }],
      picked: 0,
      failed: '',
      ttlMs: 8000,
    },
    waiting: 0,
  })
  server.broadcast('viewers', {
    ok: true,
    roomId: 1,
    anchorUid: 2,
    onlineNum: 954,
    items: [
      // 甲走大航海标签（同一行放不下两个，舰长优先于牌子），乙走粉丝牌 —— 两条路都要画到
      {
        uid: 11,
        name: '观众甲',
        face: '',
        score: 13017,
        guardLevel: 3,
        guard: '舰长',
        wealthLevel: 30,
        medal: { name: '囚人', level: 21 },
      },
      { uid: 12, name: '观众乙', face: '', score: 640, guardLevel: 0, guard: '', wealthLevel: 5, medal: { name: '老观众', level: 12 } },
    ],
    updatedAt: Date.now(),
    error: '',
    fetching: false,
  })
}

/** 开一个叠加层窗口并等它连上、把帧收完 */
async function openSource(port, pathname, size = { width: 1000, height: 700 }) {
  const w = new BrowserWindow({ ...size, show: false, webPreferences: { contextIsolation: true } })
  await w.loadURL(`http://127.0.0.1:${port}${pathname}`)
  await wait(150)
  return w
}

async function main() {
  const server = new OverlayServer(0)
  const port = await server.start(13971)
  const cfg = { ...DEFAULTS.overlay }
  server.configProvider = () => cfg
  console.log(`\n叠加层服务端口 ${port}`)

  const wins = []
  try {
    /* ------------------------- [A] 地址路由 ------------------------- */
    console.log('\n[A] 地址路由：一个页面，多个地址')
    {
      const base = await get(port, '/overlay')
      const lyric = await get(port, '/overlay/lyric')
      const plain = await get(port, '/index.html')
      ok('老的 /overlay 照常 200', base.status === 200 && base.type.includes('text/html'), base.status)
      ok('/overlay/lyric 也回那份页面', lyric.status === 200 && lyric.type.includes('text/html'), lyric.status)
      ok('两份内容一模一样（没有各存一份 HTML）', lyric.body === base.body && base.body.length > 1000, [base.body.length, lyric.body.length])
      ok('/index.html 也能直接开', plain.status === 200 && plain.body === base.body)
      // 不设 no-store 的话，升级程序后 OBS 点「刷新」拿到的还是旧页面
      ok('页面不许被缓存', base.cache.includes('no-store') && lyric.cache.includes('no-store'), base.cache)

      // 认不得的名字不该 404，也不该变成空白 —— 回落到「全部」还算能用
      const nope = await get(port, '/overlay/nope')
      ok('乱写的名字不 404（先给一份页面）', nope.status === 200 && nope.body === base.body, nope.status)
      const deep = await get(port, '/overlay/lyric/extra')
      ok('多一层路径也不 404', deep.status === 200)

      // 目录穿越还是得挡住。%2f 不会被 path.normalize 解码，所以这里其实拿到的是
      // 「找不到 -> 回落 index.html」那条路；断言的是**仓库里的文件没被吐出来**
      const evil = await get(port, '/..%2f..%2fpackage.json')
      ok('穿越路径拿不到仓库文件', !evil.body.includes('"version"'), evil.status)
    }

    /* ------------------------- [B] 各画各的 ------------------------- */
    console.log('\n[B] 各画各的：六个源同时开着，推同一批帧')
    const PANELS = [
      { key: 'all', url: '/overlay' },
      { key: 'danmaku', url: '/overlay/danmaku' },
      { key: 'lyric', url: '/overlay/lyric' },
      { key: 'music', url: '/overlay/music' },
      { key: 'voicepick', url: '/overlay/voicepick' },
      { key: 'viewers', url: '/overlay/viewers' },
    ]
    const views = {}
    for (const p of PANELS) views[p.key] = await openSource(port, p.url)
    wins.push(...Object.values(views))

    await waitFor(() => server.clientCount >= PANELS.length, 6000)
    ok(`B1 六个源都连上了（实际 ${server.clientCount}）`, server.clientCount >= PANELS.length, server.clientCount)

    pushAll(server)
    await wait(500)
    const got = {}
    for (const p of PANELS) got[p.key] = await read(views[p.key])
    // 打一行摘要：出问题时一眼看出是哪块串了
    for (const p of PANELS) {
      const v = got[p.key]
      console.log(
        `        ${p.key.padEnd(9)} 弹幕${v.danmakuCount} 歌词${v.lyricShown ? '有' : '无'} 点歌${v.musicShown ? '有' : '无'} 音色${v.pickShown ? '有' : '无'} 观众${v.viewersShown ? '有' : '无'}`,
      )
    }

    // ---- 弹幕源 ----
    ok('B4 弹幕源：弹幕画出来了', got.danmaku.danmakuCount === 1 && got.danmaku.danmakuText[0] === '弹幕内容一号', got.danmaku.danmakuText)
    ok('B5 弹幕源：没有歌词', !got.danmaku.lyricShown)
    ok('B6 弹幕源：没有点歌面板', !got.danmaku.musicShown)
    ok('B7 弹幕源：没有音色面板', !got.danmaku.pickShown)
    // 位置配置在这个源里说的是「源内的位置」—— br 就该贴着右边缘。
    // 留了 40u 的余量：hide 着的窗口里 CSS 动画会被节流，入场那一帧的
    // translateX(24u) 可能还挂着，量的位置会比落定后偏出去一点
    ok(
      'B8 弹幕源里位置配置照样生效（br 贴右）',
      got.danmaku.danmakuRight >= got.danmaku.viewW - 40,
      { right: got.danmaku.danmakuRight, viewW: got.danmaku.viewW },
    )
    ok('B9 弹幕源认得出自己的身份', got.danmaku.panel === 'danmaku' && got.danmaku.isPanel, got.danmaku.panel)

    // 换成左下，刚才那条应该整个跑到左边去 —— 这比量一次坐标更能说明「配置真的被用上了」
    server.broadcast('config', { ...cfg, danmakuPos: 'bl' })
    await wait(300)
    const movedLeft = await read(views.danmaku)
    ok(
      'B10 改成左下以后真的挪到左边去了',
      movedLeft.danmakuPos === 'bl' && movedLeft.danmakuLeft <= 40,
      { pos: movedLeft.danmakuPos, left: movedLeft.danmakuLeft },
    )
    server.broadcast('config', cfg)
    await wait(200)

    // ---- 歌词源 ----
    ok('B11 歌词源：两句词都画出来了', got.lyric.lyricShown && got.lyric.lyricLines.length === 2, got.lyric.lyricLines)
    ok('B12 歌词源：词的内容对得上', got.lyric.lyricLines[0] === '测试歌词第一句', got.lyric.lyricLines)
    // 这条是整个改动的核心：弹幕源和歌词源是两个窗口，弹幕绝不能跑到歌词源里
    ok('B13 歌词源：一条弹幕都没有', got.lyric.danmakuCount === 0, got.lyric.danmakuCount)
    ok('B14 歌词源：没有点歌面板', !got.lyric.musicShown)
    ok('B15 歌词源：没有音色面板', !got.lyric.pickShown)

    // ---- 点歌源 ----
    ok('B16 点歌源：面板画出来了', got.music.musicShown && got.music.musicText.includes('测试歌一号'), got.music.musicText.slice(0, 40))
    ok('B17 点歌源：点歌人也显示出来', got.music.musicText.includes('小明'), got.music.musicText.slice(0, 40))
    ok('B18 点歌源：一条弹幕都没有', got.music.danmakuCount === 0, got.music.danmakuCount)
    ok('B19 点歌源：没有歌词', !got.music.lyricShown)
    ok('B20 点歌源：没有音色面板', !got.music.pickShown)

    // ---- 音色源 ----
    ok('B21 音色源：候选画出来了', got.voicepick.pickShown && got.voicepick.pickText.includes('音色甲'), got.voicepick.pickText.slice(0, 40))
    ok('B22 音色源：搜索人也在', got.voicepick.pickText.includes('小红'), got.voicepick.pickText.slice(0, 40))
    ok('B23 音色源：一条弹幕都没有', got.voicepick.danmakuCount === 0, got.voicepick.danmakuCount)
    ok('B24 音色源：没有歌词', !got.voicepick.lyricShown)
    ok('B25 音色源：没有点歌面板', !got.voicepick.musicShown)

    // ---- 提示：单面板源不该弹「已连接」 ----
    // 刚打开那一瞬去读是碰运气：那条提示 3 秒后自己就收了，漏了就成了假红。
    // 所以主动制造一次重连，把要观察的那一刻**固定下来**：
    //   断开 -> 两个源都会报「已断开」（这是错误，谁都该看见）
    //        -> 重连成功 -> 「已连接」只该在「全部」那个源上出现
    for (const c of Array.from(server.clients)) {
      try {
        c.terminate()
      } catch {
        /* noop */
      }
    }
    // 必须**先等它真的掉到 0**：连接还没清完的时候 clientCount 仍然是 5，
    // 直接等「回到 5」会立刻返回，那时候页面还停在「正在重连」上，读出来的全是错的
    const dropped = await waitFor(() => server.clientCount === 0, 4000)
    await wait(250)
    const offline = await read(views.lyric)
    ok(
      'B26 断开时单面板源也会报（这是错误，得让人看见）',
      offline.statusShown && offline.statusBad,
      { shown: offline.statusShown, bad: offline.statusBad, text: offline.statusText },
    )

    const back = await waitFor(() => server.clientCount >= PANELS.length, 10000)
    ok('B27 断开之后六个源都自己连回来了', dropped && back, { dropped, back, clients: server.clientCount })
    // 服务端一 accept 就把计数加上去了，页面那边的 onopen 要等握手回来才跑，
    // 差的就是这几毫秒 —— 给足 400ms，离提示自己收掉的 3 秒还远着
    await wait(400)
    const again = { all: await read(views.all), lyric: await read(views.lyric) }
    ok('B28 重连成功后「全部」那个源照旧打个招呼', again.all.statusShown, {
      shown: again.all.statusShown,
      text: again.all.statusText,
    })
    ok('B29 单面板源连上后不弹「已连接」', !again.lyric.statusShown, {
      shown: again.lyric.statusShown,
      text: again.lyric.statusText,
      panel: again.lyric.panel,
    })

    await waitFor(async () => !(await read(views.all)).statusShown, 5000)
    const after = await read(views.all)
    ok('B30 提示到点自己收掉', !after.statusShown, after.statusShown)
    ok('B31 「全部」那个源没有被当成单块源', !after.isPanel && after.panel === null, after.panel)

    // ---- 观众源（高能榜）----
    ok(
      'B32 观众源：名单画出来了',
      got.viewers.viewersShown && got.viewers.viewersText.includes('观众甲') && got.viewers.viewersText.includes('观众乙'),
      got.viewers.viewersText.slice(0, 60),
    )
    // 榜上人数和在线人数是两回事，两个都要画出来
    ok('B33 观众源：在线人数也标出来了', got.viewers.viewersText.includes('954'), got.viewers.viewersText.slice(0, 60))
    ok(
      'B34 观众源：大航海优先，没大航海的显示粉丝牌',
      got.viewers.viewersText.includes('舰长') && got.viewers.viewersText.includes('老观众'),
      got.viewers.viewersText.slice(0, 60),
    )
    ok('B35 观众源：默认摆左下', got.viewers.viewersPos === 'bl', got.viewers.viewersPos)
    // 和别块一样，观众源里也不许冒出别人的东西
    ok(
      'B36 观众源：一条弹幕/歌词/点歌/音色都没有',
      got.viewers.danmakuCount === 0 &&
        !got.viewers.lyricShown &&
        !got.viewers.musicShown &&
        !got.viewers.pickShown,
      {
        danmaku: got.viewers.danmakuCount,
        lyric: got.viewers.lyricShown,
        music: got.viewers.musicShown,
        pick: got.viewers.pickShown,
      },
    )
    // 反过来也得成立：另外四个源里一个观众榜都不该出现
    // （「全部」那个源除外 —— 它本来就是几块齐全）
    ok(
      'B37 别的源里不出现观众榜',
      !got.danmaku.viewersShown && !got.lyric.viewersShown && !got.music.viewersShown && !got.voicepick.viewersShown,
      {
        danmaku: got.danmaku.viewersShown,
        lyric: got.lyric.viewersShown,
        music: got.music.viewersShown,
        voicepick: got.voicepick.viewersShown,
      },
    )

    /* ------------------------- [C] 窄源 ------------------------- */
    console.log('\n[C] 窄源：单块能吃满整个源')
    {
      // 420×320：比 NARROW_W/NARROW_H 都小，肯定算「窄」
      const wLyric = await openSource(port, '/overlay/lyric', { width: 420, height: 320 })
      const wAll = await openSource(port, '/overlay', { width: 420, height: 320 })
      wins.push(wLyric, wAll)
      await waitFor(() => server.clientCount >= PANELS.length + 2, 6000)
      pushAll(server)
      await wait(600)

      const narrowLyric = await read(wLyric)
      const narrowAll = await read(wAll)
      ok('C1 窄源确实被判成「窄」', narrowLyric.isNarrow && narrowAll.isNarrow, [narrowLyric.isNarrow, narrowAll.isNarrow])

      // 「三块同挤一个画布」时定的上限（歌词 28% / 点歌 46% / 音色 42%）。
      // 单块源里这块独占整个源，这些上限必须被放开 ——
      // 两边选择器权重一样，靠的是 is-panel 那组规则排在 is-narrow 后面
      ok('C2 单独的歌词源不再被 28% 卡住', narrowLyric.caps.lyric === '100%', narrowLyric.caps)
      ok('C3 全部模式下那个 28% 还在（没误伤）', narrowAll.caps.lyric === '28%', narrowAll.caps)

      // 字幕该占满整个源：主播把源拉多宽，字就跟着走。
      // 窗口宽度按 innerWidth 算 —— 建的 420 里有一圈边框，实际画布是 404
      ok('C4 单独的歌词源里字幕占满宽度', narrowLyric.lyricWidth === narrowLyric.viewW, {
        w: narrowLyric.lyricWidth,
        view: narrowLyric.viewW,
      })
      ok('C5 全部模式下还留着左右各 24u 的余量', narrowAll.lyricWidth === narrowAll.viewW - 48, {
        w: narrowAll.lyricWidth,
        view: narrowAll.viewW,
      })

      // 点歌 / 音色两块同理
      const wMusic = await openSource(port, '/overlay/music', { width: 420, height: 320 })
      const wPick = await openSource(port, '/overlay/voicepick', { width: 420, height: 320 })
      wins.push(wMusic, wPick)
      await waitFor(() => server.clientCount >= PANELS.length + 4, 6000)
      pushAll(server)
      await wait(600)
      const nm = await read(wMusic)
      const np = await read(wPick)
      ok('C6 单独的点歌源放开了 46% 上限', nm.caps.music === '100%', nm.caps)
      ok('C7 单独的音色源放开了 42% 上限', np.caps.pick === '100%', np.caps)
      ok('C8 全部模式下那两个上限都还在', narrowAll.caps.music === '46%' && narrowAll.caps.pick === '42%', narrowAll.caps)
      ok('C9 窄源里点歌面板照样画出来', nm.musicShown, nm.musicText.slice(0, 30))
      ok('C10 窄源里音色候选照样画出来', np.pickShown, np.pickText.slice(0, 30))

      // 观众源也是同一个道理：42% 那条上限是为了「几块同挤一个画布」定的，
      // 单块源里整源都是它的，必须放开。选择器权重一样，靠 is-panel 排在后面赢
      const wView = await openSource(port, '/overlay/viewers', { width: 420, height: 320 })
      wins.push(wView)
      await waitFor(() => server.clientCount >= PANELS.length + 5, 6000)
      pushAll(server)
      await wait(600)
      const nv2 = await read(wView)
      ok('C11 单独的观众源放开了 42% 上限', nv2.caps.viewers === '100%', nv2.caps)
      ok('C12 全部模式下观众榜那个上限还在（没误伤）', narrowAll.caps.viewers === '42%', narrowAll.caps)
      ok('C13 窄源里观众榜照样画出来', nv2.viewersShown, nv2.viewersText.slice(0, 40))

      // 单块源里也不该冒出别的块
      ok(
        'C14 窄源里依然不串',
        nm.danmakuCount === 0 && !nm.lyricShown && np.danmakuCount === 0 && !np.musicShown && nv2.danmakuCount === 0 && !nv2.musicShown,
      )
    }

    /* ------------------------- [D] 老地址与兜底 ------------------------- */
    console.log('\n[D] 老地址与兜底')
    {
      const all = got.all
      // 「齐全」现在是五块 —— 观众榜也是常驻的一块
      ok(
        'D1 /overlay 还是几块齐全',
        all.danmakuCount === 1 && all.lyricShown && all.musicShown && all.pickShown && all.viewersShown,
        {
          danmaku: all.danmakuCount,
          lyric: all.lyricShown,
          music: all.musicShown,
          pick: all.pickShown,
          viewers: all.viewersShown,
        },
      )
      ok('D2 /overlay 上没有 is-panel 标记（样式不该被单块那套影响）', !all.isPanel && all.panel === null, all.panel)

      // ?panel=lyric 这种手敲的写法也认
      const q = await openSource(port, '/overlay?panel=lyric')
      wins.push(q)
      await waitFor(() => server.clientCount >= PANELS.length + 6, 6000)
      await wait(300)
      const qv = await read(q)
      ok('D3 ?panel=lyric 也认', qv.panel === 'lyric' && qv.isPanel, qv.panel)
      ok('D4 这么写的歌词源同样只有歌词', qv.danmakuCount === 0 && !qv.viewersShown, {
        danmaku: qv.danmakuCount,
        viewers: qv.viewersShown,
      })

      // 乱写的名字回落到「全部」：宁可多画一块，也不能给一片空白
      const nope = await openSource(port, '/overlay/nope')
      wins.push(nope)
      await waitFor(() => server.clientCount >= PANELS.length + 7, 6000)
      pushAll(server)
      await wait(600)
      const nv = await read(nope)
      ok('D5 乱写的名字按「全部」渲染', !nv.isPanel && nv.panel === null, nv.panel)
      ok(
        'D6 于是几块都会画出来',
        nv.danmakuCount === 1 && nv.lyricShown && nv.musicShown && nv.pickShown && nv.viewersShown,
        {
          danmaku: nv.danmakuCount,
          lyric: nv.lyricShown,
          music: nv.musicShown,
          pick: nv.pickShown,
          viewers: nv.viewersShown,
        },
      )
    }

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  } finally {
    for (const w of wins) {
      try {
        if (!w.isDestroyed()) w.destroy()
      } catch {
        /* noop */
      }
    }
    await server.stop()
  }
}

app.whenReady().then(() =>
  main()
    .catch((e) => {
      console.error('脚本异常：', e && e.stack ? e.stack : e)
      fail++
    })
    .finally(async () => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy()
      await wait(200)
      try {
        fs.rmSync(tmpUserData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      } catch {
        /* 留给下次 */
      }
      setTimeout(() => app.exit(fail ? 1 : 0), 200)
    }),
)
