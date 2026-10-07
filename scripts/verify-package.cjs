'use strict'
/**
 * 发版前的最后一道关：验证打包出来的免安装版**真的能启动**。
 *
 * 为什么需要它：`npm run build` 说「done」不代表双击能跑 —— 打错文件、漏了资源、
 * 或者 Electron 以纯 Node 模式起来，构建日志里全都看不出来。等到用户下载下来
 * 双击没反应才发现，就太晚了。
 *
 * 怎么判断「起来了」而不去翻进程表（有些环境 tasklist 会被安全策略拦掉）：
 * 主进程启动成功的话，叠加层会在 CP_OVERLAY_PORT 上监听 —— 那个端口能连上，
 * 就说明 Electron 起来了、main.cjs 跑通了、附带的服务也拉起来了。
 *
 * 用法：
 *   npm run verify:package                    # 验 release/ 里的免安装版
 *   npm run verify:package -- release/x.exe   # 验指定的包
 *
 * 隔离措施（三件一起上，防止动到用户真实使用中的那套）：
 *   1. APPDATA 指向临时目录 → userData 跟着走，读不到真实配置（不会自动连直播间）
 *   2. CP_OVERLAY_PORT 随机 → 不去抢 12450
 *   3. CP_E2E=1 → 走测试分支，不碰直播间
 * 跑完无论成败都强制结束 ChatsParty 进程，绝不留一个卡住的窗口。
 */
const { execFile, spawn } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const PORT = 30000 + Math.floor(Math.random() * 5000)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-pkgtest-'))
const HARD_LIMIT = 90000

/** 默认验 release/ 里的免安装版；也可以直接把包路径当参数传进来 */
function findExe() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('-'))
  if (arg) return path.resolve(ROOT, arg)
  const dir = path.join(ROOT, 'release')
  if (!fs.existsSync(dir)) return ''
  const hit = fs.readdirSync(dir).filter((f) => /\.exe$/i.test(f) && /Portable/i.test(f))
  return hit.length ? path.join(dir, hit[0]) : ''
}

const EXE = findExe()
if (!EXE || !fs.existsSync(EXE)) {
  console.error('✗ 找不到要验证的包。先跑 npm run build，或把包路径当参数传进来。')
  process.exit(1)
}

const kill = () =>
  new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command', 'Get-Process ChatsParty -ErrorAction SilentlyContinue | Stop-Process -Force; "ok"'],
      { timeout: 20000 },
      () => resolve(),
    )
  })

function probe(port, timeoutMs) {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      const s = net.connect({ port, host: '127.0.0.1' })
      s.setTimeout(600)
      s.on('connect', () => {
        s.destroy()
        resolve(Date.now() - t0)
      })
      const retry = () => {
        s.destroy()
        if (Date.now() - t0 > timeoutMs) return resolve(-1)
        setTimeout(tick, 500)
      }
      s.on('timeout', retry)
      s.on('error', retry)
    }
    tick()
  })
}

const hardStop = setTimeout(async () => {
  console.log('\n✗ 超时（90 秒还没连上端口），强制收尾')
  await kill()
  process.exit(1)
}, HARD_LIMIT)

async function main() {
  console.log(`产物：${path.basename(EXE)}（${(fs.statSync(EXE).size / 1048576).toFixed(1)} MB）`)
  console.log(`隔离：userData→临时目录，叠加层端口→${PORT}\n`)

  const t0 = Date.now()
  // 这两个变量必须清掉，否则 Electron 根本不把自己当 GUI 程序：
  //  - ELECTRON_RUN_AS_NODE=1 会让它退化成纯 Node，main.cjs 被当普通脚本跑 ——
  //    不开窗口、不起服务，表现就是「双击了没反应」。有些 shell 里它默认就是 1，
  //    所有 e2e 都要 `env -u ELECTRON_RUN_AS_NODE` 也是这个原因。
  //  - NODE_OPTIONS 可能被注入语言 shim，Electron 去加载它只会添乱。
  const env = {
    ...process.env,
    APPDATA: TMP,
    LOCALAPPDATA: TMP,
    CP_OVERLAY_PORT: String(PORT),
    CP_E2E: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS

  const child = spawn(EXE, [`--user-data-dir=${TMP}`], { detached: true, stdio: 'ignore', env })
  child.on('error', (e) => console.log('  启动报错：' + e.message))
  child.unref()

  const took = await probe(PORT, 60000)
  clearTimeout(hardStop)
  await kill()

  if (took < 0) {
    console.log('✗ 60 秒内叠加层端口没起来 —— 这个包跑不起来，别发出去')
    process.exit(1)
  }
  console.log(`✓ 起来了：解压 + 启动一共 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`)
  console.log(`✓ 叠加层在 ${PORT} 上正常监听（说明主进程、内置服务都跑通了）`)
  console.log('✓ 已强制结束，没有留下窗口')
}

main()
  .catch((e) => {
    console.log('✗ ' + e.message)
    process.exit(1)
  })
  .finally(() => {
    try {
      fs.rmSync(TMP, { recursive: true, force: true })
    } catch {
      /* 被占着就留给系统清 */
    }
  })
