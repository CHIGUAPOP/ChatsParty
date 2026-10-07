'use strict'
/**
 * 弹幕音色指令的端到端验证。
 *
 * 为什么要有这个脚本：`#换音色 / #删除音色` 这条链路只在**真实弹幕事件**里才走得到
 * （直播连接没法在测试环境里起），靠单元测试只能验到 parseCommand 那一层。
 * 这里真起主进程、真派发弹幕事件、真读配置，把「观众发了这条弹幕之后到底发生了什么」验完。
 *
 * 用法（必须在项目根目录，且用 electron 的二进制跑，不能用 node）：
 *   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/e2e-danmaku.cjs
 * 或者：npm run e2e:danmaku
 *
 * 依赖 main.cjs 里 CP_E2E=1 分支挂出来的 global.__cpE2E（派发口 + store + 回执记录）。
 * 用临时 userData，绝对不会碰真实配置。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-danmaku-'))

/**
 * 收走上一次跑剩下的临时目录。
 *
 * 自己退出前删是删不干净的 —— Chromium 的 Cookies / Network 那几个文件被
 * 它自己的子进程占着，主进程删不掉（这也是 Electron 里删 userData 的经典坑）。
 * 改成**下次启动时**扫一遍：那时候上一轮的进程已经全退了，一删一个准。
 * 前缀是本脚本独占的，不会误伤别的东西。
 */
function sweepStale(keep) {
  let names = []
  try {
    names = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith('cp-e2e-danmaku-') || path.join(os.tmpdir(), n) === keep) continue
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
// 直接加载构建产物，别去连可能没起来的 vite dev server（连不上主窗口就是白的）
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
  const { store, dispatchEvent, replies, speech, currentProfileOf, setOwnUid } = hook

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
  const seed = (extra = {}) =>
    store.patch({
      tts: { enabled: true, provider: 'system', mergeDuplicate: false, perUserCooldownMs: 0 },
      voicePolicy: { enabled: true, cooldownMs: 5000, replyInChat: true, requireMedal: false, allowUnbind: true },
      voiceLibrary: [PROFILE],
      voiceBindings: {},
      commands: { voice: { bind: ['绑定', '换音色'], unbind: ['删除音色', '解绑'] } },
      ...extra,
    })

  let uidSeq = 9000
  const bindings = () => store.get().voiceBindings || {}
  const send = (uid, content) =>
    dispatchEvent({ type: 'danmaku', uid, username: '测试观众', content, medal: null, face: '', timestamp: Date.now() })
  // 队列空闲时会被 pumpSpeech 立刻取走，冻结 busy 才能看清这一轮到底塞了什么进去
  const collectPreviews = async (fn) => {
    speech.setBusy(true)
    const before = speech.queue.length
    await fn()
    const items = speech.queue.slice(before)
    speech.setBusy(false)
    speech.queue.length = 0
    return items.filter((x) => x.meta && x.meta.type === 'voice-preview')
  }

  console.log('\n[0] 环境自检：测试实例没去抢直播间的端口')
  {
    // main.cjs 启动时会把叠加层真的拉起来。要是用了默认的 12450，而主播正开着程序
    // 直播用同一个端口，两边的 OBS 源就会一个连到真实实例、一个连到测试实例 ——
    // 表现出来是「直播画面里少了一半弹幕」，而且完全不报错。
    // 所以脚本在启动主进程之前就把端口换掉了（见文件头的 CP_OVERLAY_PORT）。
    let ov = store.get().overlay || {}
    for (let i = 0; i < 60; i++) {
      ov = store.get().overlay || {}
      if (Number(ov.port) > 0 && Number(ov.port) !== 12450) break
      await wait(100)
    }
    ok('测试实例没监听 12450', Number(ov.port) !== 12450, { 实际监听: ov.port, 脚本指定: process.env.CP_OVERLAY_PORT })
    ok(
      '用的是脚本指定的那个端口',
      Number(ov.port) === Number(process.env.CP_OVERLAY_PORT),
      { 实际监听: ov.port, 脚本指定: process.env.CP_OVERLAY_PORT },
    )
  }

  console.log('\n[1] 观众自己换音色，随后立刻反悔（默认冷却 5 秒）')
  {
    seed()
    const u = ++uidSeq
    replies.length = 0
    send(u, '#绑定 测试音色')
    await wait(800)
    ok('1a 换音色生效', bindings()[u] === 'prof_test', bindings())
    send(u, '#删除音色')
    await wait(900)
    console.log(`        回执：${replies.map((x) => JSON.stringify(x)).join(' | ')}`)
    ok('1b 冷却期内发的删除音色照样生效（以前被静默吞掉）', Object.keys(bindings()).length === 0, bindings())
    ok('1c 两条指令各有回执', replies.length === 2, replies)
  }

  console.log('\n[2] 解绑之后真的回到默认音色')
  {
    seed()
    const u = ++uidSeq
    const peek = (uid, content) => {
      speech.setBusy(true)
      send(uid, content)
      const item = speech.queue[speech.queue.length - 1] || null
      speech.setBusy(false)
      speech.queue.length = 0
      return item
    }
    const before = peek(u, '绑定前的一条弹幕')
    ok('2a 绑定前走全局默认', before && before.profile === null, before && before.profile)

    send(u, '#绑定 测试音色')
    await wait(700)
    const mid = peek(u, '绑定后的一条弹幕')
    ok('2b 绑定后用绑定音色', mid && mid.profile && mid.profile.id === 'prof_test', mid && mid.profile)
    ok('2c stylePrompt 也跟着换', mid && mid.style === '这是绑定的音色', mid && mid.style)

    send(u, '#删除音色')
    await wait(700)
    const after = peek(u, '解绑后的一条弹幕')
    ok('2d 解绑后回到全局默认', after && after.profile === null, after && after.profile)
    ok('2e stylePrompt 也回到默认', after && after.style !== '这是绑定的音色', after && after.style)
    ok('2f currentProfileOf 查不到了', currentProfileOf(u) === null, currentProfileOf(u))
  }

  console.log('\n[3] 解绑成功时会用默认音色念一句（profile 必须是 null）')
  {
    seed()
    const u = ++uidSeq
    store.patch({ voiceBindings: { [u]: 'prof_test' } })
    const previews = await collectPreviews(async () => {
      send(u, '#删除音色')
      await wait(400)
    })
    ok('3a 念了一句', previews.length === 1, previews.length)
    ok('3b 用的是默认音色', previews[0] && previews[0].profile === null, previews[0] && previews[0].profile)
  }

  console.log('\n[4] 别名都能触发解绑')
  {
    seed()
    for (const word of ['删除音色', '解绑']) {
      const u = ++uidSeq
      store.patch({ voiceBindings: { [u]: 'prof_test' } })
      replies.length = 0
      send(u, `#${word}`)
      await wait(500)
      ok(`4: #${word} 能解绑`, Object.keys(bindings()).length === 0, {
        bindings: bindings(),
        reply: replies[replies.length - 1],
      })
    }
  }

  console.log('\n[5] 没绑定时发解绑：有回执、不报错、不出声')
  {
    seed()
    const u = ++uidSeq
    replies.length = 0
    const previews = await collectPreviews(async () => {
      send(u, '#删除音色')
      await wait(500)
    })
    console.log(`        回执：${replies[replies.length - 1]}`)
    ok('5a 有回执', replies.length === 1, replies)
    ok('5b 没绑定时不出声', previews.length === 0, previews.length)
  }

  console.log('\n[6] 冷却只挡「同一条指令」')
  {
    seed()
    const u = ++uidSeq
    replies.length = 0
    send(u, '#绑定 测试音色')
    await wait(300)
    send(u, '#删除音色')
    await wait(500)
    ok('6a 换音色不会挡住随后的删除音色', Object.keys(bindings()).length === 0, bindings())
    ok('6b 两条都有回执', replies.length === 2, replies)
  }

  console.log('\n[7] 同一条指令连刷：挡住、但要给提示，且不刷屏')
  {
    seed()
    const u = ++uidSeq
    store.patch({ voiceBindings: { [u]: 'prof_test' } })
    replies.length = 0
    const previews = await collectPreviews(async () => {
      for (let i = 0; i < 10; i++) send(u, '#删除音色')
      await wait(1200)
    })
    console.log(`        回执 ${replies.length} 条；语音预览 ${previews.length} 条`)
    ok('7a 连刷不会刷满回执', replies.length <= 3, replies.length)
    ok(
      '7b 被挡下的那次给了「还要等几秒」的提示',
      replies.some((x) => x.includes('还要等')),
      replies,
    )
    ok('7c 连刷不会反复出声', previews.length <= 1, previews.length)
  }

  console.log('\n[8] 冷却设成 0（界面滑块能拖到 0，语义是「不限制」）')
  {
    seed()
    store.patch({ voicePolicy: { cooldownMs: 0 } })
    const u = ++uidSeq
    send(u, '#绑定 测试音色')
    await wait(300)
    send(u, '#删除音色')
    await wait(800)
    ok('8 冷却 0 时连发两条都生效', Object.keys(bindings()).length === 0, bindings())
  }

  console.log('\n[9] allowUnbind=false 时拒绝并说明原因')
  {
    seed()
    const u = ++uidSeq
    store.patch({ voicePolicy: { allowUnbind: false }, voiceBindings: { [u]: 'prof_test' } })
    replies.length = 0
    send(u, '#删除音色')
    await wait(600)
    console.log(`        回执：${replies[replies.length - 1]}`)
    ok('9a 不再解绑', bindings()[u] === 'prof_test', bindings())
    ok('9b 说明了原因', String(replies[replies.length - 1] || '').includes('没有开放'), replies)
  }

  console.log('\n[10] 音色页存的是字符串 uid，弹幕里是数字 —— 两边都得认')
  {
    seed()
    store.patch({ voicePolicy: { cooldownMs: 1 } })
    const u = ++uidSeq
    store.patch({ voiceBindings: { [String(u)]: 'prof_test' } })
    send(u, '#删除音色')
    await wait(500)
    ok('10a 字符串键的绑定能被弹幕解掉', Object.keys(bindings()).length === 0, bindings())

    store.patch({ voiceBindings: { [u]: 'prof_test' } })
    dispatchEvent({
      type: 'danmaku',
      uid: String(u),
      username: '测试观众',
      content: '#删除音色',
      medal: null,
      face: '',
      timestamp: Date.now(),
    })
    await wait(500)
    ok('10b 反过来（数字键 / 字符串 uid）也能解掉', Object.keys(bindings()).length === 0, bindings())
  }

  console.log('\n[11] 开了「需要粉丝牌」：观众要牌子，主播和房管不受限')
  {
    /**
     * 主播身上**没有**自己房间的粉丝牌（弹幕包 info[3] 为空），弹幕包里也没有
     * 任何「我是主播」的标记 —— 所以只能靠 room.anchorUid / 本机登录 uid 认人。
     * 这一节就是把「认出来没有」两种结果都钉住。
     */
    seed()
    const streamer = ++uidSeq
    const mod = ++uidSeq
    const plain = ++uidSeq
    const low = ++uidSeq
    const okFan = ++uidSeq
    store.patch({ voicePolicy: { requireMedal: true, minMedalLevel: 5, cooldownMs: 1 }, room: { anchorUid: streamer } })
    const asMedal = (uid, content, medal) =>
      dispatchEvent({ type: 'danmaku', uid, username: '测试观众', content, medal, face: '', timestamp: Date.now() })

    replies.length = 0
    send(streamer, '#绑定 测试音色')
    await wait(800)
    ok('11a 主播没有粉丝牌也能换音色', bindings()[streamer] === 'prof_test', {
      bindings: bindings(),
      reply: replies[replies.length - 1],
    })

    replies.length = 0
    dispatchEvent({
      type: 'danmaku',
      uid: mod,
      username: '房管',
      content: '#绑定 测试音色',
      medal: null,
      isAdmin: true,
      face: '',
      timestamp: Date.now(),
    })
    await wait(800)
    ok('11b 房管没有粉丝牌也能换音色', bindings()[mod] === 'prof_test', {
      bindings: bindings(),
      reply: replies[replies.length - 1],
    })

    replies.length = 0
    send(plain, '#绑定 测试音色')
    await wait(800)
    ok('11c 普通观众没牌子被挡', bindings()[plain] === undefined, bindings())
    console.log(`        回执：${replies[replies.length - 1]}`)
    ok('11d 挡下时说明了门槛', String(replies[replies.length - 1] || '').includes('粉丝牌'), replies)

    replies.length = 0
    asMedal(low, '#绑定 测试音色', { name: '测试牌', level: 3, anchorName: '', color: 0 })
    await wait(800)
    ok('11e 牌子等级不足被挡', bindings()[low] === undefined, bindings())

    asMedal(okFan, '#绑定 测试音色', { name: '测试牌', level: 9, anchorName: '', color: 0 })
    await wait(800)
    ok('11f 牌子等级够就放行', bindings()[okFan] === 'prof_test', bindings())

    replies.length = 0
    send(streamer, '#删除音色')
    await wait(800)
    ok('11g 主播也能用删除音色（这条以前同样被门槛挡住）', bindings()[streamer] === undefined, {
      bindings: bindings(),
      reply: replies[replies.length - 1],
    })
  }

  console.log('\n[12] 主播 uid 还没认出来时，靠本机登录账号也能认（升级上来的老配置）')
  {
    seed()
    const own = ++uidSeq
    setOwnUid(own)
    store.patch({ voicePolicy: { requireMedal: true, minMedalLevel: 5, cooldownMs: 1 }, room: { anchorUid: 0 } })
    replies.length = 0
    send(own, '#绑定 测试音色')
    await wait(800)
    ok('12a 本机登录的那个号免检', bindings()[own] === 'prof_test', {
      bindings: bindings(),
      reply: replies[replies.length - 1],
    })
    const other = ++uidSeq
    send(other, '#绑定 测试音色')
    await wait(800)
    ok('12b 别的没牌子的观众还是被挡', bindings()[other] === undefined, bindings())
    setOwnUid(0)
    store.patch({ room: { anchorUid: 0 }, voicePolicy: { requireMedal: false } })
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
