'use strict'
/**
 * 在线观众（高能榜）轮询的端到端验证。
 *
 * 为什么非要有这个脚本：**「拉了一次就再也不刷新」这种毛病，静态断言和单元测试都验不到。**
 * smoke 里那一堆断言只能证明「代码里写着 setInterval」，证不了「定时器真的在跳、
 * 跳了之后真的把新名单推给了界面」。而线上表现恰恰就是「名单定格在第一份上」——
 * 和「房间本来就没人」长得一模一样，光看截图根本分不出来。
 *
 * 所以这里真起主进程、真开轮询、真让它跳几个间隔，然后数：
 *   1. 请求到底发出去了几次（不是「结果有没有变」——榜单本身可能真的没变）
 *   2. 每次拿回来的新名单有没有进到 state 里
 *   3. 拉失败的时候旧名单保不保留、error 有没有留下来（界面要靠它显示「这是旧的」）
 *   4. 断开之后轮询停不停（不停就是一路撞风控）
 *
 * 用法：npm run e2e:viewers
 * 依赖 main.cjs 里 CP_E2E=1 分支挂出来的 global.__cpE2E.viewers。
 * 用临时 userData，绝对不会碰真实配置。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-viewers-'))

/** 收走上一次跑剩下的临时目录（Chromium 子进程占着的文件主进程删不掉，只能下次启动时收） */
function sweepStale(keep) {
  let names = []
  try {
    names = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith('cp-e2e-viewers-') || path.join(os.tmpdir(), n) === keep) continue
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
process.env.CP_PROD = '1'
process.env.CP_E2E = '1'
// 绝不占 12450：用户可能正开着真实例直播，抢过来会让 OBS 里的源一半连错实例
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

require(path.join(__dirname, '..', 'electron', 'main.cjs'))

/** 榜单间隔下限只有 10 秒（接口风控），所以这个脚本天生要跑二十几秒 */
const INTERVAL = 10
const oneTick = INTERVAL * 1000 + 2500

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
  const V = hook.viewers
  const { store } = hook

  /**
   * 「在线用户」那一路默认桩成空。
   *
   * 它**要登录**，而 e2e 跑在临时 userData 上永远没登录 —— 不桩住的话每次刷新
   * 都会真发一个请求出去（拿到 -101），既拖慢首次刷新、又让等待时间变成玄学。
   * 想验合并的用例自己再覆盖一次。
   */
  V.setOnlineFetcher(async () => ({ onlineNum: 0, items: [] }))

  console.log('\n[A] 没连直播间的时候不该乱拉')
  {
    // 先把房间清干净，模拟「刚启动、还没连」
    V.setRoom({ roomId: '', realRoomId: 0, anchorUid: 0 })
    V.stop()
    const before = V.calls()
    await V.refresh({ manual: true })
    const s = V.snapshot()
    ok('缺房间号时不发请求', V.calls() === before, V.calls() - before)
    ok('状态里说明「还没连上直播间」', s.error === '还没连上直播间', s.error)
    ok('没有名单', Array.isArray(s.items) && s.items.length === 0)
  }

  console.log('\n[B] 真房间：轮询要一跳一跳地跑起来')
  {
    V.setRoom({ roomId: '25564050', realRoomId: 25564050, anchorUid: 381726629 })
    store.patch({ viewers: { enabled: true, intervalMs: INTERVAL * 1000 } })

    // 换掉取榜单的实现：测试不联网，只验「定时器 -> 请求 -> state -> 推帧」这条链。
    // 每次返回的名单都不一样，这样「有没有真的换上新数据」一眼看得出来。
    let round = 0
    const seen = []
    V.setFetcher(async () => {
      round++
      seen.push(round)
      return {
        onlineNum: 100 + round,
        items: [
          { uid: 1, name: '主播', face: '', score: round, guardLevel: 0, guard: '', wealthLevel: 1, medal: null, onRank: true },
          ...(round >= 2
            ? [{ uid: 999, name: '后来互动的人', face: '', score: 5, guardLevel: 0, guard: '', wealthLevel: 1, medal: null, onRank: true }]
            : []),
        ],
      }
    })

    const t0 = V.calls()
    V.start()
    await wait(400)
    const first = V.snapshot()
    ok('开轮询会立刻先拉一次（不让人干等一整个间隔）', V.calls() === t0 + 1, V.calls() - t0)
    ok('第一份名单进了 state', first.items.length === 1 && first.items[0].score === 1, first.items)
    ok('ok=true、error 清空', first.ok === true && first.error === '', { ok: first.ok, error: first.error })

    await wait(oneTick)
    const afterOne = V.calls()
    ok('过了一个间隔确实又拉了一次', afterOne >= t0 + 2, afterOne - t0)
    const second = V.snapshot()
    ok(
      '新名单顶掉了旧名单（这条就是用户报的「有互动也不更新」）',
      second.items.length === 2 && second.items.some((x) => x.name === '后来互动的人'),
      second.items.map((x) => x.name),
    )
    ok('在线人数跟着换新', second.onlineNum === 101 + (afterOne - t0 - 1), second.onlineNum)
    ok('updatedAt 是新的', second.updatedAt >= first.updatedAt)

    await wait(oneTick)
    ok('再过一个间隔还在继续拉', V.calls() >= t0 + 3, V.calls() - t0)
    ok('拉回来的次数与请求次数对得上', V.calls() - t0 === seen.length, { calls: V.calls() - t0, seen: seen.length })

    console.log('\n[B2] 断开之后必须停：不停就是一路撞风控')
    V.stop()
    const atStop = V.calls()
    await wait(oneTick)
    ok('停了之后一次都不再发', V.calls() === atStop, V.calls() - atStop)
  }

  console.log('\n[C] 半路开始失败：旧名单要留着，但必须让界面知道它是旧的')
  {
    V.setRoom({ roomId: '25564050', realRoomId: 25564050, anchorUid: 381726629 })
    V.setFetcher(async () => ({
      onlineNum: 7,
      items: [{ uid: 2, name: '撑场面的', face: '', score: 9, guardLevel: 3, guard: '舰长', wealthLevel: 1, medal: null }],
    }))
    V.start()
    await wait(400)
    const good = V.snapshot()
    ok('先拿到一份好名单', good.ok === true && good.items.length === 1, good.items)

    // 全失败：旧名单不能清（清掉画面会闪一下变空，比旧数据更糟）
    V.setFetcher(async () => {
      throw new Error('被 B 站风控拦了（-352），把刷新间隔调大些、等一两分钟再试')
    })
    await V.refresh({ manual: true })
    const bad = V.snapshot()
    ok('失败时旧名单还在（画面不会突然空掉）', bad.items.length === 1 && bad.items[0].name === '撑场面的', bad.items)
    ok('ok 变成 false', bad.ok === false)
    ok('error 留下人话，界面才能显示「这是旧的」', /-352|风控/.test(bad.error), bad.error)

    // 只翻页失败（第 2 页挂了）在 api 层就被吃掉了，这里验的是「不因为一次抖动把名单清空」
    V.setFetcher(async () => ({ onlineNum: 8, items: [] }))
    await V.refresh({ manual: true })
    const empty = V.snapshot()
    ok('真的拉到空榜时才会变空', empty.items.length === 0 && empty.ok === true, empty)
  }

  console.log('\n[D] 同时只跑一次')
  {
    V.setRoom({ roomId: '25564050', realRoomId: 25564050, anchorUid: 381726629 })
    let inflight = 0
    let maxInflight = 0
    V.setFetcher(async () => {
      inflight++
      maxInflight = Math.max(maxInflight, inflight)
      await wait(600)
      inflight--
      return { onlineNum: 1, items: [] }
    })
    V.stop()
    const c0 = V.calls()
    // 手点刷新撞上自动轮询时，第二次必须直接返回，不能把两个请求一前一后打出去
    await Promise.all([V.refresh({ manual: true }), V.refresh({ manual: true }), V.refresh({ manual: true })])
    ok('并发调用只发一次请求', V.calls() === c0 + 1, V.calls() - c0)
    ok('同一时刻没有两个请求叠着', maxInflight === 1, maxInflight)
    V.stop()
  }

  console.log('\n[E] 界面那一环：新名单要真的画到弹幕页右侧栏上')
  {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('没有主窗口')
    const js = (code) => win.webContents.executeJavaScript(code)

    // 切到弹幕页（右侧栏在那儿）
    const nav = await js(`(() => {
      const items = [...document.querySelectorAll('.nav-rail__item')]
      const b = items.find((x) => x.textContent.includes('弹幕'))
      if (b) b.click()
      return Boolean(b)
    })()`)
    ok('导航里有「弹幕」页', nav)
    await wait(900)

    V.stop()
    V.setRoom({ roomId: '25564050', realRoomId: 25564050, anchorUid: 381726629 })
    const shown = () => js(`(() => {
      const rows = [...document.querySelectorAll('.side-card--viewers .vlist__row')]
      return { names: rows.map((r) => r.querySelector('.vlist__name')?.textContent || ''), n: rows.length }
    })()`)

    V.setFetcher(async () => ({
      onlineNum: 2,
      items: [{ uid: 1, name: '先来的', face: '', score: 1, guardLevel: 0, guard: '', wealthLevel: 1, medal: null, onRank: true }],
    }))
    await V.refresh({ manual: true })
    await wait(500)
    const r1 = await shown()
    ok('第一份名单画出来了', r1.n === 1 && r1.names[0] === '先来的', r1)

    // 换成另一份：这条就是用户报的「有互动也不更新」。
    // 前面 [B] 验的是主进程 state，这里验的是**屏幕上真的换了**。
    V.setFetcher(async () => ({
      onlineNum: 2,
      items: [
        { uid: 2, name: '后来互动的', face: '', score: 9, guardLevel: 0, guard: '', wealthLevel: 1, medal: null, onRank: true },
        { uid: 1, name: '先来的', face: '', score: 1, guardLevel: 0, guard: '', wealthLevel: 1, medal: null, onRank: true },
      ],
    }))
    await V.refresh({ manual: true })
    await wait(500)
    const r2 = await shown()
    ok('新名单顶掉了旧的（界面上真的换了）', r2.n === 2 && r2.names[0] === '后来互动的', r2)
    ok('榜单顺序按贡献值降序', r2.names.join(',') === '后来互动的,先来的', r2.names)

    // ---- 「在线用户」那一路：人在房间里就算，不要求互动过 ----
    // 用户报的原话是「网页端可以看到没有互动也显示的观看用户」。
    // 这一路**要登录**（真实环境没登录就是 -101），e2e 用的临时 userData
    // 永远没登录，所以必须单独把它换掉才能验「两份名单合并」。
    V.setOnlineFetcher(async () => ({
      onlineNum: 5,
      items: [
        { uid: 1, name: '先来的' }, // 榜上也有他 → 只留榜上那条（信息更多）
        { uid: 77, name: '只看不说的' },
        { uid: 78, name: '另一个潜水的' },
      ],
    }))
    await V.refresh({ manual: true })
    await wait(500)
    const withOnline = V.snapshot()
    ok('两份名单并起来了（榜上 2 + 只看不说 2）', withOnline.items.length === 4, withOnline.items.map((x) => x.name))
    ok('榜上的人排在前，且保留贡献值', withOnline.items[0].onRank === true && withOnline.items[0].score === 9)
    ok(
      '只看不说的人接在后面，贡献值 0 且不在榜上',
      withOnline.items[2].onRank === false && withOnline.items[2].score === 0,
      withOnline.items[2],
    )
    ok('同一个人不会出现两次', withOnline.items.filter((x) => x.uid === 1).length === 1)
    ok('在线人数优先用「在线用户」那份（更接近网页端右上角）', withOnline.onlineNum === 5, withOnline.onlineNum)

    const dom3 = await js(`(() => {
      const card = document.querySelector('.side-card--viewers')
      const rows = [...card.querySelectorAll('.vlist__row')]
      return {
        n: rows.length,
        nos: rows.map((r) => r.querySelector('.vlist__no')?.textContent || ''),
        scores: rows.map((r) => r.querySelector('.vlist__score')?.textContent || ''),
      }
    })()`)
    ok('屏幕上四行都在', dom3.n === 4, dom3)
    ok('榜上的人画名次，没上榜的画「-」', dom3.nos.join(',') === '1,2,-,-', dom3.nos)
    ok('没上榜的人不画贡献值（0 看着像真投喂了 0 元）', dom3.scores.join(',') === '9,1,,', dom3.scores)

    // 这一路自己挂了（比如没登录）：榜上的还在，但要说明少了什么 ——
    // 不说的话，用户会以为那批「人在房间但没说话」的人真的不在
    V.setOnlineFetcher(async () => {
      throw new Error('登录状态失效了，重新扫码登录一下')
    })
    await V.refresh({ manual: true })
    await wait(500)
    const noLogin = await js(`(() => {
      const card = document.querySelector('.side-card--viewers')
      return { rows: card.querySelectorAll('.vlist__row').length, text: card.textContent || '' }
    })()`)
    ok('在线名单挂了不影响榜上的人', noLogin.rows === 2, noLogin.rows)
    ok('并且明说「在线名单没拿到」，不装作没这回事', /在线名单没拿到/.test(noLogin.text), noLogin.text.slice(0, 140))

    // 拉失败时：旧名单留着，但界面上要能看出「这是旧的」
    V.setFetcher(async () => {
      throw new Error('被 B 站风控拦了（-352），把刷新间隔调大些、等一两分钟再试')
    })
    await V.refresh({ manual: true })
    await wait(500)
    const stale = await js(`(() => {
      const card = document.querySelector('.side-card--viewers')
      return {
        rows: card.querySelectorAll('.vlist__row').length,
        text: card.textContent || '',
      }
    })()`)
    ok('失败后旧名单还在屏幕上（不会突然空掉）', stale.rows === 2, stale.rows)
    ok('并且明确标出这是旧的，不是装作没事', /风控|旧|没更新上/.test(stale.text), stale.text.slice(0, 90))

    V.stop()
  }

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
      await wait(300)
      try {
        fs.rmSync(tmpUserData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      } catch {
        /* 交给下一轮的 sweepStale */
      }
      setTimeout(() => app.exit(fail ? 1 : 0), 200)
    }),
)
