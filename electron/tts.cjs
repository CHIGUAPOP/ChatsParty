'use strict'

/**
 * TTS 适配层。
 * MiMo 走 OpenAI 兼容的 chat/completions（文本放 assistant、风格放 user）；
 * OpenAI 官方及多数第三方走 /audio/speech。两者都支持，界面上可自由填。
 */

const edge = require('./tts-edge.cjs')
const sapi = require('./tts-sapi.cjs')
const { httpRequest, httpJson, resolveMode, describeHttpError, describeNetError } = require('./lib/net.cjs')
const { normalizeKey, keySummary } = require('./lib/keytext.cjs')

/**
 * Fish Audio 的接口地址。
 *
 * 这里必须写清楚，因为来回踩过两次坑：
 *   - `fishaudio.org`（Kitta Audio）是**另一家公司**的同名产品，密钥与之不通用；
 *   - `fish.audio` 才是 Fish Audio 官方，API 走 `https://api.fish.audio`。
 * 两边产品名一样、Key 长得像，拿错平台一律 401/402，极容易误判成「Key 填错了」。
 *
 * 协议要点（以官方 openapi.json 为准，别再照抄旧文档）：
 *   - 合成 `POST /v1/tts`，模型放在 **model 请求头**（不是 body 字段）；
 *   - 音色是 **reference_id**（音色库里的 model id）；不给也能出声，用默认音色；
 *   - 音色列表是 `GET /model`（**没有 /v1 前缀**，旧文档里的 /v1/models 已 404）；
 *   - 身份/额度看 `GET /wallet/self/package`，API 额度另算（/wallet/self/api-credit）。
 *
 * 额度有两套，别混为一谈：
 *   平台额度（package.balance）→ 只有免费模型 `s2.1-pro-free` 能用；
 *   API 额度（api-credit）     → 付费模型（s2.1-pro / s1 / s2-pro）才扣这个。
 * 新账号 API 额度是 0，所以默认必须走 `s2.1-pro-free`，否则一定 402。
 */
const FISH_BASE = 'https://api.fish.audio'

const PROVIDERS = {
  edge: {
    id: 'edge',
    name: 'Edge 朗读（免费 · 免密钥）',
    protocol: 'edge-tts',
    baseUrl: '',
    needsKey: false,
    supportsStylePrompt: false,
    models: [],
    voices: [
      { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声（推荐）' },
      { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声（活泼）' },
      { id: 'zh-CN-YunxiNeural', label: '云希 · 男声（年轻）' },
      { id: 'zh-CN-YunyangNeural', label: '云扬 · 男声（播报）' },
      { id: 'zh-CN-YunjianNeural', label: '云健 · 男声（有力）' },
      { id: 'zh-CN-YunxiaNeural', label: '云夏 · 男声（少年）' },
      { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北话' },
      { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西话' },
      { id: 'zh-HK-HiuMaanNeural', label: '曉曼 · 粤语女声' },
      { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾国语女声' },
    ],
    formats: ['mp3'],
    note: '走微软 Edge「大声朗读」接口，无需 API Key、不限量。首次使用会拉取完整音色表（300+），中文音色在「音色」下拉里挑即可。',
  },
  system: {
    id: 'system',
    name: '系统语音（本地 · 离线）',
    protocol: 'sapi',
    baseUrl: '',
    needsKey: false,
    supportsStylePrompt: false,
    models: [],
    voices: [],
    formats: ['wav'],
    note: '调用 Windows 系统已安装的语音，完全离线、不联网、零延迟。音色取决于系统里装了什么，点「刷新本机音色」查看。',
  },
  mimo: {
    id: 'mimo',
    name: '小米 MiMo',
    protocol: 'chat-completions',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    models: ['mimo-v2.5-tts', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts-voiceclone'],
    voices: [
      { id: 'mimo_default', label: 'MiMo-默认' },
      { id: '冰糖', label: '冰糖 · 女声' },
      { id: '茉莉', label: '茉莉 · 女声' },
      { id: '苏打', label: '苏打 · 男声' },
      { id: '白桦', label: '白桦 · 男声' },
      { id: 'Mia', label: 'Mia · 英文女声' },
      { id: 'Chloe', label: 'Chloe · 英文女声' },
      { id: 'Milo', label: 'Milo · 英文男声' },
      { id: 'Dean', label: 'Dean · 英文男声' },
    ],
    formats: ['wav', 'mp3', 'pcm16'],
    note: '限时免费。合成文本必须放在 assistant 消息，风格指令放 user 消息。',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'audio-speech',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
    voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'].map((v) => ({
      id: v,
      label: v,
    })),
    formats: ['mp3', 'wav', 'opus', 'flac'],
    note: '标准 /v1/audio/speech 接口。',
  },
  fish: {
    id: 'fish',
    name: 'Fish Audio（fish.audio · 在线音色库）',
    protocol: 'fish-tts',
    baseUrl: FISH_BASE,
    needsKey: true,
    supportsStylePrompt: false,
    canSearch: true,
    // 官方 openapi.json 里 /v1/tts 的 model 请求头枚举值。
    // s2.1-pro-free 走平台额度（新账号默认有），其余走 API 额度。
    models: ['s2.1-pro-free', 's2.1-pro', 's1', 's2-pro'],
    voices: [], // 没有固定列表，走 GET /model 实时搜
    formats: ['mp3', 'wav'],
    note: 'fish.audio 官方 API。音色库里的音色可直接引用，不用先克隆到自己账号；不绑音色也能用默认音色出声。',
  },
  custom: {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    protocol: 'chat-completions',
    baseUrl: '',
    models: [],
    voices: [],
    formats: ['wav', 'mp3'],
    note: '自行填写 Base URL、模型与音色，协议可选 chat/completions 或 audio/speech。',
  },
}

const MIME = { wav: 'audio/wav', mp3: 'audio/mpeg', opus: 'audio/ogg', flac: 'audio/flac', pcm16: 'audio/wav' }

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

const fs = require('node:fs')

/* -------------------- MiMo 音色复刻样本 -------------------- */

const cloneCache = new Map() // key → data URI，值是几 MB 的字符串，缓存别开太大

/**
 * 复刻音色每次请求都要把样本塞进 audio.voice，格式
 * `data:audio/mpeg;base64,<...>`，官方文档给的上限是 base64 后 10 MB。
 * 同一个文件重复读盘太浪费，用 mtime+size 做 key 缓存一跳。
 */
function cloneDataUri(file) {
  const p = String(file || '').trim()
  if (!p) throw new Error('这个音色缺少复刻用的音频样本')
  if (!fs.existsSync(p)) throw new Error(`复刻样本找不到了：${p}`)

  const stat = fs.statSync(p)
  const key = `${p}|${stat.mtimeMs}|${stat.size}`
  const hit = cloneCache.get(key)
  if (hit) return hit

  const ext = p.split('.').pop().toLowerCase()
  const mime = ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : null
  if (!mime) throw new Error('复刻样本只支持 mp3 或 wav')

  const b64 = fs.readFileSync(p).toString('base64')
  if (b64.length > 10 * 1024 * 1024) {
    throw new Error('复刻样本太大了，base64 后不能超过 10 MB')
  }

  const uri = `data:${mime};base64,${b64}`
  if (cloneCache.size > 2) cloneCache.delete(cloneCache.keys().next().value)
  cloneCache.set(key, uri)
  return uri
}

async function synthChatCompletions(cfg, text, style) {
  const base = normalizeBase(cfg.baseUrl)
  if (!base) throw new Error('请先填写 TTS 的 Base URL')

  const messages = []
  const audio = { format: cfg.format || 'wav' }
  let model = cfg.model

  if (cfg.mimoMode === 'design') {
    // voicedesign 没有可持久的 voice id，每次都得把描述文本当 user 消息重算一遍
    model = cfg.model || 'mimo-v2.5-tts-voicedesign'
    const desc = String(cfg.designPrompt || '').trim()
    if (desc) messages.push({ role: 'user', content: desc })
    messages.push({ role: 'assistant', content: text })
    // 注意：不能传预置音色名，否则会被当成「音色设计 + 预置音色」的非法组合
  } else if (cfg.mimoMode === 'clone') {
    model = cfg.model || 'mimo-v2.5-tts-voiceclone'
    if (style) messages.push({ role: 'user', content: style })
    messages.push({ role: 'assistant', content: text })
    audio.voice = cloneDataUri(cfg.cloneFile)
  } else {
    if (style) messages.push({ role: 'user', content: style })
    messages.push({ role: 'assistant', content: text })
    if (cfg.voice) audio.voice = cfg.voice
  }

  const url = `${base}/chat/completions`
  const key = normalizeKey(cfg.apiKey)
  const res = await httpJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model, messages, audio, stream: false }),
    timeoutMs: 60000,
    mode: resolveMode(cfg.provider, cfg),
  })

  const json = res.data
  if (!res.ok) {
    const label = cfg.provider === 'mimo' ? '小米 MiMo' : 'TTS 服务'
    const msg = json?.error?.message || json?.message || ''
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        describeHttpError(res.status, res.text, { label, keySummary: keySummary(key) }),
      )
    }
    throw new Error(`TTS 请求失败：${msg || `HTTP ${res.status} ${String(res.text || '').slice(0, 160)}`}`)
  }
  const data =
    json?.choices?.[0]?.message?.audio?.data || json?.audio?.data || json?.data?.[0]?.audio || ''
  if (!data) throw new Error('TTS 未返回音频数据，请检查模型名与音色是否匹配')
  return { base64: data, mime: MIME[cfg.format] || 'audio/wav' }
}

async function synthAudioSpeech(cfg, text, style) {
  const base = normalizeBase(cfg.baseUrl)
  if (!base) throw new Error('请先填写 TTS 的 Base URL')
  const body = {
    model: cfg.model,
    input: style ? `${style}\n${text}` : text,
    voice: cfg.voice || 'alloy',
    response_format: cfg.format || 'mp3',
  }
  if (cfg.speed) body.speed = Number(cfg.speed)

  const key = normalizeKey(cfg.apiKey)
  const res = await httpRequest(`${base}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'api-key': key,
    },
    body: JSON.stringify(body),
    timeoutMs: 60000,
    mode: resolveMode(cfg.provider, cfg),
  })

  if (!res.ok) {
    throw new Error(
      describeHttpError(res.status, res.text, {
        label: cfg.provider === 'openai' ? 'OpenAI' : 'TTS 服务',
        keySummary: keySummary(key),
      }),
    )
  }
  return { base64: res.buffer.toString('base64'), mime: MIME[cfg.format] || 'audio/mpeg' }
}

/* -------------------- 免费 / 本地提供方 -------------------- */

function synthEdge(cfg, text) {
  return edge.synthesize(cfg, text)
}

function synthSapi(cfg, text) {
  // 界面上是 0~1 的音量 + 倍速，换算成 SAPI 的 0~100 / -10~10
  const volume = Math.round((Number(cfg.volume) || 0) * 100)
  const rate = Math.round((Number(cfg.speed) || 1) * 4) - 4 // 1.0 → 0（正常）
  return sapi.synthesize({ voice: cfg.voice, volume, rate }, text)
}

/**
 * Fish（fish.audio 官方 API）：音色库里任一音色的 id 都能直接引用，不必先克隆到自己账号。
 * 模型走 **model 请求头**，不是 body 字段。
 */
const FISH_MODELS = PROVIDERS.fish.models

/**
 * 换个模型再试一次的状态码。
 * 402 最常见：API 额度为 0 时付费模型全拒，但免费模型 s2.1-pro-free 还能出声 —— 必试。
 * 401 换个模型往往也还是 401，但成本极低，留着。
 * **403 不重试**：403 是这把 Key 根本没有 TTS 权限，换任何模型都是同一个结果，
 * 逐个试一遍只会白白多花几次请求、让人等更久。
 */
const FISH_RETRY_STATUS = new Set([401, 402, 404, 422, 429])

function fishModelChain(primary) {
  // 免费模型放最前：新账号 API 额度是 0，只有它能出声
  const want = [primary, 's2.1-pro-free', 's2.1-pro', 's1', 's2-pro']
  return want.filter((m, i) => m && want.indexOf(m) === i)
}

/**
 * 把一次失败的合成翻译成「哪儿错了 + 现在做什么」。
 *
 * 刻意写得短：这里的话最终会一字不差地弹在用户眼前，用户要的是下一步动作，
 * 不是诊断过程。模型名、平台内部错误码、状态码明细、账户配额这类中间信息不进这句话，
 * 它们各自以结构化字段返回（tried / account），由界面单独排版。
 */
function fishError(res, key) {
  if (res.status === 403) {
    // 403 在这家平台是「没权限」，不是「Key 错了」—— 解决办法完全不同，不能混着说
    return 'Fish 拒绝了这次合成（HTTP 403）：这把 Key 有效，但它没有 TTS 权限。去 fish.audio 的账户页确认后重试。'
  }
  if (res.status === 402) {
    // 平台额度与 API 额度是两笔账，这里必须把「去哪充值」说准
    return 'Fish 的 API 额度用完了（HTTP 402）。去 fish.audio/app/developers 充值，或把模型改成免费档 s2.1-pro-free。'
  }
  if (res.status === 404) {
    return '这个音色不存在（HTTP 404）。去「音色」页重新搜一个并绑定。'
  }
  if (res.status === 400) {
    return 'Fish 说请求参数不对（HTTP 400）：多半是音色 id 不对或已经失效，去「音色」页重新搜一个并绑定。'
  }
  if (res.status === 401) {
    // 这家平台 401 的头号原因是拿错平台的 Key（fishaudio.org 同名），先点破这一层
    return 'Fish 不认这把 Key（HTTP 401）：fishaudio.org 是另一家平台，密钥不能互换。去 fish.audio/app/developers 重新生成一把，整段粘贴回来再校验。'
  }
  return describeHttpError(res.status, res.text, { label: 'Fish Audio', keySummary: keySummary(key) })
}

/**
 * 组装 /v1/tts 的请求体。
 * 只写 openapi 里明确列出的字段，而且**空值一律不发** —— 平台对多余字段和空串很敏感。
 */
function fishBody(cfg, text) {
  const body = {
    text: String(text || '').slice(0, 10000),
    format: cfg.format || 'mp3',
  }
  // 音色可以留空：不给 reference_id 会用默认音色出声，不是错误
  const voice = String(cfg.voice || '').trim()
  if (voice) body.reference_id = voice

  // prosody：speed 0.5~2.0，volume 是 dB 增减。项目里的 volume 是 0~1，要换算。
  // 超出范围的宁可不发，让平台用默认值，也不要去赌一个 400。
  const prosody = {}
  const speed = Number(cfg.speed)
  if (Number.isFinite(speed) && speed >= 0.5 && speed <= 2) prosody.speed = speed
  const vol = Number(cfg.volume)
  if (Number.isFinite(vol) && vol > 0 && vol <= 1) prosody.volume = Math.round((vol - 1) * 20)
  if (Object.keys(prosody).length) body.prosody = prosody
  return body
}

async function synthFish(cfg, text) {
  // 密钥统一走清洗：把零宽字符 / 全角空格 / 误抄的 Bearer 前缀去掉，
  // 这类「看起来一模一样但就是 401」的坑占了一大半
  const key = normalizeKey(cfg.apiKey)
  if (!key) throw new Error('请先填写 Fish Audio 的 API Key')

  const base = normalizeBase(cfg.baseUrl) || FISH_BASE
  const primary = String(cfg.model || '').trim() || 's2.1-pro-free'
  const chain = fishModelChain(primary)
  const tried = []
  let last = null

  for (const modelId of chain) {
    let res
    try {
      res = await httpRequest(`${base}/v1/tts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          model: modelId,
        },
        body: JSON.stringify(fishBody(cfg, text)),
        timeoutMs: 60000,
        mode: resolveMode('fish', cfg),
      })
    } catch (e) {
      tried.push({ model: modelId, status: 0, message: e.message || String(e) })
      last = e
      continue
    }
    if (res.ok && res.buffer.length) {
      // 兜底模型顶上了：告诉调用方，好让它把这个模型记下来，下次别再白试一遍
      return {
        base64: res.buffer.toString('base64'),
        mime: MIME[cfg.format] || 'audio/mpeg',
        model: modelId,
        fallback: modelId !== primary,
      }
    }
    const message = fishError(res, key)
    tried.push({ model: modelId, status: res.status, message })
    // 403 = 没有 TTS 权限，换模型没意义，直接把结论抛出去
    if (res.status === 403) throw new Error(message)
    if (!res.ok && FISH_RETRY_STATUS.has(res.status)) {
      last = new Error(message)
      continue
    }
    throw new Error(message)
  }

  // 每个模型的失败原因都已经收在 tried 里（界面会把「模型 → HTTP 状态」列出来），
  // 这里只抛最后一条 —— 它已经是人话，不必再套一层「试过哪几个模型」的外壳
  if (last) throw last
  throw new Error(`Fish 合成没成功：换过 ${tried.length} 个模型都没出声，先确认网络能访问 fish.audio。`)
}

/**
 * 真·连通性自检：先验身份，再真合成一次。
 *
 * 为什么要分两步：这两种失败的表现一样（都播不出声），但解决办法毫不相干 ——
 *   钱包接口就 401        → Key 本身不被接受（填错 / 过期 / 是另一家平台发的）
 *   钱包 200、合成 402    → Key 有效，但 API 额度为 0（新账号默认如此，改用免费模型即可）
 *   钱包 200、合成 403    → Key 有效，但没有 TTS 权限（套餐不含）
 *
 * 报出来的话只讲「哪儿错了 + 现在做什么」，模型名 / 状态码明细 / 账户配额
 * 都不进 message —— 它们各自有结构化字段，界面会单独排版。
 */
async function probeFish(cfg, opts = {}) {
  const key = normalizeKey(cfg.apiKey)
  const base = normalizeBase(cfg.baseUrl) || FISH_BASE
  const out = { ok: false, account: null, tried: [], workingModel: '', bytes: 0, message: '' }
  if (!key) {
    out.message = '还没填 Fish Audio 的 API Key'
    return out
  }
  const mode = resolveMode('fish', cfg)

  // 第一步：钱包接口。只验身份 —— 不需要音色，也不消耗额度
  let acc
  try {
    acc = await httpJson(`${base}/wallet/self/package`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      timeoutMs: 15000,
      mode,
    })
  } catch (e) {
    out.account = 0
    out.message = String(describeNetError(e, `${base}/wallet/self/package`).message)
    return out
  }
  out.account = acc.status
  if (!acc.ok) {
    // 身份这关就没过，不必再去撞合成 —— 那只会再换回一个同样看不懂的 401
    out.message =
      `Fish 不认这把 Key（HTTP ${acc.status}）。` +
      '这把 Key 必须是在 fish.audio 生成的：fishaudio.org 是另一家平台，两边的密钥不能互换。' +
      '去 fish.audio/app/developers 重新生成一把，整段粘贴回来、点「保存」，再校验一次。'
    return out
  }

  // 第二步：真合成。这家平台不给 reference_id 也能出声（用默认音色），
  // 所以没绑音色照样能验到底通不通 —— 绑了就顺带验音色本身。
  const voiceId = String(opts.voiceId || cfg.voice || '').trim()
  const chain = fishModelChain(String(cfg.model || '').trim() || 's2.1-pro-free')
  for (const modelId of chain) {
    let res
    try {
      res = await httpRequest(`${base}/v1/tts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          model: modelId,
        },
        body: JSON.stringify({ text: opts.text || '好', format: 'mp3', ...(voiceId ? { reference_id: voiceId } : {}) }),
        timeoutMs: 30000,
        mode,
      })
    } catch (e) {
      out.tried.push({ model: modelId, status: 0, message: String(describeNetError(e, `${base}/v1/tts`).message) })
      continue
    }
    out.tried.push({ model: modelId, status: res.status, message: res.ok ? '成功' : fishError(res, key) })
    if (res.ok && res.buffer.length) {
      out.ok = true
      out.workingModel = modelId
      out.bytes = res.buffer.length
      break
    }
    if (!FISH_RETRY_STATUS.has(res.status)) break
  }

  if (out.ok) {
    out.message = voiceId
      ? `合成实测通过：出了 ${out.bytes} 字节音频，这把 Key 和当前音色都能正常用。`
      : `合成实测通过：出了 ${out.bytes} 字节音频（用的默认音色）。想换成别的音色，去「音色库」搜一个绑定。`
    return out
  }

  // 合成失败：只报最后一个具体原因。
  // fishError / describeNetError 给出的已经是「哪儿错了 + 现在做什么」，
  // 再拼上「试过哪几个模型」「账户还剩多少配额」只会把重点淹掉 ——
  // 那些中间信息都在 out.tried 里，界面自己要展示就展示。
  const last = out.tried[out.tried.length - 1]
  out.message = (last && last.message) || '合成没成功，先确认网络能访问 fish.audio。'
  return out
}

async function synthesize(cfg, text, style) {
  const protocol = cfg.protocol || PROVIDERS[cfg.provider]?.protocol || 'chat-completions'
  switch (protocol) {
    case 'edge-tts':
      return synthEdge(cfg, text, style)
    case 'sapi':
      return synthSapi(cfg, text, style)
    case 'fish-tts':
      return synthFish(cfg, text, style)
    case 'audio-speech':
      return synthAudioSpeech(cfg, text, style)
    default:
      return synthChatCompletions(cfg, text, style)
  }
}

/**
 * 动态音色：Edge 走在线音色表，系统语音读注册表里已安装的。
 * 失败时回退到内置列表，不阻塞界面。
 */
async function listVoices(provider, { force } = {}) {
  if (provider === 'system') {
    const list = await sapi.listVoices()
    return list.length ? list : PROVIDERS.system.voices
  }
  if (provider === 'edge') {
    try {
      const all = await edge.listVoices({ force })
      const zh = all.filter((v) => /^zh/i.test(v.locale || ''))
      const rest = all.filter((v) => !/^zh/i.test(v.locale || ''))
      return [...zh, ...rest] // 中文排前面
    } catch {
      return PROVIDERS.edge.voices
    }
  }
  return null
}

module.exports = {
  PROVIDERS,
  synthesize,
  normalizeBase,
  listVoices,
  probeFish,
  synthFish,
  FISH_MODELS,
  FISH_BASE,
}
