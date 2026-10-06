'use strict'

/**
 * 网易云点歌 —— 只实现点歌真正需要的几个接口，不引第三方服务。
 *
 * 为什么不用 NeteaseCloudMusicApi：
 *   它是一个完整的 Express/Fastify 服务（几百个接口、一堆依赖、默认占 3000 端口）。
 *   我们只需要「搜索 → 拿播放链接 → 取歌词」三步，为此在弹幕姬里再养一个 HTTP 服务
 *   既笨重又多一个故障点。加密本身很简单（AES-128-ECB），Node 内置 crypto 就够。
 *
 * 为什么走 linuxapi 通道（/api/linux/forward）：
 *   实测在匿名状态下，weapi 的 /api/cloudsearch/pc 会返回 400「参数错误」，
 *   /api/search/pc 会触发风控 code=-462；而 linuxapi 转发出来的请求稳定可用，
 *   搜索、播放链接、歌词都正常，且**不需要登录**。
 *
 * 有登录态时必须换 weapi：
 *   linuxapi 是「Linux 客户端」通道，实测它**不带会员身份** ——
 *   匿名时听不了的黑胶歌曲，塞了 Cookie 照样 pl=0（nolimit 空/0），只能出 30 秒试听或直接没链接。
 *   weapi 才是网页播放页自己用的那条，服务端按 Cookie 里的 MUSIC_U 判会员，
 *   搜索结果里的 privilege.pl 才会变成 320000 / 999000。
 *   所以：填了 MUSIC_U → 走 weapi；没填 → 走 linuxapi 匿名（更稳、更少风控）。
 *
 * 播放链接是 http://mxxx.music.126.net/... 这种临时地址，有效期约 20 分钟（expi），
 * 所以只在真正要播的那一刻才去取，不要提前囤。
 */

const crypto = require('node:crypto')
const net = require('./lib/net.cjs')

const HOST = 'https://music.163.com'
const FORWARD = '/api/linux/forward'
const LINUX_KEY = 'rFgB&h#%2?^eDg:Q'
// weapi 的固定参数，二十多个开源实现都用这几个，服务端没换过
const W_IV = '0102030405060708'
const W_NONCE = '0CoJUm6Qyw8W8jud'
const W_PUBKEY = '010001'
const W_MODULUS =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
// 匿名身份。用户在界面里填了自己的 Cookie 时会补充进来
const ANON_COOKIE = 'os=pc; appver=8.9.70'

/** linuxapi：整包 AES-128-ECB，hex 大写 */
function linuxapi(payload) {
  const cipher = crypto.createCipheriv('aes-128-ecb', LINUX_KEY, Buffer.alloc(0))
  const hex = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()])
    .toString('hex')
    .toUpperCase()
  return `eparams=${hex}`
}

/* ------------------------------- weapi ------------------------------- */

function aesCbcBase64(text, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, W_IV)
  return Buffer.concat([cipher.update(Buffer.from(text, 'binary')), cipher.final()]).toString('base64')
}

/** m^e mod n。Node 没有直接的「裸 RSA 十六进制公钥」，自己算比拼 PEM 省事也更可控 */
function powMod(base, exp, mod) {
  let r = 1n
  let b = base % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod
    b = (b * b) % mod
    e >>= 1n
  }
  return r
}

/** weapi：明文先固定密钥 AES 一层，再随机密钥一层；随机密钥用 RSA 交给服务端 */
function weapi(params) {
  const secretKey = crypto.randomBytes(8).toString('hex').slice(0, 16)
  const mod = BigInt('0x' + W_MODULUS)
  const text = JSON.stringify(params)
  const reversed = secretKey.split('').reverse().join('')
  const encSecKey = powMod(BigInt('0x' + Buffer.from(reversed, 'utf8').toString('hex')) % mod, BigInt('0x' + W_PUBKEY), mod)
    .toString(16)
    .padStart(256, '0')
  return { params: aesCbcBase64(aesCbcBase64(text, W_NONCE), secretKey), encSecKey }
}

/** /api/xxx → /weapi/xxx。已经是 /weapi/ 的原样返回 */
function weapiPath(path) {
  return path.startsWith('/weapi/') ? path : path.replace(/^\/api/, '/weapi')
}

/** 用户 Cookie 里抽 __csrf —— weapi 的写操作要它 */
function csrfOf(cookie) {
  const m = /__csrf=([^;]+)/.exec(String(cookie || ''))
  return m ? m[1].trim() : ''
}

/**
 * 把用户的 Cookie 补齐成完整的请求头。
 * 只填 MUSIC_U 也能用，但缺了 os/NMTID 这类环境字段很容易被判成爬虫，
 * 所以这里一律帮着补上。
 */
function cookieFor(userCookie) {
  const c = String(userCookie || '').trim()
  if (!c) return ANON_COOKIE
  const parts = [c.replace(/;\s*$/, '')]
  const has = (n) => new RegExp(`(^|;\\s*)${n}=`).test(c)
  if (!has('os')) parts.push('os=pc')
  if (!has('appver')) parts.push('appver=8.9.70')
  if (!has('NMTID')) parts.push(`NMTID=00O${crypto.randomBytes(9).toString('hex')}`)
  return parts.join('; ')
}

/** 有没有登录态。MUSIC_U 是网页端的登录凭证，没有它就是匿名 */
function hasLogin(cookie) {
  return /MUSIC_U\s*=/.test(String(cookie || ''))
}

/** 有登录态时就该按会员身份走 weapi（界面上显示用的宏观判断） */
function channelFor(cookie) {
  return hasLogin(cookie) ? 'weapi' : 'linux'
}

/**
 * 每个接口具体走哪条通道。
 *
 * 只有**取播放链接**必须换 weapi —— 会员身份只对这一步有意义。
 * 搜索千万别换：实测 weapi 的 /api/cloudsearch/pc 会稳定返回一堆不相干的歌
 * （搜「晴天」给出来「红尘情歌」「Angel」），这是网易对网页爬虫灌假数据的老手段，
 * 而 linuxapi 转发通道返回的是正确结果。所以两头分工：
 *   搜索/歌词/详情 → linuxapi（结果准、匿名也稳）
 *   播放链接      → weapi（会员身份在这里生效）
 */
function useWeapiFor(path, cookie) {
  if (!hasLogin(cookie)) return false
  return /^\/api\/song\/enhance\/(player|download)\/url/.test(String(path || ''))
}

/**
 * 把空响应体、非 JSON 这类「传输层不对劲」标成可重试，
 * 好让上层能退回另一条通道；业务报错（code!=200）不重试，重试也没用。
 */
function transportFail(message, opts = {}) {
  const e = new Error(message)
  e.retryable = opts.retryable !== false
  return e
}

/** weapi 通道 */
async function callWeapi(path, params = {}, opts = {}) {
  const mode = opts.mode || 'direct'
  const cookie = opts.cookie || ANON_COOKIE
  const res = await net.httpRequest(`${HOST}${weapiPath(path)}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${HOST}/`,
      Cookie: cookie,
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: new URLSearchParams(weapi(params)).toString(),
    timeoutMs: opts.timeoutMs || 15000,
    mode,
  })
  if (!res.text || !res.text.trim()) throw transportFail('网易云这次没返回内容')
  return parseBody(res)
}

/** linuxapi 转发通道（匿名，无会员身份） */
async function callLinux(path, params = {}, opts = {}) {
  const method = opts.method || 'POST'
  const mode = opts.mode || 'direct'
  const url = `${HOST}${path}`
  // GET 接口的参数要拼在转发目标 URL 上，转发体里的 params 留空
  const payload =
    method === 'GET' && Object.keys(params).length
      ? { method, url: `${url}?${new URLSearchParams(params).toString()}` }
      : { method, url, params }
  const res = await net.httpRequest(`${HOST}${FORWARD}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${HOST}/`,
      Cookie: opts.cookie || ANON_COOKIE,
    },
    body: linuxapi(payload),
    timeoutMs: opts.timeoutMs || 15000,
    mode,
  })
  return parseBody(res)
}

function parseBody(res) {
  let data = null
  try {
    data = JSON.parse(res.text)
  } catch {
    throw transportFail(`网易云返回了没法解析的内容（HTTP ${res.status}）`)
  }
  if (data && data.code !== undefined && data.code !== 200 && !data.result && !data.data && !data.songs) {
    // 平台的 code 留在括号里够排查用了，内部接口路径不必给用户看
    throw transportFail(`网易云拒绝了这次请求（code=${data.code}${data.msg ? ` ${data.msg}` : ''}）`, { retryable: false })
  }
  return data
}

/**
 * 调一个网易云接口，自动选通道。
 * @param {string} path 例如 /api/cloudsearch/pc
 * @param {object} params 接口参数
 * @param {{cookie?:string, method?:'GET'|'POST', timeoutMs?:number, mode?:string}} opts
 */
async function call(path, params = {}, opts = {}) {
  const cookie = cookieFor(opts.cookie)
  if (!useWeapiFor(path, opts.cookie)) return callLinux(path, params, { ...opts, cookie })

  try {
    return await callWeapi(path, { ...params, csrf_token: csrfOf(opts.cookie) }, { ...opts, cookie })
  } catch (e) {
    // weapi 被风控或参数变了，退回匿名通道，至少别让点歌整个瘫掉
    if (e && e.retryable) return callLinux(path, params, { ...opts, cookie })
    throw e
  }
}

/**
 * 登录态体检：界面上的「Cookie 检测」用它。
 * 填了 Cookie 却查不到账号，基本就是 Cookie 失效或被登出了。
 */
async function accountInfo(opts = {}) {
  const cookie = cookieFor(opts.cookie)
  const out = { loggedIn: false, nickname: '', vip: false, vipType: 0, channel: channelFor(opts.cookie) }
  if (!hasLogin(opts.cookie)) return out
  try {
    const data = await callWeapi(
      '/api/w/nuser/account/get',
      { csrf_token: csrfOf(opts.cookie) },
      { ...opts, cookie, timeoutMs: 10000 },
    )
    const profile = data?.profile || data?.account?.profile
    if (profile && profile.userId) {
      out.loggedIn = true
      out.nickname = profile.nickname || ''
      out.vipType = Number(profile.vipType || 0)
      out.vip = out.vipType > 0
    }
  } catch {
    // 查不到就当没登录，UI 那边会照着我这句提示用户去重新取
  }
  return out
}

/**
 * 从浏览器 Cookie 罐里挑出点歌真正需要的那几项，拼成可以直接存的字符串。
 *
 * 网页里 music.163.com 有几十个 Cookie，绝大多数是埋点统计（NMTID、_ntes_nuid、
 * WNMCID、sDeviceId…），**真正决定「你是谁、是不是会员」的只有 MUSIC_U**。
 * 所以这里只留 MUSIC_U（+ 顺手的 __csrf），其余一概不带 ——
 * 少即是准：带一堆过期/无关的字段反而更容易被判定成异常请求。
 * os / appver / NMTID 这些环境字段，发请求时由 cookieFor() 统一补。
 *
 * @param {Array<{name:string,value:string,domain?:string,expirationDate?:number}>} list
 * @returns {string} 例如 "MUSIC_U=xxx; __csrf=yyy"；没有登录凭证时返回空串
 */
function cookieFromJar(list) {
  const jar = Array.isArray(list) ? list : []
  const nowSec = Date.now() / 1000
  const pick = (name) => {
    const hits = jar.filter((c) => {
      if (c?.name !== name) return false
      if (!/music\.163\.com/.test(String(c.domain || ''))) return false
      // 会话 Cookie 没有 expirationDate，一律算有效；有过期时间的要还没过期
      return !c.expirationDate || c.expirationDate > nowSec
    })
    if (!hits.length) return ''
    // 同一个名字可能同时存在 .music.163.com 和 music.163.com 两份，取活得最久的那份
    hits.sort((a, b) => (Number(b.expirationDate) || 0) - (Number(a.expirationDate) || 0))
    return String(hits[0].value || '').trim()
  }
  const u = pick('MUSIC_U')
  if (!u) return ''
  const parts = [`MUSIC_U=${u}`]
  const csrf = pick('__csrf')
  if (csrf) parts.push(`__csrf=${csrf}`)
  return parts.join('; ')
}

/** 时长毫秒 → m:ss */
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * 把搜索结果里的一首歌整理成界面要的形状。
 * @param {object} s 服务端原始歌曲
 * @param {boolean} loggedIn 有登录态时，别拿匿名权限去否定这首歌
 */
function normalizeSong(s, loggedIn = false) {
  const artists = (s.artists || s.ar || []).map((a) => a.name).filter(Boolean)
  const album = s.album || s.al || {}
  const priv = s.privilege || {}
  const pl = Number(priv.pl || 0)
  return {
    id: Number(s.id),
    name: s.name || '',
    alias: (s.alias || []).join(' ') || (s.alia || [])[0] || '',
    artists: artists.join('/'),
    album: album.name || '',
    picUrl: album.picUrl || album.pic || '',
    duration: s.duration || s.dt || 0,
    durationText: fmtDuration(s.duration || s.dt || 0),
    // 搜索走的是匿名通道，返回的 pl 反映不了会员身份 ——
    // 填了 Cookie 就一律放行，真正的判定留给「取链接」那一步（它会走 weapi）
    playable: pl > 0 || s.fee === 0 || loggedIn,
    maxBr: pl || 0,
    fee: s.fee ?? 0,
  }
}

/**
 * 搜索歌曲。
 * @param {string} keyword 歌名 / 歌手 / 「歌名 歌手」都行
 * @param {{limit?:number, cookie?:string}} opts
 */
async function searchMusic(keyword, opts = {}) {
  const kw = String(keyword || '').trim()
  if (!kw) return []
  const data = await call(
    '/api/cloudsearch/pc',
    { s: kw, type: 1, limit: opts.limit || 10, offset: 0, total: true },
    { cookie: opts.cookie, mode: opts.mode },
  )
  const songs = data?.result?.songs || []
  const loggedIn = hasLogin(opts.cookie)
  // 不能写 songs.map(normalizeSong)：map 会把下标当第二个参数传进去
  return songs.map((s) => normalizeSong(s, loggedIn))
}

/**
 * 取播放链接。**要播的时候才调** —— 地址 20 分钟就过期。
 * @param {number|string} id
 * @param {{br?:number, cookie?:string}} opts
 */
async function songUrl(id, opts = {}) {
  const want = Number(opts.br) || 320000
  // 账号权限不够时服务端会给 url=null。先按用户选的音质要，拿不到就逐级降，
  // 总比直接一句「取不到」强 —— 会员到期、换了台设备都可能只是掉到低音质。
  const tries = [want, 320000, 192000, 128000].filter((b, i, a) => a.indexOf(b) === i && b > 0)
  let last = null
  for (const br of tries) {
    const data = await call(
      '/api/song/enhance/player/url',
      { ids: JSON.stringify([Number(id)]), br },
      { cookie: opts.cookie, mode: opts.mode },
    )
    const item = (data?.data || [])[0]
    last = item
    if (item && item.url) {
      return {
        id: Number(item.id),
        url: item.url,
        br: item.br || br,
        size: item.size || 0,
        type: item.type || 'mp3',
        level: item.level || '',
        // 秒。过期就重新取一次
        expiresIn: Number(item.expi) || 1200,
        md5: item.md5 || '',
        // 实际拿到的音质比想要的低，界面上要能看出来
        downgraded: br !== want,
      }
    }
  }
  // 有版权但当前账号/地区拿不到，给一句能照着做的话
  const how = last && last.freeTrialInfo ? '只能试听 30 秒' : '可能受版权或账号限制'
  throw new Error(`这首歌现在拿不到完整播放地址（${how}） —— 换一版（原唱/Cover）试试`)
}

/** 歌词：{ lines: [{time, text}], translation: {...} } */
async function lyric(id, opts = {}) {
  const data = await call(
    '/api/song/lyric',
    { id: Number(id), tv: -1, lv: -1, rv: -1, kv: -1 },
    { method: 'POST', cookie: opts.cookie, mode: opts.mode },
  )
  return { lrc: parseLrc(data?.lrc?.lyric || ''), raw: data?.lrc?.lyric || '' }
}

/** [mm:ss.xx]文本 → [{time:秒, text}] */
function parseLrc(text) {
  const out = []
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = re.exec(line)
    re.lastIndex = 0
    if (!m) continue
    const t = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / (m[3].length === 3 ? 1000 : 100) : 0)
    const txt = line.replace(/\[[^\]]*\]/g, '').trim()
    if (txt) out.push({ time: t, text: txt })
  }
  return out.sort((a, b) => a.time - b.time)
}

/** 批量取详情（封面 / 时长）。点歌队列恢复显示时用 */
async function songDetail(ids, opts = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean)
  if (!list.length) return []
  const data = await call(
    '/api/v3/song/detail',
    { c: JSON.stringify(list.map((id) => ({ id }))), ids: JSON.stringify(list) },
    { cookie: opts.cookie, mode: opts.mode },
  )
  const loggedIn = hasLogin(opts.cookie)
  return (data?.songs || []).map((s) => normalizeSong(s, loggedIn))
}

/**
 * 体检：搜一首必有的歌，看能不能拿到链接。
 * 界面上的「测试」按钮用它 —— 网络/风控一变，用户能立刻知道。
 */
async function check(opts = {}) {
  const started = Date.now()
  const account = await accountInfo(opts)
  const songs = await searchMusic('晴天', { limit: 3, cookie: opts.cookie, mode: opts.mode })
  if (!songs.length) throw new Error('网易云这会儿搜不到歌，稍后再试一次')
  const first = songs.find((s) => s.playable) || songs[0]
  const audio = await songUrl(first.id, { br: opts.br || 320000, cookie: opts.cookie, mode: opts.mode })
  return { ok: true, song: first, audio, account, channel: channelFor(opts.cookie), latency: Date.now() - started }
}

/**
 * 判断一条弹幕是不是在点歌。
 * @returns {string|null} 命中返回歌名（可能为空串，表示只发了触发词没带歌名），没命中返回 null
 */
function parseMusicCommand(text, commands) {
  const list = Array.isArray(commands) ? commands : String(commands || '点歌').split(/[,，]/)
  const s = String(text || '').trim()
  for (const c of list) {
    const word = String(c || '').trim()
    if (!word) continue
    if (s === word) return ''
    if (s.startsWith(word)) {
      const rest = s.slice(word.length).replace(/^[\s:：,，、]+/, '').trim()
      if (rest) return rest
    }
  }
  return null
}

module.exports = {
  searchMusic,
  songUrl,
  lyric,
  songDetail,
  parseLrc,
  normalizeSong,
  parseMusicCommand,
  linuxapi,
  weapi,
  accountInfo,
  cookieFromJar,
  channelFor,
  useWeapiFor,
  cookieFor,
  hasLogin,
  check,
}
