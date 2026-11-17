import React from 'react'
import { api, AppConfig, AppInfo, UpdateCheckResult } from '../lib/api'
import { Button, Card, Chip, Row, Switch } from '../components/ui'
import appIcon from '../assets/icon.png'

const REPO_URL = 'https://github.com/CHIGUAPOP/ChatsParty'
const REPO_LABEL = 'CHIGUAPOP/ChatsParty'

interface Props {
  config: AppConfig
  patch: (p: Record<string, unknown>) => Promise<AppConfig>
  notify: (m: string, e?: boolean) => void
}

export default function AboutPage({ config, patch, notify }: Props) {
  const [info, setInfo] = React.useState<AppInfo | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [result, setResult] = React.useState<UpdateCheckResult | null>(null)

  // 版本由主进程给：打包后是 exe 的版本信息，源码跑时是 package.json
  React.useEffect(() => {
    api.app
      .info()
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])

  const openExternal = async (url: string) => {
    const r = await api.app.openExternal(url).catch(() => ({ ok: false, message: '打不开链接' }))
    if (!r.ok) notify(r.message || '打不开链接', true)
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify('链接已复制')
    } catch {
      notify('复制失败，请手动选中链接', true)
    }
  }

  const check = async () => {
    setChecking(true)
    try {
      const r = await api.app.updateCheck({ reason: 'manual' })
      setResult(r)
      if (!r.ok) {
        if (r.reason === 'no-release') notify('GitHub 上还没有发布版本')
        else notify(r.message || '检查更新失败', true)
      } else if (r.hasUpdate) notify(`有新版本 v${r.latest}`)
      else notify('已经是最新版本')
    } catch (e: any) {
      notify(String(e?.message || e), true)
    } finally {
      setChecking(false)
    }
  }

  const auto = config.general?.autoCheckUpdate !== false
  const devMode = info?.packaged === false

  /** 状态文案：只有手动查过才说细的，没查过就一句话说明会怎么查 */
  const statusText = () => {
    if (checking) return '正在问 GitHub…'
    if (!result) {
      return devMode
        ? '从源码运行的，不会自动检查（可以点按钮手动查）'
        : auto
          ? '每次打开时查一次，连不上就跳过'
          : '自动检查已关闭'
    }
    if (!result.ok) return `没查成：${result.message || result.reason || '网络不通'}`
    if (result.hasUpdate) return `发现新版本 v${result.latest}（当前 v${result.current}）`
    return `已经是最新版本（v${result.current}）`
  }

  return (
    <div className="section">
      <div className="about-hero">
        <img className="about-hero__icon" src={appIcon} alt="ChatsParty" />
        <div className="about-hero__text">
          <div className="about-hero__name">
            ChatsParty
            <Chip variant="ok">v{info?.version || '—'}</Chip>
          </div>
          <p className="about-hero__desc">
            B 站直播弹幕姬：把直播间弹幕变成声音，支持多种 TTS 引擎、弹幕音色指令、点歌与 OBS 叠加层。
          </p>
        </div>
      </div>

      <Card title="版本与更新" desc="只比对 GitHub 上最新的 Release 标签，确认有新版本后自己去下载页拿新的 exe。">
        <Row label="当前版本">
          <span className="mono">v{info?.version || '—'}</span>
        </Row>
        <div className="divider" />
        <Row label="打开软件时自动检查" hint="整个启动过程只查一次；连不上就算了，不会反复重试">
          <Switch value={auto} onChange={(v) => patch({ general: { autoCheckUpdate: v } })} />
        </Row>
        <div className="divider" />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Button variant="tonal" small onClick={check} disabled={checking} icon="refresh">
            {checking ? '检查中…' : '检查更新'}
          </Button>
          <span className="row__hint" style={{ flex: 1, minWidth: 0 }}>
            {statusText()}
          </span>
        </div>

        {result?.ok && result.hasUpdate && (
          <>
            <div className="divider" />
            <div className="tip tip--warn">
              新版本 v{result.latest} 已经在 GitHub 上发布了，当前用的是 v{result.current}。
              便携版不会自己替换程序文件，需要手动下载新的 exe。
            </div>
            <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
              <Button small onClick={() => openExternal(result.url || REPO_URL)} icon="download">
                去下载 v{result.latest}
              </Button>
              <Button
                variant="text"
                small
                onClick={async () => {
                  await patch({ general: { skipUpdateVersion: String(result.latest) } })
                  notify(`v${result.latest} 不再提醒`)
                }}
              >
                这个版本先不提醒
              </Button>
            </div>
            {result.notes ? <pre className="about-notes">{result.notes}</pre> : null}
          </>
        )}
      </Card>

      <Card title="新手引导" desc="第一次打开时会自动走一遍：B站登录、语音怎么出声、填直播间号。">
        <Row label="重新看一遍引导" hint="任何时候都能重来，跳过或走完都不会改你已有的设置">
          <Button
            variant="tonal"
            small
            onClick={async () => {
              await patch({ general: { onboardingSeen: false } })
              notify('引导已经重新打开了')
            }}
          >
            重新打开
          </Button>
        </Row>
      </Card>

      <Card title="项目" desc="源码、更新记录和问题反馈都在 GitHub 上。">
        <div className="about-link">
          <span className="about-link__url" title={REPO_URL}>
            github.com/{REPO_LABEL}
          </span>
          <span className="about-link__actions">
            <Button small variant="tonal" icon="link" onClick={() => openExternal(REPO_URL)}>
              打开项目页
            </Button>
            <Button small variant="text" onClick={() => copy(REPO_URL)}>
              复制链接
            </Button>
          </span>
        </div>
        <p className="about-note">点「打开项目页」会用系统默认浏览器打开 {REPO_URL}</p>
      </Card>

      <Card title="运行环境" desc="反馈问题时把这一段一起贴出来，能省一轮来回。">
        <Row label="Electron">{info?.electron || '—'}</Row>
        <Row label="Chromium">{info?.chrome || '—'}</Row>
        <Row label="Node.js">{info?.node || '—'}</Row>
        <Row label="平台">{info?.platform || '—'}</Row>
        <Row label="构建" hint="源码运行时不会自动检查更新">
          {devMode ? '源码运行（未打包）' : '打包发布版'}
        </Row>
      </Card>

      <Card title="许可与致谢">
        <Row label="开源许可" hint="可自由使用、修改与分发，需保留版权声明">
          MIT License
        </Row>
        <Row label="开发" hint="本项目由 AI 辅助完成">
          Hy4 preview 与 DeepSeek V4.1 Flash
        </Row>
        <Row label="界面" hint="设计语言与动效令牌">
          Material 3 / Material 3 Expressive / Material 2
        </Row>
      </Card>
    </div>
  )
}
