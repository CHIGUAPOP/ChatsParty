'use strict'
/**
 * 「B站默认昵称不念数字」的端到端验证。
 *
 * 为什么要有这个脚本：这条链路只有在**真实弹幕事件**里才走得完 ——
 * 弹幕进来 → maybeSpeak → buildSpeechText → 拼好一句话塞进播报队列。
 * smoke 里那几条只能验到 speakableName 这个纯函数，验不到「到底有没有接上」。
 * 这里真起主进程、真派发事件、真读配置，把「观众发了这条弹幕之后嗓子里要说的是什么」验完。
 *
 * 用法（必须在项目根目录，且用 electron 的二进制跑，不能用 node）：
 *   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/e2e-tts-name.cjs
 * 或者：npm run e2e:tts
 *
 * 依赖 main.cjs 里 CP_E2E=1 分支挂出来的 global.__cpE2E（派发口 + store + 回执记录）。
 * 用临时 userData，绝对不会碰真实配置。
 * 只验「队列里那句话是什么」，不会真的去合成音频 —— 音色提供方填的是 system。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-ttsname-'))

/**
 * 收走上一次跑剩下的临时目录。自己退出前删不干净（Chromium 的子进程占着
 * Cookies / Network），改成下次启动时扫一遍 —— 那时上一轮进程已经全退了。
 */
function sweepStale(keep) {
  let names = []
  try {
    names = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith('cp-e2e-ttsname-') || path.join(os.tmpdir(), n) === keep) continue
    try {
      fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true })
    } catch {
      /* 还被占着就留给下一轮，不影响结论 */
    }
  }
}
sweepStale(tmpUserData)

app.setPath('userData', tmpUserData)
// 无 GPU 的环境里 Chromium 的 GPU 进程会直接崩，这两个开关让它走软件渲染
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('use-gl', 'swiftshader')
// 直接加载构建产物，别去连可能没起来的 vite dev server
process.env.CP_PROD = '1'
process.env.CP_E2E = '1'
// 叠加层端口也要错开：12450 上可能正跑着用户在直播用的那一份真实实例，
// 测试实例去占了它，之后真实实例会被挤到 12451，而 OBS 里写的还是 12450。
// 认这个变量的是 main.cjs 的 overlayPort()。
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
  const { store, dispatchEvent, replies, speech } = hook

  /** 没改过昵称的账号长这样 */
  const BILI_DEFAULT = 'bili_3706983133743519'
  const ALIAS = '一个b站用户'

  const PROFILE = {
    id: 'prof_test',
    owner: 'host',
    ownerName: '',
    enabled: true,
    name: '测试音色',
    platform: 'system',
    protocol: 'system',
    baseUrl: '',
    apiKey: '',
    model: '',
    voice: '测试voice',
    format: 'wav',
    speed: 1,
    stylePrompt: '这是绑定的音色',
    mimoMode: 'preset',
    createdAt: Date.now(),
  }

  /**
   * 这一节的 tts 基线。
   *
   * store.patch 是**深合并**，上一节改过的键会留着 —— 所以每节都得把基线整个铺一遍，
   * 只覆盖 extra 里点名的字段，否则 [3] 关掉的开关会一路漏到 [4] 去。
   */
  const TTS = {
    enabled: true,
    provider: 'system',
    mergeDuplicate: false,
    perUserCooldownMs: 0,
    minIntervalMs: 0,
    readUsername: true,
    readGift: true,
    readGuard: true,
    readSuperchat: true,
    readEnter: true,
    renameDefaultUser: true,
    defaultUserName: ALIAS,
  }

  const seed = (extra = {}) => {
    const { tts: ttsExtra, ...rest } = extra
    return store.patch({
      tts: { ...TTS, ...(ttsExtra || {}) },
      // 点歌指令那条分支会去发网络请求，这里不需要它，关掉
      music: { enabled: false },
      voicePolicy: { enabled: true, cooldownMs: 1, replyInChat: true, requireMedal: false, allowUnbind: true },
      voiceLibrary: [PROFILE],
      voiceBindings: {},
      commands: { voice: { bind: ['绑定', '换音色'], unbind: ['删除音色', '解绑'] } },
      ...rest,
    })
  }

  let uidSeq = 8000
  /**
   * 派发一条事件，把「这一条最后要塞进嗓子里的那句话」捞出来。
   *
   * 必须先把队列冻住：不冻的话 pumpSpeech 会立刻把它取走，就看不见塞了什么。
   */
  const speak = (ev) => {
    speech.setBusy(true)
    const before = speech.queue.length
    dispatchEvent(ev)
    const item = speech.queue[before] || null
    speech.queue.length = 0
    speech.setBusy(false)
    return item ? item.text : null
  }
  const danmaku = (username, content = '你好') => ({
    type: 'danmaku',
    uid: ++uidSeq,
    username,
    content,
    medal: null,
    face: '',
    timestamp: Date.now(),
  })

  console.log('\n[1] 弹幕：B站默认昵称不念数字')
  {
    seed()
    const got = speak(danmaku(BILI_DEFAULT))
    console.log(`        念的是：${JSON.stringify(got)}`)
    ok('1a 默认昵称念成「一个b站用户」', got === `${ALIAS}说，你好`, got)
    ok('1b 数字一个都没漏出来', !/\d/.test(String(got || '')), got)

    const normal = speak(danmaku('小明'))
    ok('1c 自己起的名原样念', normal === '小明说，你好', normal)
  }

  console.log('\n[2] 各种长相的默认昵称')
  {
    seed()
    const shapes = [
      ['bili_1234567890123456789', '超长 uid'],
      ['BILI_1234567', '大写前缀'],
      ['bilibili_1234567', 'bilibili 前缀'],
      ['用户_1234567', '早期中文前缀'],
      ['3706983133743519', '纯数字的昵称'],
    ]
    for (const [name, label] of shapes) {
      const got = speak(danmaku(name))
      ok(`2 ${label}也念成「一个b站用户」`, got === `${ALIAS}说，你好`, { name, got })
    }
    // 名字里夹几个数字是常态，不能一杆子全打掉
    const keep = speak(danmaku('小明2333'))
    ok('2 名字里夹数字的照念', keep === '小明2333说，你好', keep)
  }

  console.log('\n[3] 关掉开关就退回原样（这个功能是能被关掉的）')
  {
    seed({ tts: { renameDefaultUser: false } })
    const got = speak(danmaku(BILI_DEFAULT))
    ok('3 关掉后念原名', got === `${BILI_DEFAULT}说，你好`, got)
  }

  console.log('\n[4] 称呼可以自己改')
  {
    seed({ tts: { defaultUserName: '一位路人' } })
    ok('4a 用自定义称呼', speak(danmaku(BILI_DEFAULT)) === '一位路人说，你好')

    seed({ tts: { defaultUserName: '' } })
    ok('4b 填成空就回落默认', speak(danmaku(BILI_DEFAULT)) === `${ALIAS}说，你好`)
  }

  console.log('\n[5] 礼物 / 上舰 / 醒目留言 / 进场 这几条也都得跟着换')
  {
    seed()
    const gift = speak({ type: 'gift', uid: ++uidSeq, username: BILI_DEFAULT, giftName: '辣条', num: 1, timestamp: Date.now() })
    ok('5a 礼物', gift === `感谢 ${ALIAS} 的 辣条`, gift)

    const guard = speak({ type: 'guard', uid: ++uidSeq, username: BILI_DEFAULT, giftName: '舰长', timestamp: Date.now() })
    ok('5b 上舰', guard === `感谢 ${ALIAS} 开通 舰长`, guard)

    const sc = speak({ type: 'superchat', uid: ++uidSeq, username: BILI_DEFAULT, content: '加油', timestamp: Date.now() })
    ok('5c 醒目留言', sc === `${ALIAS} 的醒目留言，加油`, sc)

    const enter = speak({ type: 'enter', uid: ++uidSeq, username: BILI_DEFAULT, timestamp: Date.now() })
    ok('5d 进场欢迎', enter === `欢迎 ${ALIAS} 进入直播间`, enter)
  }

  console.log('\n[6] 关掉「朗读用户名」时压根不该出现名字')
  {
    seed({ tts: { readUsername: false } })
    const got = speak(danmaku(BILI_DEFAULT))
    ok('6 只念内容', got === '你好', got)
  }

  console.log('\n[7] 换音色 / 恢复默认音色 的试听句也得过同一道转换')
  {
    seed()
    const u = ++uidSeq
    // 冻结队列，看清这一轮塞了什么（试听句是异步落的，要等一下）
    speech.setBusy(true)
    replies.length = 0
    dispatchEvent({ type: 'danmaku', uid: u, username: BILI_DEFAULT, content: '#绑定 测试音色', medal: null, face: '', timestamp: Date.now() })
    await wait(600)
    const spoken = speech.queue.map((x) => x.text)
    speech.queue.length = 0
    speech.setBusy(false)
    console.log(`        念的是：${JSON.stringify(spoken)}`)
    ok('7a 试听句用的是「一个b站用户」', spoken.includes(`${ALIAS}换音色了，现在是这样`), spoken)
    ok('7b 数字没有漏进试听句', !spoken.some((x) => /\d{4,}/.test(String(x))), spoken)
    // 回执是发到直播间给人看的文字，不是念出来的 —— 它得留着真名，不然观众认不出是自己
    console.log(`        回执：${JSON.stringify(replies)}`)
    ok('7c 文字回执仍用真名', replies.some((x) => x.includes(BILI_DEFAULT)), replies)

    // 解绑走的是另一句（previewDefault），单独验一下
    speech.setBusy(true)
    dispatchEvent({ type: 'danmaku', uid: u, username: BILI_DEFAULT, content: '#删除音色', medal: null, face: '', timestamp: Date.now() })
    await wait(600)
    const spoken2 = speech.queue.map((x) => x.text)
    speech.queue.length = 0
    speech.setBusy(false)
    ok('7d 恢复默认音色的试听句也换过了', spoken2.includes(`${ALIAS}换回默认音色了，现在是这样`), spoken2)
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
      // 尽力删一次；删不掉也没关系，下一次启动时的 sweepStale 会收走
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
