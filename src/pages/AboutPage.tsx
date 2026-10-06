import React from 'react'
import { api, AppInfo } from '../lib/api'
import { Button, Card, Chip, Row } from '../components/ui'
import appIcon from '../assets/icon.png'

const REPO_URL = 'https://github.com/CHIGUAPOP/ChatsParty'
const REPO_LABEL = 'CHIGUAPOP/ChatsParty'

interface Props {
  notify: (m: string, e?: boolean) => void
}

export default function AboutPage({ notify }: Props) {
  const [info, setInfo] = React.useState<AppInfo | null>(null)

  // 版本由主进程的 app.getVersion() 给：开发时读 package.json，打包后读 exe 版本信息
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
        <p className="about-note">
          点「打开项目页」会用系统默认浏览器打开 {REPO_URL}
        </p>
      </Card>

      <Card title="运行环境" desc="反馈问题时把这一段一起贴出来，能省一轮来回。">
        <Row label="Electron">{info?.electron || '—'}</Row>
        <Row label="Chromium">{info?.chrome || '—'}</Row>
        <Row label="Node.js">{info?.node || '—'}</Row>
        <Row label="平台">{info?.platform || '—'}</Row>
      </Card>

      <Card title="许可与致谢">
        <Row label="开源许可" hint="可自由使用、修改与分发，需保留版权声明">
          MIT License
        </Row>
        <Row label="开发" hint="本项目由 AI 辅助完成">
          Hy4 preview 与 DeepSeek V4.1 Flash
        </Row>
        <Row label="界面" hint="设计语言与动效令牌">
          Material 3 / Material 3 Expressive
        </Row>
      </Card>
    </div>
  )
}
