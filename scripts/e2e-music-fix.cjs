'use strict'
/**
 * 点歌链路的两处硬伤 —— 只有真跑一遍才看得见。
 *
 * ① **关掉语音播报之后点歌还灵不灵**。以前点歌的处理逻辑写在 maybeSpeak（播报）里，
 *    `tts.enabled=false` 那一行 return 顺带把它一起吃了：观众照常发「点歌 晴天」，
 *    程序不排队、不回执、不报错，主播只会以为「点歌坏了」。
 * ② **同一首歌被点两次，第二条会不会卡住**。以前引擎按 `kind:id` 认条目，
 *    两条 id 一模一样 → 推进 effect 的依赖没变 → effect 不重跑 → 第二条永远不启动，
 *    画面停在最后一帧（观众看到的是「卡住了」）。
 *
 * 这两条静态断言都验不到（源码每一句看着都对），必须让真引擎 + 真 <audio> 跑。
 *
 * 不出声：音源是**全零 wav**（有真时长、能解码、没有波形），进程另加了 --mute-audio。
 *
 * 用法：npm run e2e:music
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-mfix-'))

/** 清掉上一轮留下的临时 userData（目录名带前缀，绝不碰别的东西） */
function sweepStale(keep) {
  let names = []
  try {
    names = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith('cp-e2e-mfix-') || path.join(os.tmpdir(), n) === keep) continue
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

/** 4 秒：够「播完自动推进」，又不至于让测试等太久 */
const CLIP = silentWav(4)
const SONG_ID = 9101

require(path.join(__dirname, '..', 'electron', 'main.cjs'))

const cp = () => global.__cpE2E
const mainWindow = () => BrowserWindow.getAllWindows().find((w) => (w.getTitle() || '').includes('弹幕姬'))
const run = (w, code) => w.webContents.executeJavaScript(code)

/** 引擎那一个播放元素（new Audio() 造的，DOM 里没有它） */
const AUDIO = `(() => {
  const el = (window.__audios || [])[0]
  if (!el) return null
  return { currentTime: Number(el.currentTime.toFixed(2)), paused: el.paused, duration: el.duration, ready: el.readyState, src: String(el.src || '').length }
})()`

async function main() {
  const win = await waitFor(() => mainWindow(), 20000)
  ok('主窗口起来了', Boolean(win))
  if (!win) {
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
    app.exit(fail > 0 ? 1 : 0)
    return
  }
  const api = cp()

  // 劫持 window.Audio：元素不在 DOM 里，只能从构造函数这一层抓到它
  await run(
    win,
    `(() => {
      if (window.__audios) return true
      window.__audios = []
      const Orig = window.Audio
      window.Audio = function (...a) {
        const el = new Orig(...a)
        window.__audios.push(el)
        return el
      }
      return true
    })()`,
  )

  console.log('[0] 铺桩：搜索返回固定那首，取链给一段全零 wav')
  // 搜索桩：不联网。playable/restricted 都给上，模拟「一首看着能播的歌」
  api.music.setSearch(async () => [
    {
      id: SONG_ID,
      name: '测试曲',
      artists: 'e2e',
      album: '',
      picUrl: '',
      duration: 4000,
      durationText: '0:04',
      playable: true,
      restricted: false,
      fee: 0,
      maxBr: 320000,
    },
  ])
  // 取链桩：真解码、真时长、零波形
  api.music.setUrl(async (id) => ({
    id: Number(id),
    url: CLIP,
    br: 320000,
    size: 0,
    type: 'wav',
    level: 'exhigh',
    expiresIn: 1200,
    md5: '',
    downgraded: false,
  }))
  api.store.patch({ tts: { enabled: false }, music: { enabled: true, replyInChat: true } })
  ok('语音播报确实是关着的（复现前提）', api.store.get().tts.enabled === false, api.store.get().tts?.enabled)

  console.log('[1] 关着语音播报发「点歌」→ 照样进队列并开播')
  api.music.danmaku('点歌 测试曲', { uid: 90001, username: '甲' })
  const s1 = await waitFor(() => {
    const s = api.music.snapshot()
    return s.current ? s : null
  }, 12000)
  ok('关掉播报也能点进队列（以前这里是空的）', Boolean(s1 && s1.current), api.music.snapshot())
  ok('入队的就是桩里那首', Boolean(s1 && s1.current && s1.current.name === '测试曲'), s1 && s1.current && s1.current.name)

  const a1 = await waitFor(async () => {
    const r = await run(win, AUDIO)
    return r && r.ready >= 2 ? r : null
  }, 12000)
  ok('第一条真的在播（元素就绪且没暂停）', Boolean(a1 && a1.paused === false), a1)

  console.log('[2] 同一首再点一次 → 队列里多一条，身份分得开')
  api.music.danmaku('点歌 测试曲', { uid: 90002, username: '乙' })
  const s2 = await waitFor(() => {
    const s = api.music.snapshot()
    return s.items.length >= 1 ? s : null
  }, 12000)
  ok('第二条进了队列', Boolean(s2), s2 && { current: s2.current && s2.current.name, items: s2.items.length })
  const cur = s2 && s2.current
  const queued = s2 && s2.items[0]
  ok('两条确实是同一首歌（id 相同）', Boolean(cur && queued && cur.id === queued.id), {
    cur: cur && cur.id,
    queued: queued && queued.id,
  })
  ok(
    '但 qid 不同（身份不能再靠 id 认）',
    Boolean(cur && queued && cur.qid && queued.qid && cur.qid !== queued.qid),
    { cur: cur && cur.qid, queued: queued && queued.qid },
  )

  console.log('[3] 第一条播完 → 第二条自己接上（以前卡在最后一帧）')
  const firstQid = cur && cur.qid
  const moved = await waitFor(() => {
    const s = api.music.snapshot()
    return s.current && s.current.qid !== firstQid ? s : null
  }, 25000)
  ok('current 真的推进到了第二条', Boolean(moved), api.music.snapshot())
  ok('推进方向对（第二条就是队列里那条）', Boolean(moved && queued && moved.current.qid === queued.qid), {
    moved: moved && moved.current && moved.current.qid,
    queued: queued && queued.qid,
  })

  const a2 = await waitFor(async () => {
    const r = await run(win, AUDIO)
    return r && r.ready >= 2 && r.paused === false ? r : null
  }, 12000)
  ok('第二条开始播了（没卡住）', Boolean(a2), a2)
  const t1 = (a2 && a2.currentTime) || 0
  await wait(1200)
  const a3 = await run(win, AUDIO)
  ok('进度真的在走（1.2 秒后应该更靠后）', Boolean(a3 && a3.currentTime > t1), { t1, t2: a3 && a3.currentTime })
  ok('第二条也是从头开始（不是接着第一条的结尾）', Boolean(a3 && a3.currentTime < 3.5), a3 && a3.currentTime)

  console.log('[4] 回执：尾巴上的「第几位」不能被截掉')
  const acks = (api.replies || []).filter((x) => String(x).startsWith('已点歌：'))
  ok('点歌有回执（播报关着也照发）', acks.length >= 1, api.replies)
  ok('回执里保住了「（第 1 位）」', acks.some((x) => /（第 \d+ 位）$/.test(x)), acks)
  ok('回执没超过 B 站单条 20 字上限', acks.every((x) => String(x).length <= 20), acks.map((x) => String(x).length))

  console.log('[5] 关掉语音页那个「回执」开关 → 点歌回执仍然发（两个开关不再粘连）')
  api.store.patch({ voicePolicy: { replyInChat: false } })
  api.replies.length = 0
  api.music.danmaku('点歌 测试曲', { uid: 90003, username: '丙' })
  await waitFor(() => (api.replies || []).some((x) => String(x).startsWith('已点歌：')), 8000)
  ok(
    '语音回执关了，点歌回执照样发',
    (api.replies || []).some((x) => String(x).startsWith('已点歌：')),
    api.replies,
  )

  console.log('[6] 同一个人连着点 → 被节流也要回一声（以前是静默丢弃）')
  api.replies.length = 0
  api.music.danmaku('点歌 测试曲', { uid: 90004, username: '丁' })
  await waitFor(() => (api.replies || []).some((x) => String(x).startsWith('已点歌：')), 8000)
  api.music.danmaku('点歌 测试曲', { uid: 90004, username: '丁' })
  const cooled = await waitFor(
    () => ((api.replies || []).some((x) => /点太快/.test(String(x))) ? true : null),
    8000,
  )
  ok('被节流时回了「点太快啦」，不是一声不吭', Boolean(cooled), api.replies)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  app.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  app.exit(1)
})
