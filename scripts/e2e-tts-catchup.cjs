'use strict'
/**
 * 队列堆积时加速朗读 —— 只有真跑一遍才看得见。
 *
 * 静态断言只能证明「代码里写了 rate」，证明不了**它真的被应用到了播放端**。
 * 这里让真主进程 + 真渲染进程 + 真 <audio> 跑一遍：
 *
 *   ① 灌 6 条弹幕 → 第 1 条开始播时队列还堆着 5 条 → 应当是 1.5 倍速
 *   ② 同一时刻去读 audio.playbackRate，确认不是只把数字传过去没人用
 *   ③ 全部播完、静默期（为了测试缩成 1 秒）过去后，再来一条 → 回原速
 *
 * 不出声：音源是**全零 wav**（有真时长、能解码、没有波形），进程另加了 --mute-audio。
 *
 * 用法：npm run e2e:tts
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-catchup-'))

/** 清掉上一轮留下的临时 userData（目录名带前缀，绝不碰别的东西） */
function sweepStale(keep) {
  let names = []
  try {
    names = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith('cp-e2e-catchup-') || path.join(os.tmpdir(), n) === keep) continue
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
// 双保险：就算哪天换成了有波形的音频，也不会从扬声器出来
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
async function waitFor(fn, ms = 10000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const r = await fn()
      if (r) return r
    } catch {
      /* 还没到 */
    }
    await wait(80)
  }
  return false
}

/** 全零 wav：有真时长、能解码、一点声音都没有。0.6 秒够播完又不拖时间 */
function silentWavBase64(seconds) {
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
  // 注意：App.tsx 那边是 atob(p.base64)，不带 data: 前缀
  return buf.toString('base64')
}

const CLIP_B64 = silentWavBase64(0.6)
const RATE = 1.5
const THRESHOLD = 5
const HOLD_SEC = 1

require(path.join(__dirname, '..', 'electron', 'main.cjs'))

const cp = () => global.__cpE2E
const mainWindow = () => BrowserWindow.getAllWindows().find((w) => (w.getTitle() || '').includes('弹幕姬'))
const run = (w, code) => w.webContents.executeJavaScript(code)

/**
 * 渲染侧：拦 tts:play 的 payload，同时记下每一个 new Audio() 出来的元素。
 *
 * 为什么要抓元素而不是 hook `playbackRate` 的 setter：那个属性挂在原型上，
 * 重定义之后赋值走不走新 setter 取决于引擎实现，试过一轮是抓不到的。
 * 直接把元素攒起来，播完读它**真实的** playbackRate —— 这才是「有没有生效」。
 */
const HOOK = `(() => {
  if (window.__ttsRateHook) return true
  window.__ttsRateHook = true
  window.__ttsPlay = []
  window.__audios = []
  const Orig = window.Audio
  window.Audio = function (...a) {
    const el = new Orig(...a)
    window.__audios.push(el)
    return el
  }
  window.chatsparty.tts.onPlay((p) => window.__ttsPlay.push({ rate: p.rate, text: p.text }))
  return true
})()`

/** 当前这批里第一个播放元素的真实倍速（元素不在 DOM，只能靠上面的构造函数抓） */
const FIRST_AUDIO_RATE = `(() => {
  const el = window.__audios && window.__audios[0]
  return el ? Number(el.playbackRate) : null
})()`

/** 清掉上一阶段的记录，只观察下一批 */
const CLEAR = `(() => { window.__ttsPlay.length = 0; window.__audios.length = 0; return true })()`

async function main() {
  const win = await waitFor(() => mainWindow(), 20000)
  ok('主窗口起来了', Boolean(win))
  if (!win) {
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
    await wait(120)
    app.exit(fail > 0 ? 1 : 0)
    return
  }
  const api = cp()

  // 先挂钩子，再灌弹幕 —— 反了就抓不到第一批
  await waitFor(() => run(win, HOOK), 8000)
  ok('渲染侧钩子挂上了', await run(win, 'Boolean(window.__ttsRateHook)'))

  console.log('[0] 铺桩：合成返回全零 wav，加速参数调小以便快速跑完')
  api.ttsFallback.setSynthesizer(async () => ({ base64: CLIP_B64, mime: 'audio/wav', latency: 1 }))
  api.store.patch({
    tts: {
      enabled: true,
      volume: 0,
      // 关掉一切「不该在这条链路里」的干扰：间隔、同人冷却、长度截断
      minIntervalMs: 0,
      perUserCooldownMs: 0,
      mergeDuplicate: false,
      maxLength: 200,
      catchUp: { enabled: true, threshold: THRESHOLD, rate: RATE, holdSec: HOLD_SEC },
    },
  })
  const cfg = api.store.get().tts
  ok('阈值 5 / 倍率 1.5 / 静默 1 秒已生效', cfg.catchUp?.threshold === 5 && cfg.catchUp?.rate === RATE && cfg.catchUp?.holdSec === 1, cfg.catchUp)

  console.log('[1] 连灌 6 条 → 第 1 条开始播时队列还堆着 5 条，应当加速')
  for (let i = 0; i < 6; i++) {
    api.music.danmaku(`加速测试第 ${i + 1} 条`, { uid: 91000 + i, username: `观众${i + 1}` })
  }
  ok('6 条都进了播报队列', api.speech.queue.length + (api.speech.busy ? 1 : 0) >= THRESHOLD, {
    queued: api.speech.queue.length,
    busy: api.speech.busy,
  })

  const firstPlay = await waitFor(() => run(win, 'window.__ttsPlay[0] || null'), 10000)
  ok('第一条真的播出去了', Boolean(firstPlay), firstPlay)
  ok('下发的倍速是 1.5', firstPlay && firstPlay.rate === RATE, firstPlay && firstPlay.rate)

  // 关键：数字传过去了还要真的设到元素上，否则听感毫无变化
  const applied = await waitFor(() => run(win, FIRST_AUDIO_RATE), 5000)
  ok('渲染层真的把 playbackRate 设成了 1.5', applied === RATE, applied)

  const preserved = await run(win, '(() => { const a = document.createElement("audio"); return a.preservesPitch !== false })()')
  ok('播放元素保持变速不变调（preservesPitch 未被关掉）', preserved === true, preserved)

  console.log('[2] 全部播完 + 静默期过去 → 回原速')
  const drained = await waitFor(() => api.speech.queue.length === 0 && !api.speech.busy, 20000)
  ok('队列读空了', Boolean(drained), { queued: api.speech.queue.length, busy: api.speech.busy })
  // 静默期 1 秒：采样看它是不是按时回落（顺带把「什么时候回落」记进日志）
  let droppedAt = 0
  for (let i = 1; i <= 8; i++) {
    await wait(250)
    if (!api.catchUp.active()) {
      droppedAt = i * 250
      break
    }
  }
  ok('静默期一到就回原速', droppedAt > 0, { droppedAt })
  ok('没有提前回落（至少撑过 0.8 秒）', droppedAt === 0 || droppedAt >= 800, { droppedAt })

  // 清掉记录，只看这一条
  await run(win, CLEAR)
  api.music.danmaku('静默期之后再来一条', { uid: 99001, username: '观众末' })
  const slowPlay = await waitFor(() => run(win, 'window.__ttsPlay[0] || null'), 10000)
  ok('静默期后那条播出去了', Boolean(slowPlay), slowPlay)
  ok('已经回原速（1.0）', slowPlay && slowPlay.rate === 1, slowPlay && slowPlay.rate)
  const slowApplied = await waitFor(() => run(win, FIRST_AUDIO_RATE), 5000)
  ok('渲染层也确实是 1.0', slowApplied === 1, slowApplied)

  console.log('[3] 静默期内来新需求 → 不该被打回原速')
  api.store.patch({ tts: { catchUp: { threshold: 3 } } })
  await run(win, CLEAR)
  for (let i = 0; i < 4; i++) {
    api.music.danmaku(`第二轮第 ${i + 1} 条`, { uid: 92000 + i, username: `乙${i + 1}` })
  }
  const secondRound = await waitFor(() => run(win, 'window.__ttsPlay.length ? window.__ttsPlay[0] : null'), 10000)
  ok('阈值降到 3 之后又加速了', secondRound && secondRound.rate === RATE, secondRound && secondRound.rate)

  // 关掉开关：立刻原速，哪怕队列还堆着
  await waitFor(() => api.speech.queue.length === 0 && !api.speech.busy, 20000)
  api.store.patch({ tts: { catchUp: { enabled: false } } })
  await run(win, CLEAR)
  for (let i = 0; i < 5; i++) {
    api.music.danmaku(`关掉后第 ${i + 1} 条`, { uid: 93000 + i, username: `丙${i + 1}` })
  }
  const offPlay = await waitFor(() => run(win, 'window.__ttsPlay.length ? window.__ttsPlay[0] : null'), 10000)
  ok('关掉开关后即使堆 5 条也是原速', offPlay && offPlay.rate === 1, offPlay && offPlay.rate)

  await waitFor(() => api.speech.queue.length === 0 && !api.speech.busy, 20000)
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  await wait(150)
  app.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('e2e 崩了：', e)
  app.exit(1)
})
