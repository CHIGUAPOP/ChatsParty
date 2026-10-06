import React from 'react'
import { api, AppConfig, LoginInfo, Diagnostics } from '../lib/api'
import { Button, Card, Row, SectionTitle, Switch, TextField, Icon, Avatar } from '../components/ui'

interface Props {
  config: AppConfig
  patch: (p: Record<string, unknown>) => Promise<AppConfig>
  notify: (m: string, e?: boolean) => void
  loginInfo: LoginInfo
  setLoginInfo: (v: LoginInfo) => void
}

const QR_TEXT: Record<string, string> = {
  waiting: '等待扫码',
  scanned: '已扫码，请在手机上确认',
  success: '登录成功',
  expired: '二维码已失效',
  unknown: '未知状态',
}

export default function ConnectPage({ config, patch, notify, loginInfo, setLoginInfo }: Props) {
  const [roomId, setRoomId] = React.useState(config.room?.roomId || '')
  const [busy, setBusy] = React.useState(false)
  const [qr, setQr] = React.useState<string>('')
  const [qrState, setQrState] = React.useState('')
  const [polling, setPolling] = React.useState(false)
  const [diag, setDiag] = React.useState<Diagnostics | null>(null)
  const autoConnect = Boolean(config.room?.autoConnect)
  const setAutoConnect = (v: boolean) => {
    patch({ room: { autoConnect: v } })
  }

  const refreshDiag = React.useCallback(() => {
    api.app
      .diagnostics()
      .then(setDiag)
      .catch(() => setDiag(null))
  }, [])

  React.useEffect(() => {
    refreshDiag()
    const off = api.bilibili.onQrStatus((s) => {
      setQrState(s.status)
      if (s.status === 'success') {
        setPolling(false)
        api.bilibili.loginInfo().then(setLoginInfo)
        refreshDiag()
        notify('B站登录成功')
      }
    })
    return off
  }, [notify, setLoginInfo, refreshDiag])

  // 凭据有没有真的落到本机 —— 这一行是「重开就掉」时最直接的证据
  const credHint = diag
    ? `${
        diag.hasCredentials
          ? `凭据已加密保存在本机${diag.savedAt ? `（${new Date(diag.savedAt).toLocaleString('zh-CN')}）` : ''}`
          : '本机没有存到凭据，重开软件会掉登录，请重新扫码'
      } · 存下的音色库 ${diag.voiceCount ?? 0} 个 / 绑定 ${diag.bindingCount ?? 0} 人`
    : '凭据只用 safeStorage 存在本机，不会上传'

  const makeQr = async () => {
    setBusy(true)
    try {
      const r = await api.bilibili.qrGenerate()
      setQr(r.dataUrl)
      setQrState('waiting')
      setPolling(true)
      api.bilibili
        .qrPoll()
        .catch((e) => {
          setPolling(false)
          notify(String(e?.message || e), true)
        })
        .finally(() => setPolling(false))
    } catch (e: any) {
      notify(String(e?.message || e), true)
    } finally {
      setBusy(false)
    }
  }

  const connect = async () => {
    const id = String(roomId).trim()
    if (!id) {
      notify('请先填写直播间号', true)
      return
    }
    setBusy(true)
    await patch({ room: { roomId: id } })
    const r = await api.live.start(id)
    setBusy(false)
    if (!r.ok) notify(r.message || '连接失败', true)
    else notify(`已连接到 ${r.title || r.realRoomId || id}`)
  }

  const disconnect = async () => {
    await api.live.stop()
    notify('已断开')
  }

  const logout = async () => {
    await api.bilibili.logout()
    setLoginInfo({ isLogin: false })
    setQr('')
    setDiag(null)
    notify('已退出登录')
  }

  return (
    <div className="section">
      <SectionTitle>直播间</SectionTitle>
      <Card
        title="连接直播间"
        desc="填写直播间号即可接收弹幕。短号会自动换算成真实房间号。"
      >
        <div className="row">
          <TextField label="直播间号" value={roomId} onChange={setRoomId} placeholder="例如 21452505" />
          <Button onClick={connect} disabled={busy} icon="play">
            连接
          </Button>
          <Button variant="outlined" onClick={disconnect} icon="stop">
            断开
          </Button>
        </div>
        {config.room?.realRoomId ? (
          <div className="tip" style={{ marginTop: 16 }}>
            真实房间号 <span className="mono">{config.room.realRoomId}</span>
            {config.room.anchor ? ` · 主播 ${config.room.anchor}` : ''}
          </div>
        ) : null}
        <div className="divider" />
        <Row label="启动后自动连接" hint="记住上次房间号，启动时自动接入">
          <Switch value={autoConnect} onChange={setAutoConnect} />
        </Row>
      </Card>

      <SectionTitle>账号</SectionTitle>
      <div className="two-col">
        <Card
          title="B站扫码登录"
          desc="用手机 B站 App 扫码即可。登录后能看到完整昵称、发送弹幕，弹幕也不会被脱敏。"
          actions={
            loginInfo.isLogin ? (
              <Button variant="text" small onClick={logout} icon="logout">
                退出
              </Button>
            ) : null
          }
        >
          {loginInfo.isLogin ? (
            <div className="row">
              <Avatar src={loginInfo.face} name={loginInfo.uname} size={48} />
              <div className="row__text">
                <div className="row__label">{loginInfo.uname || '已登录'}</div>
                <div className="row__hint">{credHint}</div>
              </div>
            </div>
          ) : (
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div
                className={`qr-box${qr ? '' : ' is-idle'}`}
                onClick={() => !qr && !busy && makeQr()}
                style={{ cursor: qr || busy ? 'default' : 'pointer' }}
              >
                {qr ? <img src={qr} alt="登录二维码" /> : <span>点击生成二维码</span>}
              </div>
              <div className="row__text" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="row__label">{QR_TEXT[qrState] || '尚未生成二维码'}</div>
                <div className="row__hint">
                  未登录也能收弹幕，但大约 5 分钟后用户名会被 B站脱敏成 ***，且无法发送弹幕。
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button variant="tonal" small onClick={makeQr} disabled={busy || polling} icon="refresh">
                    {qr ? '刷新二维码' : '生成二维码'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Card>

        <Card title="说明">
          {loginInfo.expired ? (
            <div className="tip tip--warn" style={{ marginBottom: 12 }}>
              本机存过凭据，但 B站已经判定它失效了（换过密码 / 别处登录 / 太久没用）。
              {diag?.hasCredentials ? '重开前请先重新扫码。' : '本机目前没有可用凭据，扫码后会重新写入。'}
            </div>
          ) : null}
          <div className="tip" style={{ marginBottom: 12 }}>
            扫码走的是 B站官方二维码登录接口，凭据只用 <span className="mono">safeStorage</span> 存在本机。
          </div>
          <div className="tip tip--warn">
            Cookie 等同登录凭证。换了设备、改了密码或清了浏览器数据，需要重新扫码。
          </div>
        </Card>
      </div>
    </div>
  )
}
