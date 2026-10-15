'use strict'
/**
 * 「关掉主界面 = 缩到托盘，后台继续收弹幕」的端到端验证。
 *
 * 为什么单开一个脚本：托盘是**系统级**的，截图截不到、也没法比对图标长什么样，
 * 静态断言只能证明代码写了托盘，证明不了「点了×窗口还在不在」—— 而这条正是
 * 这个功能唯一重要的事（真把应用关了 = 弹幕断了，比没有这功能还糟）。
 * 所以这里在真主进程里真点一次 ×，量窗口的存活和可见性。
 *
 * 用法：npm run e2e:tray。用临时 userData，绝对不会碰真实配置。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app } = require('electron')

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-tray-'))
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
  const t0 = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* 还没好，继续等 */
    }
    if (Date.now() - t0 > ms) return null
    await wait(120)
  }
}

require(path.join(__dirname, '..', 'electron', 'main.cjs'))

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
  const T = hook.tray

  console.log('[1] 默认：点×是缩起来，不是退出')
  ok('默认开着缩托盘', hook.store.get().general?.closeToTray === true, hook.store.get().general)
  ok('托盘图标文件找得到（打包后也要在）', Boolean(T.iconPath()) && fs.existsSync(T.iconPath()), T.iconPath())

  const win = await waitFor(() => {
    const w = T.mainWindow()
    return w && !w.isDestroyed() && w.isVisible() ? w : null
  }, 15000)
  ok('主界面开着', Boolean(win))

  console.log('[2] 点一次 ×')
  win.close()
  const hidden = await waitFor(() => {
    const w = T.mainWindow()
    return w && !w.isDestroyed() && !w.isVisible() ? { alive: true } : null
  }, 6000)
  ok('窗口还在（进程没退出，弹幕还在收）', Boolean(hidden), hidden ? null : '窗口没了 = 真的退出了')
  ok('窗口藏起来了（不是卡在前台）', Boolean(T.mainWindow() && !T.mainWindow().isVisible()))
  ok('托盘图标建起来了', T.icon() === true)
  ok('没走退出路径', T.quitting() === false)

  console.log('[3] 从托盘把界面找回来')
  T.show()
  const back = await waitFor(() => {
    const w = T.mainWindow()
    return w && !w.isDestroyed() && w.isVisible() ? { ok: true } : null
  }, 6000)
  ok('点托盘图标界面回来了', Boolean(back))
  ok('还是原来那个窗口（没重开一个）', T.mainWindow() === win)

  console.log('[4] 关掉这项 = 点×就是真退出')
  hook.store.patch({ general: { closeToTray: false } })
  ok('配置改过去了', hook.store.get().general?.closeToTray === false)
  // 这一下是真的要退出（主窗口没了 → 整个应用退出），进程随即收摊，
  // 所以断言挂在 closed 回调里同步打出来，别指望退出之后还有机会报结果
  const w2 = T.mainWindow()
  await new Promise((resolve) => {
    const done = (gone) => {
      ok('关掉开关后点×真的关掉了窗口', gone === true)
      resolve()
    }
    w2.once('closed', () => done(true))
    setTimeout(() => done(false), 4000)
    w2.close()
  })
}

main()
  .then(async () => {
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
    // 走到这里应用已经在退出（[4] 点了真的×），自己收尾，别等 Electron 的窗口逻辑。
    // pipe 出去的 stdout 是异步的，直接 app.exit 会把最后几行吞掉 —— 先等它被读走
    await wait(120)
    app.exit(fail ? 1 : 0)
  })
  .catch((e) => {
    console.error('\n脚本异常：', e && e.stack ? e.stack : e)
    app.exit(1)
  })
