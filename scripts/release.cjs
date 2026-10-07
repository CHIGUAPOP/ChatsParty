#!/usr/bin/env node
'use strict'
/**
 * 一键发布：打包免安装版 → 传到 GitHub Releases。
 *
 * 为什么要有这个脚本：以后每次发版都是同一套动作 —— 改版本号、构建、
 * 把 release/ 里那个 Portable.exe 传到 Release 上。手动做的话，
 * 最容易忘的是「改了 version 却没跟着改 tag」和「传错文件」。
 *
 * 用法（在项目根目录）：
 *   npm run release                  # 打包 + 发布
 *   npm run release -- --skip-build  # 只把现成的产物传上去（重传用）
 *   npm run release -- --draft       # 发成草稿，自己在网页上确认后再点发布
 *   npm run release -- --notes "..." # 自定义更新说明
 *   npm run release -- --file ../chatsparty/release/xxx.exe   # 传别处打好的包
 *   npm run release -- --dry-run     # 只打包、不上传
 *
 * 关于二进制放哪：**exe 一律进 Release，不进 git 仓库**。
 * 一个免安装版一百多 MB，而 git 的历史只增不减 —— 提交进去以后每次发版都留一份，
 * 仓库很快上 GB，任何人 clone 都要拖全部历史，而且**删不掉**（除非重写历史）。
 * 所以 `release/` 已经在 .gitignore 里，这个脚本只往 Release 传。
 *
 * 取 GitHub 凭据的次序（见 tokenOf）：环境变量 → gh 自己存的 → 本机 git 凭据。
 * 最后那条是这台机器上的现成路径：能 push 就说明有写权限，够发 Release 了。
 */
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
const TAG = `v${VERSION}`
const OUT_DIR = path.join(ROOT, 'release')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''
}
const SKIP_BUILD = has('--skip-build')
const DRAFT = has('--draft')
const DRY = has('--dry-run')

const log = (...a) => console.log(...a)
const die = (msg) => {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

/** 跑一个命令，收 stdout（失败就把 stderr 带出来） */
function run(cmd, args, opts = {}) {
  // 注意：异步 execFile **没有** input 选项（那是 execFileSync 才有的），
  // 要往 stdin 喂数据得自己写。`git credential fill` 就靠这个 —— 不给它喂，
  // 它会一直等输入，最后撞超时。
  const { input, ...rest } = opts
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: 'utf8', timeout: 300000, ...rest }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} ${args.join(' ')} 失败：${stderr || err.message}`))
      resolve(stdout || '')
    })
    if (input !== undefined && child.stdin) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

/** 跑一个命令并继承终端（打包时能看见进度） */
function runLive(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })
    c.on('error', reject)
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))))
  })
}

/* --------------------------- 找 gh 与凭据 --------------------------- */

/** gh 可能装在 PATH 里，也可能是我们下到本地的那个 zip 解压出来的 */
function ghCandidates() {
  return [
    process.env.GH_BIN,
    'gh',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'gh-cli', 'bin', 'gh.exe') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'GitHub CLI', 'gh.exe') : '',
  ].filter(Boolean)
}

async function findGh() {
  for (const c of ghCandidates()) {
    try {
      const v = await run(c, ['--version'])
      if (/gh version/.test(v)) return c
    } catch {
      /* 换下一个 */
    }
  }
  die(
    '找不到 gh（GitHub CLI）。装一个再来：\n' +
      '  winget install --id GitHub.cli --source winget\n' +
      '  或者把 gh.exe 放到 PATH 里，再用 GH_BIN 指定它的绝对路径。',
  )
}

/**
 * 拿一个能写仓库的 token。
 * `gh auth login` 会额外要求 read:org，而**发 Release 只要 repo 权限** ——
 * 所以哪怕 gh 说「没登录」，本机 git 凭据里那个 token 照样够用（能 push 就够）。
 */
async function tokenOf(gh) {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    const t = (await run(gh, ['auth', 'token'])).trim()
    if (t) return t
  } catch {
    /* gh 没登录，走下面 */
  }
  try {
    // 这一步是问系统凭据管理器要 token，不会弹窗、也不会打印出来
    const out = await run('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
    })
    const m = out.match(/^password=(.+)$/m)
    if (m) return m[1].trim()
  } catch {
    /* 没存凭据 */
  }
  die(
    '拿不到 GitHub 凭据。三选一：\n' +
      '  1) gh auth login（浏览器里授权一次）\n' +
      '  2) 设置环境变量 GH_TOKEN\n' +
      '  3) 先 git push 一次，把凭据存进系统凭据管理器',
  )
}

/* ------------------------------ 打包 ------------------------------ */

async function build() {
  if (SKIP_BUILD) return log('· 跳过打包（--skip-build）')
  log('· 构建渲染层 + 打包免安装版…')
  await runLive('npm', ['run', 'build'], { cwd: ROOT })
}

/** 找到要上传的那个 exe。产物名由 package.json 的 build.portable.artifactName 决定 */
function findArtifact() {
  // --file 用来传「包已经打好在别处」的情况：比如构建工作副本、发布交付仓库
  const given = val('--file')
  if (given) {
    const full = path.resolve(ROOT, given)
    if (!fs.existsSync(full)) die(`--file 指定的文件不存在：${given}`)
    return { name: path.basename(full), path: full, mb: (fs.statSync(full).size / 1048576).toFixed(1) }
  }
  if (!fs.existsSync(OUT_DIR)) die(`没有 ${path.relative(ROOT, OUT_DIR)}/ 目录，先跑一次 npm run build`)
  const files = fs.readdirSync(OUT_DIR).filter((f) => /\.exe$/i.test(f))
  if (!files.length) die(`${path.relative(ROOT, OUT_DIR)}/ 里没有 exe，打包没成功？`)
  // 认准当前版本号；找不到就退回体积最大的那个（最可能是安装包本体）
  const exact = files.find((f) => f.includes(VERSION) && /Portable/i.test(f))
  const pick =
    exact ||
    files.filter((f) => f.includes(VERSION)).sort((a, b) => size(b) - size(a))[0] ||
    files.sort((a, b) => size(b) - size(a))[0]
  const full = path.join(OUT_DIR, pick)
  return { name: pick, path: full, mb: (fs.statSync(full).size / 1048576).toFixed(1) }
}

const size = (f) => fs.statSync(path.join(OUT_DIR, f)).size

/* ------------------------------ 发布 ------------------------------ */

async function recentCommits(n = 8) {
  try {
    // 交付仓库里才有 .git；工作副本里没有，取不到就少写一段，不算错
    const out = await run('git', ['log', `-${n}`, '--pretty=- %s'], { cwd: ROOT })
    return out.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function notesFor(artifact) {
  const custom = val('--notes')
  if (custom) return custom

  const commits = await recentCommits()
  const lines = [
    `**免安装版**：下载下面的 \`${artifact.name}\`，双击即用，不需要安装。`,
    '',
    '首次启动会提示 Windows 防火墙放行 —— 叠加层要监听本地 12450 端口给 OBS 连，',
    '选「专用网络」允许即可。',
    '',
  ]
  if (commits.length) lines.push('### 本次包含', '', ...commits, '')
  lines.push('完整改动见 [提交记录](https://github.com/CHIGUAPOP/ChatsParty/commits/main)。')
  return lines.join('\n')
}

async function main() {
  log(`\nChatsParty 发布 · ${TAG}\n`)
  const gh = await findGh()
  const token = await tokenOf(gh)
  const env = { ...process.env, GH_TOKEN: token }

  await build()
  const artifact = findArtifact()
  log(`· 产物：${artifact.name}（${artifact.mb} MB）`)

  if (DRY) return log('· --dry-run：到此为止，没有上传')

  const exists = await run(gh, ['release', 'view', TAG], { env }).then(
    () => true,
    () => false,
  )

  if (exists) {
    log(`· ${TAG} 已经存在，改为覆盖上传附件`)
    await runLive(gh, ['release', 'upload', TAG, artifact.path, '--clobber'], { env })
  } else {
    const notes = await notesFor(artifact)
    log(`· 新建 Release ${TAG}${DRAFT ? '（草稿）' : ''}`)
    const args = ['release', 'create', TAG, artifact.path, '--title', `ChatsParty ${TAG}`, '--notes', notes]
    if (DRAFT) args.push('--draft')
    await runLive(gh, args, { env })
  }

  const url = (await run(gh, ['release', 'view', TAG, '--json', 'url', '-q', '.url'], { env })).trim()
  log(`\n✓ 发布完成：${url}\n`)
}

main().catch((e) => die(e.message))
