'use strict'
/**
 * 新手引导 / 检查更新 / M2 风格 —— 真起一个实例验。
 *
 * 这几件事静态断言证明不了：
 *   · 引导是不是**真的在全新配置下自动弹出来**，点「跳过这一步」是不是真的往下走
 *   · 走完之后 onboardingSeen 有没有真的落盘（不然下次又弹）
 *   · 切到 M2 之后 <html data-style> 和真实圆角是不是变了
 *   · 浮窗（独立渲染进程）有没有跟着一起变 —— 它以前压根不刷主题
 *   · 开发模式下自动检查更新应当直接跳过（源码跑不该被提示"有新版本"）
 *
 * 配置目录是临时目录：store 找不到配置文件 → 视作全新安装 → onboardingSeen=false。
 *
 * 用法：npm run e2e:onboard
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-onb-'))

function sweepStale(keep) {
  let names = []
  try {
    names = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith('cp-e2e-onb-') || path.join(os.tmpdir(), n) === keep) continue
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
app.commandLine.appendSwitch('mute-audio')
// 打开测试钩子（__cpE2E）：没有它拿不到 store / 弹幕派发口
process.env.CP_E2E = '1'
// 加载 dist-renderer 里的构建产物，而不是去连 5180 的 dev server
process.env.CP_PROD = '1'
// 叠加层端口换一个：12450 写死在 OBS 源里，测试抢它会把用户的画面搞透明
process.env.CP_OVERLAY_PORT = String(20000 + Math.floor(Math.random() * 20000))

require(path.join(__dirname, '..', 'electron', 'main.cjs'))

const cp = () => global.__cpE2E
const mainWindow = () =>
  BrowserWindow.getAllWindows().find((w) => (w.getTitle() || '').includes('弹幕姬'))
const run = (w, code) => w.webContents.executeJavaScript(code)

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass += 1
    console.log('  PASS ', name)
  } else {
    fail += 1
    console.log('  FAIL ', name, extra === undefined ? '' : JSON.stringify(extra))
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeout = 8000, step = 120) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) return null
    await wait(step)
  }
}

const stepLabel = `document.querySelector('.onb__step-label')?.textContent || ''`

/** 点掉浮层里文字精确等于 text 的按钮 */
const clickOnb = (text) => `(() => {
  const b = [...document.querySelectorAll('.onb button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(text)})
  if (!b) return false
  b.click()
  return true
})()`

async function main() {
  const win = await waitFor(() => mainWindow(), 20000)
  ok('主窗口起来了', Boolean(win))
  if (!win) {
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
    await wait(120)
    return app.exit(1)
  }

  const api = cp()

  console.log('[1] 全新配置 → 引导自动出现')
  ok('配置里标记为「没看过」', api.store.get().general?.onboardingSeen === false)
  const shown = await waitFor(() => run(win, "Boolean(document.querySelector('.onb'))"), 8000)
  ok('浮层向导弹出来了', Boolean(shown))
  const label1 = await run(win, stepLabel)
  ok('停在第一步', String(label1).includes('1 / 5'), label1)

  console.log('[2] 逐屏往下点，每一步都能跳过')
  ok('点「开始设置」', await run(win, clickOnb('开始设置')))
  const label2 = await waitFor(
    () => run(win, `${stepLabel}.includes('2 / 5') ? ${stepLabel} : ''`),
    5000,
  )
  ok('进到第 2 步（B站登录）', Boolean(label2), label2)
  ok('登录这步可以「先不登录」', await run(win, clickOnb('先不登录')))
  const label3 = await waitFor(
    () => run(win, `${stepLabel}.includes('3 / 5') ? ${stepLabel} : ''`),
    5000,
  )
  ok('进到第 3 步（语音）', Boolean(label3), label3)
  ok('语音这步可以「跳过这一步」', await run(win, clickOnb('跳过这一步')))
  const label4 = await waitFor(
    () => run(win, `${stepLabel}.includes('4 / 5') ? ${stepLabel} : ''`),
    5000,
  )
  ok('进到第 4 步（直播间）', Boolean(label4), label4)
  ok('直播间这步可以「先不连」', await run(win, clickOnb('先不连')))
  const label5 = await waitFor(
    () => run(win, `${stepLabel}.includes('5 / 5') ? ${stepLabel} : ''`),
    5000,
  )
  ok('进到第 5 步（完成）', Boolean(label5), label5)

  console.log('[3] 走完之后不再弹')
  ok('点「开始使用」', await run(win, clickOnb('开始使用')))
  const gone = await waitFor(() => run(win, "!document.querySelector('.onb')"), 5000)
  ok('浮层关掉了', Boolean(gone))
  const seen = await waitFor(() => api.store.get().general?.onboardingSeen === true, 5000)
  ok('标记已落盘（下次不弹）', Boolean(seen))

  console.log('[4] 从关于页能重新打开')
  // 真点界面：进「关于」页 → 点「重新打开」。
  // 走 config.patch 也能改数据，但那条路测不到「按钮到底有没有接上」
  await run(win, "document.querySelector('.nav-rail__logo').click()")
  const onAbout = await waitFor(() => run(win, "Boolean(document.querySelector('.about-hero'))"), 6000)
  ok('进到关于页', Boolean(onAbout))
  const clicked = await run(
    win,
    `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '重新打开')
      if (!b) return false
      b.click()
      return true
    })()`,
  )
  ok('点了「重新打开」', Boolean(clicked))
  const again = await waitFor(() => run(win, "Boolean(document.querySelector('.onb'))"), 8000)
  ok('重新打开成功', Boolean(again))
  await run(win, clickOnb('全部跳过'))
  const gone2 = await waitFor(() => run(win, "!document.querySelector('.onb')"), 5000)
  ok('「全部跳过」也能关掉', Boolean(gone2))
  const seen2 = await waitFor(() => api.store.get().general?.onboardingSeen === true, 5000)
  ok('全部跳过同样记成已看过', Boolean(seen2))

  console.log('[5] M2 风格：主窗口与浮窗一起变')
  const radiusM3 = await run(win, "getComputedStyle(document.querySelector('.card')).borderRadius")
  await run(win, "window.chatsparty.config.patch({ theme: { style: 'm2' } })")
  const styleAttr = await waitFor(
    () => run(win, "document.documentElement.dataset.style === 'm2' ? 'm2' : ''"),
    5000,
  )
  ok('主窗口 <html data-style=m2>', styleAttr === 'm2', styleAttr)
  const radiusM2 = await run(win, "getComputedStyle(document.querySelector('.card')).borderRadius")
  ok('卡片圆角从 M3 的 12px 收到 4px', radiusM3 === '12px' && radiusM2 === '4px', { radiusM3, radiusM2 })

  // 浮窗是独立渲染进程，主题得自己刷 —— 以前它压根没刷，一直是写死的深紫
  await run(win, 'window.chatsparty.float.open("danmaku")')
  const floatWin = await waitFor(
    () => BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed()),
    12000,
  )
  ok('弹幕浮窗起来了', Boolean(floatWin))
  if (floatWin) {
    await waitFor(() => floatWin.webContents.executeJavaScript('document.readyState === "complete"'), 12000)
    const fStyle = await waitFor(
      () =>
        floatWin.webContents
          .executeJavaScript("document.documentElement.dataset.style === 'm2' ? 'm2' : ''")
          .catch(() => ''),
      8000,
    )
    ok('浮窗也是 M2', fStyle === 'm2', fStyle)
    const fRadius = await floatWin.webContents
      .executeJavaScript("getComputedStyle(document.querySelector('.float-shell') || document.body).borderRadius")
      .catch(() => '')
    ok('浮窗圆角也收成 4px', fRadius === '4px', fRadius)
    // 切回 M3，浮窗应当跟着回去（证明不是只在启动时读了一次）
    await run(win, "window.chatsparty.config.patch({ theme: { style: 'm3' } })")
    const back = await waitFor(
      () =>
        floatWin.webContents
          .executeJavaScript("document.documentElement.dataset.style === 'm3' ? 'm3' : ''")
          .catch(() => ''),
      8000,
    )
    ok('切回 M3 浮窗跟着回去', back === 'm3', back)
  }

  console.log('[6] 检查更新：开发模式自动跳过，手动照查')
  // 渲染层启动 3 秒后已经自己调过一次 auto（这次进程里就那一次），所以这里拿到
  // 的可能是 'already'。两种都说明「没有真的去查」—— 关键是 skipped。
  const auto = await run(win, "window.chatsparty.app.updateCheck({ reason: 'auto' })")
  ok(
    '自动检查不真的发请求（dev / 已查过）',
    auto && auto.skipped === true && (auto.reason === 'dev' || auto.reason === 'already'),
    auto,
  )
  const manual = await run(win, "window.chatsparty.app.updateCheck({ reason: 'manual' })")
  ok('手动检查会真的发请求（返回值是结果对象）', manual && typeof manual.ok === 'boolean', manual)
  ok('返回值带当前版本号', Boolean(manual && typeof manual.current === 'string' && manual.current.length), manual && manual.current)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  await wait(200)

  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.destroy()
    }
  } catch {
    /* noop */
  }
  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true })
  } catch {
    /* 目录还被占着就下次再清 */
  }
  app.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('e2e 崩了：', e)
  app.exit(1)
})
