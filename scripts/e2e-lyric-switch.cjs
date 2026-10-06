'use strict'
/**
 * 歌词串歌的端到端验证。
 *
 * 为什么要有这个脚本：歌词是「渲染层算行号 -> 主进程中转 -> OBS 叠加层画」三段接力，
 * 换歌那一瞬间的状态竞态靠静态断言根本看不出来（每一段单看都是对的）。
 * 这里真起应用、真点歌、真换歌，从**叠加层页面画出来的字**回头看结论。
 *
 * 用法（必须在项目根目录，且用 electron 的二进制跑，不能用 node）：
 *   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/e2e-lyric-switch.cjs
 * 或者：npm run e2e:lyric
 * 注意：跑之前先 `npx vite build` —— 它加载的是构建产物 dist-renderer。
 *
 * 两节：
 *   [A] 真机接力：真队列 + 真渲染层，验「换歌后叠加层显示的是新那首的词」
 *   [B] 叠加层守卫：自己起一个叠加层服务，伪造一帧「挂着乙的名、带着甲的词」，验它被丢掉
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')
const WebSocket = require('ws')

const ROOT = path.join(__dirname, '..')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-lyric-'))

app.setPath('userData', tmpUserData)
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('use-gl', 'swiftshader')
app.disableHardwareAcceleration()
process.env.CP_PROD = '1'
process.env.CP_E2E = '1'

const SONG_A = 9001
const SONG_B = 9002
const SONG_C = 9004
/** 这首故意不给词：真实曲库里没词的歌不少，换上去不能残留上一首的 */
const SONG_NOLYRIC = 9003
/** 两首歌的词故意用不同的字开头：串没串一眼就能看出来 */
const WORDS = {
  [SONG_A]: ['甲歌第一句', '甲歌第二句', '甲歌第三句'],
  [SONG_B]: ['乙歌第一句', '乙歌第二句', '乙歌第三句'],
  [SONG_C]: ['丙歌第一句', '丙歌第二句', '丙歌第三句'],
}
const linesOf = (id) => (WORDS[id] || []).map((text, i) => ({ time: i * 30, text }))

/** 一段 12 秒的静音 wav。取链被拦时播放器会自己跳下一首，那样就测不成「换歌」了 */
function wavDataUri(seconds) {
  const rate = 8000
  const n = rate * seconds
  const buf = Buffer.alloc(44 + n, 0x80)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate, 28)
  buf.writeUInt16LE(1, 32)
  buf.writeUInt16LE(8, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n, 40)
  return 'data:audio/wav;base64,' + buf.toString('base64')
}

// 拦住网易云：不联网，歌词固定，播放地址给上面那段静音
const NCM = require(path.join(ROOT, 'electron', 'netease.cjs'))
const SILENCE = wavDataUri(12)
NCM.lyric = async (id) => ({ lrc: linesOf(Number(id)), raw: '' })
NCM.songUrl = async () => ({ url: SILENCE, br: 320000, size: 0 })

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

/** 读叠加层页面上「真正画出来的」歌词 */
const READ_LYRIC = `(() => {
  const el = document.getElementById('cp-lyric')
  if (!el) return { show: false, lines: [] }
  return {
    show: el.classList.contains('is-show'),
    lines: Array.from(el.querySelectorAll('.cp-lyric__line')).map((n) => n.textContent),
    songId: Number(el.getAttribute('data-song')) || 0,
  }
})()`
const readLyric = (w) => w.webContents.executeJavaScript(READ_LYRIC)

require(path.join(ROOT, 'electron', 'main.cjs'))

async function main() {
  let win = null
  await waitFor(async () => {
    win = BrowserWindow.getAllWindows()[0] || null
    return Boolean(win)
  })
  if (!win) throw new Error('主窗口没起来')
  await waitFor(() => win.webContents.executeJavaScript('1').then(() => true).catch(() => false))
  const hasApi = await waitFor(() =>
    win.webContents
      .executeJavaScript('Boolean(window.chatsparty && window.chatsparty.music && window.chatsparty.overlay)')
      .then((v) => Boolean(v))
      .catch(() => false),
  )
  if (!hasApi) throw new Error('渲染层没拿到 chatsparty 接口')

  /**
   * 把播放器换成假的。
   * 这一段测的是「歌词跟不跟得上换歌」，不需要真出声 —— 而真 <audio> 在这个环境里
   * 放不了（没手势 / 拿不到真链），它会走 onerror 自动跳下一首，队列被它带跑以后
   * 测的就不是我要测的那件事了。假播放器只会老老实实往前走时间，不会自己换歌。
   */
  await win.webContents.executeJavaScript(`(() => {
    window.Audio = class {
      constructor() {
        this.src = ''; this.paused = true; this.volume = 1
        this.currentTime = 0; this.duration = 12; this.error = null
        this.onloadedmetadata = null; this.ontimeupdate = null
        this.onerror = null; this.onended = null; this._t = 0
      }
      play() {
        this.paused = false
        if (this.onloadedmetadata) this.onloadedmetadata()
        clearInterval(this._t)
        this._t = setInterval(() => {
          this.currentTime += 0.5
          if (this.ontimeupdate) this.ontimeupdate()
        }, 250)
        return Promise.resolve()
      }
      pause() { this.paused = true; clearInterval(this._t) }
      addEventListener() {}
    }
    return true
  })()`)

  const started = await win.webContents.executeJavaScript('window.chatsparty.overlay.start()')
  if (!started || !started.ok) throw new Error(`叠加层没起来：${JSON.stringify(started)}`)
  const port = started.port
  console.log(`\n叠加层端口 ${port}`)

  // 一份「OBS 会收到什么」的流水账
  const frames = []
  const sock = new WebSocket(`ws://127.0.0.1:${port}/overlay`)
  sock.on('message', (raw) => {
    try {
      const m = JSON.parse(String(raw))
      if (m.type === 'lyric') frames.push(m.payload)
    } catch {
      /* noop */
    }
  })
  await new Promise((r, j) => {
    sock.once('open', r)
    sock.once('error', j)
  })

  // 真开一个叠加层页面，验的就是它画在画面上的字
  const owin = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { contextIsolation: true } })
  await owin.loadURL(`http://127.0.0.1:${port}/overlay`)
  await waitFor(() => Promise.resolve(true), 100)
  await wait(400)

  const prefix = (id) => (WORDS[id][0] || '').slice(0, 2)
  const allFrom = (list, id) => list.length > 0 && list.every((t) => String(t).indexOf(prefix(id)) === 0)

  const enqueue = (id) =>
    win.webContents.executeJavaScript(
      `window.chatsparty.music.enqueue({ id: ${id}, name: '测试歌${id}', artists: '测试' }, 'e2e')`,
    )
  const nextSong = () => win.webContents.executeJavaScript('window.chatsparty.music.next()')

  console.log('\n[A] 真队列里换歌，看叠加层画的是谁家的词')
  {
    await enqueue(SONG_A)
    await enqueue(SONG_B)
    await enqueue(SONG_C)
    await enqueue(SONG_NOLYRIC)
    const gotA = await waitFor(async () => allFrom((await readLyric(owin)).lines, SONG_A))
    const a = await readLyric(owin)
    ok('A1 第一首的歌词正常出来了', gotA, a)
    console.log(`        画面上：${JSON.stringify(a.lines)}`)

    const before = frames.length
    await nextSong()
    const gotB = await waitFor(async () => allFrom((await readLyric(owin)).lines, SONG_B))
    const b = await readLyric(owin)
    ok('A2 换上第二首后，画面上是第二首的词（不串歌）', gotB, b)
    console.log(`        画面上：${JSON.stringify(b.lines)}`)

    // 这一帧一帧查：标注的歌和它带的词必须是同一首
    const after = frames.slice(before)
    const labeled = after.filter((f) => Array.isArray(f.lines) && f.lines.length)
    const mixed = labeled.filter((f) => !allFrom(f.lines, f.songId))
    ok('A3 没有「挂着新歌的名、带着旧歌的词」的帧', mixed.length === 0, mixed)
    ok(
      'A4 第二首自己的词确实送出去过',
      labeled.some((f) => f.songId === SONG_B),
      labeled.map((f) => ({ songId: f.songId, first: f.lines[0] })),
    )
    const wrong = after.filter((f) => f.songId === SONG_B && Array.isArray(f.lines) && !allFrom(f.lines, SONG_B))
    ok('A5 第二首名下没出现过别人的词', wrong.length === 0, wrong)
    // 换歌那一帧要先把旧词清掉，否则会有几百毫秒的「新歌配旧词」
    const clearFrame = after.findIndex((f) => f.songId === SONG_B && !(f.lines || []).length)
    const firstName = after.findIndex((f) => f.songId === SONG_B)
    ok('A6 换歌后先清空、再补新词', clearFrame >= 0 && clearFrame <= firstName, { clearFrame, firstName })
  }

  console.log('\n[C] 再往后换：连换、换到没词的、放空、再点一遍')
  {
    const before = frames.length
    await nextSong()
    const gotC = await waitFor(async () => allFrom((await readLyric(owin)).lines, SONG_C))
    const c = await readLyric(owin)
    ok('C1 第三首也画的是自己的词（不是上一首的）', gotC, c)
    console.log(`        画面上：${JSON.stringify(c.lines)}`)
    const labeled = frames.slice(before).filter((f) => Array.isArray(f.lines) && f.lines.length)
    ok(
      'C2 第二首、第三首的词没有互相混',
      labeled.every((f) => allFrom(f.lines, f.songId)),
      labeled.map((f) => ({ songId: f.songId, first: f.lines[0] })),
    )

    await nextSong()
    await wait(700)
    const noLyric = await readLyric(owin)
    ok('C3 换到没歌词的歌：画面上不残留上一首的词', noLyric.lines.length === 0, noLyric)

    await nextSong()
    await wait(700)
    const ended = await readLyric(owin)
    ok('C4 队列放空：歌词跟着收起来', ended.lines.length === 0, ended)

    await enqueue(SONG_B)
    const again = await waitFor(async () => allFrom((await readLyric(owin)).lines, SONG_B))
    ok('C5 同一首隔了几首再点回来，词还是对的', again, await readLyric(owin))

    // OBS 中途才连上来：补发的必须是当前这首歌的词
    const late = []
    const lateSock = new WebSocket(`ws://127.0.0.1:${port}/overlay`)
    lateSock.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw))
        if (m.type === 'lyric') late.push(m.payload)
      } catch {
        /* noop */
      }
    })
    await new Promise((r) => lateSock.once('open', r))
    await wait(600)
    const first = late.find((f) => Array.isArray(f.lines) && f.lines.length)
    ok('C6 中途连上来的 OBS 补发的是当前这首的词', Boolean(first) && allFrom(first.lines, SONG_B), late)
    try {
      lateSock.close()
    } catch {
      /* noop */
    }
  }

  // [B] 直接在叠加层服务上伪造一帧错歌的歌词
  console.log('\n[B] 叠加层自己的守卫：收到不属于当前这首歌的词怎么办')
  {
    const { OverlayServer } = require(path.join(ROOT, 'electron', 'overlay.cjs'))
    const { DEFAULTS } = require(path.join(ROOT, 'electron', 'store.cjs'))
    const cfg = { ...DEFAULTS.overlay, port: 0 }
    const server = new OverlayServer(0)
    const p2 = await server.start(13980)
    server.configProvider = () => cfg
    const w = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { contextIsolation: true } })
    await w.loadURL(`http://127.0.0.1:${p2}/overlay`)
    await waitFor(() => Promise.resolve(server.clientCount > 0))
    await wait(300)

    server.broadcast('music', { current: { id: SONG_B, name: '乙' }, items: [], queued: 0 })
    server.broadcast('lyric', {
      songId: SONG_A,
      lines: WORDS[SONG_A],
      times: [0, 30, 60],
      index: 0,
      playing: true,
    })
    await wait(400)
    const bad = await readLyric(w)
    ok('B1 挂着甲歌名的词，在放乙歌时不会被画出来', !allFrom(bad.lines, SONG_A), bad)

    server.broadcast('lyric', {
      songId: SONG_B,
      lines: WORDS[SONG_B],
      times: [0, 30, 60],
      index: 0,
      playing: true,
    })
    await wait(400)
    const good = await readLyric(w)
    ok('B2 换成乙歌自己的词就正常显示', allFrom(good.lines, SONG_B), good)

    server.broadcast('music', { current: null, items: [], queued: 0 })
    server.broadcast('lyric', { songId: 0, index: -1, playing: false })
    await wait(400)
    const cleared = await readLyric(w)
    ok('B3 停下清空的那一帧不会被守卫误挡（该藏就藏）', cleared.lines.length === 0 && !cleared.show, cleared)

    // 断开那阵子画面上最后一句还挂着，重连回来必须被告知「现在没有词」
    server.lyricProvider = () => ({ songId: 0, index: -1, text: '', playing: false })
    const late = []
    const ls = new WebSocket(`ws://127.0.0.1:${p2}/overlay`)
    ls.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw))
        if (m.type === 'lyric') late.push(m.payload)
      } catch {
        /* noop */
      }
    })
    await new Promise((r) => ls.once('open', r))
    await wait(500)
    ok('B4 中途连上来时「现在没有词」也会说一声', late.length > 0 && !(late[0].lines || []).length, late)
    try {
      ls.close()
    } catch {
      /* noop */
    }

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
