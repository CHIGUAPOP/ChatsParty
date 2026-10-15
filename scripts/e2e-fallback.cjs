'use strict'
/**
 * 「在线语音挂了 → 自动换免费嗓子」的端到端验证。
 *
 * 为什么单开一个脚本：这个功能的触发条件（超时、额度用完）在真实环境里
 * 只能靠线上抽风才遇得到，静态断言证明不了「真会换」和「换了之后不再每条都卡一次」。
 * 于是用 CP_E2E 的 setSynthesizer 把合成实现换成桩：
 *   provider=fish → 按测试要求抛「超时 / 402 / 401」
 *   provider=edge / system → 直接返回一段假音频
 * 冷却、恢复、试听不回退这些分支就都能在真主进程里跑一遍，不用联网。
 *
 * 用法：npm run e2e:fallback。用临时 userData，绝对不会碰真实配置。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-fallback-'))

/** 收走上一次跑剩下的临时目录（Chromium 子进程占着文件，退出时删不干净） */
function sweepStale(keep) {
  let names = []
  try {
    names = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith('cp-e2e-fallback-') || path.join(os.tmpdir(), n) === keep) continue
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

require(path.join(__dirname, '..', 'electron', 'main.cjs'))

/* ---------------- 桩 ---------------- */

/** 一次「平台自己不顶用」的失败。kind 决定它算哪一类 */
function failure(kind) {
  if (kind === 'timeout') {
    const e = new Error('api.fish.audio 连不上（超时）。')
    e.netKind = 'timeout'
    return e
  }
  if (kind === 'credit') {
    const e = new Error('Fish 的 API 额度用完了（HTTP 402）。')
    e.status = 402
    return e
  }
  if (kind === 'server') {
    const e = new Error('Fish 返回 HTTP 503。')
    e.status = 503
    return e
  }
  if (kind === 'limited') {
    const e = new Error('Fish 限流了（HTTP 429）。')
    e.status = 429
    return e
  }
  if (kind === 'badkey') {
    const e = new Error('Fish 不认这把 Key（HTTP 401）。')
    e.status = 401
    return e
  }
  if (kind === 'denied') {
    const e = new Error('Fish 拒绝了这次合成（HTTP 403）。')
    e.status = 403
    return e
  }
  throw new Error('没这种失败：' + kind)
}

const FISH_CFG = {
  provider: 'fish',
  protocol: 'fish-tts',
  baseUrl: 'https://api.fish.audio',
  apiKey: 'test-key',
  model: 's2.1-pro',
  voice: 'some-voice',
  format: 'mp3',
  speed: 1,
  volume: 0.9,
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
  const { store, ttsFallback } = hook

  // 缓存会挡住「同一句话第二次」的调用计数，这轮只验链路，先关掉
  await store.patch({ tts: { cache: { enabled: false }, fallback: { enabled: true, provider: 'edge', cooldownMs: 60000 } } })

  /** 桩：fish 按 mode 抛错，edge / system 出声 */
  let mode = 'timeout'
  let dead = { edge: false, system: false }
  const calls = { fish: 0, edge: 0, system: 0 }
  ttsFallback.setSynthesizer(async (cfg) => {
    const p = cfg && cfg.provider
    calls[p] = (calls[p] || 0) + 1
    if (p === 'fish' && mode !== 'ok') throw failure(mode)
    if (dead[p]) throw new Error(`${p} 也没出声（桩）`)
    return { base64: 'ZmFrZQ==', mime: p === 'system' ? 'audio/wav' : 'audio/mpeg' }
  })
  const reset = () => {
    calls.fish = 0
    calls.edge = 0
    calls.system = 0
    ttsFallback.reset()
  }

  console.log('\n[1] 失败分类：哪一种才值得换嗓子')
  ok('超时 → 平台这会儿不顶用', ttsFallback.classify(failure('timeout')) === 'network')
  ok('额度用完 → 值得换', ttsFallback.classify(failure('credit')) === 'credit')
  ok('被限流 → 值得换', ttsFallback.classify(failure('limited')) === 'credit')
  ok('平台 5xx → 值得换', ttsFallback.classify(failure('server')) === 'server')
  ok('Key 无效 → 配置错，不换', ttsFallback.classify(failure('badkey')) === 'config')
  ok('没权限 → 配置错，不换', ttsFallback.classify(failure('denied')) === 'config')
  ok('值得换的三类判定一致', [failure('timeout'), failure('credit'), failure('server')].every((e) => ttsFallback.canFallback(e)))
  ok('Key 错/没权限 判定为不换', !ttsFallback.canFallback(failure('badkey')) && !ttsFallback.canFallback(failure('denied')))

  console.log('\n[2] 超时：换成免费嗓子把这句念完')
  reset()
  mode = 'timeout'
  const a1 = await ttsFallback.synth(FISH_CFG, '第一条测试弹幕', '')
  ok('出声了（不是静音）', Boolean(a1 && a1.base64), a1 && Object.keys(a1))
  ok('用的是备用嗓子', a1 && a1.fallbackProvider === 'edge', a1 && a1.fallbackProvider)
  ok('记下了原因：连不上平台', a1 && a1.fallbackReason === 'network', a1 && a1.fallbackReason)
  ok('原平台只撞了一次', calls.fish === 1 && calls.edge === 1, calls)
  ok('已经进入冷却', ttsFallback.state().active === true, ttsFallback.state())

  console.log('\n[3] 冷却期内不再去撞那个抽风的平台（否则每条都要先卡满一次超时）')
  const a2 = await ttsFallback.synth(FISH_CFG, '第二条测试弹幕', '')
  ok('第二条也出声了', Boolean(a2 && a2.base64), a2 && a2.fallbackProvider)
  ok('原平台一次都没再试', calls.fish === 1, calls)
  ok('第二条直接走的备用嗓子', calls.edge === 2, calls)

  console.log('\n[4] 额度用完（402）同样换，而且会告知原因')
  reset()
  mode = 'credit'
  const a3 = await ttsFallback.synth(FISH_CFG, '第三条测试弹幕', '')
  ok('额度用完也换成了备用嗓子', a3 && a3.fallbackProvider === 'edge', a3 && a3.fallbackProvider)
  ok('原因是额度/限流', a3 && a3.fallbackReason === 'credit', a3 && a3.fallbackReason)
  ok('冷却记的是同一个原因', ttsFallback.state().reason === 'credit', ttsFallback.state())

  console.log('\n[5] Key 填错（401）不换 —— 悄悄换掉的话永远发现不了配置是坏的')
  reset()
  mode = 'badkey'
  let caught = null
  try {
    await ttsFallback.synth(FISH_CFG, '第四条测试弹幕', '')
  } catch (e) {
    caught = e
  }
  ok('原样把错误抛出来', Boolean(caught), caught && caught.message)
  ok('备用嗓子没被叫来救场', calls.edge === 0 && calls.system === 0, calls)
  ok('没有进入冷却', ttsFallback.state().active === false, ttsFallback.state())

  console.log('\n[6] 平台恢复了：换回原来的嗓子')
  reset()
  mode = 'ok'
  const a5 = await ttsFallback.synth(FISH_CFG, '第五条测试弹幕', '')
  ok('用的是原平台（没标备用）', a5 && !a5.fallbackProvider, a5 && a5.fallbackProvider)
  ok('冷却已经退出', ttsFallback.state().active === false && !ttsFallback.state().reason, ttsFallback.state())
  ok('这一条是原平台合成的', calls.fish === 1 && calls.edge === 0, calls)

  console.log('\n[7] 关掉开关就不换（有人就是要听见报错）')
  reset()
  mode = 'timeout'
  await store.patch({ tts: { fallback: { enabled: false } } })
  let caught2 = null
  try {
    await ttsFallback.synth(FISH_CFG, '第六条测试弹幕', '')
  } catch (e) {
    caught2 = e
  }
  ok('照样报错', Boolean(caught2), caught2 && caught2.message)
  ok('没偷偷换嗓子', calls.edge === 0, calls)
  await store.patch({ tts: { fallback: { enabled: true } } })

  console.log('\n[8] 试听不换嗓子 —— 那边是在验音色，换成别的就听不出好坏')
  reset()
  mode = 'timeout'
  let caught3 = null
  try {
    await ttsFallback.synth(FISH_CFG, '音色试听', '', { allowFallback: false })
  } catch (e) {
    caught3 = e
  }
  ok('试听失败就是失败', Boolean(caught3), caught3 && caught3.message)
  ok('试听不会拿备用嗓子糊过去', calls.edge === 0 && calls.system === 0, calls)

  console.log('\n[9] 连 Edge 也挂了 → 还有本地系统语音兜底（它完全离线）')
  reset()
  mode = 'timeout'
  dead = { edge: true, system: false }
  const a6 = await ttsFallback.synth(FISH_CFG, '第七条测试弹幕', '')
  ok('退到了系统语音', a6 && a6.fallbackProvider === 'system', a6 && a6.fallbackProvider)
  ok('Edge 试过、没出声就往下走了', calls.edge === 1 && calls.system === 1, calls)
  dead = { edge: false, system: false }

  console.log('\n[10] 备用链全哑：报错，并且退出冷却（下一条还能回去碰碰运气）')
  reset()
  mode = 'timeout'
  dead = { edge: true, system: true }
  let caught4 = null
  try {
    await ttsFallback.synth(FISH_CFG, '第八条测试弹幕', '')
  } catch (e) {
    caught4 = e
  }
  ok('两个备用都哑了就报错', Boolean(caught4), caught4 && caught4.message)
  ok('没有卡在冷却里', ttsFallback.state().active === false, ttsFallback.state())
  dead = { edge: false, system: false }

  console.log('\n[11] 冷却时长可配：设为 0 = 每条都先试一次原平台')
  reset()
  mode = 'timeout'
  await store.patch({ tts: { fallback: { cooldownMs: 0 } } })
  await ttsFallback.synth(FISH_CFG, '第九条测试弹幕', '')
  await ttsFallback.synth(FISH_CFG, '第十条测试弹幕', '')
  ok('没有冷却，两条都先撞了原平台', calls.fish === 2, calls)
  ok('两条都靠备用嗓子出声了', calls.edge === 2, calls)
  await store.patch({ tts: { fallback: { cooldownMs: 60000 } } })

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
