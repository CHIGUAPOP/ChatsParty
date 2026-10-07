import React from 'react'
import { api, AppConfig, TtsCacheInfo } from '../lib/api'
import { Button, Card, Row, SectionTitle, Select, Slider, Switch, TextArea, TextField, useLiveSave } from '../components/ui'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** ms → 「数字 + 单位」，优先还原成能整除的大单位，读起来最自然 */
function splitDuration(ms: number) {
  const v = Math.max(1, Number(ms) || 0)
  if (v % DAY === 0) return { n: v / DAY, unit: 'day' }
  if (v % HOUR === 0) return { n: v / HOUR, unit: 'hour' }
  return { n: Math.max(1, Math.round(v / MINUTE)), unit: 'minute' }
}

function joinDuration(n: number, unit: string) {
  const factor = unit === 'day' ? DAY : unit === 'hour' ? HOUR : MINUTE
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return DAY
  return Math.round(v * factor)
}

function fmtBytes(b: number) {
  const mb = Number(b || 0) / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(2)} MB` : `${Math.round(Number(b || 0) / 1024)} KB`
}

interface Props {
  config: AppConfig
  patch: (p: Record<string, unknown>) => Promise<AppConfig>
  notify: (m: string, e?: boolean) => void
}

/** '+8Hz' → 8；'0Hz' → 0；乱值回落 0 */
function parseHz(v: string) {
  const n = Number(String(v || '').replace(/[^-\d]/g, ''))
  return Number.isFinite(n) ? Math.max(-20, Math.min(20, n)) : 0
}

export default function VoicePage({ config, patch, notify }: Props) {
  const t = config.tts
  const [providers, setProviders] = React.useState<Record<string, any>>({})
  const [testing, setTesting] = React.useState(false)
  const [state, setState] = React.useState('')
  const [liveVoices, setLiveVoices] = React.useState<any[]>([])
  const [loadingVoices, setLoadingVoices] = React.useState(false)
  const [cacheInfo, setCacheInfo] = React.useState<TtsCacheInfo | null>(null)

  const refreshCache = React.useCallback(async () => {
    try {
      setCacheInfo(await api.tts.cacheInfo())
    } catch {
      setCacheInfo(null)
    }
  }, [])

  React.useEffect(() => {
    api.tts.providers().then(setProviders)
    refreshCache()
    const off = api.tts.onState((s) => setState(s.state === 'idle' ? '' : s.state))
    return off
  }, [refreshCache])

  const preset = providers[t.provider] || null

  // 免密钥的提供方（Edge / 系统语音）音色要现取
  const dynamic = t.provider === 'edge' || t.provider === 'system'

  const loadVoices = React.useCallback(
    async (force?: boolean) => {
      if (!dynamic) {
        setLiveVoices([])
        return
      }
      setLoadingVoices(true)
      try {
        const r = await api.tts.voices(t.provider, force)
        if (r.ok && r.voices?.length) setLiveVoices(r.voices)
        else if (r.message) notify(r.message, true)
      } catch (e: any) {
        notify(String(e?.message || e), true)
      } finally {
        setLoadingVoices(false)
      }
    },
    [dynamic, t.provider, notify]
  )

  React.useEffect(() => {
    loadVoices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.provider])

  const applyProvider = async (id: string) => {
    const p = providers[id]
    if (!p) return
    const firstVoice = p.voices?.[0]?.id ?? p.voices?.[0] ?? ''
    await patch({
      tts: {
        provider: id,
        protocol: p.protocol,
        baseUrl: p.baseUrl || (id === 'custom' ? t.baseUrl : ''),
        model: p.models?.[0] || (id === 'custom' ? t.model : ''),
        voice: firstVoice || (id === 'custom' ? t.voice : ''),
        format: p.formats?.[0] || t.format,
      },
    })
    if (id === 'system') {
      // 系统语音默认音色取自本机列表，取完再回填
      const r = await api.tts.voices('system').catch(() => null)
      if (r?.ok && r.voices?.length) patch({ tts: { voice: r.voices[0].id } })
    }
  }

  const test = async () => {
    setTesting(true)
    setState('loading')
    try {
      const r = await api.tts.test()
      notify(`合成成功，耗时 ${r.latency} ms`)
    } catch (e: any) {
      notify(String(e?.message || e), true)
    } finally {
      setTesting(false)
      setState('')
    }
  }

  const set = (k: string, v: unknown) => patch({ tts: { [k]: v } })

  /**
   * B站默认昵称改念的那个称呼。
   * 它紧挨着 TTS 的开关，改一个字就写一次盘太伤，交给 useLiveSave 停手 600ms 再落。
   */
  const defaultNameDraft = useLiveSave(t.defaultUserName || '', async (v) => {
    await set('defaultUserName', v.trim() || '一个b站用户')
  })

  /* ------------------------------ 合成缓存 ------------------------------ */
  const cache = t.cache || { enabled: true, ttlMs: 7 * DAY, maxMB: 200 }
  const [ttlUnit, setTtlUnit] = React.useState(() => splitDuration(Number(t.cache?.ttlMs) || 0).unit)

  // 换算单位时保持总时长不变：7 天 → 单位切到小时，显示成 168
  const ttlFactor = ttlUnit === 'day' ? DAY : ttlUnit === 'hour' ? HOUR : MINUTE
  const ttlShown = Math.max(1, Math.round((Number(cache.ttlMs) || MINUTE) / ttlFactor))
  const ttlDraft = useLiveSave(String(ttlShown), async (v) => {
    await patchCache({ ttlMs: joinDuration(Number(v) || 1, ttlUnit) })
  })

  async function patchCache(p: Record<string, unknown>) {
    await patch({ tts: { cache: p } })
    refreshCache()
  }

  async function pruneCache() {
    try {
      const r = await api.tts.cachePrune()
      notify(r.removed ? `已清理 ${r.removed} 条过期缓存` : '没有过期的缓存')
    } catch (e: any) {
      notify(String(e?.message || e), true)
    }
    refreshCache()
  }

  async function clearCache() {
    try {
      const r = await api.tts.cacheClear()
      notify(`已清空 ${r.cleared} 条缓存，回收 ${fmtBytes(r.bytes)}`)
    } catch (e: any) {
      notify(String(e?.message || e), true)
    }
    refreshCache()
  }

  const source = liveVoices.length ? liveVoices : preset?.voices || []
  const voiceOptions = source.map((v: any) => ({
    value: typeof v === 'string' ? v : v.id,
    label: typeof v === 'string' ? v : v.label,
  }))
  if (voiceOptions.length === 0) voiceOptions.push({ value: t.voice, label: t.voice || '（自定义）' })
  else if (t.voice && !voiceOptions.some((o: any) => o.value === t.voice)) {
    voiceOptions.unshift({ value: t.voice, label: `${t.voice}（当前）` })
  }

  const needsKey = preset ? preset.needsKey !== false : true
  const hideStyle = preset ? preset.supportsStylePrompt === false : false
  // 只有 Edge 和 Windows 系统语音认音高参数，别的给了也是白给，控件就不出现
  const supportsPitch = t.provider === 'edge' || t.provider === 'sapi' || t.protocol === 'sapi'

  return (
    <div className="section">
      <SectionTitle>语音提供方</SectionTitle>
      <Card
        title="TTS 服务"
        desc="不想申请 API Key 就选「Edge 朗读」或「系统语音」，都是填好即用。其他 OpenAI 兼容服务选「自定义」后自己填地址和模型。"
        actions={
          <Button variant="tonal" small onClick={test} disabled={testing} icon="play">
            {testing ? '合成中…' : '测试语音'}
          </Button>
        }
      >
        <div className="grid">
          <Select
            label="提供方"
            value={t.provider}
            onChange={applyProvider}
            options={Object.values(providers).map((p: any) => ({ value: p.id, label: p.name }))}
          />
          {t.provider === 'custom' && (
            <Select
              label="调用协议"
              value={t.protocol}
              onChange={(v) => set('protocol', v)}
              options={[
                { value: 'chat-completions', label: 'chat/completions（MiMo 等）' },
                { value: 'audio-speech', label: 'audio/speech（OpenAI 等）' },
              ]}
            />
          )}
        </div>

        {needsKey && (
          <div className="grid" style={{ marginTop: 12 }}>
            <TextField label="Base URL" value={t.baseUrl} onChange={(v) => set('baseUrl', v)} mono />
            <TextField
              label="API Key"
              value={t.apiKey}
              onChange={(v) => set('apiKey', v)}
              type="password"
              mono
            />
          </div>
        )}

        <div className="grid" style={{ marginTop: 12 }}>
          {(preset?.models?.length || 0) > 0 && (
            <Select
              label="模型"
              value={t.model}
              onChange={(v) => set('model', v)}
              options={(preset?.models || []).map((m: string) => ({ value: m, label: m }))}
            />
          )}
          <Select label="音色" value={t.voice} onChange={(v) => set('voice', v)} options={voiceOptions} />
          {(preset?.formats?.length || 0) > 1 && (
            <Select
              label="音频格式"
              value={t.format}
              onChange={(v) => set('format', v)}
              options={(preset?.formats || []).map((f: string) => ({ value: f, label: f }))}
            />
          )}
        </div>

        {dynamic && (
          <div className="row" style={{ marginTop: 12, gap: 8, alignItems: 'center' }}>
            <Button variant="text" small onClick={() => loadVoices(true)} disabled={loadingVoices} icon="refresh">
              {loadingVoices ? '读取中…' : '刷新音色列表'}
            </Button>
            <span className="row__hint">
              {t.provider === 'edge'
                ? `已载入 ${liveVoices.length || 0} 个音色，中文的排在前面`
                : `本机已安装 ${liveVoices.length || 0} 个语音`}
            </span>
          </div>
        )}

        {preset?.note && (
          <div className="tip" style={{ marginTop: 16 }}>
            {preset.note}
          </div>
        )}
        {needsKey && !t.apiKey && (
          <div className="tip tip--warn" style={{ marginTop: 12 }}>
            这个提供方需要 API Key，现在还没填，弹幕不会朗读。去 platform.xiaomimimo.com 控制台生成一个粘进来；
            或者直接在上面切到「Edge 朗读」/「系统语音」，两者都不用密钥。
          </div>
        )}
        {t.provider === 'custom' && (
          <div className="tip tip--warn" style={{ marginTop: 12 }}>
            音色和模型需要手填时，先在下面「音色」里填好再保存；列表里没有的选项请直接改配置文件。
          </div>
        )}
      </Card>

      <SectionTitle>播报风格</SectionTitle>
      <Card
        title="语速与语气"
        desc={hideStyle ? '这个提供方不支持风格指令，用下面的语速来调。' : '风格指令会作为 user 消息传给模型，用来控制语气、语速、情绪。'}
      >
        <Row label={`语速 ${(Number(t.speed) || 1).toFixed(2)}×`} hint="1.00 为正常语速">
          <div style={{ width: 200 }}>
            <Slider
              value={Number(t.speed) || 1}
              min={0.5}
              max={2}
              step={0.05}
              onChange={(v) => set('speed', v)}
            />
          </div>
        </Row>
        {supportsPitch && (
          <Row label={`音高 ${t.pitch || '+0Hz'}`} hint="只有 Edge 朗读和系统语音认这个；MiMo 用风格指令控制">
            <div style={{ width: 200 }}>
              <Slider
                value={parseHz(t.pitch)}
                min={-20}
                max={20}
                step={1}
                suffix=" Hz"
                onChange={(v) => set('pitch', `${v >= 0 ? '+' : '-'}${Math.abs(v)}Hz`)}
              />
            </div>
          </Row>
        )}
        {!hideStyle && (
          <>
            <div style={{ marginTop: 16 }}>
              <TextArea label="风格指令" value={t.stylePrompt} onChange={(v) => set('stylePrompt', v)} rows={3} />
            </div>
            <div className="tip" style={{ marginTop: 12 }}>
              也可以用标签写法直接在文本里控制，例如
              <span className="mono">（开心 语速稍快）</span>
              或
              <span className="mono">（东北话）</span>。
            </div>
          </>
        )}
      </Card>

      <SectionTitle>播报规则</SectionTitle>
      <Card title="开关">
        <Row label="启用语音播报">
          <Switch value={t.enabled} onChange={(v) => set('enabled', v)} />
        </Row>
        <Row label="朗读用户名" hint="关闭后只念弹幕内容">
          <Switch value={t.readUsername} onChange={(v) => set('readUsername', v)} />
        </Row>
        <Row
          label="默认昵称不念数字"
          hint="bili_3706983133743519 这种没改过名的账号，念出来是一串数字"
        >
          <Switch
            value={t.renameDefaultUser !== false}
            onChange={(v) => set('renameDefaultUser', v)}
          />
        </Row>
        {t.renameDefaultUser !== false && (
          <Row label="念作" hint="纯数字的名字也按这个念">
            <div style={{ width: 200 }}>
              <TextField
                label="念作"
                value={defaultNameDraft.value}
                onChange={defaultNameDraft.onChange}
                onBlur={defaultNameDraft.onBlur}
              />
            </div>
          </Row>
        )}
        <Row label="礼物">
          <Switch value={t.readGift} onChange={(v) => set('readGift', v)} />
        </Row>
        <Row label="上舰">
          <Switch value={t.readGuard} onChange={(v) => set('readGuard', v)} />
        </Row>
        <Row label="醒目留言 SC">
          <Switch value={t.readSuperchat} onChange={(v) => set('readSuperchat', v)} />
        </Row>
        <Row label="进场欢迎" hint="人多的直播间会很吵">
          <Switch value={t.readEnter} onChange={(v) => set('readEnter', v)} />
        </Row>
      </Card>

      <Card title="节流与过滤">
        <Row label={`音量 ${Math.round(t.volume * 100)}%`}>
          <div style={{ width: 200 }}>
            <Slider value={t.volume} min={0} max={1} step={0.05} onChange={(v) => set('volume', v)} />
          </div>
        </Row>
        <Row label="单条最大字数">
          <div style={{ width: 200 }}>
            <Slider value={t.maxLength} min={10} max={200} step={5} onChange={(v) => set('maxLength', v)} suffix=" 字" />
          </div>
        </Row>
        <Row label="两条播报最小间隔">
          <div style={{ width: 200 }}>
            <Slider
              value={t.minIntervalMs}
              min={0}
              max={5000}
              step={100}
              onChange={(v) => set('minIntervalMs', v)}
              suffix=" ms"
            />
          </div>
        </Row>
        <Row label="同一用户冷却时间" hint="防止同一个人刷屏刷爆语音">
          <div style={{ width: 200 }}>
            <Slider
              value={t.perUserCooldownMs}
              min={0}
              max={60000}
              step={1000}
              onChange={(v) => set('perUserCooldownMs', v)}
              suffix=" ms"
            />
          </div>
        </Row>
        <Row label="20 秒内重复内容合并" hint="弹幕刷屏时只念一次">
          <Switch value={t.mergeDuplicate} onChange={(v) => set('mergeDuplicate', v)} />
        </Row>
        <div style={{ marginTop: 16 }}>
          <TextArea
            label="屏蔽词（逗号或换行分隔）"
            value={t.blockWords}
            onChange={(v) => set('blockWords', v)}
            rows={2}
          />
        </div>
      </Card>

      <SectionTitle>合成缓存</SectionTitle>
      <Card
        title="重复的话不再重复合成"
        desc="同一套音色 + 同一句话，第一次生成后存到本机；保留时长内再遇到就直接播本地那份，不再向服务请求。每命中一次就刷新保存时间 —— 常说的话会一直续期，没人再说的话自然过期。"
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Button variant="text" small onClick={pruneCache} icon="refresh">
              清理过期
            </Button>
            <Button variant="tonal" small onClick={clearCache} icon="delete">
              清空
            </Button>
          </div>
        }
      >
        <Row label="启用缓存" hint="关掉之后只不再读写，已存的文件要清空才会删">
          <Switch value={cache.enabled !== false} onChange={(v) => patchCache({ enabled: v })} />
        </Row>

        <div className="grid" style={{ marginTop: 12 }}>
          <TextField
            label="保留时长"
            value={ttlDraft.value}
            onChange={ttlDraft.onChange}
            onBlur={ttlDraft.onBlur}
            mono
          />
          <Select
            label="单位"
            value={ttlUnit}
            onChange={(v) => {
              setTtlUnit(v)
              patchCache({ ttlMs: joinDuration(Number(ttlDraft.value) || 1, v) })
            }}
            options={[
              { value: 'minute', label: '分钟' },
              { value: 'hour', label: '小时' },
              { value: 'day', label: '天' },
            ]}
          />
        </div>

        <Row label={`容量上限 ${cache.maxMB || 0} MB`} hint="装满了从「最久没人说过」的那句开始删">
          <div style={{ width: 200 }}>
            <Slider
              value={cache.maxMB || 0}
              min={20}
              max={1024}
              step={20}
              suffix=" MB"
              onChange={(v) => patchCache({ maxMB: v })}
            />
          </div>
        </Row>

        <div className="tip" style={{ marginTop: 12 }}>
          {cacheInfo ? (
            <>
              已存 <span className="mono">{cacheInfo.entries}</span> 条 · 占用{' '}
              <span className="mono">{fmtBytes(cacheInfo.bytes)}</span> · 累计省下{' '}
              <span className="mono">{cacheInfo.hits}</span> 次合成
              {cacheInfo.putCount ? ` · 生成过 ${cacheInfo.putCount} 条` : ''}
              {cacheInfo.enabled === false ? ' · 当前已停用' : ''}
            </>
          ) : (
            '正在读取缓存状态…'
          )}
        </div>
        <div className="row__hint" style={{ marginTop: 8 }}>
          文件放在本机用户数据目录（{cacheInfo?.dir || 'userData/tts-cache'}），不会上传到任何地方。
        </div>
      </Card>

      <SectionTitle>每个人的专属音色</SectionTitle>
      <Card
        title="这里配的是默认音色"
        desc="所有人共用。要让不同观众用不同音色说话，去「音色」页注册，观众自己在弹幕里挑。"
      >
        <div className="tip">
          流程：音色页搜一个平台音色 → 点注册 → 观众弹幕发
          <span className="mono"> #音色列表 关键词 </span>
          搜索、<span className="mono"> #绑定 序号 </span>
          选定，也可以发 <span className="mono"> #设计 温柔的御姐音 </span>
          用文字现场造一个。发 <span className="mono"> #删除音色 </span> 恢复默认。命令前缀和粉丝牌门槛都在音色页改。
        </div>
      </Card>

      <SectionTitle>当前状态</SectionTitle>
      <Card title="当前状态">
        <div className="row__hint">{state ? `正在${state === 'loading' ? '合成' : '播放'}…` : '空闲'}</div>
      </Card>
    </div>
  )
}
