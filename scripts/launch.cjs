'use strict'
/**
 * 一键启动器
 *   node scripts/launch.cjs          # 生产模式：必要时构建渲染层，然后直接启动 Electron
 *   node scripts/launch.cjs --dev    # 开发模式：起 Vite 开发服务器 + Electron（改代码热更新）
 *   node scripts/launch.cjs --build  # 只构建，不启动
 *
 * 会自动完成：依赖检查 → 缺失则安装（走国内镜像）→ 构建渲染层 → 启动应用
 */
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const VITE_PORT = 5180
const MIRROR = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
}

const args = process.argv.slice(2)

/** 传给 Electron 自己的额外参数（调试用，平时为空） */
function electronArgs() {
  const port = Number(process.env.CP_REMOTE_DEBUG || 0)
  return port > 0 ? [`--remote-debugging-port=${port}`] : []
}
const MODE = args.includes('--dev') ? 'dev' : args.includes('--build') ? 'build' : 'prod'

const log = (...a) => console.log('[ChatsParty]', ...a)
const step = (n, total, text) => log(`(${n}/${total}) ${text}`)

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...(opts.env || {}) },
  })
  return r.status === 0
}

/* ---------- 1. 定位 electron 可执行文件 ---------- */
function findElectron() {
  const base = path.join(ROOT, 'node_modules', 'electron')
  const txt = path.join(base, 'path.txt')
  if (fs.existsSync(txt)) {
    const rel = fs.readFileSync(txt, 'utf8').trim()
    for (const p of [
      path.join(base, 'dist', rel),
      path.join(base, rel),
    ]) {
      if (fs.existsSync(p)) return p
    }
  }
  const exe = path.join(base, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  return fs.existsSync(exe) ? exe : null
}

/* ---------- 2. 依赖检查 / 安装 ---------- */
function ensureDeps() {
  const needInstall =
    !fs.existsSync(path.join(ROOT, 'node_modules')) ||
    !fs.existsSync(path.join(ROOT, 'node_modules', 'electron')) ||
    !fs.existsSync(path.join(ROOT, 'node_modules', 'vite')) ||
    !findElectron()

  if (!needInstall) return true

  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    step(1, 3, '首次运行：正在安装依赖（约 1-3 分钟，走国内镜像）...')
  } else {
    step(1, 3, '依赖不完整：正在修复安装...')
  }
  const ok = run('npm', ['install', '--no-audit', '--no-fund'], { env: MIRROR })
  if (!ok) {
    console.error('[ChatsParty] 依赖安装失败。请检查网络，或手动执行：npm install')
    return false
  }
  if (!findElectron()) {
    console.error('[ChatsParty] Electron 二进制缺失，请手动执行：npm install')
    return false
  }
  return true
}

/* ---------- 3. 构建渲染层 ---------- */
function rendererOutdated() {
  const out = path.join(ROOT, 'dist-renderer', 'index.html')
  if (!fs.existsSync(out)) return true
  const outMtime = fs.statSync(out).mtimeMs
  let newest = 0
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else newest = Math.max(newest, fs.statSync(p).mtimeMs)
    }
  }
  for (const d of ['src', 'overlay']) {
    const abs = path.join(ROOT, d)
    if (fs.existsSync(abs)) walk(abs)
  }
  if (fs.existsSync(path.join(ROOT, 'index.html'))) {
    newest = Math.max(newest, fs.statSync(path.join(ROOT, 'index.html')).mtimeMs)
  }
  return newest > outMtime
}

function ensureBuild() {
  if (MODE === 'dev') return true
  if (!rendererOutdated()) {
    step(2, 3, '渲染层已是最新，跳过构建')
    return true
  }
  step(2, 3, '正在构建界面...')
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!run(process.execPath, [viteBin, 'build'])) {
    console.error('[ChatsParty] 界面构建失败')
    return false
  }
  return true
}

/* ---------- 4. 等待端口 ---------- */
// Windows 上 localhost 可能只解析到 ::1，所以三个地址都试
const PROBE_HOSTS = ['127.0.0.1', '::1', 'localhost']

function probe(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host)
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {}
      resolve(ok)
    }
    sock.setTimeout(1200)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

async function waitForPort(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const results = await Promise.all(PROBE_HOSTS.map((h) => probe(h, port)))
    if (results.some(Boolean)) return
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('Vite 开发服务器启动超时')
}

/* ---------- 5. 启动 ---------- */
async function main() {
  log(`工作目录：${ROOT}`)
  log(`启动模式：${MODE === 'dev' ? '开发（热更新）' : MODE === 'build' ? '仅构建' : '标准'}`)

  if (!ensureDeps()) process.exit(1)

  if (MODE === 'build') {
    if (!ensureBuild()) process.exit(1)
    log('构建完成，输出目录：dist-renderer')
    return
  }

  if (!ensureBuild()) process.exit(1)

  const electronBin = findElectron()
  const cleanEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE // 否则 Electron 会退化成纯 Node，不弹窗

  const children = []
  const shutdown = () => {
    for (const c of children) {
      try {
        c.kill()
      } catch {}
    }
  }
  process.on('SIGINT', () => {
    shutdown()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    shutdown()
    process.exit(0)
  })

  if (MODE === 'dev') {
    const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
    let vite = null
    // 端口已被占用（多半是上一次没关干净）就直接复用，避免重复起服务
    const alreadyUp = (await Promise.all(PROBE_HOSTS.map((h) => probe(h, VITE_PORT)))).some(Boolean)
    if (alreadyUp) {
      step(3, 3, `检测到 ${VITE_PORT} 端口已有开发服务器，直接复用`)
    } else {
      vite = spawn(process.execPath, [viteBin], { cwd: ROOT, stdio: 'inherit' })
      children.push(vite)
      vite.on('exit', (code) => {
        if (code !== 0 && code != null) log(`Vite 退出，代码 ${code}`)
      })
      try {
        await waitForPort(VITE_PORT)
      } catch (e) {
        console.error('[ChatsParty]', e.message)
        vite.kill()
        process.exit(1)
      }
    }
    step(3, 3, '启动窗口...')
    const electron = spawn(electronBin, ['.'], { cwd: ROOT, stdio: 'inherit', env: cleanEnv })
    children.push(electron)
    electron.on('exit', (code) => {
      if (vite) vite.kill()
      process.exit(code == null ? 0 : code)
    })
  } else {
    step(3, 3, '启动窗口...')
    // CP_REMOTE_DEBUG=9223 会开 CDP，方便用脚本连进来点界面（排查「改了没生效」这类问题）
    const electron = spawn(electronBin, ['.', ...electronArgs()], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...cleanEnv, CP_PROD: '1' },
    })
    children.push(electron)
    electron.on('exit', (code) => process.exit(code == null ? 0 : code))
  }
}

main().catch((e) => {
  console.error('[ChatsParty] 启动失败：', e)
  process.exit(1)
})
