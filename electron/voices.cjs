'use strict'

/**
 * 在线音色搜索 + 音色注册 + 弹幕命令。
 *
 * 三件事：
 *  1. 搜索：实时去各家平台拉当前可用的音色，不维护本地名单
 *  2. 注册：把某个平台音色（或 MiMo 的音色描述）存成一条「音色档案」
 *  3. 绑定：把档案绑到某个 uid，之后他发的弹幕就用这个音色念
 *
 * 没绑定的人回落到全局默认配置（一般是 MiMo）。
 */

const { PROVIDERS } = require('./tts.cjs')
const edge = require('./tts-edge.cjs')
const sapi = require('./tts-sapi.cjs')
const { httpJson, describeNetError, describeHttpError, resolveMode } = require('./lib/net.cjs')
const { normalizeKey, keySummary } = require('./lib/keytext.cjs')

const COMMAND_ALIASES = {
  // 每类的第一个是「正名」：帮助信息里显示的就是它，所以挑最顺口、最不容易撞车的那个
  query: ['我的音色', '音色', '当前音色', '查音色', 'voice', 'myvoice'],
  list: ['音色列表', '搜音色', '音色库', '音色搜索', '搜声音', 'list', 'voices', 'search'],
  bind: ['绑定', '用', '换成', '我要', '选', 'bind', 'use'],
  design: ['设计', '定制', '造一个', '创建音色', 'design', 'create'],
  unbind: ['删除音色', '解绑', '取消音色', '恢复默认音色', 'unbind', 'reset'],
  help: ['帮助音色', '音色帮助', '怎么换音色', '音色怎么用', 'help'],
}

const OWNER_LABEL = { builtin: '内置', host: '主播', audience: '观众' }

/** 各平台的默认接口地址；国内直连不通的可以在界面上换成镜像 / 中转 */
const DEFAULT_BASE = {
  // Fish Audio 官方（fish.audio）的 API。注意 fishaudio.org 是另一家平台，密钥不通用。
  fish: 'https://api.fish.audio',
  openai: 'https://api.openai.com/v1',
}

function baseFor(source, cfg) {
  const custom = String(cfg?.platformBase?.[source] || '').trim()
  return (custom || DEFAULT_BASE[source] || '').replace(/\/+$/, '')
}

function uid() {
  return 'vp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function norm(s) {
  return String(s || '').trim().toLowerCase()
}

function keyFor(source, cfg) {
  if (source === 'fish') return normalizeKey(cfg?.platformKeys?.fish)
  if (source === 'openai') {
    return normalizeKey(cfg?.platformKeys?.openai) || normalizeKey(cfg?.tts?.apiKey)
  }
  return normalizeKey(cfg?.tts?.apiKey)
}

/* ------------------------------ 在线音色搜索 ------------------------------ */

/** 静态兜底列表。只有平台确实没有列表接口时才写死，且一律用平台原生 id。 */
const STATIC_VOICES = {
  // hint 要保留 label 里的性别/语言信息，观众搜「女声」「英文」才能命中
  mimo: PROVIDERS.mimo.voices.map((v) => ({
    id: v.id,
    name: v.label.split(' · ')[0] || v.id,
    hint: `小米 MiMo 预置 · ${v.label}`,
  })),
  openai: PROVIDERS.openai.voices.map((v) => ({ id: v.id, name: v.id, hint: 'OpenAI' })),
}

/**
 * Fish Audio（fish.audio）音色库。
 * GET /model?page_size=&page_number=&title=
 * 返回 {total, items:[{_id, title, description, tags, languages, samples, state, type}]}
 *
 * 三个坑：
 *  1. 路径是 /model （没有 /v1 前缀）—— 旧文档里的 /v1/models 现在已经 404。
 *     但 /v1/tts 又确实带 /v1，同一家平台两套前缀并存，别想当然。
 *  2. 音色 id 字段叫 **_id**，合成时作为 reference_id 用。
 *  3. title 是前缀/子串匹配而非全文检索，翻页深了结果会很泛；
 *     另外服务端只认这一个筛选条件，语言过滤只能在拉回来的结果里本地做。
 */
async function searchFish({ apiKey, keyword, limit, page = 1, language = '', baseUrl, mode = 'system' }) {
  if (!apiKey) throw new Error('还没填 Fish Audio 的 API Key')
  const base = String(baseUrl || DEFAULT_BASE.fish).replace(/\/+$/, '')
  const url = new URL(`${base}/model`)
  url.searchParams.set('page_number', String(Math.max(page, 1)))
  // 多拉一些再本地过滤（语言、关键词都是在本地二次筛的），上限 100
  url.searchParams.set('page_size', String(Math.min(Math.max(limit, 1) * 4, 100)))
  const kw = String(keyword || '').trim()
  if (kw) url.searchParams.set('title', kw)

  let res
  try {
    res = await httpJson(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeoutMs: 20000,
      mode,
    })
  } catch (e) {
    throw new Error(e.message || `Fish 音色搜索失败：${String(e)}`)
  }
  if (!res.ok) {
    throw new Error(
      describeHttpError(res.status, res.text, {
        label: 'Fish Audio',
        keySummary: keySummary(apiKey),
        hint: '音色接口出问题了，确认 Key 有读取音色的权限。',
      }),
    )
  }
  const json = res.data
  let items = Array.isArray(json?.items) ? json.items : []
  const total = Number(json?.total) || items.length

  // 只要能直接拿来合成的 TTS 音色，排除变声器（svc）和训练失败的
  items = items.filter((it) => (it.type || 'tts') === 'tts' && it.state !== 'failed')

  // 服务端只有 title 一个筛选条件，关键词其余维度（标签、简介）本地补一遍
  const kwLow = kw.toLowerCase()
  if (kwLow) {
    items = items.filter((it) => {
      const title = String(it.title || '').toLowerCase()
      const desc = String(it.description || '').toLowerCase()
      const tags = Array.isArray(it.tags) ? it.tags.join(' ').toLowerCase() : ''
      return title.includes(kwLow) || desc.includes(kwLow) || tags.includes(kwLow)
    })
  }
  if (language) {
    const lang = String(language).toLowerCase()
    items = items.filter((it) => {
      const langs = Array.isArray(it.languages) ? it.languages : []
      return langs.some((l) => String(l).toLowerCase().includes(lang))
    })
  }

  return {
    total,
    voices: items
      .slice(0, Math.max(limit, 1))
      .map((it) => ({
        id: String(it._id || ''),
        name: String(it.title || it._id || '未命名音色').slice(0, 24),
        hint:
          [(Array.isArray(it.languages) ? it.languages.slice(0, 2).join('/') : '') || '未标语言', (Array.isArray(it.tags) ? it.tags.slice(0, 3).join('/') : '')]
            .filter(Boolean)
            .join(' · ') || 'Fish 音色库',
      }))
      .filter((v) => v.id),
  }
}

function staticScore(v, kw) {
  const name = norm(v.name)
  const id = norm(v.id)
  if (name === kw || id === kw) return 100
  if (name.startsWith(kw) || id.startsWith(kw)) return 80
  if (name.includes(kw) || id.includes(kw)) return 60
  if (norm(v.hint).includes(kw)) return 30
  return 0
}

/**
 * 在单个平台上搜音色。各家的能力不一样：
 *  - fish / edge / system：实时在线拉
 *  - mimo / openai：平台没开放列表接口，用官方文档里的原生列表做本地过滤
 * @returns {Promise<{ok:boolean, voices:Array, total?:number, message?:string}>}
 */
async function searchSource(source, opts = {}) {
  const { keyword = '', limit = 8, cfg = {}, page = 1, language = '', force = false } = opts
  try {
    if (source === 'fish') {
      const r = await searchFish({
        apiKey: keyFor('fish', cfg),
        keyword,
        limit,
        page,
        language,
        baseUrl: baseFor('fish', cfg),
        mode: resolveMode('fish', cfg),
      })
      return { ok: true, voices: r.voices, total: r.total }
    }
    if (source === 'edge') {
      const all = await edge.listVoices({ force })
      const pool = all.map((v) => ({
        id: v.id,
        name: v.label ? v.label.split(' · ')[0] : v.id,
        hint: `Edge 官方 · ${v.label?.split(' · ')[1] || v.locale}${v.locale ? ` (${v.locale})` : ''}`,
        locale: v.locale || '',
        scoreBase: v.label?.split(' · ')[1] || '',
      }))
      let hit = pool
      if (keyword) {
        hit = pool
          .map((v) => ({
            v,
            s: Math.max(staticScore(v, norm(keyword)), norm(v.scoreBase).includes(norm(keyword)) ? 55 : 0),
          }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
      }
      return { ok: true, voices: hit.slice((page - 1) * limit, page * limit).map((x) => x.v || x), total: hit.length }
    }
    if (source === 'system') {
      const list = await sapi.listVoices()
      const pool = list.map((v) => ({
        id: v.name,
        name: v.name,
        hint: `本机语音 · ${v.culture || ''} ${v.gender || ''}`.trim(),
        scoreRaw: `${v.culture} ${v.gender}`,
      }))
      return {
        ok: true,
        voices: (keyword
          ? pool
              .map((v) => ({ v, s: Math.max(staticScore(v, norm(keyword)), norm(v.scoreRaw).includes(norm(keyword)) ? 50 : 0) }))
              .filter((x) => x.s > 0)
              .sort((a, b) => b.s - a.s)
              .slice(0, limit)
              .map((x) => x.v)
          : pool.slice(0, limit)
        ).map(({ scoreRaw, ...v }) => v),
      }
    }
    if (source === 'mimo' || source === 'openai') {
      const pool = STATIC_VOICES[source] || []
      const hit = keyword
        ? pool
            .map((v) => ({ v, s: staticScore(v, norm(keyword)) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s)
            .map((x) => x.v)
        : pool
      return { ok: true, voices: hit.slice(0, limit) }
    }
    return { ok: false, message: `未知的音色平台：${source}` }
  } catch (e) {
    return { ok: false, message: e.message || String(e) }
  }
}

/** 按策略聚合多个平台的搜索结果 */
async function searchEverywhere(unusedPolicyOrSources, opts = {}) {
  const { limit = 8 } = opts
  const sources = Array.isArray(unusedPolicyOrSources) && unusedPolicyOrSources.length
    ? unusedPolicyOrSources
    : ['mimo']
  const jobs = await Promise.all(sources.map((s) => searchSource(s, opts).then((r) => ({ source: s, r }))))
  const voices = []
  const errors = []
  for (const { source, r } of jobs) {
    if (!r.ok) errors.push(`${source}: ${r.message}`)
    else for (const v of r.voices) voices.push({ ...v, source })
  }
  return { ok: voices.length > 0, voices: voices.slice(0, limit), errors }
}

/* ------------------------------ 命令解析 ------------------------------ */

const FULLWIDTH_SHARP = '＃'

/**
 * 取某一类指令当前生效的叫法。
 * 用户可以在界面上改，改完存在 cfg.commands.voice 里。
 * 某一类被清空（或没配）时回落到内置叫法 —— 宁可多认一个词，
 * 也别因为配置空了让整条指令彻底失联。
 */
function commandNames(cfg, kind) {
  const custom = cfg?.commands?.voice?.[kind]
  const list = Array.isArray(custom) ? custom.filter((x) => String(x || '').trim()) : []
  return list.length ? list : COMMAND_ALIASES[kind] || []
}

/** 帮助信息里显示的名字 = 这类指令的第一个叫法（界面上叫「正名」） */
function primaryName(cfg, kind) {
  return commandNames(cfg, kind)[0] || COMMAND_ALIASES[kind]?.[0] || kind
}

/**
 * @param {string} text
 * @param {string|{prefix?:string, names?:Record<string,string[]>}} opts
 *  兼容老写法：第二个参数直接传前缀字符串也认。
 * @returns {null | {kind:string, arg:string, raw:string}}
 */
function parseCommand(text, opts = {}) {
  const o = typeof opts === 'string' ? { prefix: opts } : opts || {}
  const raw = String(text || '').trim()
  const p = o.prefix || '#'
  const hit = [p, FULLWIDTH_SHARP].find((x) => raw.startsWith(x))
  if (!hit) return null
  const body = raw.slice(hit.length).trim()
  if (!body) return null

  const m = body.match(/^(\S+)\s*([\s\S]*)$/)
  const head = norm(m ? m[1] : body)
  const arg = (m ? m[2] : '').trim()

  const names = o.names || COMMAND_ALIASES
  for (const [kind, fallback] of Object.entries(COMMAND_ALIASES)) {
    // 空数组 / 没配都回落内置叫法 —— 宁可多认一个词，也别让整条指令失联
    const aliases = Array.isArray(names[kind]) && names[kind].length ? names[kind] : fallback
    if (aliases.some((a) => norm(a) === head)) return { kind, arg, raw }
  }
  return null
}

/**
 * 帮助文本。名字要用当前生效的叫法，不然主播改了名、观众照帮助发却没反应。
 */
function helpText(opts = {}) {
  const o = typeof opts === 'string' ? { prefix: opts } : opts || {}
  const p = o.prefix || '#'
  const n = (kind) => primaryName(o.cfg, kind)
  return [
    `${p}${n('list')} 关键词 — 搜索在线音色`,
    `${p}${n('bind')} 音色名 — 选一个长期用`,
    `${p}${n('design')} 描述 — 用文字造专属音色`,
    `${p}${n('query')} — 查看当前绑定`,
    `${p}${n('unbind')} — 恢复默认音色`,
  ].join(' / ')
}

/* ------------------------------ 权限与配额 ------------------------------ */

function roleOf(ev) {
  if (ev?.isAdmin) return 'admin'
  if (ev?.medal?.name) return 'fans'
  return 'guest'
}

/**
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
function checkPermission(ev, policy, opts = {}) {
  // 房管（弹幕包里的 isAdmin）和主播（调用方比对 uid 后传 isPrivileged）不受任何开关限制。
  //
  // 主播身份**不能**从弹幕包里读：实测当前协议下 DANMU_MSG 不带 identities，
  // 而主播自己身上没有自己房间的粉丝牌（info[3] 为空）。所以这里留一个 isPrivileged
  // 入口给调用方 —— 不然一开「需要粉丝牌」，主播连自己都换不了音色。
  if (opts.isPrivileged || roleOf(ev) === 'admin') return { ok: true }
  if (policy?.requireMedal) {
    const level = Number(ev?.medal?.level) || 0
    const min = Number(policy.minMedalLevel) || 1
    // 文案别说成「才能换音色」：这条卡的是全部音色指令，帮助/查询也过不去
    if (level < min) return { ok: false, reason: `这个直播间设置了要 ${min} 级粉丝牌才能用音色指令` }
  }
  if (opts.need === 'design' && policy?.allowDesign === false) {
    return { ok: false, reason: '主播没有开放音色设计' }
  }
  if (opts.need === 'bind' && policy?.allowBind === false) {
    return { ok: false, reason: '主播没有开放音色绑定' }
  }
  // allowUnbind 一直是配了但没人读的死配置，界面/类型里都有、逻辑里没有。
  // 补上，免得以后真给它加开关了还是不生效。
  if (opts.need === 'unbind' && policy?.allowUnbind === false) {
    return { ok: false, reason: '主播没有开放自助取消音色' }
  }
  return { ok: true }
}

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function designQuota(state) {
  const limit = Number(state.limit) || 20
  const today = todayKey()
  if (state.date !== today) return { today, used: 0, ok: true }
  const used = Number(state.used) || 0
  return { today, used, ok: used < limit }
}

/* ------------------------------ 档案构造 ------------------------------ */

/** 把在线搜到的音色登记成本地档案 */
function profileFromVoice({ source, voice, ownerUid, ownerName, cfg }) {
  const preset = PROVIDERS[source] || {}
  return {
    id: uid(),
    owner: ownerUid ? 'audience' : 'host',
    ownerUid: ownerUid || 0,
    ownerName: ownerName || '',
    enabled: true,
    name: String(voice.name || voice.id).slice(0, 24),
    platform: source,
    provider: source,
    protocol: preset.protocol || 'chat-completions',
    baseUrl: String(preset.baseUrl || cfg?.tts?.baseUrl || ''),
    apiKey: source === 'openai' ? String(cfg?.platformKeys?.openai || '') : '',
    model: preset.models?.[0] || '',
    voice: voice.id,
    voiceHint: String(voice.hint || '').slice(0, 60),
    format: source === 'edge' ? 'mp3' : source === 'fish' ? 'mp3' : source === 'system' ? 'wav' : String(cfg?.tts?.format || 'wav'),
    speed: Number(cfg?.tts?.speed) || 1,
    stylePrompt: '',
    mimoMode: 'preset',
    designPrompt: '',
    cloneFile: '',
    createdAt: Date.now(),
  }
}

/**
 * 观众用自然语言造一个 MiMo voicedesign 音色。
 * prompt 是最终喂给模型的描述（可能已经过 LLM 扩写），
 * rawPrompt 留着观众的原话 —— 扩写跑偏时可以对照着看是哪一步的锅。
 */
function makeDesignProfile({ ownerUid, ownerName, prompt, tts, rawPrompt = '', expanded = false }) {
  return {
    id: uid(),
    owner: 'audience',
    ownerUid: ownerUid || 0,
    ownerName: ownerName || '',
    enabled: true,
    name: `${ownerName || '观众'}的专属音色`,
    platform: 'mimo',
    provider: 'mimo',
    protocol: 'chat-completions',
    baseUrl: String(tts?.baseUrl || PROVIDERS.mimo.baseUrl),
    apiKey: String(tts?.apiKey || ''),
    model: 'mimo-v2.5-tts-voicedesign',
    voice: '',
    voiceHint: '文字设计音色',
    format: String(tts?.format || 'wav'),
    speed: Number(tts?.speed) || 1,
    stylePrompt: '',
    mimoMode: 'design',
    designPrompt: String(prompt || '').slice(0, 300),
    rawPrompt: String(rawPrompt || '').slice(0, 120),
    expanded: Boolean(expanded),
    cloneFile: '',
    createdAt: Date.now(),
  }
}

/* ------------------------------ 库内查找 ------------------------------ */

function scoreProfile(p, kw) {
  const name = norm(p.name)
  const voice = norm(p.voice)
  const hint = norm(p.voiceHint)
  const meta = norm(`${p.platform || ''} ${p.model || ''} ${p.ownerName || ''}`)
  if (name === kw || voice === kw) return 100
  if (name.startsWith(kw) || voice.startsWith(kw)) return 80
  if (name.includes(kw) || voice.includes(kw)) return 60
  if (hint.includes(kw) || meta.includes(kw)) return 30
  return 0
}

function searchProfiles(library, keyword, limit = 8) {
  const pool = (library || []).filter((p) => p.enabled !== false)
  const kw = norm(keyword)
  if (!kw) return pool.slice(0, limit)
  return pool
    .map((p) => ({ p, s: scoreProfile(p, kw) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.p)
}

function findByName(library, name, { includeDisabled = false } = {}) {
  const pool = (library || []).filter((p) => includeDisabled || p.enabled !== false)
  const kw = norm(name)
  if (!kw) return null
  return pool.find((p) => norm(p.name) === kw || norm(p.voice) === kw) || searchProfiles(pool, kw, 1)[0] || null
}

function ownerLabel(profile) {
  return OWNER_LABEL[profile?.owner] || '未知'
}

module.exports = {
  COMMAND_ALIASES,
  DEFAULT_BASE,
  baseFor,
  searchSource,
  searchEverywhere,
  searchFish,
  parseCommand,
  helpText,
  commandNames,
  primaryName,
  roleOf,
  checkPermission,
  designQuota,
  profileFromVoice,
  makeDesignProfile,
  searchProfiles,
  findByName,
  ownerLabel,
  keyFor,
  uid,
}
