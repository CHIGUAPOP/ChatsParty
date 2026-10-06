import React from 'react'
import { api, AppConfig, MusicState } from '../lib/api'
import { Button, Card, Row, SectionTitle, Slider, Switch, TextField, TextArea, Select } from '../components/ui'
import MusicWidget, { MUSIC_POS } from '../components/MusicWidget'

interface Props {
  config: AppConfig
  patch: (p: Record<string, unknown>) => Promise<AppConfig>
  notify: (m: string, e?: boolean) => void
}

interface OverlayStatus {
  enabled: boolean
  port: number
  url?: string
  clients: number
  error?: string
}

export default function OverlayPage({ config, patch, notify }: Props) {
  const o = config.overlay
  const [status, setStatus] = React.useState<OverlayStatus>({
    enabled: false,
    port: o.port,
    url: `http://127.0.0.1:${o.port}/overlay`,
    clients: 0,
  })
  const [checking, setChecking] = React.useState(false)
  const [check, setCheck] = React.useState<{ ok: boolean; message: string } | null>(null)
  const [copied, setCopied] = React.useState(false)
  // 端口改一次就要重启一次服务，所以这里先本地打字，回车/失焦才提交
  const [portDraft, setPortDraft] = React.useState(String(o.port))
  // 预览要拿真实的点歌队列，没歌时也能看到「空态」长什么样
  const [music, setMusic] = React.useState<MusicState>({ items: [], current: null, queued: 0 })

  React.useEffect(() => setPortDraft(String(o.port)), [o.port])
  React.useEffect(() => {
    api.music.state().then(setMusic)
    return api.music.onState(setMusic)
  }, [])

  React.useEffect(() => api.overlay.onStatus(setStatus), [])

  const commitPort = () => {
    const v = Number(portDraft)
    if (!v || v < 1 || v > 65535 || v === Number(o.port)) {
      setPortDraft(String(o.port))
      return
    }
    patch({ overlay: { port: v } })
    notify(`叠加层端口改为 ${v}，服务重启中`)
  }

  /**
   * 端口没法「每敲一下存一下」—— 存一次就要重启一次叠加层服务。
   * 所以停手 1 秒自动提交；且只认完整端口（≥1024），
   * 免得打到一半的「1」「12」被当成端口真的去监听。
   * 回车 / 失焦仍然立即生效，两条路都留着。
   */
  React.useEffect(() => {
    if (portDraft === String(o.port)) return
    if (Number(portDraft) < 1024) return
    const t = window.setTimeout(() => commitPort(), 1000)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portDraft, o.port])

  const start = async () => {
    const r = await api.overlay.start()
    if (!r.ok) notify(r.message || '启动失败', true)
    else notify(`叠加层已启动，端口 ${r.port}`)
  }

  const stop = async () => {
    await api.overlay.stop()
    notify('叠加层已停止')
  }

  const runCheck = async () => {
    setChecking(true)
    try {
      const r = await api.overlay.selfcheck()
      setCheck({ ok: r.ok, message: r.message })
      if (r.clients !== status.clients) setStatus((s) => ({ ...s, clients: r.clients }))
    } catch (e: any) {
      setCheck({ ok: false, message: String(e?.message || e) })
    } finally {
      setChecking(false)
    }
  }

  const pushTest = async () => {
    const r = await api.overlay.test()
    if (r.ok) notify('已推送测试消息，去 OBS 看有没有出现')
    else notify('还没有客户端连上，先在 OBS 里加上浏览器源', true)
  }

  const copyUrl = async () => {
    const url = status.url || `http://127.0.0.1:${o.port}/overlay`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      notify('复制失败，手动选中地址复制吧', true)
    }
  }

  const url = status.url || `http://127.0.0.1:${o.port}/overlay`
  const live = status.enabled && status.clients > 0

  return (
    <div className="section">
      <SectionTitle>OBS 叠加层</SectionTitle>
      <Card
        title="本地服务"
        desc="程序一启动就会自动跑起来，不用手动开。在 OBS 里加「浏览器」源，URL 填下面的地址即可，背景默认透明。"
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Button variant="text" small onClick={() => api.overlay.open()} icon="link">
              在浏览器打开
            </Button>
            {status.enabled ? (
              <Button variant="outlined" small onClick={stop} icon="stop">
                停止
              </Button>
            ) : (
              <Button small onClick={start} icon="play">
                启动
              </Button>
            )}
          </div>
        }
      >
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <span className="status-pill">
            <span
              className="status-dot"
              style={{ background: live ? '#4caf50' : status.enabled ? '#ffb300' : undefined }}
            />
            {status.enabled ? '服务运行中' : '服务未启动'}
          </span>
          <span className="status-pill">
            <span className="status-dot" style={{ background: live ? '#4caf50' : undefined }} />
            OBS 连接 {status.clients} 个
          </span>
          <div className="field is-floating" style={{ maxWidth: 140 }}>
            <input
              className="field__input"
              inputMode="numeric"
              value={portDraft}
              onChange={(e) => setPortDraft(e.target.value.replace(/[^\d]/g, ''))}
              // 逐字提交会把服务重启 5 次，所以交给上面那个防抖 effect；失焦/回车立即生效
              onBlur={commitPort}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitPort()
              }}
            />
            <label className="field__label">端口（改完自动生效）</label>
          </div>
        </div>

        <div className="row" style={{ marginTop: 14, gap: 8, flexWrap: 'wrap' }}>
          <code className="overlay-url">{url}</code>
          <Button variant="tonal" small onClick={copyUrl}>
            {copied ? '已复制' : '复制'}
          </Button>
          <Button variant="outlined" small onClick={pushTest} disabled={!status.enabled} icon="send">
            推一条测试消息
          </Button>
          <Button variant="text" small onClick={runCheck} disabled={checking} icon="refresh">
            {checking ? '检测中…' : '自检'}
          </Button>
        </div>

        {status.error && (
          <div className="tip tip--warn" style={{ marginTop: 12 }}>
            服务启动有问题：{status.error}
          </div>
        )}

        {check && (
          <div className={`tip${check.ok ? '' : ' tip--warn'}`} style={{ marginTop: 12 }}>
            {check.message}
          </div>
        )}

        {status.enabled && status.clients === 0 && (
          <div className="tip tip--warn" style={{ marginTop: 8 }}>
            服务是好的，但还没有客户端连上 —— 说明 OBS 那边没接上。检查这几处：<br />
            ① OBS 源类型必须是「浏览器」（不是你手动开的 Chrome）；<br />
            ② URL 一字不差地填 <span className="mono">{url}</span>；<br />
            ③ 宽高设成画布尺寸（1920×1080）；<br />
            ④ 改完点一下源的「刷新」。
          </div>
        )}

        <div className="tip" style={{ marginTop: 8 }}>
          别在 OBS 里勾选「源不可见时关闭浏览器源」，切场景回来会丢消息。
        </div>
      </Card>

      <SectionTitle>叠加层外观</SectionTitle>
      <Card title="显示项">
        <Row label="显示头像">
          <Switch value={o.showFace} onChange={(v) => patch({ overlay: { showFace: v } })} />
        </Row>
        <Row label="显示粉丝勋章">
          <Switch value={o.showMedal} onChange={(v) => patch({ overlay: { showMedal: v } })} />
        </Row>
        <Row label="显示礼物">
          <Switch value={o.showGift} onChange={(v) => patch({ overlay: { showGift: v } })} />
        </Row>
        <Row label="显示醒目留言">
          <Switch value={o.showSuperchat} onChange={(v) => patch({ overlay: { showSuperchat: v } })} />
        </Row>
        <Row label="最多保留条数">
          <div style={{ width: 220 }}>
            <Slider value={o.maxItems} min={5} max={120} step={5} onChange={(v) => patch({ overlay: { maxItems: v } })} suffix=" 条" />
          </div>
        </Row>
      </Card>

      <Card
        title="点歌面板"
        desc="画面上常驻显示「正在播放」和接下来的待播列表。一首歌都没有时整块自动隐藏，不会在画面上留空框。"
      >
        <Row label="显示点歌面板">
          <Switch value={o.showMusic !== false} onChange={(v) => patch({ overlay: { showMusic: v } })} />
        </Row>
        <Row label="位置" hint="弹幕默认堆在右下角，点歌面板放左上一般不会打架">
          <div style={{ width: 150 }}>
            <Select
              label="位置"
              value={o.musicPos || 'tl'}
              onChange={(v) => patch({ overlay: { musicPos: v } })}
              options={MUSIC_POS}
            />
          </div>
        </Row>
        <Row label="待播显示条数" hint="设为 0 就只显示正在播放那一首">
          <div style={{ width: 220 }}>
            <Slider
              value={o.musicQueueCount ?? 3}
              min={0}
              max={8}
              step={1}
              onChange={(v) => patch({ overlay: { musicQueueCount: v } })}
              suffix=" 首"
            />
          </div>
        </Row>

        <div className="obs-preview" style={{ marginTop: 12 }}>
          <span className="obs-preview__tag">效果预览</span>
          <MusicWidget
            state={music}
            queueCount={o.musicQueueCount}
            pos={o.musicPos || 'tl'}
          />
          {!music.current && music.items.length === 0 && (
            <div className="obs-preview__off">还没有歌 —— 去「点歌」页加一首，或让观众在弹幕里发「点歌 歌名」</div>
          )}
        </div>
      </Card>

      <Card title="样式">
        <div className="grid">
          <Select
            label="字体"
            value={o.fontFamily}
            onChange={(v) => patch({ overlay: { fontFamily: v } })}
            options={[
              { value: 'system-ui, "Microsoft YaHei", sans-serif', label: '系统默认' },
              { value: '"Microsoft YaHei", sans-serif', label: '微软雅黑' },
              { value: '"PingFang SC", sans-serif', label: '苹方' },
              { value: '"Source Han Sans SC", sans-serif', label: '思源黑体' },
            ]}
          />
          <div className="field is-floating">
            <input
              className="color-input"
              type="color"
              value={o.accent}
              onChange={(e) => patch({ overlay: { accent: e.target.value.toUpperCase() } })}
            />
            <label className="field__label">强调色</label>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <TextArea
            label="自定义 CSS"
            value={o.customCss}
            onChange={(v) => patch({ overlay: { customCss: v } })}
            rows={4}
          />
        </div>
        <div className="tip" style={{ marginTop: 12 }}>
          例子：<span className="mono">.cp-item {'{'} font-size: 20px; {'}'}</span>
        </div>
      </Card>
    </div>
  )
}
