import React from 'react'
import { api, AppConfig, LoginInfo } from '../lib/api'
import { Button, Icon, TextField } from './ui'
import appIcon from '../assets/icon.png'

/**
 * 首次启动的浮层向导。
 *
 * 目的很窄：让第一次打开的人**在五分钟内听到第一句弹幕**，而不是先对着八个
 * 设置页发呆。所以只走四件事 —— 说明这软件干什么、B站登录、语音怎么出声、
 * 填直播间号 —— 每一步都能跳，也可以整体跳过（跳过之后从「关于」页还能再打开）。
 *
 * 不在这里做「配置大全」：颜色、OBS、音色都留在各自的页面里，向导只负责
 * 把人送到「能用」这条线上。
 */

interface Props {
  config: AppConfig
  patch: (p: Record<string, unknown>) => Promise<AppConfig>
  notify: (m: string, e?: boolean) => void
  loginInfo: LoginInfo
  setLoginInfo: (v: LoginInfo) => void
  onDone: () => void
}

const STEPS = [
  { id: 'welcome', label: '欢迎' },
  { id: 'login', label: 'B站登录' },
  { id: 'voice', label: '语音' },
  { id: 'room', label: '直播间' },
  { id: 'done', label: '完成' },
] as const

type StepId = (typeof STEPS)[number]['id']

const QR_TEXT: Record<string, string> = {
  waiting: '等待扫码…',
  scanned: '已扫码，请在手机上确认',
  success: '登录成功',
  expired: '二维码失效了，点下面刷新',
  unknown: '状态未知',
}

export default function Onboarding({ config, patch, notify, loginInfo, setLoginInfo, onDone }: Props) {
  const [i, setI] = React.useState(0)
  const step: StepId = STEPS[i].id

  const [qr, setQr] = React.useState('')
  const [qrState, setQrState] = React.useState('')
  const [qrBusy, setQrBusy] = React.useState(false)
  const [providers, setProviders] = React.useState<Record<string, any>>({})
  const [keyDraft, setKeyDraft] = React.useState('')
  const [showKey, setShowKey] = React.useState(false)
  const [roomDraft, setRoomDraft] = React.useState(config.room?.roomId || '')
  const [busy, setBusy] = React.useState(false)

  const next = () => setI((n) => Math.min(STEPS.length - 1, n + 1))
  const prev = () => setI((n) => Math.max(0, n - 1))

  /** 走完 / 跳过 / 点×：都记成「看过了」，下次不自动弹。关于页还能手动重开 */
  const finish = React.useCallback(async () => {
    try {
      await patch({ general: { onboardingSeen: true } })
    } finally {
      onDone()
    }
  }, [patch, onDone])

  React.useEffect(() => {
    api.tts
      .providers()
      .then((p) => setProviders(p || {}))
      .catch(() => setProviders({}))
  }, [])

  // 扫码状态由主进程推：游客点确认之后这里才知道成没成
  React.useEffect(() => {
    return api.bilibili.onQrStatus((s) => {
      setQrState(s.status)
      if (s.status === 'success') {
        api.bilibili.loginInfo().then(setLoginInfo)
        notify('B站登录成功')
      }
    })
  }, [notify, setLoginInfo])

  const makeQr = React.useCallback(async () => {
    setQrBusy(true)
    try {
      const r = await api.bilibili.qrGenerate()
      setQr(r.dataUrl)
      setQrState('waiting')
      api.bilibili.qrPoll().catch((e: any) => notify(String(e?.message || e), true))
    } catch (e: any) {
      notify(String(e?.message || e), true)
    } finally {
      setQrBusy(false)
    }
  }, [notify])

  // 走到登录这一步就自动出一张码 —— 让用户再点一次「生成」纯属多余
  React.useEffect(() => {
    if (step !== 'login' || loginInfo.isLogin || qr || qrBusy) return
    makeQr()
  }, [step, loginInfo.isLogin, qr, qrBusy, makeQr])

  const useEdge = async () => {
    setBusy(true)
    try {
      await patch({
        tts: {
          enabled: true,
          provider: 'edge',
          protocol: 'edge-tts',
          baseUrl: '',
          apiKey: '',
          model: '',
          voice: 'zh-CN-XiaoxiaoNeural',
          format: 'mp3',
        },
      })
      notify('已切到 Edge 朗读，不用密钥就能出声')
      next()
    } finally {
      setBusy(false)
    }
  }

  const saveKey = async () => {
    const key = keyDraft.trim()
    if (!key) {
      notify('先把 Key 粘进来', true)
      return
    }
    setBusy(true)
    try {
      await patch({ tts: { enabled: true, apiKey: key } })
      notify('Key 已保存，可以在「语音」页点「测试语音」试听')
      next()
    } finally {
      setBusy(false)
    }
  }

  const connectRoom = async () => {
    const id = roomDraft.trim()
    if (!id) {
      notify('填一个直播间号，或者直接跳过', true)
      return
    }
    setBusy(true)
    try {
      await patch({ room: { roomId: id } })
      const r = await api.live.start(id)
      if (!r.ok) notify(r.message || '连接失败', true)
      else notify(`已连接到 ${r.title || r.realRoomId || id}`)
      next()
    } finally {
      setBusy(false)
    }
  }

  const preset = providers[config.tts?.provider || 'mimo'] || {}
  const hasKey = Boolean(String(config.tts?.apiKey || '').trim())
  const providerName = preset.name || config.tts?.provider || '当前平台'
  const consoleUrl = preset.consoleUrl || ''

  const openUrl = async (url: string) => {
    const r = await api.app.openExternal(url).catch(() => ({ ok: false, message: '打不开链接' }))
    if (!r.ok) notify(r.message || '打不开链接', true)
  }

  return (
    <div className="onb-scrim" role="dialog" aria-modal="true" aria-label="新手引导">
      <div className="onb">
        <header className="onb__head">
          <div className="onb__brand">
            <img src={appIcon} alt="" width={28} height={28} />
            <span>ChatsParty 快速上手</span>
          </div>
          <button type="button" className="onb__close" onClick={finish} title="关掉引导（之后可在「关于」页重新打开）">
            <Icon name="close" size={20} />
          </button>
        </header>

        <div className="onb__steps" aria-hidden>
          {STEPS.map((s, n) => (
            <span key={s.id} className={`onb__dot${n === i ? ' is-active' : ''}${n < i ? ' is-done' : ''}`} />
          ))}
          <span className="onb__step-label">
            {i + 1} / {STEPS.length} · {STEPS[i].label}
          </span>
        </div>

        <div className="onb__body">
          {step === 'welcome' && (
            <>
              <h2 className="onb__title">把直播间弹幕念出来</h2>
              <p className="onb__desc">
                四步就能听到第一句弹幕。每一步都可以跳过，跳过的内容以后在对应页面里随时能补。
              </p>
              <ul className="onb__list">
                <li>
                  <Icon name="plug" size={18} /> 不登录也能收弹幕，登录后昵称不会被脱敏
                </li>
                <li>
                  <Icon name="voice" size={18} /> 语音可以完全免费 —— Edge 朗读不用密钥
                </li>
                <li>
                  <Icon name="music" size={18} /> 观众能点歌、点视频，也能挂到 OBS 上
                </li>
              </ul>
            </>
          )}

          {step === 'login' && (
            <>
              <h2 className="onb__title">登录 B 站（可选）</h2>
              <p className="onb__desc">
                手机 B站 App 扫一下就好。不登录也能用，只是大约 5 分钟后弹幕里的用户名会被 B站
                打码成 <span className="mono">***</span>，也没法在直播间发弹幕。
              </p>
              {loginInfo.isLogin ? (
                <div className="onb__ok">
                  <Icon name="check" size={20} />
                  已登录{loginInfo.uname ? `：${loginInfo.uname}` : ''}
                </div>
              ) : (
                <div className="onb__qr">
                  <div className="qr-box">
                    {qr ? <img src={qr} alt="登录二维码" /> : <span>正在生成二维码…</span>}
                  </div>
                  <div className="onb__qr-side">
                    <div className="onb__qr-state">{QR_TEXT[qrState] || '准备中'}</div>
                    <div className="row__hint">凭据只用系统加密存在本机，不会上传。</div>
                    <Button variant="tonal" small onClick={makeQr} disabled={qrBusy} icon="refresh">
                      {qr ? '刷新二维码' : '重新生成'}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}

          {step === 'voice' && (
            <>
              <h2 className="onb__title">让弹幕出声</h2>
              <p className="onb__desc">
                不想折腾密钥就选第一个，装好即用。要用自己的音色再接在线平台。
              </p>
              <div className="onb__choices">
                <button type="button" className="onb__choice" onClick={useEdge} disabled={busy}>
                  <span className="onb__choice-title">
                    Edge 朗读 <span className="onb__tag">免费 · 免密钥</span>
                  </span>
                  <span className="onb__choice-desc">系统自带的声音，不用注册任何账号，选它立刻就能念</span>
                </button>

                <div className={`onb__choice onb__choice--static${showKey ? ' is-open' : ''}`}>
                  <button
                    type="button"
                    className="onb__choice-head"
                    onClick={() => setShowKey((v) => !v)}
                  >
                    <span className="onb__choice-title">
                      {providerName}
                      <span className="onb__tag">{hasKey ? '已填 Key' : '需要 Key'}</span>
                    </span>
                    <span className="onb__choice-desc">
                      {hasKey ? 'Key 已经填过了，可以直接下一步' : '去控制台生成一把 Key 粘进来'}
                    </span>
                  </button>
                  {showKey && !hasKey && (
                    <div className="onb__key">
                      <TextField
                        label="API Key"
                        value={keyDraft}
                        onChange={setKeyDraft}
                        type="password"
                        mono
                        placeholder="粘贴到这里"
                      />
                      <div className="onb__key-actions">
                        {consoleUrl && (
                          <Button variant="text" small onClick={() => openUrl(consoleUrl)} icon="link">
                            去申请
                          </Button>
                        )}
                        <Button small onClick={saveKey} disabled={busy}>
                          保存
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <p className="onb__hint">选哪个都能随时在「语音」页换掉，这里只是先让它能出声。</p>
            </>
          )}

          {step === 'room' && (
            <>
              <h2 className="onb__title">连一个直播间</h2>
              <p className="onb__desc">
                填直播间号就行，短号会自动换算成真实房间号。也可以先去设置里逛逛，等开播再连。
              </p>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <TextField
                  label="直播间号"
                  value={roomDraft}
                  onChange={setRoomDraft}
                  placeholder="例如 21452505"
                  onEnter={connectRoom}
                />
              </div>
              {config.room?.realRoomId ? (
                <div className="tip" style={{ marginTop: 12 }}>
                  当前已连：真实房间号 <span className="mono">{config.room.realRoomId}</span>
                  {config.room.title ? ` · ${config.room.title}` : ''}
                </div>
              ) : null}
            </>
          )}

          {step === 'done' && (
            <>
              <h2 className="onb__title">可以开播了</h2>
              <p className="onb__desc">下面这几个地方值得逛一圈，都不是必须的。</p>
              <ul className="onb__list">
                <li>
                  <Icon name="settings" size={18} /> <b>OBS</b>：把弹幕、礼物、点歌做成叠加层，浏览器源填个地址就能用
                </li>
                <li>
                  <Icon name="layers" size={18} /> <b>音色</b>：保存不同的嗓子，观众发弹幕就能切
                </li>
                <li>
                  <Icon name="palette" size={18} /> <b>外观</b>：换主题色、深浅色，还能切 Material 2 风格
                </li>
              </ul>
              <p className="onb__hint">这个引导之后想看，从左上角图标进「关于」页点「重新看一遍引导」。</p>
            </>
          )}
        </div>

        <footer className="onb__foot">
          <button type="button" className="onb__skip-all" onClick={finish}>
            全部跳过
          </button>
          <div style={{ flex: 1 }} />
          {i > 0 && i < STEPS.length - 1 && (
            <Button variant="text" onClick={prev}>
              上一步
            </Button>
          )}
          {step === 'welcome' && <Button onClick={next}>开始设置</Button>}
          {step === 'login' && (
            <>
              <Button variant="text" onClick={next}>
                先不登录
              </Button>
              <Button onClick={next}>{loginInfo.isLogin ? '下一步' : '已经登录了'}</Button>
            </>
          )}
          {step === 'voice' && (
            <>
              <Button variant="text" onClick={next}>
                跳过这一步
              </Button>
              <Button onClick={next}>下一步</Button>
            </>
          )}
          {step === 'room' && (
            <>
              <Button variant="text" onClick={next}>
                先不连
              </Button>
              <Button onClick={connectRoom} disabled={busy}>
                连接并继续
              </Button>
            </>
          )}
          {step === 'done' && <Button onClick={finish}>开始使用</Button>}
        </footer>
      </div>
    </div>
  )
}
