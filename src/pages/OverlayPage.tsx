import React from 'react'
import { api, AppConfig, MusicState } from '../lib/api'
import { Button, Card, Row, SectionTitle, Slider, Switch, TextField, TextArea, Select } from '../components/ui'
import MusicWidget, { MUSIC_POS } from '../components/MusicWidget'
import DanmakuPreview, { DANMAKU_POS } from '../components/DanmakuPreview'
import LyricPreview, { LYRIC_POS, LYRIC_LINE_OPTIONS } from '../components/LyricPreview'
import VoicePickPreview, { PICK_POS, PICK_HIT_OPTIONS } from '../components/VoicePickPreview'

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

/**
 * 能单独打开的几块，一块一个 OBS「浏览器」源。
 *
 * id 必须与 electron/overlay.cjs 的 OVERLAY_PANELS、以及 overlay/index.html 里认的
 * 那几个名字一致 —— 对不上的话界面给出来的地址会是一个纯透明页，还不报错。
 * （smoke 里有断言盯着这三处。）
 */
const PANEL_SOURCES = [
  { id: 'danmaku', name: '弹幕', hint: '头像 + 昵称 + 内容' },
  { id: 'lyric', name: '歌词', hint: '当前唱到的那句高亮' },
  { id: 'music', name: '点歌', hint: '正在播放 + 队列' },
  { id: 'voicepick', name: '音色面板', hint: '观众搜音色时弹的候选' },
]

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
  /** 刚复制的是哪一个（'all' 或面板 id）。空串 = 谁都没复制 */
  const [copied, setCopied] = React.useState('')
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

  const origin = status.url
    ? status.url.replace(/\/overlay.*$/, '')
    : `http://127.0.0.1:${o.port}`
  const url = status.url || `${origin}/overlay`
  /** 某一块的地址。'all' 就是原来那个「三块齐全」的地址 */
  const panelUrl = (id: string) => (id === 'all' ? `${origin}/overlay` : `${origin}/overlay/${id}`)

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      window.setTimeout(() => setCopied(''), 1600)
    } catch {
      notify('复制失败，手动选中地址复制吧', true)
    }
  }

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
            </Button>            {status.enabled ? (
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
          <Button variant="tonal" small onClick={() => copy('all', url)}>
            {copied === 'all' ? '已复制' : '复制'}
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

      <Card
        title="拆开用（推荐）"
        desc="一块加一个「浏览器」源，各占一层。这样歌词、弹幕、点歌就是三个独立的东西：能各自拖动、各自缩放，还能单独加滤镜或调层级，互不牵连。位置在下面各自的设置里选，指的是「在这个源里的位置」。"
        actions={
          <Button variant="text" small onClick={() => api.overlay.open('lyric')} icon="link">
            预览歌词源
          </Button>
        }
      >
        <div className="panel-src">
          {PANEL_SOURCES.map((p) => (
            <div className="panel-src__row" key={p.id}>
              <span className="panel-src__name">{p.name}</span>
              <span className="panel-src__hint">{p.hint}</span>
              <code className="overlay-url panel-src__url">{panelUrl(p.id)}</code>
              <Button variant="tonal" small onClick={() => copy(p.id, panelUrl(p.id))}>
                {copied === p.id ? '已复制' : '复制'}
              </Button>
              <Button variant="text" small onClick={() => api.overlay.open(p.id)} icon="link">
                打开
              </Button>
            </div>
          ))}
        </div>
        <div className="tip" style={{ marginTop: 10 }}>
          源还是建议先按画布尺寸（1920×1080）建，再用 OBS 的变换把这一块拖到想要的位置 ——
          和原来那个「全部」的源看到的效果一模一样，只是这次能单独调了。
          上面那个 {url} 仍然可用：一个源里三块齐全，还会自动避让。
        </div>
      </Card>

      <SectionTitle>叠加层外观</SectionTitle>
      <Card
        title="大小"
        desc="整体缩放会把头像、间距、圆角连同文字一起放大或缩小；只想动字就单独调字体大小。OBS 画布不是 1920×1080 时先调这个。"
      >
        <Row label="界面大小" hint="左边对齐不变，整体等比例缩放">
          <div style={{ width: 220 }}>
            <Slider
              value={o.scale ?? 100}
              min={50}
              max={200}
              step={5}
              onChange={(v) => patch({ overlay: { scale: v } })}
              suffix="%"
            />
          </div>
        </Row>
        <Row label="字体大小" hint="在整体缩放之上再单独调整字号，布局不动">
          <div style={{ width: 220 }}>
            <Slider
              value={o.fontSize ?? 100}
              min={50}
              max={200}
              step={5}
              onChange={(v) => patch({ overlay: { fontSize: v } })}
              suffix="%"
            />
          </div>
        </Row>
        <div className="row" style={{ gap: 8 }}>
          <Button variant="text" small onClick={() => patch({ overlay: { scale: 100, fontSize: 100 } })} icon="refresh">
            恢复默认
          </Button>
        </div>
      </Card>

      <Card title="显示项">
        <Row label="弹幕位置" hint="头像和文字对齐会自动跟着所选这一侧镜像，新的弹幕始终紧贴你选的角">
          <div style={{ width: 190 }}>
            <Select
              label="弹幕位置"
              value={o.danmakuPos || 'br'}
              onChange={(v) => patch({ overlay: { danmakuPos: v } })}
              options={DANMAKU_POS}
            />
          </div>
        </Row>

        <div className="obs-preview" style={{ marginTop: 4 }}>
          <span className="obs-preview__tag">效果预览</span>
          <DanmakuPreview pos={o.danmakuPos} />
        </div>

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
        <Row label="位置" hint="挑一个不和弹幕打架的角">
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

      <Card
        title="歌词"
        desc="当前这首歌的歌词会跟着播放进度滚动。纯音乐间奏没有歌词时这一块自动隐藏，不会在画面上留空白。"
      >
        <Row label="显示歌词">
          <Switch value={o.showLyric !== false} onChange={(v) => patch({ overlay: { showLyric: v } })} />
        </Row>
        <Row label="位置" hint="默认底部居中，像字幕；也可以贴某一角">
          <div style={{ width: 150 }}>
            <Select
              label="位置"
              value={o.lyricPos || 'bc'}
              onChange={(v) => patch({ overlay: { lyricPos: v } })}
              options={LYRIC_POS}
            />
          </div>
        </Row>
        <Row label="同屏行数" hint="第一行是当前正在唱的，其余是提前预告">
          <div style={{ width: 150 }}>
            <Select
              label="同屏行数"
              value={String(o.lyricLines ?? 2)}
              onChange={(v) => patch({ overlay: { lyricLines: Number(v) } })}
              options={LYRIC_LINE_OPTIONS}
            />
          </div>
        </Row>

        <div className="obs-preview" style={{ marginTop: 12 }}>
          <span className="obs-preview__tag">效果预览</span>
          <LyricPreview pos={o.lyricPos} lines={o.lyricLines} />
        </div>
        <div className="tip" style={{ marginTop: 8 }}>
          预览只示意位置与对齐，不含「界面大小 / 字体大小」的缩放 —— 那两个要在 OBS 里看真实画面。
        </div>
      </Card>

      <Card
        title="音色选择面板"
        desc="观众发「#音色列表 关键词」时，把候选连同信息摆到画面上供他挑；他再发「#绑定 2」，第 2 条就会被标出来。"
      >
        <Row label="显示选择面板">
          <Switch value={o.showVoicePick !== false} onChange={(v) => patch({ overlay: { showVoicePick: v } })} />
        </Row>
        <Row label="位置" hint="挑一个不和弹幕、歌词打架的角">
          <div style={{ width: 150 }}>
            <Select
              label="位置"
              value={o.voicePickPos || 'tr'}
              onChange={(v) => patch({ overlay: { voicePickPos: v } })}
              options={PICK_POS}
            />
          </div>
        </Row>
        <Row label="最多列几条" hint="列太多会顶掉弹幕那一段；序号小的永远在前面">
          <div style={{ width: 150 }}>
            <Select
              label="最多列几条"
              value={String(o.voicePickHits ?? 4)}
              onChange={(v) => patch({ overlay: { voicePickHits: Number(v) } })}
              options={PICK_HIT_OPTIONS}
            />
          </div>
        </Row>
        <Row label="每条显示时长" hint="到点自动消失。同时有好几个人在选就按这个时长排队一个个放，不会互相盖住">
          <div style={{ width: 220 }}>
            <Slider
              value={Math.round((o.voicePickTtlMs ?? 8000) / 1000)}
              min={3}
              max={30}
              step={1}
              onChange={(v) => patch({ overlay: { voicePickTtlMs: v * 1000 } })}
              suffix=" 秒"
            />
          </div>
        </Row>

        <div className="obs-preview" style={{ marginTop: 12 }}>
          <span className="obs-preview__tag">效果预览</span>
          <VoicePickPreview pos={o.voicePickPos} hits={o.voicePickHits} />
        </div>
        <div className="tip" style={{ marginTop: 8 }}>
          一次只显示一个人。后面还排着队时面板底下会写「还有 N 位在等」，倒计时条走完就换下一位。
          关掉它，主播端的一切照旧，只是不往画面上推了。
        </div>
      </Card>

      <Card
        title="画面适配"
        desc="OBS 浏览器源的宽高不一定是 16:9。拖成一条窄竖带时，弹幕、点歌面板、歌词、音色面板会各占一段、互不遮挡。"
      >
        <Row label="自动避让" hint="按你选的位置摆好之后实测各块占位，同一侧真的挨在一起才上下叠开；宽画面下不动任何东西">
          <Switch value={o.autoLayout !== false} onChange={(v) => patch({ overlay: { autoLayout: v } })} />
        </Row>
        <div className="tip" style={{ marginTop: 8 }}>
          宽度不到 640px（或高度不到 540px）时还会顺带把各块的宽度放开 —— 弹幕气泡不再按 1080p
          的宽度撑出画面，点歌面板、歌词、音色面板也会各自限定高度，给弹幕留地方。关掉它就严格照你选的位置摆，重叠也照放。
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
