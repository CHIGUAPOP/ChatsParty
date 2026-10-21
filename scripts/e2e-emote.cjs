'use strict'
/**
 * 弹幕里的「[表情名]」是不是真的画成了图片。
 *
 * 为什么要有这个脚本：栽过一次「表情包显示成了文字」——
 * 原来的实现只在弹幕包自带 `emots` 时才换图，而且键直接拿 `emots[名字]` 去查，
 * 可 B 站两个面板下发的名字格式并不统一（收藏集给 `[dog]`、通用表情给 `啊`），
 * 一旦对不上就整条退回纯文本。源码看着每句都成立，只有真跑一遍界面才知道。
 *
 * 验三件事：
 *   1. 图册合并：收藏集 / 通用 / 评论面板三路合进一张表，名字剥掉方括号，直播优先
 *   2. 界面：`[dog]` 变成 <img>，查不到的名字保持原样文字，图片带 no-referrer
 *   3. 叠加层（OBS）：同一份图册也能把图拉出来
 *
 * 不出声：整个进程 --mute-audio，并且把 TTS 关掉（这里不需要任何声音）。
 *
 * 用法：npm run e2e:emote
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-emote-'))

function sweepStale(keep) {
  let names = []
  try {
    names = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith('cp-e2e-emote-') || path.join(os.tmpdir(), n) === keep) continue
    try {
      fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true })
    } catch {
      /* 还被占着就留给下一轮 */
    }
  }
}
sweepStale(tmpUserData)

/**
 * 叠加层端口：产品默认 12450 是写死在 OBS 源里的，测试一律换一个随机口，
 * 否则真开着程序的人一跑测试就把自己的叠加层挤掉了。
 */
const PORT = 20000 + Math.floor(Math.random() * 20000)
app.setPath('userData', tmpUserData)
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('mute-audio')
app.disableHardwareAcceleration()
process.env.CP_PROD = '1'
process.env.CP_E2E = '1'
process.env.CP_OVERLAY_PORT = String(PORT)

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

require(path.join(__dirname, '..', 'electron', 'main.cjs'))

/* --------------------------- 两个面板的假数据 --------------------------- */

const LIVE_DOG = 'http://i0.hdslb.com/bfs/live/e2e-live-dog.png'
const LIVE_AH = 'http://i0.hdslb.com/bfs/live/e2e-live-ah.png'
const REPLY_DOG = 'http://i0.hdslb.com/bfs/emote/e2e-reply-dog.png'
const REPLY_JINGU = 'http://i0.hdslb.com/bfs/emote/e2e-reply-jingu.png'

/** 直播间面板：收藏集（pkg_type=3）的名字带方括号，通用表情（pkg_type=1）不带 */
const liveFixture = {
  code: 0,
  data: {
    data: [
      {
        pkg_id: 100,
        pkg_type: 3,
        pkg_name: 'emoji',
        emoticons: [{ emoji: '[dog]', url: LIVE_DOG, width: 200, height: 60 }],
      },
      {
        pkg_id: 1,
        pkg_type: 1,
        pkg_name: '通用表情',
        emoticons: [{ emoji: '啊', url: LIVE_AH, width: 200, height: 60 }],
      },
    ],
  },
}

/** 评论面板：同一个 dog 故意给不同的图，用来验「直播优先」 */
const replyFixture = {
  code: 0,
  data: {
    packages: [
      {
        id: 1,
        text: '小黄脸',
        emote: [
          { text: '[dog]', url: REPLY_DOG, meta: { alias: '狗' } },
          { text: '[doge_金箍]', url: REPLY_JINGU, meta: { alias: '金箍' } },
        ],
      },
    ],
  },
}

const mainWindow = () => BrowserWindow.getAllWindows().find((w) => (w.getTitle() || '').includes('弹幕姬'))
const run = (w, code) => w.webContents.executeJavaScript(code)

/** 最后一条弹幕里画出来的表情 */
const LAST_EMOTE = `(() => {
  const rows = document.querySelectorAll('.danmaku-item')
  const row = rows[rows.length - 1]
  if (!row) return null
  const img = row.querySelector('img.danmaku-emote')
  return {
    hasImg: Boolean(img),
    src: img ? img.src : '',
    alt: img ? img.alt : '',
    ref: img ? img.referrerPolicy : '',
    text: (row.querySelector('.danmaku-text') || {}).textContent || '',
  }
})()`

async function main() {
  const win = await waitFor(() => mainWindow(), 25000)
  ok('主窗口起来了', Boolean(win))
  if (!win) {
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
    app.exit(1)
    return
  }

  const cp = global.__cpE2E
  ok('e2e 测试口可用', Boolean(cp && cp.emoticons && cp.dispatchEvent))
  if (!cp) {
    app.exit(1)
    return
  }
  // 这个脚本不验声音，直接关掉播报，避免任何合成/播放
  cp.store.patch({ tts: { enabled: false } })

  console.log('[1] 图册合并：收藏集 / 通用 / 评论三路 → 一张表')
  const asked = []
  cp.store.patch({ room: { realRoomId: 25564050 } })
  cp.emoticons.setFetcher(async (url) => {
    asked.push(url)
    if (url.includes('GetEmoticons')) return liveFixture
    if (url.includes('panel/web')) return replyFixture
    return { code: -1 }
  })
  await cp.emoticons.refresh(true)
  const book = cp.emoticons.book()
  ok('直播间面板被请求，且带上了真实房间号', asked.some((u) => u.includes('room_id=25564050')), asked)
  ok('收藏集的 [dog] 剥掉方括号后能查到', Boolean(book.dog && book.dog.url), book.dog)
  ok('通用表情「啊」能查到', Boolean(book['啊'] && book['啊'].url), book['啊'])
  ok('评论表情 [doge_金箍] 能查到', Boolean(book['doge_金箍'] && book['doge_金箍'].url), book['doge_金箍'])
  ok('同名时直播面板优先（不是评论那张）', Boolean(book.dog && book.dog.url === 'https://i0.hdslb.com/bfs/live/e2e-live-dog.png'), book.dog)
  ok('http 图床地址统一升成 https', Boolean(book['啊'] && book['啊'].url.startsWith('https://')), book['啊'])
  ok('表里不留下带方括号的键（布局统一）', book['[dog]'] === undefined, Object.keys(book))

  console.log('[2] 界面：一条 [dog] 弹幕变成图片')
  // 渲染层是异步挂载的（配置拉回来之前只有一个「正在载入」），别在它还没画出来时就去点导航
  await waitFor(async () => run(win, `document.querySelectorAll('.nav-rail__label').length > 0`), 15000)
  const clicked = await run(
    win,
    `(() => {
      const labels = [...document.querySelectorAll('.nav-rail__label')]
      const want = '弹幕'
      const el = labels.find((x) => (x.textContent || '').trim() === want)
      if (!el) return { ok: false, labels: labels.map((x) => (x.textContent || '').trim()) }
      el.closest('button').click()
      return { ok: true }
    })()`,
  )
  await waitFor(async () => run(win, `Boolean(document.querySelector('.danmaku-side'))`), 15000)
  cp.dispatchEvent({ type: 'danmaku', uid: 90001, username: 'e2e表情', content: '[dog] 好耶 [不存在]', color: 16777215 })
  const row1 = await waitFor(async () => {
    const r = await run(win, LAST_EMOTE)
    return r && r.hasImg ? r : null
  }, 8000)
  ok('[dog] 真的画成了 <img>', Boolean(row1 && row1.hasImg), row1)
  ok('用的是图册里那张图（直播面板）', Boolean(row1 && row1.src.includes('e2e-live-dog')), row1 && row1.src)
  ok('图片带 no-referrer（B站图床要它，否则 403）', Boolean(row1 && row1.ref === 'no-referrer'), row1 && row1.ref)
  ok('查不到的名字保持原样文字', Boolean(row1 && row1.text.includes('[不存在]')), row1 && row1.text)
  ok('命中表情后不再显示 [dog] 原文', Boolean(row1 && !row1.text.includes('[dog]')), row1 && row1.text)

  console.log('[3] 弹幕包自带的 emots 优先于图册')
  cp.dispatchEvent({
    type: 'danmaku',
    uid: 90002,
    username: 'e2e表情',
    content: '[dog]',
    color: 16777215,
    emots: { '[dog]': { url: 'https://i0.hdslb.com/bfs/live/e2e-event-local.png' } },
  })
  const row2 = await waitFor(async () => {
    const r = await run(win, LAST_EMOTE)
    return r && r.hasImg && r.src.includes('e2e-event-local') ? r : null
  }, 8000)
  ok('事件自带的 emots 覆盖图册（键带方括号也能认）', Boolean(row2), await run(win, LAST_EMOTE))

  console.log('[4] 叠加层（OBS）也能画出同一张图')
  const ovWin = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  const ovErr = []
  ovWin.webContents.on('console-message', (_e, level, message) => {
    // CSP / 安全提示是 Electron 对未打包页面的常规唠叨，不是这一页的问题
    if (level >= 2 && !/Electron Security Warning/.test(message)) ovErr.push(message)
  })
  await ovWin.loadURL(`http://127.0.0.1:${PORT}/overlay/danmaku`)
  await waitFor(async () => ovWin.webContents.executeJavaScript(`Boolean(window.WebSocket)`), 8000)
  await wait(600) // 等 ws 连上并收到 hello / emoticons 那两帧
  cp.dispatchEvent({ type: 'danmaku', uid: 90003, username: 'e2e表情', content: '[dog] 叠加层', color: 16777215 })
  const ovRow = await waitFor(
    () =>
      ovWin.webContents.executeJavaScript(`(() => {
        const items = document.querySelectorAll('.cp-item')
        const row = items[items.length - 1]
        if (!row) return null
        const img = row.querySelector('img')
        return {
          hasImg: Boolean(img),
          src: img ? img.src : '',
          ref: img ? img.referrerPolicy : '',
          text: (row.querySelector('.cp-text') || {}).textContent || '',
        }
      })()`),
    8000,
  )
  ok('叠加层里画出了表情图', Boolean(ovRow && ovRow.hasImg), ovRow)
  ok('叠加层同样带 no-referrer', Boolean(ovRow && ovRow.ref === 'no-referrer'), ovRow && ovRow.ref)
  ok('叠加层这条弹幕确实进了画面', Boolean(ovRow && String(ovRow.text).includes('叠加层')), ovRow && ovRow.text)
  ok('叠加层没有报错', ovErr.length === 0, ovErr.slice(0, 3))
  ovWin.destroy()

  console.log('[5] 面板拿不到时不炸（退回纯文字）')
  cp.emoticons.reset()
  cp.emoticons.setFetcher(async () => {
    throw new Error('e2e 模拟断网')
  })
  let threw = null
  try {
    await cp.emoticons.refresh(true)
  } catch (e) {
    threw = String(e && e.message)
  }
  ok('拉取失败不抛给调用方', threw === null, threw)
  ok('图册为空时不崩', Object.keys(cp.emoticons.book()).length === 0, cp.emoticons.book())
  // 连界面那份也清掉，模拟「从头到尾就没拿到过图册」
  cp.emoticons.setBook({})
  cp.dispatchEvent({ type: 'danmaku', uid: 90004, username: 'e2e表情', content: '[dog] 没图册', color: 16777215 })
  const row3 = await waitFor(async () => {
    const r = await run(win, LAST_EMOTE)
    return r && String(r.text).includes('没图册') ? r : null
  }, 8000)
  ok('没有图册时退回原样文字', Boolean(row3 && !row3.hasImg && row3.text.includes('[dog]')), row3)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  app.exit(fail > 0 ? 1 : 0)
}

app.whenReady().then(() => {
  main().catch((e) => {
    console.log('e2e 崩了：', e && e.stack ? e.stack : e)
    app.exit(1)
  })
})
