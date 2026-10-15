'use strict'
/**
 * 一次性诊断探针：用户报「侧栏视频卡会反复出现滑杆」。
 *
 * 做法：真渲染层 + 假流（data: URL，e2e 同款），入队一条视频后在弹幕页侧栏
 * 对视频卡**高频采样 12 秒**（50ms 一拍），把「哪一帧哪个元素出现/消失/位移」
 * 记下来。「反复出现」的东西只有这么抓才抓得到 —— 截图只能看到结果，看不到过程。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS npx electron scripts/probe-video-ui.cjs
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-probe-vui-'))
app.setPath('userData', tmpUserData)
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('use-gl', 'swiftshader')
app.disableHardwareAcceleration()
process.env.CP_PROD = '1'
process.env.CP_E2E = '1'
process.env.CP_OVERLAY_PORT = String(20000 + Math.floor(Math.random() * 20000))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 10000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const r = await fn()
      if (r) return r
    } catch {}
    await wait(100)
  }
  return null
}

require(path.join(__dirname, '..', 'electron', 'main.cjs'))

function mainWindow() {
  return BrowserWindow.getAllWindows().find((w) => (w.getTitle() || '').includes('弹幕姬'))
}
const run = (w, code) => w.webContents.executeJavaScript(code)

async function main() {
  let hook = null
  for (let i = 0; i < 150; i++) {
    if (global.__cpE2E) { hook = global.__cpE2E; break }
    await wait(200)
  }
  if (!hook) throw new Error('CP_E2E 钩子没挂上')
  const V = hook.video

  // 3 秒假流（跟 e2e 同款画布直录）
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false } })
  await w.loadURL('about:blank')
  const b64 = await w.webContents.executeJavaScript(`(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 180
    const g = c.getContext('2d')
    const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm;codecs=vp8' })
    const chunks = []; rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
    const stopped = new Promise((res) => { rec.onstop = res })
    rec.start(100)
    const t0 = Date.now()
    await new Promise((res) => { const t = setInterval(() => { g.fillStyle = '#123a5c'; g.fillRect(0,0,320,180); if (Date.now() - t0 >= 3000) { clearInterval(t); res() } }, 66) })
    rec.stop(); await stopped
    const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())
    let s = ''; for (let j = 0; j < buf.length; j += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(j, j + 0x8000))
    return btoa(s)
  })()`)
  w.destroy()
  const clip = 'data:video/webm;base64,' + b64
  V.setUrlProvider(async () => ({ url: clip, quality: 64 }))

  const main = await waitFor(() => mainWindow(), 15000)
  if (!main) throw new Error('主窗口没起来')

  // 探针窗口不用截图，但要让 hover 类样式稳定：主窗口 show 出来即可
  await run(main, `(() => {
    const items = [...document.querySelectorAll('.nav-rail__item')]
    const t = items.find((x) => (x.textContent || '').includes('弹幕'))
    if (t) t.click()
    // 抓渲染层报错，最后一起倒出来
    window.__errs = []
    window.addEventListener('error', (e) => window.__errs.push(String(e.message || e.error)))
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej: ' + String(e.reason)))
  })()`)
  V.enqueue({ kind: 'video', bvid: 'BVprobe001', cid: 901, title: '探针视频', up: 'probe', pic: '', duration: 3, durationText: '0:03' })
  await waitFor(async () => {
    const r = await run(main, `(() => { const h = document.querySelector('.vstage__videohost'); return Boolean(h && h.querySelector('video') && h.querySelector('video').videoWidth > 0) })()`)
    return r
  }, 20000)
  console.log('视频已进入播放状态，开始 12 秒高频采样…')

  const SAMPLE = `(() => {
    const q = (s) => document.querySelector(s)
    const qa = (s) => [...document.querySelectorAll(s)]
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
    const sliders = qa('.vstage input[type=range]').map((el) => ({ cls: el.className, rect: rect(el) }))
    const side = q('.danmaku-side')
    return {
      sliders,
      nSliderFit: qa('.slider--fit').length,
      vstage: rect(q('.vstage')),
      frame: rect(q('.vstage__frame')),
      fail: q('.vstage__fail') ? q('.vstage__fail').textContent : null,
      poster: Boolean(q('.vstage__poster')),
      elsewhere: Boolean(q('.vstage__elsewhere')),
      vconsole: Boolean(q('.vconsole')),
      sideCard: Boolean(q('.side-card--console')),
      ctrlOpacity: q('.vstage__ctrl') ? getComputedStyle(q('.vstage__ctrl')).opacity : null,
      // 滚动条有没有被撑出来（横向溢出 = 底部会出现横条）
      docScrollW: [document.documentElement.clientWidth, document.documentElement.scrollWidth],
      sideScroll: side ? [side.clientWidth, side.scrollWidth, side.clientHeight, side.scrollHeight] : null,
      pageScroll: [document.body.clientWidth, document.body.scrollWidth],
      barY: rect(q('.vstage__bar')),
      volY: rect(q('.vstage__vol')),
    }
  })()`

  let prev = null
  const timeline = []
  const T0 = Date.now()
  while (Date.now() - T0 < 12000) {
    let s = null
    try { s = await run(main, SAMPLE) } catch {}
    if (s) {
      const key = JSON.stringify(s)
      if (key !== (prev && prev.key)) {
        timeline.push({ t: ((Date.now() - T0) / 1000).toFixed(2), s, prev: prev ? prev.s : null })
        prev = { key, s }
      }
    }
    await wait(50)
  }

  console.log(`\\n采样完成：${timeline.length} 次状态变化`)
  for (const ev of timeline.slice(0, 40)) {
    const diffs = []
    const a = ev.prev || {}
    const b = ev.s
    for (const k of Object.keys(b)) {
      const ja = JSON.stringify(a[k]); const jb = JSON.stringify(b[k])
      if (ja !== jb) diffs.push(`${k}: ${ja} -> ${jb}`)
    }
    console.log(`  [t=${ev.t}s] ${diffs.join(' | ')}`)
  }

  const errs = await run(main, `JSON.stringify(window.__errs || [])`).catch(() => '[]')
  console.log(`\\n渲染层报错: ${errs}`)
  app.exit(0)
}

main().catch((e) => { console.error(e); app.exit(1) })
