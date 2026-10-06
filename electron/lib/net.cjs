'use strict'

/**
 * 对外平台请求的统一入口（TTS / 音色搜索）。
 *
 * 为什么不能直接用全局 fetch：
 *   Node 的 fetch（undici）**不读 Windows 的系统代理**，只认 HTTP_PROXY / HTTPS_PROXY
 *   环境变量。Clash、v2rayN 这类工具默认只设置系统代理，于是 api.fish.audio 这种
 *   在国内被 DNS 污染（解析到 31.13.94.36 之类的海外 IP）的域名会直接卡到超时 ——
 *   报出来的却是一句没头没脑的 "fetch failed"。
 *
 * 所以这里按模式分流：
 *   system → Electron 的 net.request，走 Chromium 网络栈，自动采用系统代理（含 PAC）
 *   direct → Node 的全局 fetch，明确不过代理（代理没配好时的逃生舱）
 *
 * 系统代理没配置时，net.request 本身就是直连，所以默认用 system 是安全的。
 */

const net_mod = require('node:net')
const dns = require('node:dns')

let electronNetCache = null

function electronNet() {
  if (electronNetCache !== null) return electronNetCache
  try {
    // 纯 Node 跑单测时 require('electron') 拿到的是可执行文件路径字符串，不是模块
    const e = require('electron')
    electronNetCache = e && e.net && typeof e.net.request === 'function' ? e.net : false
  } catch {
    electronNetCache = false
  }
  return electronNetCache
}

/** 默认「自动」时各平台走哪条路。国内直连不通的域名走系统代理。 */
const PROXY_SENSITIVE = new Set(['fish', 'openai', 'elevenlabs', 'minimaxGlobal'])

/**
 * @param {string} provider 平台 id
 * @param {object} cfg 全局配置
 * @returns {'system'|'direct'}
 */
function resolveMode(provider, cfg) {
  const mode = cfg?.proxy?.mode || 'auto'
  if (mode === 'system' || mode === 'direct') return mode
  return PROXY_SENSITIVE.has(provider) ? 'system' : 'direct'
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return String(url || '')
  }
}

/** 把裸错误翻译成能照着做点什么的中文。已翻译过的不再套一层。 */
function describeNetError(err, url) {
  if (err && err.netTranslated) return err
  const raw = String((err && (err.message || err)) || '')
  const host = hostOf(url)
  const wrap = (m) => {
    const e = new Error(m)
    e.netTranslated = true
    return e
  }
  if (/ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|timeout|超时|ERR_TIMED_OUT|ERR_CONNECTION_RESET|ECONNRESET/i.test(raw)) {
    return wrap(
      `${host} 连不上（超时）。这个域名在国内通常直连不通，把上面的「外网请求」切成「走系统代理」，并确认代理软件已经开着。`,
    )
  }
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i.test(raw)) {
    return wrap(`${host} 域名解析失败，检查网络或 DNS 设置。`)
  }
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(raw)) {
    return wrap(`${host} 拒绝连接，如果走的是本地代理，确认代理端口还开着。`)
  }
  if (/ERR_CERT|CERT_|SSL|ERR_PROXY/i.test(raw)) {
    return wrap(`${host} 证书或代理握手失败：${raw}`)
  }
  return wrap(`${host} 请求失败：${raw}`)
}

/**
 * 发一个请求，按模式选择网络栈。二进制音频也走这里，所以同时返回 buffer。
 * @returns {Promise<{status:number, ok:boolean, buffer:Buffer, text:string}>}
 */
function httpRequest(url, opts = {}) {
  const { method = 'GET', headers = {}, body = '', timeoutMs = 20000, mode = 'system' } = opts
  const eNet = electronNet()
  const run =
    mode === 'system' && eNet
      ? viaElectronNet(eNet, url, { method, headers, body, timeoutMs })
      : viaFetch(url, { method, headers, body, timeoutMs })
  return run.catch((e) => {
    throw describeNetError(e, url)
  })
}

async function viaFetch(url, { method, headers, body, timeoutMs }) {
  const res = await fetch(url, {
    method,
    headers,
    body: body || undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const buffer = Buffer.from(await res.arrayBuffer())
  return { status: res.status, ok: res.ok, buffer, text: buffer.toString('utf8') }
}

function viaElectronNet(eNet, url, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn(arg)
    }

    let req
    try {
      req = eNet.request({ method, url, redirect: 'follow' })
    } catch (e) {
      finish(reject, e)
      return
    }

    const badHeaders = []

    timer = setTimeout(() => {
      try {
        req.abort()
      } catch {
        /* noop */
      }
      finish(reject, new Error(`ERR_CONNECTION_TIMED_OUT 请求超过 ${Math.round(timeoutMs / 1000)} 秒`))
    }, timeoutMs)

    for (const [k, v] of Object.entries(headers)) {
      try {
        req.setHeader(k, v)
      } catch (e) {
        // 以前这里是静默忽略的。后果很严重：Authorization 一旦被内核拒掉，
        // 请求就带着「没有身份的密钥」发出去，服务器回一句 401 Invalid Token，
        // 而界面看到的只是一把「明明填对了」的 Key。所以宁可当场报错。
        badHeaders.push(`${k}（${e.message || e}）`)
      }
    }
    if (badHeaders.length) {
      try {
        req.abort()
      } catch {
        /* noop */
      }
      finish(
        reject,
        new Error(
          `请求头被浏览器内核拒绝：${badHeaders.join('、')}。` +
            `通常意味着 Key 里混进了空格、换行、零宽字符或全角字符 —— 重新复制一次密钥再试。`,
        ),
      )
      return
    }

    req.on('response', (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      res.on('end', () => {
        const buffer = Buffer.concat(chunks)
        finish(resolve, {
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          buffer,
          text: buffer.toString('utf8'),
        })
      })
      res.on('error', (e) => finish(reject, e))
    })
    req.on('error', (e) => finish(reject, e))

    if (body) req.write(body)
    req.end()
  })
}

/**
 * 请求并解析 JSON。网络错误统一翻译成中文。
 * @returns {Promise<{status:number, ok:boolean, data:any, text:string}>}
 */
async function httpJson(url, opts = {}) {
  const res = await httpRequest(url, opts) // 已经在里面翻译过错误了
  let data = null
  try {
    data = JSON.parse(res.text)
  } catch {
    data = null
  }
  return { status: res.status, ok: res.ok, data, text: res.text }
}

/* ------------------------------ 连通性自检 ------------------------------ */

function tcpProbe(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const sock = net_mod.connect({ host, port })
    let done = false
    const end = (r) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* noop */
      }
      resolve(r)
    }
    sock.setTimeout(timeoutMs, () => end('timeout'))
    sock.once('connect', () => end('ok'))
    sock.once('error', (e) => end(e.code === 'ECONNREFUSED' ? 'refused' : 'error'))
  })
}

/**
 * 给一个接口地址做体检：DNS → TCP:443 → HTTP。
 * 这三步能把「域名被污染」「代理没生效」「Key 不对」区分开。
 */
async function checkEndpoint(url, opts = {}) {
  const { mode = 'system', timeoutMs = 8000 } = opts
  const out = { url, host: '', ip: '', dns: '-', tcp: '-', http: null, ok: false, message: '' }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    out.message = '地址格式不对'
    return out
  }
  out.host = parsed.hostname

  try {
    const addrs = await dns.promises.lookup(parsed.hostname, { all: true })
    out.dns = 'ok'
    out.ip = addrs.map((a) => a.address).join(', ')
  } catch {
    out.dns = 'fail'
    out.message = '域名解析失败，检查 DNS'
    return out
  }

  const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
  out.tcp = await tcpProbe(parsed.hostname, port, timeoutMs)
  if (out.tcp !== 'ok') {
    out.message =
      out.tcp === 'refused' ? `TCP ${port} 被拒绝` : `直连 TCP ${port} 不通（超时）—— 需要代理`
    // 直连不通不代表整体失败：走系统代理可能仍然可用，继续试一次 HTTP
  }

  try {
    const res = await httpRequest(url, { method: 'GET', timeoutMs, mode })
    out.http = res.status
    // 401/403 说明网络是通的，只是 Key 不对
    out.ok = res.status < 500 && res.status !== 0
    out.message =
      out.http === 401 || out.http === 403
        ? `网络通，HTTP ${out.http}：Key 不对或没权限`
        : out.http < 400
          ? `HTTP ${out.http}：正常`
          : `HTTP ${out.http}`
  } catch (e) {
    const msg = describeNetError(e, url).message
    out.message = out.message || msg
  }
  return out
}

/**
 * 把平台返回的 HTTP 错误翻成能照着做的中文。
 * 关键是把「Key 不对」「没钱了」「音色 id 不对」「地址不对」区分开 ——
 * 一句 HTTP 401 对用户没有任何指导意义。
 *
 * @param {number} status
 * @param {string} text 响应体原文（会被截断）
 * @param {{label?:string, keySummary?:string, hint?:string}} opts
 */
/**
 * 把 HTTP 失败翻译成一句人话。
 *
 * 刻意不把 Key 指纹（「长度 64 · ab12…9f3c」）、状态码明细这类中间信息写进去 ——
 * 界面上已经单独显示着「已保存：…」，再在错误里重复一遍只会把真正要读的那句挤掉。
 * opts.keySummary 仍然收着，是给将来需要在日志里定位时用的。
 */
function describeHttpError(status, text, opts = {}) {
  const { label = '平台', hint = '' } = opts
  const detail = serverNote(text)
  if (status === 401) {
    return (
      `${label} 说这把 Key 无效（HTTP 401）${detail}。` +
      '去平台的 API Keys 页重新生成一把，整段粘贴回来、点「保存」，再用「校验 Key」确认。'
    )
  }
  if (status === 403) {
    return `${label} 拒绝了这次调用（HTTP 403）：这把 Key 没有这个权限${detail}。去平台的账户页确认它的权限范围。`
  }
  if (status === 402) {
    return `${label} 账户额度不足（HTTP 402）${detail}。去平台的账单页充值或换成有额度的模型。`
  }
  if (status === 404) {
    return `${label} 接口地址不对（HTTP 404）${detail}。检查「接口地址」有没有被改成失效的中转地址。`
  }
  if (status === 400) {
    return `${label} 参数不对（HTTP 400）${detail}。${hint || '多半是音色 id 或模型名不对。'}`
  }
  if (status === 429) {
    return `${label} 限流了（HTTP 429）${detail}。等几秒再试，或降低播报频率。`
  }
  return `${label} 返回 HTTP ${status}${detail}。过一会儿再试一次。`
}

/**
 * 从响应体里挑一句能给人看的「平台原话」。
 *
 * 这里有个坑：平台出错时不一定回 JSON —— 网关、CDN 经常回一整页 HTML，
 * 直接截一百多字贴进弹窗，用户看到的会是一屏标签和回车。所以：
 * 先认 JSON 里的 message，认不出就把标签、HTML 实体和多余空白压掉，
 * 顺手把「502 Bad Gateway 502 Bad Gateway nginx」这类重复片段收一下。
 */
function serverNote(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  try {
    const j = JSON.parse(raw)
    const m = j?.message || j?.error?.message || j?.detail
    if (typeof m === 'string' && m.trim()) return `，平台说：${m.trim().slice(0, 100)}`
  } catch {
    // 不是 JSON，往下走通用清洗
  }
  // 先压到 200 字再做去重：HTML 错误页动辄几十 KB，别让正则在大字符串上跑
  const flat = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  // HTML 页里标题和正文常是同一句，拼在一起会变成「502 Bad Gateway 502 Bad Gateway nginx」
  const dedup = flat.replace(/(.{6,40}?)\s+\1/g, '$1').trim()
  return dedup ? `，平台说：${dedup.slice(0, 60)}` : ''
}

module.exports = {
  httpRequest,
  httpJson,
  describeNetError,
  describeHttpError,
  resolveMode,
  checkEndpoint,
  hostOf,
  PROXY_SENSITIVE,
}
