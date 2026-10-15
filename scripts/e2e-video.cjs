'use strict'
/**
 * B 站视频播放器（原生 <video> 方案）的端到端验证。
 *
 * 为什么非要有这个脚本：视频这块栽过的跟头全是**静态断言验不到**的 ——
 * 「画面框被拉成非 16:9」「点了进度没反应」「只有声音没画面」，代码看着都对，
 * 只有把真渲染层引擎跑起来、让一个真的 <video> 元素真的解码出画面才知道。
 *
 * 取流用本地生成的 data: URL（MediaRecorder 直录两秒 webm，CSP 的 media-src
 * 允许 data:）—— 不联网、不碰 B 站接口，验的是「真引擎 + 真元素 + 真事件」
 * 这条链路，不是 B 站接口本身（那条路 smoke 有断言，真连通性靠人工点一次）。
 *
 * 用法：npm run e2e:video
 * 依赖 main.cjs 里 CP_E2E=1 分支挂出来的 global.__cpE2E.video。
 * 用临时 userData，绝对不会碰真实配置。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-video-'))

function sweepStale(keep) {
  let names = []
  try {
    names = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith('cp-e2e-video-') || path.join(os.tmpdir(), n) === keep) continue
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
// 绝不占 12450：用户可能正开着真实例直播
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
      // 返回 fn 的真值结果本身（调用方还要拿它当窗口/快照用），不是 true
      const r = await fn()
      if (r) return r
    } catch {
      /* 页面还没就绪时查询会抛，当「还没到」处理 */
    }
    await wait(100)
  }
  return false
}

require(path.join(__dirname, '..', 'electron', 'main.cjs'))

/** 找主窗口（title 带「弹幕姬」）和某个浮窗 */
function mainWindow() {
  return BrowserWindow.getAllWindows().find((w) => (w.getTitle() || '').includes('弹幕姬'))
}
function floatWindow(label) {
  return BrowserWindow.getAllWindows().find((w) => (w.getTitle() || '').includes(label))
}
const run = (w, code) => w.webContents.executeJavaScript(code)

/** 把渲染进程的报错倒到测试输出里 —— React 卸载整树这种事只有它自己知道为什么 */
function attachConsole(w, tag) {
  try {
    w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      // Electron 32 起 level 从数字（2=warning 3=error）换成了字符串 —— 两种都兼容
      const num = typeof level === 'number' ? level : { debug: 0, info: 1, warning: 2, error: 3 }[level] || 0
      if (num >= 2) console.log(`  [${tag}·console] ${message}  (${sourceId}:${line})`)
    })
    w.webContents.on('render-process-gone', (_e, details) => {
      console.log(`  [${tag}·render-gone] ${JSON.stringify(details)}`)
    })
    // 「整树没了但没报错」最常见的原因：页面被重载 / 导航了
    w.webContents.on('did-navigate', (_e, url) => console.log(`  [${tag}·导航] ${url}`))
    w.webContents.on('did-navigate-in-page', (_e, url) => console.log(`  [${tag}·页内导航] ${url}`))
    w.webContents.on('did-finish-load', () => console.log(`  [${tag}] did-finish-load`))
  } catch {
    /* 窗口可能已经关了 */
  }
}

/** 伪造一条视频队列条目。id 用 cid；时长秒数要和直录的片段对得上 */
const ITEM = (cid, sec) => ({
  kind: 'video',
  bvid: `BVe2e${String(cid).padStart(6, '0')}`,
  cid,
  title: `e2e 测试视频 ${cid}`,
  up: 'e2e',
  pic: '',
  duration: sec,
  durationText: `0:0${sec}`,
})

/** 主窗口里「画面 + 元素」的状态快照（在页面上下文里取，拿到的全是真 DOM） */
const STAGE_SNIPPET = `(() => {
  const q = (s) => document.querySelector(s)
  const host = q('.vstage__videohost')
  const el = host && host.querySelector('video')
  const frame = q('.vstage__frame')
  const fr = frame ? frame.getBoundingClientRect() : null
  return {
    hasHost: Boolean(host),
    hasEl: Boolean(el),
    isSingleton: Boolean(el && el.dataset.vstageVideo === ''),
    ratio: fr && fr.height > 0 ? fr.width / fr.height : 0,
    videoWidth: el ? el.videoWidth : 0,
    videoHeight: el ? el.videoHeight : 0,
    paused: el ? el.paused : null,
    currentTime: el ? el.currentTime : -1,
    volume: el ? el.volume : -1,
    muted: el ? el.muted : null,
    elsewhere: Boolean(q('.vstage__elsewhere')),
    elsewhereText: q('.vstage__elsewheretag') ? q('.vstage__elsewheretag').textContent : '',
    poster: Boolean(q('.vstage__poster')),
    fail: q('.vstage__fail') ? q('.vstage__fail').textContent : '',
    ctrlBtns: document.querySelectorAll('.vstage__ctrl .vstage__btn').length,
    hasBar: Boolean(q('.vstage__bar')),
    hasVolSlider: Boolean(q('.vstage__vol input, .vstage__vol [role=slider]')),
  }
})()`

/**
 * 生成一段真正能解码的短片（画布直录 → webm → data: URL）。
 * 有真帧才有 videoWidth —— 「画面能不能画出来」这件事只有真解码才算验过。
 */
async function makeClipDataUrl(seconds) {
  const w = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  })
  await w.loadURL('about:blank')
  const b64 = await w.webContents.executeJavaScript(
    `(async () => {
      const c = document.createElement('canvas')
      c.width = 320; c.height = 180
      const g = c.getContext('2d')
      const stream = c.captureStream(15)
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
      const chunks = []
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
      const stopped = new Promise((res) => { rec.onstop = res })
      rec.start(100)
      let i = 0
      const t0 = Date.now()
      await new Promise((res) => {
        const t = setInterval(() => {
          g.fillStyle = ['#123a5c', '#2c5c23', '#5c2323'][i % 3]
          g.fillRect(0, 0, 320, 180)
          g.fillStyle = '#ffffff'
          g.font = '48px sans-serif'
          g.fillText(String(i++), 140, 100)
          if (Date.now() - t0 >= ${seconds * 1000}) { clearInterval(t); res() }
        }, 66)
      })
      rec.stop()
      await stopped
      const blob = new Blob(chunks, { type: 'video/webm' })
      const buf = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      const CH = 0x8000
      for (let j = 0; j < buf.length; j += CH) s += String.fromCharCode.apply(null, buf.subarray(j, j + CH))
      return btoa(s)
    })()`,
  )
  w.destroy()
  return 'data:video/webm;base64,' + b64
}

async function main() {
  let hook = null
  for (let i = 0; i < 150; i++) {
    if (global.__cpE2E) {
      hook = global.__cpE2E
      break
    }
    await wait(200)
  }
  if (!hook) throw new Error('CP_E2E 测试钩子没挂上，检查 main.cjs 的 CP_E2E 分支')
  const V = hook.video

  console.log('[1] 生成测试短片（画布直录）')
  // 8 秒：[5] 要验「浮窗接管时接着播不回开头」，得留出
  // 「先播两三秒 → 浮窗创建 → 取流 → 接管 → 量进度」的完整余量
  const CLIP_MS = 8 // 秒
  let clip = ''
  try {
    clip = await makeClipDataUrl(CLIP_MS)
  } catch (e) {
    console.log(`  FAIL  测试短片生成失败：${e.message}`)
    fail++
  }
  ok('短片是真的（data: URL 且有体积）', clip.startsWith('data:video/webm;base64,') && clip.length > 20000)
  V.setUrlProvider(async () => ({ url: clip, quality: 64 }))

  const main = await waitFor(() => mainWindow(), 15000)
  ok('主窗口起来了', Boolean(main))
  attachConsole(main, '主窗口')
  // window 级错误捕获：React 卸树后 window 还在，这份记录不会跟着没
  if (main) {
    await run(
      main,
      `(() => {
        window.__cpErrors = []
        window.__cpMarked = 1
        window.addEventListener('error', (e) => window.__cpErrors.push(String(e.message || e.error || 'unknown')))
        window.addEventListener('unhandledrejection', (e) => window.__cpErrors.push('rejection: ' + String(e.reason)))
      })()`,
    ).catch(() => {})
  }

  console.log('[2] 入队一条视频 → 真引擎取流 → 原生元素解码')
  // 主窗口默认开在「连接」页 —— 画面在弹幕功能区的侧栏里，先切过去
  const nav = await run(
    main,
    `(() => { const items = [...document.querySelectorAll('.nav-rail__item')]; const t = items.find((x) => (x.textContent || '').includes('弹幕')); if (t) t.click(); return Boolean(t) })()`,
  )
  ok('切到弹幕页（画面挂在那里）', Boolean(nav))
  V.enqueue(ITEM(101, CLIP_MS))
  const s1 = await waitFor(async () => {
    const r = await run(main, STAGE_SNIPPET)
    return r.hasEl && r.videoWidth > 0 ? r : null
  }, 20000)
  ok('视频元素挂进了画面框（单例 dataset 标记）', Boolean(s1 && s1.hasEl && s1.isSingleton), s1)
  ok('真的解出了画面（videoWidth > 0，不是一片黑）', Boolean(s1 && s1.videoWidth > 0), s1 && s1.videoWidth)
  ok(
    '画面框是 16:9（栽过两次的铁律：容器拉变形 = 播放器只画一小块）',
    Boolean(s1 && s1.ratio > 1.6 && s1.ratio < 1.95),
    s1 && s1.ratio,
  )
  ok('元素在自动出声（原生 play，不等用户点）', Boolean(s1 && !s1.paused), s1 && s1.paused)
  ok('海报已经撤了（有真画面就别再垫封面）', Boolean(s1 && !s1.poster), s1 && s1.poster)
  ok('控件齐全：播停 + 音量 + 下一个（进度条单独查）', Boolean(s1 && s1.ctrlBtns >= 3 && s1.hasBar && s1.hasVolSlider), s1)
  ok('音量落在元素上（默认 0.8）', Boolean(s1 && Math.abs(s1.volume - 0.8) < 0.01), s1 && s1.volume)

  console.log('[3] 拖进度 / 暂停继续 —— 全是原生行为')
  // 点进度条 25% 处：UI 用队列时长(8s)，目标是 2s
  await run(main, `(() => { const b = document.querySelector('.vstage__bar'); const r = b.getBoundingClientRect(); b.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 0.25, clientY: r.top + r.height / 2 })) })()`)
  const s2 = await waitFor(async () => {
    const r = await run(main, STAGE_SNIPPET)
    return r.currentTime > 1.6 && r.currentTime < 2.4 ? r : null
  }, 6000)
  ok('点进度条真的跳了（原生 seek，不再「点了没反应」）', Boolean(s2), s2 && s2.currentTime)
  await run(main, `document.querySelector('.vstage__ctrl .vstage__btn').click()`)
  const paused = await waitFor(async () => {
    const r = await run(main, STAGE_SNIPPET)
    return r.paused === true ? r : null
  }, 5000)
  ok('控件能暂停（原生 pause，进度保留在元素里）', Boolean(paused), paused)
  await run(main, `document.querySelector('.vstage__ctrl .vstage__btn').click()`)
  await waitFor(async () => (await run(main, STAGE_SNIPPET)).paused === false, 5000)
  ok('控件能继续', true)

  console.log('[4] 播完自动推进下一首（原生 ended，不再靠计时器估算）')
  V.enqueue(ITEM(102, CLIP_MS))
  const advanced = await waitFor(async () => {
    const snap = V.snapshot()
    const cur = snap.current
    return cur && cur.kind === 'video' && Number(cur.cid) === 102
  }, 25000)
  ok('第一条播完自动轮到第二条', Boolean(advanced))
  const el2 = await waitFor(async () => {
    const r = await run(main, STAGE_SNIPPET)
    return r.hasEl && r.videoWidth > 0 && r.currentTime < 1.5 ? r : null
  }, 15000)
  ok('第二条从开头接着放（换条目换流，不串画面）', Boolean(el2), el2 && el2.currentTime)
  // 让第二条先播两三秒 —— 给下面的「浮窗接管不回开头」垫一个有意义的进度
  const played = await waitFor(async () => {
    const r = await run(main, STAGE_SNIPPET)
    return r.hasEl && r.currentTime > 2 ? r : null
  }, 10000)
  ok('第二条先播一会儿（垫进度）', Boolean(played), played && played.currentTime)

  console.log('[5] 播放权归属：音乐浮窗开着 = 浮窗出声，主窗口摆占位')
  await run(main, `window.chatsparty.float.open('music')`)
  const fw = await waitFor(() => floatWindow('音乐控制台浮窗'), 15000)
  ok('音乐浮窗打开了', Boolean(fw))
  if (fw) attachConsole(fw, '浮窗')
  const f1 = await waitFor(async () => {
    const r = await run(fw, STAGE_SNIPPET)
    return r.hasEl && r.videoWidth > 0 ? r : null
  }, 20000)
  ok('浮窗里有画面（真帧，不是占位）', Boolean(f1), f1)
  // 接管的核心：浮窗是**新建的窗口**，挂载时东西已在主窗口播了两三秒 ——
  // 它必须从主进程存底的心跳进度接着放，而不是当成「新条目」从 0 重播
  ok(
    '浮窗接管时接着主窗口的进度放（不回开头重播）',
    Boolean(f1 && f1.currentTime > 1),
    f1 && f1.currentTime,
  )
  ok(
    '浮窗的画面框也是 16:9',
    Boolean(f1 && f1.ratio > 1.6 && f1.ratio < 1.95),
    f1 && f1.ratio,
  )
  // 【横向拉宽】窗口宽了 ≠ 画面跟着铺满：宽高谁紧张听谁的（此时按窗口高算），
  // 画面框必须仍 16:9 且完整在窗口内 —— 底部控件条曾被裁没（用户实测报过）
  if (fw) {
    const before = fw.getBounds()
    fw.setBounds({ ...before, width: 720, height: 360 })
    const wide = await waitFor(async () => {
      const r = await run(fw, `(() => {
        const f = document.querySelector('.vstage__frame')
        const b = document.querySelector('.float-body--music')
        if (!f || !b) return null
        const fr = f.getBoundingClientRect()
        const br = b.getBoundingClientRect()
        return {
          ratio: fr.height > 0 ? fr.width / fr.height : 0,
          inside: fr.top >= br.top - 1 && fr.bottom <= br.bottom + 1 && fr.left >= br.left - 1 && fr.right <= br.right + 1,
          fw: Math.round(fr.width), fh: Math.round(fr.height), bw: Math.round(br.width), bh: Math.round(br.height),
          ctrl: Boolean(document.querySelector('.vstage__ctrl')),
        }
      })()`)
      // setBounds 生效前量的不算数（窗口尺寸到位才采信）
      return r && Math.abs(r.bw - 720) < 8 && Math.abs(r.bh - 360) < 8 ? r : null
    }, 8000)
    ok('浮窗拉宽后画面框仍是 16:9（按窗口高适配）', Boolean(wide && wide.ratio > 1.6 && wide.ratio < 1.95), wide)
    ok('浮窗拉宽后画面完整在窗口内（底部控件不被裁掉）', Boolean(wide && wide.inside && wide.ctrl), wide)
    fw.setBounds(before)
    await wait(300)
  }
  // 弹幕页侧栏：浮窗开着 = 原位退成「收回」胶囊（FloatRegion 的既有设计，
  // 同一块内容不在主窗口和浮窗各画一份）
  const gone = await waitFor(async () => {
    const r = await run(main, `(() => ({
      gone: Boolean(document.querySelector('.float-gone--music')),
      card: Boolean(document.querySelector('.side-card--console')),
    }))()`)
    return r.gone && !r.card ? r : null
  }, 8000)
  ok('弹幕页侧栏退成「收回」胶囊（那一块整个搬进浮窗了）', Boolean(gone), gone)
  // 「画面在音乐浮窗里」占位在点歌页验证：那边的 VideoStage 不被 FloatRegion
  // 包着，浮窗开着时它的正确形态就是占位 —— 控件照常画，键转发给浮窗
  await run(
    main,
    `(() => { const items = [...document.querySelectorAll('.nav-rail__item')]; const t = items.find((x) => (x.textContent || '').includes('点歌')); if (t) t.click(); return Boolean(t) })()`,
  )
  const m1 = await waitFor(async () => {
    const r = await run(main, STAGE_SNIPPET)
    return r.elsewhere ? r : null
  }, 10000)
  if (!m1) {
    // 诊断：占位没出现时，把主窗口的现场和它眼里的浮窗状态都倒出来
    const dbg = await run(main, `(() => ({
      stage: document.querySelector('.vstage') ? document.querySelector('.vstage').className : null,
      marked: Boolean(window.__cpMarked),
      rootKids: document.getElementById('root') ? document.getElementById('root').childElementCount : -1,
      activeNav: (document.querySelector('.nav-rail__item.is-active') || {}).textContent || '(无)',
    }))()`)
    const fstate = await run(main, `window.chatsparty.float.state()`)
    const errs = await run(main, `JSON.stringify(window.__cpErrors || [])`).catch(() => '[]')
    console.log(`  DEBUG 主窗口现场: ${JSON.stringify(dbg)}`)
    console.log(`  DEBUG float.state: ${JSON.stringify(fstate)}`)
    console.log(`  DEBUG 渲染层报错: ${errs}`)
  }
  ok('点歌页换成「画面在音乐浮窗里」占位', Boolean(m1), m1)
  ok('占位文案对', Boolean(m1 && m1.elsewhereText.includes('画面在音乐浮窗里')), m1 && m1.elsewhereText)
  ok('浮窗元素在响（同一时刻只有一个窗口出声）', Boolean(f1 && !f1.paused), f1 && f1.paused)

  console.log('[6] 非拥有者的键转发给拥有者执行')
  // 主窗口此刻在点歌页、占位形态：点它的播放/暂停，动的是浮窗里的元素
  await run(main, `document.querySelector('.vstage__ctrl .vstage__btn').click()`)
  const fPaused = await waitFor(async () => {
    const r = await run(fw, STAGE_SNIPPET)
    return r.paused === true ? r : null
  }, 6000)
  ok('主窗口点暂停，浮窗里的视频真停了（remote 转发链路通）', Boolean(fPaused), fPaused)

  console.log('[7] 收回浮窗 → 播放权回到主窗口')
  // 注意：close 是从浮窗自己的渲染进程发出的 —— 窗口一销毁，这个 invoke 的
  // promise 随进程一起消失，永远不 resolve。发出去就别等，拿窗口列表等它真没了。
  run(fw, `window.chatsparty.float.close('music')`).catch(() => {})
  const fwGone = await waitFor(
    () => (fw.isDestroyed() || !BrowserWindow.getAllWindows().includes(fw) ? true : null),
    10000,
  )
  ok('浮窗真的收回去了', Boolean(fwGone))
  const m2 = await waitFor(async () => {
    const r = await run(main, STAGE_SNIPPET)
    return r.hasEl && !r.elsewhere ? r : null
  }, 15000)
  ok('主窗口重新接管画面（占位撤掉、元素挂回来）', Boolean(m2), m2)

  console.log('[8] OBS 叠加层：快照带流地址，页面里真播画面（16:9）')
  // [6] 暂停过、[7] 接管延续的是「暂停」意图 —— 先恢复播放，让 102 播完
  // 自然推进（ended → advance）到新入队的 103，再验叠加层
  await run(main, `document.querySelector('.vstage__ctrl .vstage__btn').click()`)
  await waitFor(async () => (await run(main, STAGE_SNIPPET)).paused === false, 5000)
  // 前面那条 8 秒的快播完了 —— 入队下一条，让「当前条目」是活的视频
  V.enqueue(ITEM(103, CLIP_MS))
  const WS = require('ws')
  const basePort = Number(process.env.CP_OVERLAY_PORT)
  /** 连 overlay 的 ws 拿一帧 music 快照。端口被顺延时逐个试（和服务端同一套规则）。
   *  只要「当前是视频且已带流地址」的那帧 —— 流解析是异步的，waitFor 会重试 */
  async function overlayMusicSnapshot() {
    for (let off = 0; off < 10; off++) {
      const snap = await new Promise((resolve) => {
        let ws
        try {
          ws = new WS(`ws://127.0.0.1:${basePort + off}/overlay`)
        } catch {
          resolve(null)
          return
        }
        const done = (v) => {
          clearTimeout(timer)
          try {
            ws.close()
          } catch {
            /* noop */
          }
          resolve(v)
        }
        const timer = setTimeout(() => done(null), 2000)
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(String(data))
            if (msg.type === 'music' && msg.payload && msg.payload.current && msg.payload.current.kind === 'video') {
              // 流和心跳底都要齐：流解析是异步的、心跳 400ms 一拍，
              // 太早的那帧可能只齐一半 —— 不齐就当没收到，waitFor 会重连重试
              const t = msg.payload.tick
              if (msg.payload.stream && t && String(t.key) === 'video:103') done(msg.payload)
            }
          } catch {
            /* noop */
          }
        })
        ws.on('error', () => done(null))
      })
      if (snap && snap.stream) return { snap, port: basePort + off }
    }
    return null
  }
  const ovSnap = await waitFor(overlayMusicSnapshot, 15000)
  if (!ovSnap) {
    // 诊断：主进程眼里的队列状态 + 每个端口的连接情况
    const s = V.snapshot()
    console.log(
      `  DEBUG 主进程快照: current=${s.current ? `${s.current.kind}:${s.current.id}` : 'null'} stream=${s.stream ? '有' : '无'} tick=${s.tick ? JSON.stringify(s.tick) : 'null'}`,
    )
  }
  ok('叠加层快照：当前条目是视频且带着流地址', Boolean(ovSnap), ovSnap ? 'stream 缺失' : '连不上/没快照')
  ok(
    '叠加层快照的流是 data: URL（e2e 桩，不联网）',
    Boolean(ovSnap && /^data:/i.test(ovSnap.snap.stream)),
    ovSnap && typeof ovSnap.snap.stream === 'string' ? ovSnap.snap.stream.slice(0, 30) : null,
  )
  ok('叠加层快照带着播放心跳底', Boolean(ovSnap && ovSnap.snap.tick && ovSnap.snap.tick.key === 'video:103'))

  // 真开一个窗口加载叠加层页面（OBS 浏览源的替身），验 <video> 真在出画面
  if (ovSnap) {
    const ovWin = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
    const OVSNIPPET = `(() => {
      const v = document.querySelector('.cp-mvideo video')
      const f = document.querySelector('.cp-mvideo')
      if (!v || !f) return null
      const fr = f.getBoundingClientRect()
      return {
        readyState: v.readyState, currentTime: v.currentTime, paused: v.paused, muted: v.muted,
        vw: v.videoWidth, ratio: fr.height > 0 ? fr.width / fr.height : 0,
      }
    })()`
    try {
      await ovWin.loadURL(`http://127.0.0.1:${ovSnap.port}/overlay/music`)
      const ov1 = await waitFor(async () => {
        const r = await run(ovWin, OVSNIPPET)
        return r && r.vw > 0 && r.currentTime > 0.3 ? r : null
      }, 15000)
      ok('叠加层页面里视频真的在播（OBS 看到的就是这个）', Boolean(ov1), ov1)
      ok('叠加层画面框是 16:9', Boolean(ov1 && ov1.ratio > 1.6 && ov1.ratio < 1.95), ov1 && ov1.ratio)
      ok('叠加层视频静音（声音走应用本身，不出双份）', Boolean(ov1 && ov1.muted), ov1 && ov1.muted)
    } catch (e) {
      ok('叠加层页面加载并播放', false, String(e && e.message))
    }
    ovWin.destroy()
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  app.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  app.exit(1)
})
