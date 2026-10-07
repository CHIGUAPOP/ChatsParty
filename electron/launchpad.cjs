'use strict'

/**
 * 「一键准备开播」的纯逻辑家：找程序、算怎么拉起、判断是不是已经开着。
 *
 * 这里**不 require electron** —— 扫描、解析、命令构造全是纯逻辑，
 * `scripts/smoke.cjs` 能直接拿去测（跟 speech-rules.cjs / voice-pick.cjs 一个路子）。
 * 真正动手（spawn / openExternal）留在 main.cjs。
 *
 * 为什么不能把路径写死：
 *  - Steam 的安装位置、库文件夹（libraryfolders.vdf）都因人而异，机器上可能有好几个库；
 *  - 程序装在哪个库由 appmanifest_<appid>.acf 决定，不能按 Steam\steamapps\common 硬猜；
 *  - 直播姬那种「启动器 + 版本子目录」的结构，版本号还会一直往上走。
 * 所以一律**现扫**，扫到什么算什么，扫不到就交给用户在界面上手补。
 *
 * 官方依据（都查过）：
 *  - Steam：`steam.exe -applaunch <appid>` 与 `steam://rungameid/<id>`
 *    （Valve Developer Community: Command line options (Steam) / Steam browser protocol）；
 *    库路径来自 `libraryfolders.vdf`，每个库的 `appmanifest_*.acf` 里有 appid/name/installdir。
 *  - OBS：`--startstreaming` / `--profile` / `--collection` 等是官方启动参数，而且
 *    **Windows 下必须把工作目录设成 obs64.exe 所在目录**（obsproject.com/kb/launch-parameters）。
 *  - VTube Studio：官方只有 WebSocket API，没有启动参数，只能直接拉起来。
 *  - 哔哩哔哩直播姬：没有公开的命令行参数文档，只能拉起来。
 */

const fs = require('node:fs')
const path = require('node:path')

/* ------------------------------- VDF 解析 ------------------------------- */

/**
 * 读一个带引号的 token。VDF 里 `\\` 是反斜杠本身、`\"` 是引号，
 * 其余的 `\x` 原样留着（Windows 路径手写成单反斜杠的情况并不少见）。
 */
function readQuoted(src, at) {
  if (src[at] !== '"') return null
  let out = ''
  let i = at + 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      const n = src[i + 1]
      if (n === '\\' || n === '"') {
        out += n
        i += 2
        continue
      }
      out += c
      i += 1
      continue
    }
    if (c === '"') return { value: out, next: i + 1 }
    out += c
    i += 1
  }
  // 引号没闭合：把读到的当值用，别把整份文件判死
  return { value: out, next: i }
}

/**
 * Valve KeyValues（VDF）解析。只认我们需要的那点语法：
 * `"键" "值"`、`"键" { ... }`、`//` 注释、BOM。
 * 认不出来的字节直接跳过 —— 一个怪字符不该毁掉整份解析。
 */
function parseVdf(text) {
  const src = String(text == null ? '' : text)
  const root = {}
  const stack = [root]
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\uFEFF' || c === '\u0000') {
      i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (c === '}') {
      if (stack.length > 1) stack.pop()
      i += 1
      continue
    }
    if (c !== '"') {
      i += 1
      continue
    }
    const key = readQuoted(src, i)
    if (!key) break
    i = key.next
    let j = i
    while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r' || src[j] === '\n')) j += 1
    if (src[j] === '{') {
      const obj = {}
      stack[stack.length - 1][key.value] = obj
      stack.push(obj)
      i = j + 1
      continue
    }
    if (src[j] === '"') {
      const val = readQuoted(src, j)
      if (!val) break
      // 同名键重复出现时后者覆盖前者 —— 跟 Valve 自己的行为一致
      stack[stack.length - 1][key.value] = val.value
      i = val.next
      continue
    }
    i = j
  }
  return root
}

/**
 * 从 libraryfolders.vdf 里取出所有库路径。两种格式都要认：
 *   新（Steam 1.0 之后）："0" { "path" "C:\\Program Files (x86)\\Steam" ... }
 *   老（更早的版本）：    "1" "D:\\Games"
 * 老格式里还混着 `TimeNextStatsReport` / `ContentStatsID` 这种非数字键，靠「键是纯数字」滤掉。
 */
function libPathsFrom(vdf) {
  const node = vdf && (vdf.libraryfolders || vdf.LibraryFolders)
  const table = node && typeof node === 'object' ? node : vdf
  const out = []
  if (!table || typeof table !== 'object') return out
  for (const key of Object.keys(table)) {
    const v = table[key]
    if (typeof v === 'string') {
      if (/^\d+$/.test(key) && v) out.push(v)
    } else if (v && typeof v === 'object') {
      const p = typeof v.path === 'string' ? v.path : typeof v.Path === 'string' ? v.Path : ''
      if (p) out.push(p)
    }
  }
  return out
}

/** 单个 appmanifest_<appid>.acf → 我们要的那几个字段 */
function parseAppManifest(text, fallbackAppid = '') {
  const vdf = parseVdf(text)
  const st = (vdf && (vdf.AppState || vdf.appstate)) || {}
  const str = (v) => (v == null ? '' : String(v))
  return {
    appid: str(st.appid || st.appID || st.AppID || fallbackAppid),
    name: str(st.name),
    installdir: str(st.installdir),
    // 4 = 完整安装。别的值（比如 1026）说明还没装完/待更新
    stateFlags: Number(st.StateFlags) || 0,
    sizeOnDisk: Number(st.SizeOnDisk) || 0,
    lastUpdated: Number(st.LastUpdated) || 0,
  }
}

/* ----------------------------- 版本目录挑选 ----------------------------- */

function versionKey(v) {
  return String(v)
    .split(/[^\d]+/)
    .filter((s) => s !== '')
    .map((s) => Number(s))
}

/**
 * 版本号比较。**必须按数字逐段比**，不能拿字符串比 ——
 * 字符串会认为 "7.9.1" 比 "7.64.0" 新，而直播姬的版本正好会走到这一步。
 */
function cmpVersion(a, b) {
  const x = versionKey(a)
  const y = versionKey(b)
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) {
    const l = i < x.length ? x[i] : 0
    const r = i < y.length ? y[i] : 0
    if (l !== r) return l - r
  }
  return 0
}

/** 挑版本号最大的那个名字。非版本的（比如 "livehime.exe"）排最后 */
function pickLatestVersion(names) {
  const list = (Array.isArray(names) ? names : []).filter(Boolean).map(String)
  if (!list.length) return ''
  return list.slice().sort((a, b) => cmpVersion(b, a))[0]
}

/* --------------------------- 「已经在跑了吗」 --------------------------- */

/**
 * 该不该跳过这个程序。
 *
 * 判断只看「进程名对不对得上」，所以 **查不到进程列表时一律返回 false** ——
 * 宁可多启动一次，也不能因为查不到就把用户想开的程序悄悄咽掉。
 * （OBS 被重复启动只是弹个警告框，用户还能自己关；而「点了没反应」是查不出来的。）
 *
 * @param {object} entry 扫描出来（或用户手补）的程序条目
 * @param {Set<string>|null} running 正在运行的进程名，全小写。null = 没查出来
 */
function shouldSkip(entry, running) {
  if (!running || typeof running.has !== 'function') return false
  const exe = entry && entry.exe ? String(entry.exe) : ''
  if (!exe) return false
  return running.has(path.basename(exe).toLowerCase())
}

/**
 * 给扫描结果附上「是不是已经在跑」，界面直接拿这个字段显示。
 *
 * `running` 为 null（= 进程表没查出来）时，每个条目的 running 也一律是 **null**，
 * 表示「不知道」，而不是 false。这个区分很要紧：false 会被界面翻译成「没在跑」，
 * 用户看到的是个确凿的结论，而我们其实什么都没查到。
 */
function withRunning(apps, running) {
  return (Array.isArray(apps) ? apps : []).map((a) => {
    const base = a && a.exe ? path.basename(String(a.exe)).toLowerCase() : ''
    const known = Boolean(running) && typeof running.has === 'function'
    return { ...a, running: known && base ? running.has(base) : null }
  })
}

/**
 * 解析 `tasklist /FO CSV /NH` 的输出，给出正在运行的进程名（小写）。
 * 用 CSV 而不是默认的表格格式：表格那版的分隔是给中文列宽算的，
 * 而且表头会随系统语言变，CSV 稳得多。
 */
function parseTasklistCsv(text) {
  const out = new Set()
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const m = line.match(/^\s*"([^"]+)"/)
    if (!m) continue
    const name = m[1].trim().toLowerCase()
    // 只挡非 ASCII（「信息: 没有运行的任务匹配指定标准。」这类本地化提示）。
    // **不能顺手把空格也挡掉** —— 进程名里本来就可以有空格，「VTube Studio.exe」就是。
    // 挡掉它的后果很具体：用户已经开着 VTS，再点一键开播会又拉起一个，
    // 正好是这个功能最该避免的事，而且界面上完全看不出异常（会显示成「已启动」）。
    if (name && /^[\x20-\x7e]+$/.test(name)) out.add(name)
  }
  return out
}

/* ------------------------------ 已知程序表 ------------------------------ */

/**
 * Steam 库里的直播相关程序。
 * `rel` 是在 `steamapps/common/<installdir>` 下面按顺序试的相对路径。
 * `appid` 只是**辅助匹配**用的：真扫的时候以 appmanifest 里读到的为准，
 * 万一 Valve 改了 appid 也能靠名字认出来（反过来也一样）。
 */
const STEAM_APPS = [
  {
    id: 'obs',
    name: 'OBS Studio',
    kind: 'capture',
    hint: '直播推流 / 录制',
    appid: '1905180',
    nameRe: /obs\s*studio/i,
    rel: ['bin/64bit/obs64.exe', 'bin/32bit/obs32.exe', 'obs64.exe'],
    // OBS 官方启动参数（先留着，界面上按需开）
    startArgs: { streaming: '--startstreaming', recording: '--startrecording', tray: '--minimize-to-tray' },
  },
  {
    id: 'vts',
    name: 'VTube Studio',
    kind: 'avatar',
    hint: 'Live2D 虚拟形象',
    appid: '1325860',
    nameRe: /vtube\s*studio/i,
    rel: ['VTube Studio.exe'],
    // 官方自带的 start_without_steam.bat 就是这么写的：绕过 Steam 时带上 -nosteam
    nosteamArg: '-nosteam',
  },
  {
    id: 'vbridger',
    name: 'VBridger',
    kind: 'tracking',
    hint: 'VTube Studio 的面部捕捉',
    appid: '1898830',
    nameRe: /vbridger/i,
    rel: ['VBridger.exe'],
    nosteamArg: '-nosteam',
  },
]

/** 不在 Steam 里的常见直播软件。probe(env) 返回候选可执行文件（按优先级） */
const EXTERNAL_APPS = [
  {
    id: 'livehime',
    name: '哔哩哔哩直播姬',
    kind: 'capture',
    hint: 'B站官方直播工具',
    // 实测：livehime.exe（启动器和版本目录里那份都是）的内嵌 manifest 写着
    // requestedExecutionLevel level="requireAdministrator"。普通权限直接 spawn 会被
    // Windows 挡在 740，所以必须走提权那条路 —— 启动时会弹一次 UAC。
    elevate: true,
    probe: (env) => {
      const roots = [path.join(pfOf(env), 'bililive', 'livehime')]
      const out = []
      for (const root of roots) {
        // 启动器是官方入口，会自动拉起对应的版本目录 —— 优先用它
        out.push({ exe: path.join(root, 'livehime.exe'), root, role: 'launcher' })
        // 兜底：直接把版本目录里的主程序拉起来
        const versions = readSubDirs(root)
          .filter((n) => /^\d+(\.\d+)+$/.test(n))
          .filter((n) => exists(path.join(root, n, 'livehime.exe')))
        const latest = pickLatestVersion(versions)
        if (latest) out.push({ exe: path.join(root, latest, 'livehime.exe'), root, role: 'version', version: latest })
      }
      return out
    },
  },
  {
    id: 'obs-standalone',
    name: 'OBS Studio（独立安装）',
    kind: 'capture',
    hint: '没走 Steam 装的 OBS',
    probe: (env) => [
      { exe: path.join(pfOf(env), 'obs-studio', 'bin', '64bit', 'obs64.exe'), role: 'standalone' },
      { exe: path.join(pf86Of(env), 'obs-studio', 'bin', '64bit', 'obs64.exe'), role: 'standalone' },
    ],
  },
  {
    id: 'voicemeeter',
    name: 'Voicemeeter',
    kind: 'audio',
    hint: '虚拟调音台（VB-Audio）',
    probe: (env) => [
      { exe: path.join(pf86Of(env), 'VB', 'Voicemeeter', 'voicemeeter.exe'), role: 'standalone' },
      { exe: path.join(pf86Of(env), 'VB', 'Voicemeeter', 'voicemeeter8.exe'), role: 'standalone' },
      { exe: path.join(pfOf(env), 'VB', 'Voicemeeter', 'voicemeeter.exe'), role: 'standalone' },
    ],
  },
  {
    id: 'vbcable',
    name: 'VB-Audio Virtual Cable',
    kind: 'audio',
    hint: '虚拟声卡（装的是驱动，一般没有主程序）',
    probe: (env) => [
      { exe: path.join(pf86Of(env), 'VB', 'CABLE', 'VBCABLE_ControlPanel.exe'), role: 'standalone' },
      { exe: path.join(pfOf(env), 'VB', 'CABLE', 'VBCABLE_ControlPanel.exe'), role: 'standalone' },
    ],
  },
]

/* --------------------------- 扫盘要用的小工具 --------------------------- */

function pfOf(env) {
  return env['ProgramFiles'] || 'C:\\Program Files'
}
function pf86Of(env) {
  return env['ProgramFiles(x86)'] || pfOf(env)
}

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function readSubDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/**
 * Steam 根目录的候选清单。不查注册表（`reg.exe` 在很多环境下会被安全策略拦，
 * 而且还要处理 32/64 位两套键），改成按常见位置逐个探 —— 反正一次 existsSync 很便宜。
 */
function steamRootCandidates(env = process.env, extra = []) {
  const out = []
  const push = (p) => {
    if (!p) return
    const n = path.normalize(String(p))
    if (n && !out.includes(n)) out.push(n)
  }
  push(path.join(pf86Of(env), 'Steam'))
  push(path.join(pfOf(env), 'Steam'))
  if (env.LOCALAPPDATA) push(path.join(env.LOCALAPPDATA, 'Steam'))
  for (const d of 'CDEFGH') {
    push(`${d}:\\Steam`)
    push(`${d}:\\SteamLibrary`)
    push(`${d}:\\Games\\Steam`)
    push(`${d}:\\Games\\SteamLibrary`)
  }
  for (const p of extra) push(p)
  return out
}

/* ------------------------------ 需要管理员权限 ------------------------------ */

/**
 * 这个程序是不是得用管理员权限开。
 *
 * 走 Steam 的话是 Steam 去拉它，提权那一步不归咱们管 —— 所以只看「要直启」这一支。
 */
function needsElevation(entry, useSteam) {
  if (!entry || !entry.elevate) return false
  if (useSteam !== false && String(entry.appid || '').trim()) return false
  return true
}

/**
 * 把一组参数拼成 Windows 命令行里的那一段（该引的引上）。
 *
 * 为什么要自己拼：PowerShell 的 `Start-Process -ArgumentList` 收到数组时是
 * **用空格 join 完直接交出去**的，元素里的空格不会自动加引号 ——
 * 参数里只要带一个路径就会散架。
 */
function winArgv(args) {
  return (Array.isArray(args) ? args : [])
    .filter(Boolean)
    .map(String)
    .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ')
}

/** PowerShell 单引号字符串。里面只有一条转义规则：单引号写两遍 */
function psQuote(s) {
  return `'${String(s == null ? '' : s).replace(/'/g, "''")}'`
}

/**
 * 需要管理员权限的程序怎么拉起来。
 *
 * Windows 不允许普通权限的进程静默创建一个要求提升的进程 ——
 * `CreateProcess` 直接返回 `ERROR_ELEVATION_REQUIRED`（740）。所以这里没有别的办法，
 * 只能走 ShellExecute 的 `runas` 动作，也就是让系统弹一次 UAC 请用户点「是」。
 * PowerShell 的 `Start-Process -Verb RunAs` 是这条路上最省事的现成入口，
 * 系统自带，不用引 native 模块。
 *
 * 返回值里那个 `wait: true` 是重点：这个进程**要等**。等的不是直播姬退出
 * （它会一直开着），而是 PowerShell 把 UAC 那一下走完 —— 用户点「否」会拿到
 * 非 0 退出码，界面才能如实说「没起来」，而不是骗人地说启动成功。
 */
function elevateCommand(plan = {}) {
  const exe = String(plan.exe || '')
  const dir = plan.cwd || (exe ? path.dirname(exe) : '')
  const argv = winArgv(plan.args)
  // 注意 `$ErrorActionPreference='Stop'` 后面这个分号：PowerShell 里两条语句要么换行、
  // 要么用分号隔开，少一个它就是「字符串后面跟了个 try」——直接 ParserError。
  // 别改成把整串 join('; ')：`}` 和 `catch` 之间不能有分号。
  const line =
    `$ErrorActionPreference=${psQuote('Stop')}; ` +
    [
      'try {',
      `Start-Process -FilePath ${psQuote(exe)}`,
      dir ? `-WorkingDirectory ${psQuote(dir)}` : '',
      argv ? `-ArgumentList ${psQuote(argv)}` : '',
      '-Verb RunAs',
      '} catch { exit 1 }',
    ]
      .filter(Boolean)
      .join(' ')
  return {
    exe: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', line],
    wait: true,
    label: `以管理员身份启动 ${path.basename(exe) || exe}`,
  }
}

/**
 * 这次失败是不是「它要管理员权限」。
 *
 * 740 到了 libuv 手里会变成 `spawn UNKNOWN`（errno -4094），有时候又是
 * EPERM / EACCES —— 三种都得认。不认的话，用户手补进来的程序会卡在
 * 「点了没反应」，而日志里只有一句看不懂的 UNKNOWN。
 */
function looksLikeElevationError(err) {
  const e = err || {}
  const code = String(e.code || '')
  const errno = typeof e.errno === 'number' ? e.errno : 0
  const msg = String(e.message || e || '')
  if (code === 'EPERM' || code === 'EACCES') return true
  if (errno === -4094) return true
  return /spawn\s+UNKNOWN/i.test(msg)
}

/* ------------------------------ 命令构造 ------------------------------ */

/**
 * 决定这个程序该怎么拉起来。返回的东西直接交给 main.cjs 执行，
 * 本身不做任何副作用 —— 所以可以在这里把各种组合测干净。
 *
 * @returns {{id:string, mode:'steam'|'exe'|'none', url?:string, exe?:string, args?:string[], cwd?:string, elevate?:boolean, label:string, note?:string}}
 */
function planLaunch(entry = {}, opts = {}) {
  const id = String(entry.id || '')
  const appid = String(entry.appid || '').trim()
  const useSteam = opts.useSteam !== false
  const extraArgs = Array.isArray(opts.extraArgs) ? opts.extraArgs.filter(Boolean).map(String) : []

  if (useSteam && appid) {
    return {
      id,
      mode: 'steam',
      // 官方协议：rungameid 能拉起「已安装的 Steam 应用」，Steam 没开时会被系统先唤起来
      url: `steam://rungameid/${appid}`,
      label: `Steam 启动（appid ${appid}）`,
    }
  }

  const exe = String(entry.exe || '').trim()
  if (!exe) {
    return { id, mode: 'none', label: '没找到可执行文件', note: appid ? `appid ${appid}，但没扫到 exe` : '' }
  }
  const args = []
  // 已经有 Steam 却要直启时，带上官方自带的 -nosteam（VTS / VBridger 的启动脚本就是这么写的），
  // 否则程序会一直等 Steam 来认领，界面上就是「点了没反应」
  if (appid && entry.nosteamArg) args.push(String(entry.nosteamArg))
  // 条目自带的参数（手补的程序常见：要塞一个配置文件路径之类）
  if (Array.isArray(entry.args)) args.push(...entry.args.filter(Boolean).map(String))
  args.push(...extraArgs)
  return {
    id,
    mode: 'exe',
    exe,
    args,
    // OBS 官方文档：从快捷方式/计划任务拉起时必须把工作目录指到 exe 所在目录，
    // 否则它找不到 data / obs-plugins，起来是个空壳
    cwd: path.dirname(exe),
    // 直播姬这类 manifest 里写着 requireAdministrator 的，普通权限根本拉不起来，
    // 得让 main.cjs 改走「弹一次 UAC」那条路
    elevate: needsElevation(entry, useSteam),
    label: `直接启动 ${path.basename(exe)}`,
  }
}

/**
 * 先扫一遍 Steam 的库，再补上非 Steam 的程序。
 * 全程只读：读 vdf / acf、看 exe 在不在，不启动任何东西。
 *
 * @param {{env?:object, extraSteamRoots?:string[], extraExe?:Array}=} opts
 */
function scanLaunchpad(opts = {}) {
  const env = opts.env || process.env
  const roots = steamRootCandidates(env, opts.extraSteamRoots || [])
  const scan = { steamRoot: '', steamExe: '', libraries: [], apps: [], errors: [] }

  const libs = []
  for (const root of roots) {
    let libFile = ''
    const candidates = [path.join(root, 'steamapps', 'libraryfolders.vdf'), path.join(root, 'libraryfolders.vdf')]
    for (const c of candidates) {
      if (exists(c)) {
        libFile = c
        break
      }
    }
    const steamapps = path.join(root, 'steamapps')
    if (!libFile && !exists(steamapps)) continue
    if (!scan.steamRoot) {
      scan.steamRoot = root
      const exe = path.join(root, 'steam.exe')
      if (exists(exe)) scan.steamExe = exe
    }
    if (libFile) {
      try {
        const vdf = parseVdf(fs.readFileSync(libFile, 'utf8'))
        for (const p of libPathsFrom(vdf)) {
          if (!libs.includes(p)) libs.push(p)
        }
      } catch (e) {
        scan.errors.push(`读不了 ${libFile}：${e.message}`)
      }
    }
    if (!libs.includes(root)) libs.push(root)
  }
  scan.libraries = libs

  // 每个库都扫一遍 appmanifest_*.acf
  const installed = []
  for (const lib of libs) {
    const sa = path.join(lib, 'steamapps')
    let names = []
    try {
      names = fs.readdirSync(sa)
    } catch {
      continue
    }
    for (const n of names) {
      const m = n.match(/^appmanifest_(\d+)\.acf$/i)
      if (!m) continue
      try {
        const info = parseAppManifest(fs.readFileSync(path.join(sa, n), 'utf8'), m[1])
        info.library = lib
        info.dir = path.join(sa, 'common', info.installdir)
        installed.push(info)
      } catch (e) {
        scan.errors.push(`读不了 ${n}：${e.message}`)
      }
    }
  }

  // 认领已知程序。先按 appid，再按名字/安装目录 —— 两条路都留着，
  // 免得 Valve 哪天改了 appid 就全丢
  const claimed = new Set()
  for (const spec of STEAM_APPS) {
    const hit =
      installed.find((a) => a.appid === spec.appid) ||
      installed.find((a) => spec.nameRe.test(a.name)) ||
      installed.find((a) => spec.nameRe.test(a.installdir))
    if (!hit) continue
    claimed.add(hit.appid)
    let exe = ''
    for (const rel of spec.rel) {
      const p = path.join(hit.dir, rel)
      if (exists(p)) {
        exe = p
        break
      }
    }
    scan.apps.push({
      id: spec.id,
      name: spec.name,
      hint: spec.hint,
      kind: spec.kind,
      origin: 'steam',
      appid: hit.appid,
      installdir: hit.installdir,
      library: hit.library,
      exe,
      nosteamArg: spec.nosteamArg || '',
      installed: true,
      // 装是装了，但没扫到我们认识的那个 exe —— 让用户知道要手动指定
      exeMissing: !exe,
    })
  }

  // 非 Steam 的
  for (const spec of EXTERNAL_APPS) {
    let list = []
    try {
      list = spec.probe(env) || []
    } catch (e) {
      scan.errors.push(`探测 ${spec.name} 失败：${e.message}`)
    }
    const seen = new Set()
    for (const item of list) {
      if (!item || !item.exe || seen.has(item.exe)) continue
      seen.add(item.exe)
      if (!exists(item.exe)) continue
      scan.apps.push({
        id: spec.id,
        name: spec.name,
        hint: spec.hint,
        kind: spec.kind,
        origin: 'external',
        appid: '',
        exe: item.exe,
        version: item.version || '',
        role: item.role || '',
        elevate: Boolean(spec.elevate),
        installed: true,
        exeMissing: false,
      })
      break // 一个程序只要一个入口，候选按优先级排好了
    }
  }

  // 同一个 id 只留一条：Steam 装的优先（默认要走 Steam 就得更偏向它）
  const byId = new Map()
  for (const a of scan.apps) {
    const old = byId.get(a.id)
    if (!old || (old.origin === 'external' && a.origin === 'steam')) byId.set(a.id, a)
  }
  scan.apps = Array.from(byId.values())

  // 用户手补的程序
  for (const c of opts.extraExe || []) {
    if (!c || !c.exe || !exists(c.exe)) continue
    scan.apps.push({
      id: c.id || `custom-${scan.apps.length + 1}`,
      name: c.name || path.basename(c.exe),
      hint: c.hint || '手动添加',
      kind: 'custom',
      origin: 'custom',
      appid: '',
      exe: c.exe,
      // 手补的程序常常要带参数（比如指一个配置文件）
      args: Array.isArray(c.args) ? c.args.filter(Boolean).map(String) : [],
      // 手补的也可以自己声明要管理员权限（界面上暂时没这个开关，但字段留着）
      elevate: Boolean(c.elevate),
      installed: true,
      exeMissing: false,
    })
  }

  // 「已装但没扫到 exe」的也值得让人看见，排在后面
  scan.apps.sort((a, b) => Number(a.exeMissing) - Number(b.exeMissing))
  return scan
}

module.exports = {
  // 解析
  parseVdf,
  libPathsFrom,
  parseAppManifest,
  parseTasklistCsv,
  shouldSkip,
  withRunning,
  // 版本
  versionKey,
  cmpVersion,
  pickLatestVersion,
  // 扫描
  STEAM_APPS,
  EXTERNAL_APPS,
  steamRootCandidates,
  scanLaunchpad,
  // 命令
  planLaunch,
  // 提权
  needsElevation,
  winArgv,
  psQuote,
  elevateCommand,
  looksLikeElevationError,
}
