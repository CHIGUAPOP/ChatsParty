'use strict'

/**
 * 检查更新：查 GitHub 上最新一个 Release 的标签，和本地版本比一下。
 *
 * 为什么不引 electron-updater：发布物是**便携版 exe**，每次运行都解压到临时目录，
 * 根本不存在「原地替换自己」这回事。自动下载安装只会留下两份程序和一堆临时文件。
 * 知道有新版本、把下载页打开，就够了。
 *
 * 时机：只在启动时查一次（见 main.cjs 的 autoCheckUpdate）。这里不排定时器 ——
 * 一个弹幕姬没必要为了「有没有新版」在后台反复撞网络。
 * 连不上就返回失败，不重试也不弹窗：网络不通不是用户需要知道的事。
 */

const { httpJson } = require('./lib/net.cjs')

const REPO = 'CHIGUAPOP/ChatsParty'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases`

/**
 * 「1.10.0」→ [1,10,0]。后缀（-beta.1 / +build）直接丢掉：
 * 这里比的是发版序号，预发布比正式版新不新，对「要不要提示更新」没有意义。
 */
function parseVersion(v) {
  return String(v || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((n) => Number(n) || 0)
}

/** a 比 b 新返回 >0，相同返回 0，旧返回 <0 */
function compareVersion(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  const len = Math.max(x.length, y.length)
  for (let i = 0; i < len; i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

/** 下载地址：优先 Release 里挂的 exe，其次 Release 页面本身 */
function pickDownloadUrl(json) {
  const assets = Array.isArray(json && json.assets) ? json.assets : []
  const exe = assets.find((a) => /\.exe$/i.test(String((a && a.name) || '')))
  if (exe && exe.browser_download_url) return exe.browser_download_url
  return (json && json.html_url) || RELEASES_PAGE
}

/** Release 正文里塞的是 markdown，界面上只给个开头，别把整篇拉进来 */
function clipNotes(text, max = 1200) {
  const s = String(text || '').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 查一次最新版本。**任何失败都不抛**，统一返回 { ok:false, reason }，
 * 调用方不用套 try/catch。
 *
 * @returns {Promise<{ok:boolean, current:string, latest?:string, hasUpdate?:boolean,
 *   url?:string, notes?:string, publishedAt?:string, reason?:string, message?:string}>}
 */
async function checkLatest(opts = {}) {
  const current = String(opts.current || '0.0.0')
  try {
    const res = await httpJson(API_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub API 强制要 User-Agent，不带直接 403
        'User-Agent': `ChatsParty/${current}`,
      },
      timeoutMs: Number(opts.timeoutMs) || 8000,
      // api.github.com 在国内基本要代理：走系统代理，和 fish / openai 一个待遇
      mode: 'system',
    })

    if (!res.ok) {
      return {
        ok: false,
        current,
        reason: res.status === 404 ? 'no-release' : res.status === 403 ? 'rate-limit' : 'http',
        message: res.status === 403 ? 'GitHub 限流了，过一会儿再看' : `GitHub 返回 HTTP ${res.status}`,
      }
    }

    const json = res.data || {}
    const latest = String(json.tag_name || json.name || '').trim()
    if (!latest) return { ok: false, current, reason: 'no-tag', message: '这个 Release 没打标签' }

    return {
      ok: true,
      current,
      latest: latest.replace(/^v/i, ''),
      // 只有「线上更高」才算有新版。本地版本号比线上还新（自己改过、或者跑的开发版）
      // 时不该提示 —— 否则从源码构建的人每次启动都会被告知「有新版」一个更老的版本。
      hasUpdate: compareVersion(latest, current) > 0,
      url: pickDownloadUrl(json),
      notes: clipNotes(json.body),
      publishedAt: json.published_at || '',
      pageUrl: RELEASES_PAGE,
    }
  } catch (e) {
    // 超时 / DNS / 断网：连不上就放弃，不重试
    return { ok: false, current, reason: 'network', message: (e && e.message) || String(e) }
  }
}

module.exports = { checkLatest, compareVersion, parseVersion, pickDownloadUrl, REPO, API_URL, RELEASES_PAGE }
