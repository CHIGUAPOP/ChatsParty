import React from 'react'
import { api, AppConfig, LlmProvider, VoiceProfile, VoiceSearchHit } from '../lib/api'
import { inspectKey, keySummary } from '../lib/keys'
import { Button, Card, Row, SectionTitle, Select, Slider, Switch, TextArea, TextField, useLiveSave } from '../components/ui'

interface Props {
  config: AppConfig
  patch: (p: Record<string, unknown>) => Promise<AppConfig>
  notify: (m: string, e?: boolean) => void
}

const SOURCE_LABEL: Record<string, string> = {
  mimo: '小米 MiMo',
  fish: 'Fish Audio',
  edge: 'Edge 朗读',
  openai: 'OpenAI',
  system: '系统语音',
}

/**
 * 平台密钥输入行：边打边存 + 一键校验 + 指纹回显。
 *
 * 密钥是错一个字符就 401 的东西，而 401 的原因在界面上完全看不出来 ——
 * 是少了字符、带了不可见字符，还是这把 Key 早就过期了？
 * 所以既把「已保存的是哪一把」（指纹）摆到明面上，也把「平台认不认」（校验）做成一步。
 *
 * 保存是自动的（和语音页的 Key 输入框一致），不需要回车也不需要点保存；
 * 「校验」按的是已保存的那一把，点它之前输入框会先失焦把最后一次改动落盘。
 */
function KeyRow({
  label,
  source,
  value,
  onSave,
  notify,
}: {
  label: string
  source: string
  value: string
  onSave: (v: string) => void
  notify: (m: string, e?: boolean) => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [check, setCheck] = React.useState<{
    ok: boolean
    message: string
    tried?: { model: string; status: number; message: string }[]
  } | null>(null)

  const live = useLiveSave(value, (v) => {
    // 换了 Key，上一次的自检结论就作废了，别让人对着旧结论判断新钥匙
    setCheck(null)
    onSave(v)
  })

  const info = inspectKey(live.value)
  const savedInfo = inspectKey(value)

  const verify = async () => {
    // 输入框还focus着的话，先让它失焦把最后一次改动落盘，校验的才是真存进去的那把
    live.onBlur()
    setBusy(true)
    try {
      const r = await api.voices.keycheck(source)
      setCheck({ ok: r.ok, message: r.message, tried: r.tried })
      notify(r.message, !r.ok)
    } catch (e: any) {
      notify(String(e?.message || e), true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <TextField
        label={label}
        value={live.value}
        onChange={live.onChange}
        onBlur={live.onBlur}
        type="password"
        mono
      />
      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="text" small onClick={verify} disabled={busy} icon="link">
          {busy ? '校验中…' : '校验 Key'}
        </Button>
        <span className="row__hint" style={{ fontSize: 12 }}>
          已保存：{keySummary(value)}
        </span>
      </div>
      {info.warnings.length > 0 && (
        <div className="tip tip--warn" style={{ marginTop: 8, fontSize: 12 }}>
          粘贴的内容{info.warnings.join('、')}，会自动清理
          {!info.empty && savedInfo.len !== info.len ? `（清理后长度 ${info.len}）` : ''}
        </div>
      )}
      {check && (
        <div className={check.ok ? 'tip' : 'tip tip--warn'} style={{ marginTop: 8, fontSize: 12 }}>
          {check.message}
          {check.tried && check.tried.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {check.tried.map((t) => (
                <div key={t.model} className="mono">
                  {t.model} → HTTP {t.status || '网络错误'}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 音色设计扩写。
 *
 * 观众发「#设计 御姐音」这种四个字的要求，直接喂给 voicedesign 模型等于让模型
 * 自由发挥：年龄、共鸣、语速这些维度全是空的，同一个要求两次生成可能完全不像。
 * 所以先让文本大模型按一条固定公式（年龄性别口音 / 明暗厚薄虚实粗细 / 共鸣咬字 /
 * 语速语气 / 质感距离 / 职业锚点）把要求补全成 60~120 字的结构化描述，再交给 TTS。
 *
 * 模型名是唯一不能写死的东西 —— 各家随时上下架模型，所以模型列表一律在线检测。
 */
/**
 * 六类音色指令的用途与参数样板。界面按这个顺序排。
 * 名字本身**不写在这里** —— 那是主播可以在界面上改的东西，存在 config.commands.voice 里。
 */
const VOICE_COMMANDS: { kind: string; label: string; arg: string }[] = [
  { kind: 'query', label: '查看自己的音色', arg: '' },
  { kind: 'list', label: '搜索音色', arg: ' 关键词' },
  { kind: 'bind', label: '绑定音色', arg: ' 序号或名字' },
  { kind: 'design', label: '设计专属音色', arg: ' 描述' },
  { kind: 'unbind', label: '恢复默认音色', arg: '' },
  { kind: 'help', label: '帮助', arg: '' },
]

/**
 * 逗号 / 顿号 / 换行分隔的一串叫法 → 数组。
 * 与 electron/store.cjs 的 normalizeCommandNames 同一套规则。
 */
function splitAliases(s: string): string[] {
  return String(s || '')
    .split(/[,，、\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * 一个「叫法」输入框：边打边存。
 *
 * 显示用本地草稿（不会打到一半被标准化重排），停手 600ms 自动落盘，
 * 失焦再补一次。所以既不用回车，也不用点保存。
 */
function AliasField({
  label,
  placeholder,
  value,
  onSave,
  notify,
}: {
  label: string
  placeholder?: string
  value: string[]
  onSave: (arr: string[]) => Promise<unknown>
  notify: (m: string, e?: boolean) => void
}) {
  const live = useLiveSave(value.join('、'), (text) => {
    onSave(splitAliases(text)).catch((e: any) => notify(String(e?.message || e), true))
  })
  return (
    <TextField
      label={label}
      value={live.value}
      onChange={live.onChange}
      onBlur={live.onBlur}
      placeholder={placeholder}
    />
  )
}

/**
 * 指令名编辑器。
 *
 * 每类指令都能改成自己直播间顺口的叫法，多个叫法用逗号分隔，**第一个是正名**
 * （机器人回执和下面的命令一览都用它）。输入框删空 = 恢复内置叫法，
 * 不会出现「改错了导致这条指令再也没人触发得了」的死角。
 */
function CommandNamesCard({ config, patch, notify }: Props) {
  const voice = config.commands?.voice || {}
  const prefix = config.voicePolicy?.prefix || '#'

  const primary = (kind: string) => (Array.isArray(voice[kind]) ? voice[kind][0] || '' : '')

  const reset = async () => {
    const empty: Record<string, string[]> = {}
    for (const c of VOICE_COMMANDS) empty[c.kind] = []
    try {
      await patch({ commands: { voice: empty } })
      notify('指令名已恢复默认')
    } catch (e: any) {
      notify(String(e?.message || e), true)
    }
  }

  return (
    <div style={{ marginTop: 14 }}>
      <div className="grid">
        {VOICE_COMMANDS.map((c) => (
          <AliasField
            key={c.kind}
            label={`${c.label}的叫法`}
            placeholder="删空 = 用内置叫法"
            value={Array.isArray(voice[c.kind]) ? voice[c.kind] : []}
            onSave={(arr) => patch({ commands: { voice: { [c.kind]: arr } } })}
            notify={notify}
          />
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <TextArea
          label="命令一览（跟着上面的叫法自动变）"
          value={VOICE_COMMANDS.map((c) => `${prefix}${primary(c.kind)}${c.arg}`).join('  ')}
          onChange={() => {}}
          rows={2}
        />
      </div>

      <div style={{ marginTop: 12 }}>
        {/* 点歌触发词跟音色指令是两回事（不用前缀、直接「点歌 歌名」），
            但主播改指令时想一起看到，就并排放在这里；点歌页里也能改，改的是同一处 */}
        <AliasField
          label="点歌触发词（不用前缀，直接「点歌 歌名」）"
          placeholder="删空 = 用「点歌」"
          value={Array.isArray(config.music?.commands) ? config.music.commands : []}
          onSave={(arr) => patch({ music: { commands: arr } })}
          notify={notify}
        />
      </div>

      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <Button variant="text" small onClick={reset} icon="refresh">
          恢复默认叫法
        </Button>
      </div>

      <div className="tip" style={{ marginTop: 10 }}>
        一个框里可以填多个叫法，用逗号或顿号分隔 —— 比如「绑定」那栏填「绑定、换音色、用」，三个词都能触发。
        第一个是正名，机器人教观众时说的就是它。<strong>打完就自动保存</strong>，不用回车、不用点按钮。
      </div>
    </div>
  )
}

function DesignExpander({ config, patch, notify }: Props) {
  const llm = config.llm || ({} as any)
  const [providers, setProviders] = React.useState<LlmProvider[]>([])
  const [formula, setFormula] = React.useState('')
  const [fallbackTemplate, setFallbackTemplate] = React.useState('')
  const [models, setModels] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState<'detect' | 'check' | 'expand' | ''>('')
  const [rough, setRough] = React.useState('')
  const [result, setResult] = React.useState<{ text: string; model?: string; used: boolean; message?: string } | null>(
    null,
  )

  React.useEffect(() => {
    api.llm
      .providers()
      .then((r) => {
        setProviders(r.providers || [])
        setFormula(r.formula || '')
        setFallbackTemplate(r.template || '')
      })
      .catch(() => {})
  }, [])

  const template = String(llm.promptTemplate || '')
  // 提示词模板也是边打边存：长文本用 700ms 防抖，停手才落一次盘，不会每敲一个字写一次。
  // 和历史内置文案一模一样就存空字符串 —— 以后改内置文案时用户能自动跟着更新。
  const tpl = useLiveSave(template || fallbackTemplate, (v) => {
    patch({ llm: { promptTemplate: v === fallbackTemplate ? '' : v } })
  }, 700)

  const current = providers.find((x) => x.id === (llm.provider || 'deepseek'))
  const modelList = models.length ? models : []

  const setLlm = (k: string, v: unknown) => patch({ llm: { [k]: v } })

  const pickProvider = (id: string) => {
    const hit = providers.find((x) => x.id === id)
    setModels([])
    // 换供应商时清掉地址、套用它的默认模型，避免拿着 DeepSeek 的模型名去问 OpenAI
    patch({ llm: { provider: id, baseUrl: '', model: hit?.defaultModel || '' } })
  }

  const detect = async () => {
    setBusy('detect')
    try {
      const r = await api.llm.models()
      setModels(r.models || [])
      notify(r.ok ? `检测到 ${r.models.length} 个模型` : r.message, !r.ok)
      if (r.ok && r.models.length && !r.models.includes(String(llm.model || ''))) {
        notify(`当前模型「${llm.model || '空'}」不在列表里，从下面的下拉选一个`, true)
      }
    } catch (e: any) {
      notify(String(e?.message || e), true)
    } finally {
      setBusy('')
    }
  }

  const check = async () => {
    setBusy('check')
    try {
      const r = await api.llm.check()
      if (r.models && r.models.length) setModels(r.models)
      notify(r.message, !r.ok)
    } catch (e: any) {
      notify(String(e?.message || e), true)
    } finally {
      setBusy('')
    }
  }

  const expand = async () => {
    if (!String(rough).trim()) {
      notify('先写一句粗糙的要求，比如「御姐音」', true)
      return
    }
    setBusy('expand')
    try {
      const r = await api.llm.expand(rough)
      setResult({ text: r.text, model: r.model, used: r.used, message: r.message })
      notify(r.used ? '已扩写' : r.message || '没走 LLM，用的原话', !r.used)
    } catch (e: any) {
      notify(String(e?.message || e), true)
    } finally {
      setBusy('')
    }
  }

  return (
    <Card
      title="音色设计扩写（LLM）"
      desc="观众发「#设计 御姐音」这种要求太糙，先让文本大模型按公式补全成一段结构化描述，再交给 MiMo 的音色设计模型。扩写失败会自动用原话兜底，不会卡住观众。"
      actions={
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="row__hint" style={{ fontSize: 12 }}>
            启用扩写
          </span>
          <Switch value={llm.enabled !== false} onChange={(v) => setLlm('enabled', v)} />
        </div>
      }
    >
      <div className="grid">
        <Select
          label="LLM 供应商"
          value={llm.provider || 'deepseek'}
          onChange={pickProvider}
          options={
            providers.length
              ? providers.map((x) => ({ value: x.id, label: x.label }))
              : [{ value: 'deepseek', label: 'DeepSeek（默认）' }]
          }
        />
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <Button variant="tonal" small onClick={detect} disabled={busy === 'detect'} icon="refresh">
            {busy === 'detect' ? '检测中…' : '检测模型列表'}
          </Button>
          <Button variant="text" small onClick={check} disabled={busy === 'check'} icon="link">
            {busy === 'check' ? '自检中…' : '自检'}
          </Button>
        </div>
      </div>

      <div className="grid" style={{ marginTop: 12 }}>
        <TextField
          label="模型（可手填）"
          value={llm.model || ''}
          onChange={(v) => setLlm('model', v.trim())}
          placeholder={current?.defaultModel || 'deepseek-chat'}
          mono
        />
        {modelList.length > 0 && (
          <Select
            label={`从检测到的 ${modelList.length} 个模型里选`}
            value={modelList.includes(llm.model || '') ? llm.model || '' : ''}
            onChange={(v) => setLlm('model', v)}
            options={[{ value: '', label: '（不改）' }, ...modelList.map((m) => ({ value: m, label: m }))]}
          />
        )}
      </div>

      <div className="grid" style={{ marginTop: 12 }}>
        <TextField
          label="接口地址（留空用供应商默认）"
          value={llm.baseUrl || ''}
          onChange={(v) => setLlm('baseUrl', v.trim())}
          placeholder={current?.baseUrl || 'https://api.deepseek.com/v1'}
          mono
        />
        <div>
          <div className="row__hint" style={{ fontSize: 12, marginBottom: 4 }}>
            发散程度 {Number(llm.temperature ?? 0.8).toFixed(1)}（越低越稳定）
          </div>
          <Slider
            value={Number(llm.temperature ?? 0.8)}
            min={0}
            max={1.5}
            step={0.1}
            onChange={(v) => setLlm('temperature', v)}
          />
        </div>
        <div>
          <div className="row__hint" style={{ fontSize: 12, marginBottom: 4 }}>
            最大输出 {Number(llm.maxTokens ?? 1200)} token（推理模型要留够思考的份）
          </div>
          <Slider
            value={Number(llm.maxTokens ?? 1200)}
            min={200}
            max={4000}
            step={100}
            onChange={(v) => setLlm('maxTokens', v)}
          />
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <Row
          label="关闭模型思考"
          hint="写音色描述不需要推理。思考会占用输出额度，实测会出现「想了 300 个 token、正文一句没写出来」的情况；关掉后更快也更完整。"
        >
          <Switch value={llm.noThink !== false} onChange={(v) => setLlm('noThink', v)} />
        </Row>
      </div>

      <div style={{ marginTop: 12 }}>
        <KeyRow
          label={`${current?.label || 'LLM'} API Key`}
          source="llm"
          value={llm.apiKey || ''}
          onSave={(v) => patch({ llm: { apiKey: v } })}
          notify={notify}
        />
      </div>

      <SectionTitle>补全公式</SectionTitle>
      <TextArea label="模型要填的公式（改提示词模板时照着这个写）" value={formula} onChange={() => {}} rows={6} />

      <div style={{ marginTop: 12 }}>
        <TextArea
          label="提示词模板"
          value={tpl.value}
          onChange={tpl.onChange}
          onBlur={tpl.onBlur}
          rows={10}
        />
        <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <Button
            variant="text"
            small
            icon="refresh"
            onClick={() => {
              patch({ llm: { promptTemplate: '' } })
              notify('已恢复默认模板')
            }}
          >
            恢复默认
          </Button>
          <span className="row__hint" style={{ fontSize: 12 }}>
            打完自动保存，不用回车、不用点按钮
          </span>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <TextField
          label="试一句粗糙要求"
          value={rough}
          onChange={setRough}
          onEnter={expand}
          placeholder="御姐音 / 温柔的大叔 / 台湾腔女生"
        />
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <Button variant="tonal" small onClick={expand} disabled={busy === 'expand'} icon="play">
            {busy === 'expand' ? '扩写中…' : '扩写看看'}
          </Button>
        </div>
        {result && (
          <div className={result.used ? 'tip' : 'tip tip--warn'} style={{ marginTop: 10 }}>
            {result.used ? (
              <>
                补全后（{result.model}）：{result.text}
              </>
            ) : (
              <>没走 LLM：{result.message}。设计音色时会直接用观众的原文。</>
            )}
          </div>
        )}
      </div>

      <div className="tip" style={{ marginTop: 12 }}>
        {current?.note || ''}
        {current?.keyUrl ? (
          <>
            {' '}
            Key 在 <span className="mono">{current.keyUrl}</span> 拿。
          </>
        ) : null}
        <br />
        扩写只在观众发 <span className="mono">#设计</span> 时触发一次，不参与日常朗读，花的 token 可以忽略。
        没填 Key 或调用失败时，会自动用观众的原文继续设计 —— 不会出现「设计不了」的死路。
      </div>
    </Card>
  )
}

export default function VoicesPage({ config, patch, notify }: Props) {
  const p = config.voicePolicy || ({} as any)
  const [library, setLibrary] = React.useState<VoiceProfile[]>(config.voiceLibrary || [])
  const [bindings, setBindings] = React.useState<Record<string, string>>(config.voiceBindings || {})
  const [keyword, setKeyword] = React.useState('')
  const [source, setSource] = React.useState('all')
  const [results, setResults] = React.useState<VoiceSearchHit[]>([])
  const [errors, setErrors] = React.useState<string[]>([])
  const [searching, setSearching] = React.useState(false)
  const [testingId, setTestingId] = React.useState('')
  const [checking, setChecking] = React.useState(false)
  const [fishModels, setFishModels] = React.useState<string[]>([])
  const [clearing, setClearing] = React.useState(false)
  const [netResults, setNetResults] = React.useState<
    { id: string; label: string; base: string; dns: string; ip: string; tcp: string; http: number | null; ok: boolean; message: string }[]
  >([])

  React.useEffect(() => {
    api.voices
      .library()
      .then((r) => {
        setLibrary(r.library || [])
        setBindings((r.bindings as any) || {})
      })
      .catch(() => {})
    const off = api.voices.onChanged((v) => {
      setLibrary(v.library || [])
      setBindings(v.bindings || {})
    })
    // Fish 的模型名是官网随时在变的，从主进程那份清单里取
    api.tts.providers().then((r: any) => setFishModels(r?.fish?.models || [])).catch(() => {})
    return off
  }, [])

  const search = async (force?: boolean) => {
    setSearching(true)
    setErrors([])
    try {
      const r = await api.voices.search(source, keyword, { limit: 12, force })
      setResults(r.voices || [])
      setErrors(r.errors || [])
      if (!r.ok) {
        // 把平台返回的真实原因抛出来，别再盖一句笼统的提示
        notify(r.errors?.[0] || '没搜到符合条件的音色，换个关键词试试', true)
      }
    } catch (e: any) {
      notify(String(e?.message || e), true)
    } finally {
      setSearching(false)
    }
  }

  const netcheck = async () => {
    setChecking(true)
    try {
      const r = await api.voices.netcheck('all')
      setNetResults(r.results || [])
      const bad = (r.results || []).filter((x) => x.tcp !== 'ok')
      notify(
        bad.length
          ? `${bad.map((b) => b.label).join('、')} 直连不通，需要代理`
          : '各平台网络都正常',
        bad.length > 0,
      )
    } catch (e: any) {
      notify(String(e?.message || e), true)
    } finally {
      setChecking(false)
    }
  }

  const test = async (payload: Parameters<typeof api.voices.test>[0]) => {
    setTestingId(String(JSON.stringify(payload)))
    try {
      const r = await api.voices.test(payload)
      notify(`合成成功，耗时 ${r.latency} ms`)
    } catch (e: any) {
      notify(String(e?.message || e), true)
    } finally {
      setTestingId('')
    }
  }

  const addVoice = async (hit: VoiceSearchHit) => {
    try {
      await api.voices.add(hit.source, { id: hit.id, name: hit.name, hint: hit.hint })
      notify(`已注册「${hit.name}」，观众可以绑定了`)
    } catch (e: any) {
      notify(String(e?.message || e), true)
    }
  }

  const removeProfile = async (id: string) => {
    await api.voices.remove(id)
    notify('已删除')
  }

  // 绑定指向一条已经不在库里的音色 = 这个人只会听到默认音色。
  // 正常删除档案会顺手清掉绑定，出现孤儿说明配置某一步没走完，摆出来让主播能收拾。
  const orphanUids = Object.entries(bindings)
    .filter(([, pid]) => !library.some((v) => v.id === pid))
    .map(([uid]) => uid)

  /**
   * 清理完之后重新拉一次核对。
   * 光按「发过几次解绑请求」报成功是假的 —— 真没写进去的话界面还是老样子，
   * 主播只会觉得按钮没反应，却不知道到底清没清掉。
   */
  const clearOrphans = async () => {
    if (clearing || !orphanUids.length) return
    const targets = [...orphanUids]
    setClearing(true)
    try {
      for (const uid of targets) await api.voices.unbind(uid)
      const r = await api.voices.library()
      const left = Object.entries(r.bindings || {}).filter(
        ([, pid]) => !(r.library || []).some((v) => v.id === pid),
      ).length
      if (left) notify(`清掉了 ${targets.length - left} 条，还剩 ${left} 条没清掉 —— 再点一次试试`, true)
      else notify(`已清理 ${targets.length} 条失效绑定`)
    } catch (e: any) {
      notify(String(e?.message || e || '清理失败'), true)
    } finally {
      setClearing(false)
    }
  }

  const toggleProfile = async (v: VoiceProfile) => {
    await api.voices.save({ id: v.id, enabled: !v.enabled })
  }

  /**
   * 把这条音色设成全局默认。
   * 语音页那个「音色」下拉列的是平台自带的音色，自己注册进库的压根不在里面 ——
   * 这里补上那条路，否则就是「明明有这个音色却换不过去」。
   */
  const useAsDefault = async (v: VoiceProfile) => {
    try {
      await api.voices.useAsDefault(v.id)
      notify(`默认音色已换成「${v.name}」`)
    } catch (e: any) {
      notify(String(e?.message || e), true)
    }
  }

  /** 这条音色是不是正在当全局默认（提供方 + 音色都对上才算） */
  const isDefault = (v: VoiceProfile) =>
    config.tts?.provider === v.platform && String(config.tts?.voice || '') === String(v.voice || '')

  const set = (k: string, val: unknown) => patch({ voicePolicy: { [k]: val } })

  const boundCount = Object.keys(bindings).length

  return (
    <div className="section">
      <SectionTitle>在线音色库</SectionTitle>
      <Card
        title="搜索各平台的音色"
        desc="实时去平台拉，不缓存名单。Fish（fish.audio）音色库里搜到的音色可以直接引用，不用先克隆 —— 它是按名字匹配的，搜不到时可以往后翻几页或换个更短的关键词。"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Select
              label="平台"
              value={source}
              onChange={setSource}
              options={[
                { value: 'all', label: '全部（按策略）' },
                ...Object.keys(SOURCE_LABEL).map((k) => ({ value: k, label: SOURCE_LABEL[k] })),
              ]}
            />
            <Button variant="tonal" small onClick={() => search(true)} disabled={searching} icon="search">
              {searching ? '搜索中…' : '搜索'}
            </Button>
          </div>
        }
      >
        <TextField
          label="关键词"
          value={keyword}
          onChange={setKeyword}
          onEnter={() => search()}
          placeholder="御姐 / 男声 / narration / 粤语"
        />

        {results.length > 0 && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {results.map((hit) => {
              const known = library.some((v) => v.platform === hit.source && v.voice === hit.id)
              return (
                <div key={`${hit.source}-${hit.id}`} className="row" style={{ gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{hit.name}</div>
                    <div className="row__hint mono" style={{ fontSize: 12 }}>
                      {SOURCE_LABEL[hit.source] || hit.source} · {hit.hint || hit.id}
                    </div>
                  </div>
                  <Button variant="text" small onClick={() => test({ source: hit.source, voice: hit })} disabled={!!testingId} icon="play">
                    试听
                  </Button>
                  <Button variant="tonal" small onClick={() => addVoice(hit)} disabled={known} icon="add">
                    {known ? '已注册' : '注册'}
                  </Button>
                </div>
              )
            })}
          </div>
        )}

        {errors.length > 0 && (
          <div className="tip tip--warn" style={{ marginTop: 12 }}>
            {errors.slice(0, 3).join('；')}
          </div>
        )}

        <div className="grid" style={{ marginTop: 14 }}>
          <KeyRow
            label="Fish Audio API Key"
            source="fish"
            value={config.platformKeys?.fish || ''}
            onSave={(v) => patch({ platformKeys: { fish: v } })}
            notify={notify}
          />
          <KeyRow
            label="OpenAI API Key"
            source="openai"
            value={config.platformKeys?.openai || ''}
            onSave={(v) => patch({ platformKeys: { openai: v } })}
            notify={notify}
          />
        </div>

        <div className="grid" style={{ marginTop: 12 }}>
          <Select
            label="外网请求怎么走"
            value={config.proxy?.mode || 'auto'}
            onChange={(v) => patch({ proxy: { mode: v } })}
            options={[
              { value: 'auto', label: '自动（被墙的平台走系统代理）' },
              { value: 'system', label: '全部走系统代理' },
              { value: 'direct', label: '全部直连' },
            ]}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 160 }}>
            <Button variant="tonal" small onClick={netcheck} disabled={checking} icon="refresh">
              {checking ? '检测中…' : '连通性自检'}
            </Button>
          </div>
        </div>

        <div className="grid" style={{ marginTop: 12 }}>
          <Select
            label="Fish 模型（合成报 401/402 就换一个）"
            value={config.platformModel?.fish || ''}
            onChange={(v) => patch({ platformModel: { fish: v } })}
            options={[
              { value: '', label: '自动（按音色档案）' },
              ...fishModels.map((m) => ({
                value: m,
                label: /flash|turbo/.test(m) ? `${m}（更快 · 更省）` : m,
              })),
            ]}
          />
          <TextField
            label="Fish 接口地址（留空用默认）"
            value={config.platformBase?.fish || ''}
            onChange={(v) => patch({ platformBase: { fish: v.trim() } })}
            placeholder="https://api.fish.audio"
            mono
          />
          <TextField
            label="OpenAI 接口地址（留空用默认）"
            value={config.platformBase?.openai || ''}
            onChange={(v) => patch({ platformBase: { openai: v.trim() } })}
            placeholder="https://api.openai.com/v1"
            mono
          />
        </div>

        {netResults.length > 0 && (
          <div className="netcheck" style={{ marginTop: 12 }}>
            {netResults.map((r) => {
              const direct = r.tcp === 'ok'
              return (
                <div key={r.id} className="netcheck__row">
                  <span className={`netcheck__dot${r.ok ? ' is-ok' : direct ? ' is-warn' : ' is-bad'}`} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{r.label}</div>
                    <div className="row__hint mono" style={{ fontSize: 11 }}>
                      {r.base} · DNS {r.dns} · {r.ip || '无'} · 直连 TCP {r.tcp}
                    </div>
                    <div className="row__hint" style={{ fontSize: 12 }}>
                      {r.message}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div className="tip" style={{ marginTop: 12 }}>
          只有 Fish Audio 和 OpenAI 需要单独 Key；MiMo 复用「语音」页那个 Key，Edge 和系统语音不用 Key。
          <br />
          密钥改完一定要点「保存」，再用「校验 Key」问一次平台认不认这把钥匙 —— 光看连通性自检只能说明网络通，
          说不清 Key 对不对。粘贴时混进的零宽字符、全角空格、「Bearer 」前缀都会在保存时自动清掉。
          <br />
          <span className="mono">api.fish.audio</span> 和 <span className="mono">api.openai.com</span> 在国内被 DNS
          污染，直连一定超时 —— 默认的「自动」会让这两家走系统代理，只要 Clash / v2rayN 之类开着就行。
          如果代理是 TUN 模式或没设系统代理，自检会显示直连不通，这时把模式改成「全部走系统代理」或换一个中转地址。
          <br />
          <strong>Fish 的 Key 必须是在 fish.audio 生成的。</strong> Fish Audio 官方（
          <span className="mono">fish.audio</span>）和 Kitta Audio（
          <span className="mono">fishaudio.org</span>）是两家公司，产品名几乎一样但密钥<strong>不能互换</strong> ——
          拿错平台的 Key，报的就是一句看不出所以然的 401。
          <br />
          <strong>额度分两笔：</strong>平台额度只能给免费模型 <span className="mono">s2.1-pro-free</span> 用（新账号默认就有），
          API 额度才是给 <span className="mono">s2.1-pro</span> 这类付费模型用的 —— 新账号 API 额度是 0，一用就 402。
          没充值时把模型选成 <span className="mono">s2.1-pro-free</span> 就能正常出声。
          <br />
          <strong>「校验 Key」分两步</strong>：先查钱包接口（验身份），再真合成一次（验额度与权限）。
          身份通、合成被 402，是 API 额度不够；被 403，是这把 Key <strong>没有 TTS 权限</strong>；
          被 401，才是 Key 本身不对。
        </div>
      </Card>

      <SectionTitle>已注册的音色</SectionTitle>
      <Card title="观众可绑定的名单" desc={`共 ${library.length} 个音色，${boundCount} 人已绑定。只有这里注册过的音色才会用对应的平台，其余回落全局默认。`}>
        {orphanUids.length > 0 && (
          <div className="tip tip--warn" style={{ marginBottom: 12 }}>
            有 {orphanUids.length} 条绑定指向已经不在库里的音色（uid {orphanUids.slice(0, 3).join('、')}），这些人现在只会听到默认音色。
            <div style={{ marginTop: 8 }}>
              <Button variant="tonal" small onClick={clearOrphans} disabled={clearing} icon="delete">
                {clearing ? '清理中…' : `清理失效绑定（${orphanUids.length}）`}
              </Button>
            </div>
          </div>
        )}
        {library.length === 0 ? (
          <div className="row__hint">还没有注册音色。在上面搜一个，点「注册」加进来。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {library.map((v) => {
              const users = Object.entries(bindings)
                .filter(([, pid]) => pid === v.id)
                .map(([uid]) => uid)
              return (
                <div key={v.id} className="row" style={{ gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {v.name}
                      {v.mimoMode === 'design' && (
                        <span className="row__hint" style={{ marginLeft: 6 }}>
                          （MiMo 文字设计音色）
                        </span>
                      )}
                    </div>
                    <div className="row__hint mono" style={{ fontSize: 12 }}>
                      {SOURCE_LABEL[v.platform] || v.platform}
                      {v.voice ? ` · ${v.voice}` : ''}
                      {users.length ? ` · ${users.length} 人使用中` : ''}
                    </div>
                    {v.designPrompt && (
                      <div className="row__hint" style={{ fontSize: 12, marginTop: 2 }}>
                        描述：{v.designPrompt.slice(0, 60)}
                      </div>
                    )}
                  </div>
                  <Switch value={v.enabled !== false} onChange={() => toggleProfile(v)} />
                  <Button variant="text" small onClick={() => test({ profileId: v.id })} disabled={!!testingId} icon="play">
                    试听
                  </Button>
                  <Button
                    variant="tonal"
                    small
                    onClick={() => useAsDefault(v)}
                    disabled={isDefault(v)}
                    icon="check"
                  >
                    {isDefault(v) ? '已是默认' : '设为默认'}
                  </Button>
                  <Button variant="text" small onClick={() => removeProfile(v.id)} icon="delete">
                    删除
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <SectionTitle>音色设计</SectionTitle>
      <DesignExpander config={config} patch={patch} notify={notify} />

      <SectionTitle>弹幕命令</SectionTitle>
      <Card title="观众怎么用" desc="命令前缀和门槛都在下面改。命令弹幕本身不会被朗读。">
        <div className="grid">
          <Row label="启用弹幕音色命令">
            <Switch value={p.enabled} onChange={(v) => set('enabled', v)} />
          </Row>
          <TextField label="命令前缀" value={p.prefix || '#'} onChange={(v) => set('prefix', v || '#')} mono />
        </div>
        <CommandNamesCard config={config} patch={patch} notify={notify} />
      </Card>

      <Card title="门槛与配额">
        <Row label="需要粉丝牌才能换音色" hint="房管和主播不受限制">
          <Switch value={p.requireMedal} onChange={(v) => set('requireMedal', v)} />
        </Row>
        {p.requireMedal && (
          <div className="tip" style={{ marginBottom: 6 }}>
            {config.room?.anchorUid
              ? `已识别主播 ${config.room.anchor || `（uid ${config.room.anchorUid}）`}，主播和房管发指令不受这条限制。`
              : '还没识别出主播：去「连接」页连一次直播间即可 —— 主播身上没有自己房间的粉丝牌，只能靠这个认人，不认出来的话主播自己也会被挡住。'}
          </div>
        )}
        {p.requireMedal && (
          <Row label={`粉丝牌等级 ≥ ${p.minMedalLevel || 1}`}>
            <div style={{ width: 200 }}>
              <Slider value={p.minMedalLevel || 1} min={1} max={40} step={1} onChange={(v) => set('minMedalLevel', v)} />
            </div>
          </Row>
        )}
        <Row label="允许搜索音色">
          <Switch value={p.allowSearch !== false} onChange={(v) => set('allowSearch', v)} />
        </Row>
        <Row label="允许绑定公共音色">
          <Switch value={p.allowBind !== false} onChange={(v) => set('allowBind', v)} />
        </Row>
        <Row label="允许用文字设计音色" hint="每次都会调 MiMo 的 voicedesign">
          <Switch value={p.allowDesign !== false} onChange={(v) => set('allowDesign', v)} />
        </Row>
        <Row label="用弹幕回执回复观众" hint="关闭后命令静默执行">
          <Switch value={p.replyInChat !== false} onChange={(v) => set('replyInChat', v)} />
        </Row>
        <Row
          label={`命令冷却 ${p.cooldownMs ? Math.round(p.cooldownMs / 1000) + ' 秒' : '不限'}`}
          hint="同一条指令的最短间隔；换音色和删除音色互不影响，拖到最左＝不限"
        >
          <div style={{ width: 200 }}>
            <Slider value={p.cooldownMs ?? 5000} min={0} max={30000} step={1000} onChange={(v) => set('cooldownMs', v)} />
          </div>
        </Row>
        <Row label={`每天设计配额 ${p.dailyDesignLimit || 20} 次`} hint="防止有人刷爆额度">
          <div style={{ width: 200 }}>
            <Slider value={p.dailyDesignLimit || 20} min={1} max={200} step={1} onChange={(v) => set('dailyDesignLimit', v)} />
          </div>
        </Row>
        <Row label={`观众自造音色上限 ${p.maxAudienceVoices || 50} 个`} hint="绑定公共音色不占这个额度">
          <div style={{ width: 200 }}>
            <Slider value={p.maxAudienceVoices || 50} min={5} max={500} step={5} onChange={(v) => set('maxAudienceVoices', v)} />
          </div>
        </Row>
        <div style={{ marginTop: 14 }}>
          <Select
            label="每次搜索最多返回"
            value={String(p.searchLimit || 6)}
            onChange={(v) => set('searchLimit', Number(v))}
            options={[3, 5, 6, 8, 10].map((n) => ({ value: String(n), label: `${n} 个` }))}
          />
        </div>
      </Card>
    </div>
  )
}
