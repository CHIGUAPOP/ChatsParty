'use strict'
/**
 * 「一键准备开播」的端到端验证。
 *
 * 为什么要有这个脚本：这个功能会**真的启动别的程序**，一旦顺序错、间隔没生效、
 * 或者「已经在跑的」判断失灵，用户桌上就会多出一堆重复打开的 OBS。
 * 单元测试只能验到「命令怎么拼」，验不了「到底有没有按这个顺序拉起来」。
 *
 * ⚠️ 关键约定：**测试全程只启动无害的假程序**（自己写的 .cmd），
 * 绝不启动真实的 OBS / VTube Studio / 直播姬 —— 那会把用户正在用的窗口再拉一份起来。
 * 真实扫描那一段是只读的，只读配置、只看 exe 在不在。
 *
 * 关于「已经在跑就跳过」：那一步要读进程列表（`tasklist /FO CSV /NH`）。
 * 有些环境会把这个命令拦掉，脚本会自己认出来并改成验「降级行为」——
 * 也就是**查不到的时候绝不能谎报「已在运行」**，宁可多启动一次。
 * 不依赖环境的版本另外用纯函数（`withRunning` / `shouldSkip`）固定住。
 *
 * 还有一处必须挡住的副作用：走 Steam 那条路最后是 `shell.openExternal('steam://...')`。
 * 脚本会把这一步接管掉（顺便就能断言 URL 拼得对不对），否则测试会真的去唤用户的 Steam。
 *
 * 用法（项目根目录，用 electron 的二进制跑）：
 *   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/e2e-launchpad.cjs
 * 或者：npm run e2e:launchpad
 *
 * 六节：
 *   [A] 真实扫描：扫到本机装的程序，而且是只读的
 *   [B] 启动顺序：勾选顺序 = 启动顺序
 *   [C] 间隔：设置的等待时间真的生效
 *   [D] 已经在跑的不重复启动（拿不到进程列表时验降级）
 *   [E] 边界：只有 appid 没 exe 的、彻底找不到的、乱填的 id、空清单
 *   [F] 要管理员权限的（直播姬）：走提权那条路，失败要如实报
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execFile } = require('node:child_process')
const electron = require('electron')
const { app, BrowserWindow } = electron

const ROOT = path.join(__dirname, '..')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-launchpad-'))
/** 假程序与标记文件放这里，测试完整个删掉 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lp-fakes-'))

/** 收走上几轮剩下的临时目录。**当前这一轮的两个都要留着**，否则刚建好就被自己删了 */
function sweepStale(keep) {
  let names = []
  try {
    names = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  const keepSet = new Set(keep.map((p) => path.join(os.tmpdir(), p)))
  for (const n of names) {
    if (!n.startsWith('cp-e2e-launchpad-') && !n.startsWith('cp-lp-fakes-')) continue
    const full = path.join(os.tmpdir(), n)
    if (keepSet.has(full)) continue
    try {
      fs.rmSync(full, { recursive: true, force: true })
    } catch {
      /* 还被占着就留给下一轮 */
    }
  }
}
sweepStale([path.basename(tmpUserData), path.basename(sandbox)])

app.setPath('userData', tmpUserData)
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('use-gl', 'swiftshader')
app.disableHardwareAcceleration()
process.env.CP_PROD = '1'
process.env.CP_E2E = '1'
// 叠加层端口也要错开：12450 上可能正跑着用户在直播用的那一份真实实例，
// 测试实例去占了它，之后真实实例会被挤到 12451，而 OBS 里写的还是 12450。
// 认这个变量的是 main.cjs 的 overlayPort()。
process.env.CP_OVERLAY_PORT = String(20000 + Math.floor(Math.random() * 20000))

const LP = require(path.join(ROOT, 'electron', 'launchpad.cjs'))

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
async function waitFor(fn, ms = 6000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await fn()) return true
    await wait(80)
  }
  return false
}

/** 现在有哪些进程在跑（小写名）。查不到返回 null —— 有些环境会拦 tasklist。
 *  这里刻意跟主进程一样走**异步** execFile：主进程就是这么查的，
 *  测试用另一条路径去探会出现「脚本说查不到、主进程其实查到了」的假象。 */
function processes() {
  return new Promise((resolve) => {
    try {
      execFile('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 8000 }, (err, out) =>
        resolve(err ? null : LP.parseTasklistCsv(out)),
      )
    } catch {
      resolve(null)
    }
  })
}

/**
 * 把系统「打开外部链接」这一步接管掉。
 *
 * 为什么必须接管：走 Steam 的那条路最后是 `shell.openExternal('steam://rungameid/...')`，
 * 不拦的话测试会**真的去唤用户的 Steam**，还可能弹出「应用不存在」的框。
 * 接管以后还多一个好处：能直接断言拼出来的 URL 对不对。
 */
const steamCalls = []
let steamPatchOk = false
try {
  electron.shell.openExternal = async (url) => {
    steamCalls.push(String(url))
    return true
  }
  steamPatchOk = true
} catch {
  /* 改不动就别在测试里走 Steam 分支，免得真去动用户的东西 */
}

/* --------------------------- 造几个无害的假程序 --------------------------- */

/** 这一轮的标记文件。每轮换一个新的，路径由命令行参数传给假程序 */
let MARK = path.join(sandbox, 'order-0.txt')
let runSeq = 0

/**
 * 造一个假程序：朝「第 1 个参数指的文件」追一行自己的字母 —— 谁先谁后一看便知。
 *
 * 目标文件**走参数、不写死在脚本里**，这一点是被逼出来的：
 * cmd.exe 从被 `spawn`、到真正读到脚本并执行，中间隔着几百毫秒（这台机器上就会）。
 * 写死在脚本里的话，上一轮还没起身的进程会读到改写后的内容，
 * 把行写进**下一轮**的文件 —— 读出来的顺序就成了随机的（实测到过 A,B,C,A,B）。
 * 参数是跟着命令行走的，进程一起来就定死了，改不了。
 */
function writeCmd(name, letter) {
  const p = path.join(sandbox, `${name}.cmd`)
  // 重定向写在前面：`echo A>>file` 对尾随空格的处理在不同 shell 下不一样
  fs.writeFileSync(p, `@echo off\r\n>>"%~1" echo ${letter}\r\n`, 'utf8')
  return p
}

const FAKE_A = writeCmd('fake-a', 'A')
const FAKE_B = writeCmd('fake-b', 'B')
const FAKE_C = writeCmd('fake-c', 'C')

const readMark = () =>
  fs.existsSync(MARK)
    ? fs
        .readFileSync(MARK, 'utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    : []

/** 开一轮新的观察：换一个新的标记文件，返回要传给假程序的参数 */
function armRun() {
  runSeq += 1
  MARK = path.join(sandbox, `order-${runSeq}.txt`)
  return [MARK]
}

const fake = (id, name, exe, args) => ({
  id,
  name,
  hint: '测试用',
  kind: 'custom',
  origin: 'custom',
  appid: '',
  exe,
  args,
  installed: true,
  exeMissing: false,
})

/** A/B/C 三个假程序，都指向本轮新开的标记文件 */
function fakesThisRun() {
  const args = armRun()
  return [
    fake('fake-a', '假程序 A', FAKE_A, args),
    fake('fake-b', '假程序 B', FAKE_B, args),
    fake('fake-c', '假程序 C', FAKE_C, args),
  ]
}

/** 只要 A 一个的那种 */
function fakeAThisRun() {
  return [fake('fake-a', '假程序 A', FAKE_A, armRun())]
}

const stub = (apps) => {
  LP.scanLaunchpad = () => ({ steamRoot: '', steamExe: '', libraries: [], errors: [], apps })
}

require(path.join(ROOT, 'electron', 'main.cjs'))

async function main() {
  let win = null
  await waitFor(async () => {
    win = BrowserWindow.getAllWindows()[0] || null
    return Boolean(win)
  })
  if (!win) throw new Error('主窗口没起来')
  await waitFor(() => win.webContents.executeJavaScript('1').then(() => true).catch(() => false))
  const ready = await waitFor(() =>
    win.webContents
      .executeJavaScript('Boolean(window.chatsparty && window.chatsparty.launchpad)')
      .then((v) => Boolean(v))
      .catch(() => false),
  )
  if (!ready) throw new Error('渲染层没拿到 launchpad 接口')

  /** 从渲染层走真 IPC —— 验的就是界面点下去那条路 */
  const scan = (opts) => win.webContents.executeJavaScript(`window.chatsparty.launchpad.scan(${JSON.stringify(opts || {})})`)
  const run = (payload) => win.webContents.executeJavaScript(`window.chatsparty.launchpad.run(${JSON.stringify(payload)})`)

  const procList = await processes()
  console.log(`\n本机进程查询：${procList ? `可用（${procList.size} 个）` : '不可用（会被降级处理）'}`)

  console.log('\n[A] 真实扫描：扫到本机装的程序，而且是只读的')
  {
    const r = await scan({ force: true })
    ok('A1 扫描成功', r.ok === true, r)
    ok('A2 认出了 Steam 安装位置', Boolean(r.steamRoot) && fs.existsSync(r.steamRoot), r.steamRoot)
    ok('A3 列出的库文件夹都真实存在', (r.libraries || []).every((p) => fs.existsSync(p)), r.libraries)
    console.log(`        扫到 ${r.apps.length} 个：${r.apps.map((a) => a.name).join(' / ') || '(无)'}`)

    const ids = r.apps.map((a) => a.id)
    ok('A4 每个条目字段齐全', r.apps.every((a) => a.id && a.name && a.origin && 'running' in a), r.apps)
    ok('A5 有可执行文件的都真的存在', r.apps.filter((a) => a.exe).every((a) => fs.existsSync(a.exe)))
    const steamOnes = r.apps.filter((a) => a.origin === 'steam')
    ok('A6 Steam 库里的都带上了 appid', steamOnes.every((a) => /^\d+$/.test(a.appid)), steamOnes.map((a) => [a.id, a.appid]))
    ok('A7 同一个程序不会列出两条', new Set(ids).size === ids.length, ids)
    // 查不到进程时必须说「不知道」，不能谎报成「已在运行」——
    // 谎报的后果是用户想开的程序根本没被启动，而且界面上看不出任何异常
    const flags = r.apps.map((a) => a.running)
    ok(
      procList ? 'A8 进程查得出来时 running 是确凿的 true/false' : 'A8 进程查不出来时不谎报（只会是 null，不会是 true）',
      procList ? flags.every((v) => typeof v === 'boolean') : flags.every((v) => v === null),
      { 进程查询可用: Boolean(procList), flags },
    )
    // 上面那条依赖本机到底查不查得动 tasklist，这条不依赖 ——
    // 直接把「查不到」这一路喂给纯函数，什么时候都要守住「不谎报」
    const unknown = LP.withRunning([{ id: 'x', exe: 'C:\\a\\b.exe' }], null)
    ok('A9 查不到进程表时 running 一律是 null（而不是 false）', unknown[0].running === null, unknown[0])
    ok(
      'A10 查得到、进程名对得上就报 true',
      LP.withRunning([{ id: 'x', exe: 'C:\\OBS\\bin\\64bit\\OBS64.exe' }], new Set(['obs64.exe']))[0].running === true,
    )
    // 进程名里可以有空格（VTube Studio.exe 就是）。挡掉空格的后果很具体：
    // 用户已经开着 VTS，再点一键开播会又拉起一个 —— 正是这功能最该避免的事
    ok(
      'A11 名字里带空格的程序也认得出来',
      LP.withRunning([{ id: 'v', exe: 'C:\\VTS\\VTube Studio.exe' }], new Set(['vtube studio.exe']))[0].running === true,
      Array.from(procList || []).filter((n) => n.includes(' ')),
    )
    ok('A12 没有 exe 的条目问不出「在不在跑」，只能是 null', LP.withRunning([{ id: 'y', exe: '' }], new Set(['a.exe']))[0].running === null)
  }

  console.log('\n[B] 启动顺序：勾选顺序就是启动顺序')
  {
    stub(fakesThisRun())

    // 留一点间隔：一堆进程同时起身时，谁先执行到写文件那一行是不确定的，
    // 而「按勾选顺序启动」正是靠间隔来兑现的（见 C 节）
    const r = await run({
      order: ['fake-b', 'fake-a', 'fake-c'],
      rescan: true,
      connect: false,
      skipRunning: false,
      gapMs: 500,
    })
    ok('B1 三个都报成已启动', r.ok && r.steps.filter((s) => s.status === 'started').length === 3, r.steps)
    // .cmd 是脚本、不是可执行映像，得由 cmd 代跑 —— 不处理的话表现就是「点了没反应」
    const got = await waitFor(() => readMark().length === 3, 6000)
    ok('B2 假程序真的被拉起来了', got, readMark())
    ok('B3 顺序跟勾选顺序一致', readMark().join('') === 'BAC', readMark())
    ok('B4 每一步都写明了怎么拉起来的', r.steps.every((s) => s.mode === 'exe' && s.message), r.steps)
    ok('B5 没勾自动连接时不会去连直播间', r.connect === null, r.connect)
    ok('B6 没用 Steam 协议去唤（都是直启）', steamCalls.length === 0, steamCalls)
  }

  console.log('\n[C] 间隔：设置的等待时间真的生效')
  {
    // 第一次：不留间隔，一堆进程同时起身，只测「快不快」
    stub(fakesThisRun())
    const fast = Date.now()
    await run({ order: ['fake-a', 'fake-b', 'fake-c'], rescan: true, connect: false, skipRunning: false, gapMs: 0 })
    const t0 = Date.now() - fast

    // 第二次：留 600ms 间隔，测「是不是真的等了」，顺便看顺序
    stub(fakesThisRun())
    const slow = Date.now()
    await run({ order: ['fake-a', 'fake-b', 'fake-c'], rescan: true, connect: false, skipRunning: false, gapMs: 600 })
    const t1 = Date.now() - slow

    console.log(`        无间隔 ${t0}ms / 有间隔 ${t1}ms`)
    // 三个程序之间有两个间隔，所以至少要慢出 1200ms 的一大半
    ok('C1 设了间隔就真的会等', t1 - t0 > 800, { t0, t1 })
    // run() 是在最后一个进程「被创建」时就返回的，它还得起身、读脚本、写文件，
    // 所以这里要等最后一行落笔，不能返回就读
    await waitFor(() => readMark().length >= 3, 5000)
    ok('C2 等了以后三行还是按顺序写进去的', readMark().join('') === 'ABC', readMark())
  }

  console.log('\n[D] 已经在跑的不重复启动')
  {
    // 这两条不依赖本机查不查得动 tasklist，任何时候都要成立 ——
    // 所以放在最前面，别让「环境拦了 tasklist」把这条纪律一起带偏
    ok(
      'D0 查不到进程表时绝不跳过（宁可多启动一次，也不能把程序悄悄咽掉）',
      LP.shouldSkip({ id: 'a', exe: 'C:\\OBS\\bin\\64bit\\obs64.exe' }, null) === false,
    )
    ok(
      'D0b 查得到、名字也对得上才跳',
      LP.shouldSkip({ id: 'a', exe: 'C:\\OBS\\bin\\64bit\\OBS64.exe' }, new Set(['obs64.exe'])) === true,
    )

    if (procList) {
      // 进程列表可用：拿「本进程自己」（electron.exe 一定在跑）当靶子。
      // 它会被判定为「已在运行」→ 跳过，所以**不会真的再起一个 Electron**，安全。
      stub([fake('fake-self', '本进程（一定在跑）', process.execPath)])
      const r = await run({ order: ['fake-self'], rescan: true, connect: false, skipRunning: true, gapMs: 0 })
      ok('D1 已经在跑的直接跳过，不重复启动', r.steps[0] && r.steps[0].status === 'skipped', r.steps)
      ok('D2 跳过了也会说明原因', (r.steps[0]?.message || '').includes('已经在运行'), r.steps[0])
      ok('D3 跳过不算失败', r.ok === true, r)
      ok('D4 界面能提前看到「已在运行」', (await scan({ force: true })).apps[0]?.running === true)

      // 对比组：没在跑的照常拉起
      stub(fakeAThisRun())
      const r2 = await run({ order: ['fake-a'], rescan: true, connect: false, skipRunning: true, gapMs: 0 })
      ok('D5 没在跑的照常启动', r2.steps[0] && r2.steps[0].status === 'started', r2.steps)
      ok('D6 没在跑的不谎报成「已在运行」', (r2.steps[0]?.message || '').indexOf('已经在运行') < 0, r2.steps[0])
    } else {
      // 这个环境查不到进程表：要守住的是**降级行为** —— 别把用户的程序悄悄咽掉
      stub(fakeAThisRun())
      const r = await run({ order: ['fake-a'], rescan: true, connect: false, skipRunning: true, gapMs: 0 })
      ok('D1 查不到进程表时不跳过，照常启动', r.steps[0] && r.steps[0].status === 'started', r.steps)
      ok('D2 不会谎报成「已在运行」', (r.steps[0]?.message || '').indexOf('已经在运行') < 0, r.steps[0])
      ok('D3 扫描结果里 running 是 null 而不是 false', (await scan({ force: true })).apps[0]?.running === null)
    }
  }

  console.log('\n[E] 边界：扫不到的、乱填的 id、空清单')
  {
    // 装在 Steam 库里、但我们的相对路径猜测没命中 —— appid 是好的。
    // Steam 认的是 appid、不是我们猜的路径，所以这种情况**交给 Steam 完全能起来**，
    // 报「失败」才是错的（用户会以为没启动，其实已经起来了）。
    const ghostSteam = {
      id: 'ghost-steam',
      name: '装了但没扫到 exe（有 appid）',
      hint: '',
      kind: 'capture',
      origin: 'steam',
      appid: '999',
      exe: '',
      nosteamArg: '',
      installed: true,
      exeMissing: true,
    }
    // 既没有 appid 也没有 exe：真的无从下手，必须明说
    const ghostDead = {
      id: 'ghost-dead',
      name: '彻底找不到的程序',
      hint: '',
      kind: 'custom',
      origin: 'custom',
      appid: '',
      exe: '',
      installed: true,
      exeMissing: true,
    }
    const apps = [...fakeAThisRun(), ghostSteam, ghostDead]
    // shell 没接管成功就不跑这条 —— 不能为了测一句话真去唤用户的 Steam
    stub(steamPatchOk ? apps : apps.filter((a) => a.id !== 'ghost-steam'))

    const order = steamPatchOk
      ? ['ghost-steam', 'no-such-id', 'ghost-dead', 'fake-a']
      : ['no-such-id', 'ghost-dead', 'fake-a']
    const r = await run({ order, rescan: true, connect: false, skipRunning: false, gapMs: 0 })

    ok('E1 乱填的 id 被忽略，不留一条空记录', r.steps.length === order.length - 1 && !r.steps.some((s) => s.id === 'no-such-id'), r.steps.map((s) => s.id))
    if (steamPatchOk) {
      ok(
        'E2 只有 appid、没扫到 exe 时交给 Steam（这不是失败）',
        r.steps[0] && r.steps[0].status === 'started' && r.steps[0].mode === 'steam',
        r.steps[0],
      )
      ok('E3 拼出来的正是官方协议 steam://rungameid/<appid>', steamCalls.includes('steam://rungameid/999'), steamCalls)
      ok('E4 交给了 Steam 也要说清楚「要等一会儿」', /Steam|steam/.test(r.steps[0]?.message || ''), r.steps[0]?.message)
    } else {
      ok('E2 shell 没能接管，跳过 Steam 分支（不碰用户的 Steam）', true)
      ok('E3 同上', true)
      ok('E4 同上', true)
    }

    const deadIdx = steamPatchOk ? 1 : 0
    ok('E5 既没 exe 也没 appid 的报失败', r.steps[deadIdx] && r.steps[deadIdx].status === 'failed', r.steps[deadIdx])
    ok('E6 失败的那条会说清是找不到可执行文件', /可执行文件|exe/i.test(r.steps[deadIdx]?.message || ''), r.steps[deadIdx]?.message)
    ok('E7 有失败时整体 ok=false', r.ok === false, r.ok)
    ok('E8 一条失败不影响后面继续跑', r.steps[r.steps.length - 1]?.status === 'started', r.steps[r.steps.length - 1])

    // 关了「走 Steam」以后，只有 appid、没有 exe 就真的没辙 —— 必须明说，不能假装启动
    const noSteam = await run({
      order: ['ghost-steam'],
      rescan: true,
      connect: false,
      skipRunning: false,
      useSteam: false,
      gapMs: 0,
    })
    ok(
      'E9 不走 Steam 又没扫到 exe 时明确报失败',
      steamPatchOk ? noSteam.steps[0] && noSteam.steps[0].status === 'failed' : noSteam.ok === false,
      noSteam.steps?.[0] || noSteam,
    )

    const empty = await run({ order: [], rescan: true, connect: false })
    ok('E10 一个都没勾就明说，不静默成功', empty.ok === false && String(empty.message).includes('还没选'), empty)

    stub(fakeAThisRun())
    const noRoom = await run({ order: ['fake-a'], rescan: true, connect: true, roomId: '', gapMs: 0 })
    ok('E11 没填房间号时程序照样拉起', noRoom.steps[0] && noRoom.steps[0].status === 'started', noRoom.steps[0])
    ok(
      'E12 没填房间号时跳过连接并说明原因',
      noRoom.connect && noRoom.connect.ok === false && noRoom.connect.message.includes('直播间号'),
      noRoom.connect,
    )

    stub(fakeAThisRun())
    const badPath = await run({ order: ['fake-a'], rescan: true, connect: false, gapMs: 999999 })
    ok('E13 离谱的间隔被夹到上限内', badPath.ok === true, badPath)
  }

  console.log('\n[F] 需要管理员权限的程序（直播姬那条路）')
  {
    // 用一个**不存在**的路径来验这条路：文件不存在时 Start-Process 会直接抛异常
    // 走 catch 分支，**不会弹 UAC** —— 所以这一节跑下来不会真启动任何东西，
    // 也不会在你屏幕中间冒出一个授权窗口。真实成功那一步只能手动验（弹窗要人点）。
    const ghost = {
      id: 'fake-admin',
      name: '假装要管理员的程序',
      hint: '测试用',
      kind: 'custom',
      origin: 'custom',
      appid: '',
      exe: path.join(sandbox, 'no-such-program.exe'),
      args: [],
      elevate: true,
      installed: true,
      exeMissing: false,
    }

    stub([ghost])
    const r = await run({ order: ['fake-admin'], rescan: true, connect: false, skipRunning: false, gapMs: 0 })
    ok('F1 标了要管理员的走的是启动那条路', r.steps[0] && r.steps[0].mode === 'exe', r.steps[0])
    // 关键：提权没成功必须**如实报失败**，绝不能因为「命令发出去了」就说启动成功
    ok('F2 提权没成功时如实报失败', r.steps[0] && r.steps[0].status === 'failed', r.steps[0])
    ok('F3 而且说明是授权那一步的事', /授权/.test(r.steps[0]?.message || ''), r.steps[0])
    ok('F4 有失败时整体 ok=false', r.ok === false, r)
    // 界面靠这个标记画「需管理员」徽章、并提前告诉用户会弹窗
    ok('F5 扫描结果里带着「要管理员」的标记', (await scan({ force: true })).apps[0]?.elevate === true)

    // 走 Steam 的那种不该被标：提权是 Steam 自己去办的事，跟咱们无关
    stub([{ ...ghost, id: 'fake-steam-admin', appid: '999999' }])
    const r2 = await run({
      order: ['fake-steam-admin'],
      rescan: true,
      connect: false,
      useSteam: true,
      skipRunning: false,
      gapMs: 0,
    })
    ok('F6 走 Steam 的不走提权那条路（交给 Steam）', r2.steps[0]?.status === 'started', r2.steps[0])
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
      await wait(200)
      for (const dir of [tmpUserData, sandbox]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
        } catch {
          /* 交给下次启动的 sweep */
        }
      }
      setTimeout(() => app.exit(fail ? 1 : 0), 200)
    }),
)
