'use strict'
/**
 * 换歌之后新歌是不是**从头**开始播。
 *
 * 为什么要这个脚本：栽过一次「点歌从 2 分多开始放」—— 引擎给新歌的续播位置
 * 取的是 positionRef（上一首残留的进度），于是新歌接着上一首播到的地方响。
 * 静态断言看不出来（源码看着每句都合理），只有让真引擎 + 真 <audio> 跑一遍才知道。
 *
 * 不出声：音频是**全零 wav**（有真时长、能解码、没有波形），另外整个进程
 * 加了 --mute-audio。跑测试不该吵到正在用电脑的人。
 *
 * 用法：npm run e2e:song
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow, ipcMain } = require('electron')

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-song-'))

/** 清掉上一轮留下的临时 userData（目录名带前缀，绝不碰别的东西） */
function sweepStale(keep) {
  let names = []
  try {
    names = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith('cp-e2e-song-') || path.join(os.tmpdir(), n) === keep) continue
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
// 双保险：就算哪天换成了有波形的测试音频，也不会从扬声器出来
app.commandLine.appendSwitch('mute-audio')
app.disableHardwareAcceleration()
process.env.CP_PROD = '1'
process.env.CP_E2E = '1'
process.env.CP_OVERLAY_PORT = String(20000 + Math.floor(Math.random() * 20000))

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
async function waitFor(fn, ms = 8000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const r = await fn()
      if (r) return r
    } catch {
      /* 还没到 */
    }
    await wait(100)
  }
  return false
}

/** 全零 wav：有真时长、能解码、一点声音都没有 */
function silentWav(seconds) {
  const sr = 8000
  const n = Math.floor(sr * seconds)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sr, 24)
  buf.writeUInt32LE(sr * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  return 'data:audio/wav;base64,' + buf.toString('base64')
}

const LONG = silentWav(30) // 用「播到一半切下一首」
const SHORT = silentWav(4) // 用「自然播完自动推进」

require(path.join(__dirname, '..', 'electron', 'main.cjs'))

/** 取链换成桩（不联网）。必须等 main.cjs 注册完 handler 再覆盖 */
function stubSongUrl() {
  ipcMain.removeHandler('music:url')
  ipcMain.handle('music:url', async (_e, id) => {
    const isShort = Number(id) === 9002
    return {
      id: Number(id),
      url: isShort ? SHORT : LONG,
      br: 320000,
      size: 0,
      type: 'wav',
      level: 'exhigh',
      expiresIn: 1200,
      md5: '',
    }
  })
}

const mainWindow = () => BrowserWindow.getAllWindows().find((w) => (w.getTitle() || '').includes('弹幕姬'))
const run = (w, code) => w.webContents.executeJavaScript(code)

/** 引擎那一个播放元素的状态。元素是 new Audio() 造的，DOM 里没有它 */
const AUDIO = `(() => {
  const el = (window.__audios || [])[0]
  if (!el) return null
  return { currentTime: el.currentTime, paused: el.paused, duration: el.duration, ready: el.readyState }
})()`
const MARKS = `(() => window.__marks.slice())()`
/** 起播那一刻的进度：换歌打点里第一个 play/playing */
const START_OF = (marks) => (marks || []).find((m) => m.ev === 'playing') || (marks || []).find((m) => m.ev === 'play') || null

async function main() {
  const win = await waitFor(() => mainWindow(), 20000)
  ok('主窗口起来了', Boolean(win))
  if (!win) {
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
    app.exit(fail > 0 ? 1 : 0)
    return
  }
  stubSongUrl()

  // 劫持 window.Audio：元素不在 DOM 里，只能从构造函数这一层抓到它。
  // 引擎**复用同一个元素**（换歌只换 src），所以每次装载/起播打个点，
  // 记下那一刻的 currentTime —— 那就是「新歌从哪开始」。
  await run(
    win,
    `(() => {
      if (window.__audios) return true
      window.__audios = []
      window.__marks = []
      const Orig = window.Audio
      window.Audio = function (...a) {
        const el = new Orig(...a)
        window.__audios.push(el)
        const rec = (ev) => el.addEventListener(ev, () => window.__marks.push({ ev, t: Number(el.currentTime.toFixed(2)), d: Number(el.duration || 0) }))
        ;['emptied', 'loadedmetadata', 'play', 'playing', 'ended'].forEach(rec)
        return el
      }
      return true
    })()`,
  )
  const clearMarks = () => run(win, `(() => { window.__marks = []; return true })()`)
  const enqueue = (id, sec) =>
    run(
      win,
      `window.chatsparty.music.enqueue({ id: ${id}, name: '测试歌 ${id}', artists: 'e2e', duration: ${sec}, durationText: '0:${String(sec).padStart(2, '0')}', picUrl: '' }, 'e2e')`,
    )

  console.log('[1] 队列空时点一首 → 从头播')
  await enqueue(9001, 30)
  const a = await waitFor(async () => {
    const r = await run(win, AUDIO)
    return r && r.ready >= 1 ? r : null
  }, 15000)
  ok('歌真的在播（元素就绪且没暂停）', Boolean(a && a.ready >= 2 && a.paused === false), a)
  ok('第一首从 0 开始', Boolean(a && a.currentTime < 1.5), a && a.currentTime)

  console.log('[2] 播到一半点「下一首」→ 新歌从头播（不是接着上一首的进度）')
  await wait(2600) // 让它播到两秒多 —— 这个数就是「旧进度」，以前会被当成新歌的起点
  const before = await run(win, AUDIO)
  ok('上一首确实播出去了一段（复现前提）', Boolean(before && before.currentTime > 1.5), before && before.currentTime)
  await enqueue(9003, 30)
  await clearMarks()
  await run(win, `window.chatsparty.music.next().then(() => true)`)
  await wait(2500)
  const marksB = await run(win, MARKS)
  const startB = START_OF(marksB)
  ok('换了新的一条（重新装载并起播）', Boolean(startB), marksB)
  ok(
    '新歌从头开始（不再接着上一首的进度）',
    Boolean(startB && startB.t < 1.5),
    startB ? `起播 ${startB.t}s，上一首已播到 ${Number(before?.currentTime || 0).toFixed(2)}s` : marksB,
  )

  console.log('[3] 自然播完自动推进 → 下一首也从头播')
  await enqueue(9002, 4) // 4 秒那条，播完会自动 ended → 推进
  await clearMarks()
  await run(win, `window.chatsparty.music.next().then(() => true)`)
  await waitFor(async () => {
    const m = await run(win, MARKS)
    return (m || []).some((x) => x.ev === 'ended') ? m : null
  }, 15000)
  const marksC = await run(win, MARKS)
  const startC = START_OF(marksC)
  ok('播完自动推进到下一条（ended 触发）', Boolean((marksC || []).some((x) => x.ev === 'ended')), marksC)
  ok('自动推进的这条也是从头开始', Boolean(startC && startC.t < 1.5), startC && startC.t)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  app.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  app.exit(1)
})
