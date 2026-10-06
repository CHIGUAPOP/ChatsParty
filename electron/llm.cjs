'use strict'

/**
 * 音色描述扩写。
 *
 * 观众在弹幕里写的「来个御姐音」通常只有三四个字，直接丢给 MiMo 的
 * voicedesign 模型，出来的声音全凭运气 —— 缺的维度（年龄、厚薄、共鸣、
 * 语速、录音质感）会让模型自由发挥，两次生成可能完全不像同一个人。
 *
 * 所以这里先让一个文本 LLM 按固定公式把粗糙要求补全成一段结构化描述：
 *   年龄/性别/口音 → 明暗厚薄虚实粗细 → 共鸣与咬字 → 语速语气 → 质感与距离 → 职业锚点
 * 补全后的文本再交给 TTS 的音色设计模型，命中率稳定得多。
 *
 * 扩写失败（没填 Key、超时、Key 无效）时一律回落到用户原话，绝不阻断设计流程。
 */

const { httpJson, describeHttpError, resolveMode } = require('./lib/net.cjs')
const { normalizeKey, keySummary } = require('./lib/keytext.cjs')

/** 各家文本大模型。默认 DeepSeek：国内直连、便宜、指令跟随够用。 */
const LLM_PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek（默认）',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '国内直连，无需代理。deepseek-chat 足够写音色描述，reasoner 会慢很多。',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '国内被 DNS 污染，需要走系统代理（外网请求保持「自动」即可）。',
  },
  moonshot: {
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: '国内直连。8k 上下文写一段描述绰绰有余。',
  },
  zhipu: {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: '国内直连，glm-4-flash 有免费额度。',
  },
  siliconflow: {
    id: 'siliconflow',
    label: 'SiliconFlow 硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '国内直连，模型多，有免费额度。',
  },
  dashscope: {
    id: 'dashscope',
    label: '阿里通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    note: '国内直连。走 OpenAI 兼容模式。',
  },
  custom: {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    defaultModel: '',
    keyUrl: '',
    note: '任何实现了 /v1/chat/completions 与 /v1/models 的中转或本地服务（Ollama、One-API、vLLM 等）。',
  },
}

/** 用户给的公式。补全时每个方括号只填一个短语。 */
const DESIGN_FORMULA = [
  '[年龄]的[性别]，说[语言/口音]。',
  '音色[明暗]、[厚薄]、[虚实]、[粗细]。',
  '[共鸣位置]发声，咬字[清晰度]。',
  '语速[快慢]，语气[情绪]。',
  '[录音质感]，[距离感]。',
  '整体感觉像[职业锚点]。',
].join('\n')

function defaultTemplate() {
  return [
    '你是一个专门为语音合成（TTS）撰写「音色描述」的助手。',
    '我会给你一段观众随口写的、通常很粗糙的音色要求。你要把它补全成一段可以直接喂给 TTS 音色设计模型的中文描述。',
    '',
    '严格按下面这个公式逐项补全，把所有方括号替换成具体内容，最终只输出补全后的正文：',
    '',
    DESIGN_FORMULA,
    '',
    '规则：',
    '1. 观众没提到的维度，按他给的风格合理推断，不要写「未知」「无」「随意」。',
    '2. 每个方括号只填 2~6 个字的中文短语，不要写整句，不要保留方括号。',
    '3. 只输出一段纯文本：不要 Markdown、不要引号、不要序号、不要解释、不要前后缀。',
    '4. 总长度控制在 60~120 字。',
    '5. 观众明确指定的性别、年龄、方言必须原样保留，不能自行改掉。',
    '6. 直接给出补全结果，不要逐步推理、不要打草稿、不要输出任何解释。',
  ].join('\n')
}

/** 明显不是用来写字的模型，检测列表时滤掉，免得选了半天选到个 TTS 模型 */
const NON_CHAT = /embed|whisper|tts|dall|image|moderation|rerank|realtime|speech|audio|vision|ocr|video|embedding/i

function providerOf(cfg) {
  const l = cfg?.llm || {}
  const id = String(l.provider || 'deepseek')
  return LLM_PROVIDERS[id] || (id === 'custom' ? LLM_PROVIDERS.custom : LLM_PROVIDERS.deepseek)
}

function baseFor(cfg) {
  const l = cfg?.llm || {}
  const custom = String(l.baseUrl || '').trim().replace(/\/+$/, '')
  return custom || providerOf(cfg).baseUrl
}

function keyFor(cfg) {
  return normalizeKey(cfg?.llm?.apiKey)
}

function modelFor(cfg) {
  const l = cfg?.llm || {}
  return String(l.model || '').trim() || providerOf(cfg).defaultModel
}

/**
 * 能不能用。缺任一样都算没配好，调用方据此决定要不要回落。
 * @returns {{ok:boolean, reason?:string}}
 */
function ready(cfg) {
  const l = cfg?.llm || {}
  if (l.enabled === false) return { ok: false, reason: 'LLM 扩写已关闭' }
  if (!keyFor(cfg)) return { ok: false, reason: '还没填 LLM 的 API Key' }
  if (!baseFor(cfg)) return { ok: false, reason: 'LLM 接口地址为空' }
  if (!modelFor(cfg)) return { ok: false, reason: '还没选 LLM 模型' }
  return { ok: true }
}

/**
 * 把 LLM 的回话洗成可以直接当音色描述的一段纯文本。
 * 模型爱加 ```、引号、序号、前后缀，这些东西进了 TTS 会被当成描述的一部分念出来。
 */
function sanitize(raw) {
  let s = String(raw == null ? '' : raw)
  // 只摘掉围栏符号本身，别把围栏里的正文一起删了
  s = s.replace(/```[a-zA-Z0-9_+.-]*\s*/g, ' ').replace(/`/g, '')
  // 「描述：」「音色描述：」这类前缀
  s = s.replace(/^\s*(补全后的)?音色?描述\s*[:：]\s*/i, '')
  s = s.replace(/[【】]/g, '')
  // 公式里的方括号如果没被替换掉，剥掉壳留下内容
  s = s.replace(/\[([^\]\n]{0,12})\]/g, (_m, inner) => inner)
  s = s.replace(/[\r\n]+/g, ' ')
  s = s.replace(/^\s*[0-9]+[.、)]\s*/gm, '')
  s = s.replace(/\s{2,}/g, ' ')
  s = s.replace(/^[\s"'`“”‘’「」]+|[\s"'`“”‘’「」]+$/g, '')
  s = s.trim()
  return s.length > 300 ? s.slice(0, 300) : s
}

/**
 * 拉一次模型列表。这是「模型名到底填什么」唯一可靠的答案来源 ——
 * 各家随时在上下架模型，写死一份名单只会过期。
 */
async function listModels(cfg, opts = {}) {
  const l = cfg?.llm || {}
  const p = providerOf(cfg)
  const base = baseFor(cfg)
  const key = keyFor(cfg)
  const out = { ok: false, provider: p.id, label: p.label, base, models: [], status: 0, message: '' }
  if (!base) {
    out.message = '还没有接口地址'
    return out
  }
  if (!key) {
    out.message = `还没填 ${p.label} 的 API Key`
    return out
  }
  let res
  try {
    res = await httpJson(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      timeoutMs: Number(opts.timeoutMs) || 15000,
      mode: resolveMode(p.id, cfg),
    })
  } catch (e) {
    out.message = e.message || String(e)
    return out
  }
  out.status = res.status
  if (!res.ok) {
    out.message = describeHttpError(res.status, res.text, {
      label: p.label,
      keySummary: keySummary(key),
      hint: '有些中转不开放 /models，这时在模型那一栏手动填模型名即可。',
    })
    return out
  }
  const raw = Array.isArray(res.data?.data) ? res.data.data : Array.isArray(res.data) ? res.data : []
  const ids = [...new Set(raw.map((x) => String((typeof x === 'string' ? x : x?.id) || '')).filter(Boolean))]
  const chat = ids.filter((id) => !NON_CHAT.test(id))
  out.models = (chat.length ? chat : ids).sort()
  out.ok = out.models.length > 0
  out.message = out.ok
    ? `${p.label} 返回 ${out.models.length} 个可用模型${chat.length && chat.length < ids.length ? `（已过滤掉 ${ids.length - chat.length} 个非对话模型）` : ''}`
    : '平台返回了空的模型列表，在模型那一栏手动填模型名试试'
  return out
}

/**
 * 推理模型的思考过程（reasoning_content）会**占用 max_tokens 预算**。
 * 实测 DeepSeek-V4.1-Flash 是个混合模型：多数请求不思考，但碰到「机器人音效」这种
 * 少见描述就会启动思考，一口气烧掉 301 个 token —— 预算 320 的话正文只剩一句就被掐断。
 * 所以：默认关掉思考（见 THINK_OFF），预算给宽，真被掐断了再自动加预算重试一次。
 */
const DEFAULT_MAX_TOKENS = 1200

/**
 * 关掉思考。各家字段名不统一，索性一次都发过去 —— 不认识的字段会被忽略。
 * 实测（DeepSeek-V4.1-Flash，max_tokens=320，6 个用例）：
 *   不关：5/6 成功，平均思考 50 tok，1195ms
 *   关掉：6/6 成功，思考 0 tok，1023ms，且更快
 * 注意 reasoning_effort 只能填 'none'：填 low/minimal 反而会强制思考，
 * 实测烧满 1200 tok、耗时 7 秒、正文一个字没有。
 */
const THINK_OFF = {
  reasoning_effort: 'none',
  thinking: { type: 'disabled' },
  chat_template_kwargs: { enable_thinking: false },
  enable_thinking: false,
}

function wantThinkOff(cfg, opts) {
  if (opts && opts.noThink !== undefined) return opts.noThink !== false
  return cfg?.llm?.noThink !== false
}

function buildBody(cfg, messages, opts, thinkOff) {
  const body = {
    model: modelFor(cfg),
    messages,
    stream: false,
    temperature: Number(opts.temperature) || 0.8,
    max_tokens: Number(opts.maxTokens) || DEFAULT_MAX_TOKENS,
  }
  if (thinkOff) Object.assign(body, THINK_OFF)
  return body
}

/** 一次最小的对话，用来确认「Key + 模型名」这一组合真的能出字 */
async function chat(cfg, messages, opts = {}) {
  const p = providerOf(cfg)
  const base = baseFor(cfg)
  const key = keyFor(cfg)
  const timeoutMs = Number(opts.timeoutMs) || 20000
  const thinkOff = wantThinkOff(cfg, opts)

  const send = (body) =>
    httpJson(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      timeoutMs,
      mode: resolveMode(p.id, cfg),
    })

  let res = await send(buildBody(cfg, messages, opts, thinkOff))
  // 个别平台/中转对不认识的字段很严格，会直接 400。那就把关闭参数去掉再发一次
  if (!res.ok && res.status === 400 && thinkOff) {
    const retry = await send(buildBody(cfg, messages, opts, false))
    if (retry.ok || retry.status !== 400) res = retry
  }
  if (!res.ok) {
    throw new Error(
      describeHttpError(res.status, res.text, {
        label: p.label,
        keySummary: keySummary(key),
        hint: '也可能是模型名在这家平台上不存在，点「检测模型列表」选一个。',
      }),
    )
  }
  const c = res.data?.choices?.[0]
  const content = typeof c?.message?.content === 'string' ? c.message.content : String(c?.text || '')
  const thinking = String(c?.message?.reasoning_content || '')
  const finish = String(c?.finish_reason || '')
  if (!content.trim()) {
    // 空正文 + 一大段思考 = 预算被思考吃光了。这是「明明配好了却没结果」最常见的一种
    if (thinking.trim()) {
      throw retryable(
        `${p.label} 的思考占满了输出预算，正文一个字都没出来。把「最大输出」调大到 1200 以上，或换一个不思考的模型。`,
      )
    }
    throw new Error(`${p.label} 返回了空内容，再试一次。`)
  }
  // finish_reason=length 说明话没说完就被掐断 —— 公式只补全了一半，这种半成品不能用
  if (finish === 'length') {
    throw retryable(`${p.label} 的输出被「最大输出」上限掐断了，描述没写完。把它调大一点再试。`)
  }
  return content
}

/** 标一下「这个错误加大预算重试一次大概率能救回来」 */
function retryable(message) {
  const e = new Error(message)
  e.retryable = true
  return e
}

/**
 * 公式有没有补全。正常输出是 6 句（年龄性别 / 音色 / 共鸣咬字 / 语速语气 / 质感距离 / 职业锚点），
 * 被掐断时往往只剩两三句 —— 那种半成品能用但明显更差，值得再试一次。
 */
function complete(text) {
  const sentences = (String(text || '').match(/[。！？]/g) || []).length
  return sentences >= 4
}

/**
 * 把粗糙的音色要求补全成结构化描述。
 * @returns {Promise<{ok:boolean, used:boolean, text:string, raw?:string, model?:string, message?:string}>}
 *   used=false 表示没走 LLM（没配好或失败了），text 是原话 —— 调用方照用不误
 */
async function expandDesign(rough, cfg) {
  const text = String(rough || '').trim()
  if (!text) return { ok: false, used: false, text: '', message: '没有可扩写的描述' }
  const st = ready(cfg)
  if (!st.ok) return { ok: false, used: false, text, message: st.reason }

  const l = cfg?.llm || {}
  const tpl = String(l.promptTemplate || '').trim() || defaultTemplate()
  const ask = (maxTokens) =>
    chat(
      cfg,
      [
        { role: 'system', content: tpl },
        { role: 'user', content: `观众的原话：${text}\n\n补全后的音色描述：` },
      ],
      {
        temperature: Number(l.temperature) || 0.8,
        maxTokens,
        timeoutMs: Number(l.timeoutMs) || 20000,
      },
    )

  const budget = Number(l.maxTokens) || DEFAULT_MAX_TOKENS
  let partial = null
  let lastErr = null

  // 最多两轮：第二轮把预算翻倍，专门救「思考吃掉额度 / 输出被掐断」这两种情况
  for (const tokens of [budget, Math.max(budget * 2, DEFAULT_MAX_TOKENS * 2)]) {
    try {
      const raw = await ask(tokens)
      const clean = sanitize(raw)
      if (!clean) {
        lastErr = new Error('LLM 返回的内容清洗后是空的')
        continue
      }
      if (complete(clean)) {
        return { ok: true, used: true, text: clean, raw, model: modelFor(cfg), tokens }
      }
      // 补全不完全（多半被掐断），先留着，交给第二轮；第二轮还是这样也认了 —— 总比用原话强
      partial = { text: clean, raw, tokens }
    } catch (e) {
      lastErr = e
      if (!e || !e.retryable) break
    }
  }

  if (partial) return { ok: true, used: true, ...partial, model: modelFor(cfg), truncated: true }
  throw lastErr || new Error('扩写失败')
}

/**
 * 自检：先拿模型列表（顺带验 Key），列表拿不到就直接发一句话验模型名。
 * @returns {Promise<{ok:boolean, message:string, models:string[], status?:number}>}
 */
async function check(cfg) {
  const p = providerOf(cfg)
  if (!keyFor(cfg)) return { ok: false, provider: p.id, models: [], message: `还没填 ${p.label} 的 API Key` }
  if (!baseFor(cfg)) return { ok: false, provider: p.id, models: [], message: '还没有接口地址' }

  const list = await listModels(cfg)
  if (list.ok) {
    const model = modelFor(cfg)
    const hit = list.models.some((m) => m === model)
    return {
      ok: hit,
      provider: p.id,
      models: list.models,
      status: list.status,
      message: hit
        ? `${p.label} 认这把 Key（HTTP ${list.status}），模型 ${model} 在列表里 · ${keySummary(keyFor(cfg))}`
        : `${p.label} 认这把 Key，但列表里没有「${model}」—— 点「检测模型列表」换一个`,
    }
  }
  // 列表接口不通不代表不能用：很多中转只开放 chat，不开放 models
  try {
    // 预算不能给小：推理模型的思考要吃几百个 token，给 8 的话正文必然是空的，
    // 会把「明明能用」的模型误判成不能用（实测 DeepSeek-V4.1-Flash 光思考就烧 232）
    const content = await chat(cfg, [{ role: 'user', content: '只回复两个字：可用' }], {
      maxTokens: DEFAULT_MAX_TOKENS,
    })
    return {
      ok: true,
      provider: p.id,
      models: [],
      message: `模型 ${modelFor(cfg)} 能出字（回话：${String(content).trim().slice(0, 10)}）。列表接口没开放，模型名要手动填。`,
    }
  } catch (e) {
    return { ok: false, provider: p.id, models: [], message: e.message || String(e) }
  }
}

module.exports = {
  LLM_PROVIDERS,
  DESIGN_FORMULA,
  DEFAULT_MAX_TOKENS,
  THINK_OFF,
  buildBody,
  defaultTemplate,
  complete,
  providerOf,
  baseFor,
  keyFor,
  modelFor,
  ready,
  sanitize,
  listModels,
  chat,
  expandDesign,
  check,
}
