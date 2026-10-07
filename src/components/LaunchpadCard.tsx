import React from 'react'
import { api, AppConfig, LaunchpadScan, LaunchpadStep } from '../lib/api'
import { Button, Card, Icon, Row, Slider, Switch } from './ui'

interface Props {
  config: AppConfig
  patch: (p: Record<string, unknown>) => Promise<AppConfig>
  notify: (m: string, e?: boolean) => void
  /** 连接页输入框里当前填的房间号 —— 一键开播的最后一步要拿它连直播间 */
  roomId: string
}

const ORIGIN_LABEL: Record<string, string> = {
  steam: 'Steam',
  external: '独立安装',
  custom: '手动添加',
}

const STATUS_TEXT: Record<string, string> = {
  pending: '等待中',
  running: '正在启动…',
  started: '已启动',
  skipped: '已在运行，跳过',
  failed: '启动失败',
}

/** 配置里没写到的字段用这套顶上 —— 老配置里没有 launchpad 这一段 */
const LP_DEFAULTS: NonNullable<AppConfig['launchpad']> = {
  order: [],
  useSteam: true,
  gapMs: 1500,
  autoConnect: true,
  skipRunning: true,
  custom: [],
}

/**
 * 「开播准备」：把 OBS / 虚拟形象 / 直播姬这些一次拉起来。
 *
 * 清单是**现扫的**，不是写死的 —— Steam 装在哪个盘、库文件夹有几个、
 * 直播姬的版本目录走到哪一版，都靠 `electron/launchpad.cjs` 现场读出来。
 * 所以换台机器、换个版本，这里不用改代码。
 *
 * 两条规矩写在实现里：**已经在跑的不重复启动**（OBS 被拉第二遍会弹警告框），
 * 以及**只读扫描** —— 光打开这个页面不会启动任何东西。
 */
export default function LaunchpadCard({ config, patch, notify, roomId }: Props) {
  const [scan, setScan] = React.useState<LaunchpadScan | null>(null)
  const [scanning, setScanning] = React.useState(false)
  const [steps, setSteps] = React.useState<LaunchpadStep[]>([])
  const [busy, setBusy] = React.useState(false)
  const [connect, setConnect] = React.useState<{ ok: boolean; title?: string; realRoomId?: number; message?: string } | null>(
    null
  )

  const lp = { ...LP_DEFAULTS, ...(config.launchpad || {}) }
  const order = lp.order
  const useSteam = lp.useSteam
  const autoConnect = lp.autoConnect
  const skipRunning = lp.skipRunning
  const gapMs = Number(lp.gapMs ?? LP_DEFAULTS.gapMs)

  const load = React.useCallback(
    async (force?: boolean) => {
      setScanning(true)
      try {
        setScan(await api.launchpad.scan({ force }))
      } catch (e: any) {
        notify(String(e?.message || e), true)
      } finally {
        setScanning(false)
      }
    },
    [notify]
  )

  React.useEffect(() => {
    load(false)
  }, [load])

  // 主进程每走一步都会推一次，这里只负责显示
  React.useEffect(() => api.launchpad.onProgress((p) => setSteps(p.steps || [])), [])

  const apps = scan?.apps || []
  const stepOf = (id: string) => steps.find((s) => s.id === id)
  const setLp = (v: Record<string, unknown>) => patch({ launchpad: v })

  const toggle = (id: string) => {
    setLp({ order: order.includes(id) ? order.filter((x) => x !== id) : [...order, id] })
  }

  const run = async () => {
    if (!order.length) {
      notify('先勾选要一起拉起的程序', true)
      return
    }
    setBusy(true)
    setSteps([])
    setConnect(null)
    try {
      const r = await api.launchpad.run({
        order,
        roomId: String(roomId || config.room?.roomId || '').trim(),
      })
      setSteps(r.steps || [])
      setConnect(r.connect || null)
      const list = r.steps || []
      const n = (s: string) => list.filter((x) => x.status === s).length
      const parts = [`启动 ${n('started')} 个`]
      if (n('skipped')) parts.push(`跳过 ${n('skipped')} 个（已在运行）`)
      if (n('failed')) parts.push(`失败 ${n('failed')} 个`)
      if (r.connect) parts.push(r.connect.ok ? '已连上直播间' : r.connect.message || '没连上直播间')
      else if (r.message) parts.push(r.message)
      notify(parts.join('，'), n('failed') > 0 || (r.connect ? !r.connect.ok : false))
      // 拉完重扫一次，把刚起来的那些标成「已在运行」
      load(true)
    } catch (e: any) {
      notify(String(e?.message || e), true)
    } finally {
      setBusy(false)
    }
  }

  const addCustom = async () => {
    try {
      const r = await api.launchpad.pickExe()
      if (!r.ok || !r.exe) return
      const custom = [...(lp.custom || []), { exe: r.exe, name: r.name || '' }]
      await setLp({ custom })
      await load(true)
      notify(`已加入 ${r.name || r.exe}`)
    } catch (e: any) {
      notify(String(e?.message || e), true)
    }
  }

  const removeCustom = async (exe: string) => {
    // 顺带把它从启动顺序里摘掉 —— 留着的话清单上看不见、启动时却会去找
    const app = apps.find((a) => a.exe === exe)
    const next = (lp.custom || []).filter((c) => c.exe !== exe)
    await setLp({ custom: next, order: app ? order.filter((x) => x !== app.id) : order })
    await load(true)
  }

  return (
    <Card
      title="开播准备"
      desc="把 OBS、虚拟形象、直播姬这些直播用的程序一次拉起来，省得每次开播手点一遍。程序是按本机现扫出来的，Steam 装在哪个库都能认出来。"
      actions={
        <Button variant="text" small icon="refresh" onClick={() => load(true)} disabled={scanning || busy}>
          {scanning ? '扫描中…' : '重新扫描'}
        </Button>
      }
    >
      {scan?.steamRoot ? (
        <div className="tip" style={{ marginBottom: 12 }}>
          Steam 装在 <span className="mono">{scan.steamRoot}</span>
          {scan.libraries && scan.libraries.length > 1 ? `，共 ${scan.libraries.length} 个库文件夹` : ''}
          。扫到的东西只读了一遍配置，没有启动任何程序。
        </div>
      ) : null}
      {scan?.errors?.length ? (
        <div className="tip tip--warn" style={{ marginBottom: 12 }}>
          扫描时有几处读不了：{scan.errors.slice(0, 3).join('；')}
        </div>
      ) : null}
      {apps.some((a) => a.elevate && order.includes(a.id)) ? (
        <div className="tip" style={{ marginBottom: 12 }}>
          标着「需管理员」的程序（比如哔哩哔哩直播姬）要系统的管理员授权 ——
          轮到它时桌面会弹一个窗口，点「是」就行。没点或点了「否」它起不来，
          这一步会记成失败，后面的程序照常启动。
        </div>
      ) : null}

      {apps.length ? (
        <div className="lp-list">
          {apps.map((a) => {
            const st = stepOf(a.id)
            const on = order.includes(a.id)
            const custom = (lp.custom || []).some((c) => c.exe === a.exe)
            return (
              <div key={a.id} className={`lp-item${on ? ' is-on' : ''}${st ? ` is-${st.status}` : ''}`}>
                <div
                  className="lp-item__main"
                  onClick={() => !busy && toggle(a.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') toggle(a.id)
                  }}
                >
                  <span className={`lp-check${on ? ' is-on' : ''}`}>{on ? <Icon name="check" size={14} /> : null}</span>
                  <span className="lp-order">{on ? order.indexOf(a.id) + 1 : ''}</span>
                  <span className="lp-item__name">{a.name}</span>
                  <span className="lp-item__badge">{ORIGIN_LABEL[a.origin] || a.origin}</span>
                  {a.elevate ? (
                    <span
                      className="lp-item__badge is-admin"
                      title="它要求管理员权限，启动时桌面会弹一个窗口，点「是」即可"
                    >
                      需管理员
                    </span>
                  ) : null}
                  {a.version ? <span className="lp-item__badge">{a.version}</span> : null}
                  <span className="lp-item__spacer" />
                  {st ? (
                    <span className={`lp-item__state is-${st.status}`}>{STATUS_TEXT[st.status] || st.status}</span>
                  ) : a.running ? (
                    <span className="lp-item__state is-live">已在运行</span>
                  ) : null}
                  {custom ? (
                    <button
                      className="lp-x"
                      type="button"
                      title="从清单里移除"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeCustom(a.exe)
                      }}
                    >
                      <Icon name="delete" size={16} />
                    </button>
                  ) : null}
                </div>
                <div className="lp-item__path mono" title={a.exe || ''}>
                  {a.exe || '装是装了，但没扫到可执行文件'}
                </div>
                {st && st.message ? <div className="lp-item__msg">{st.message}</div> : null}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="tip" style={{ marginBottom: 12 }}>
          {scanning ? '正在扫描本机的直播软件…' : '没扫到认识的直播程序。装在别处的可以用下面的「手动添加」补上。'}
        </div>
      )}

      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <Button variant="tonal" small icon="check" onClick={() => setLp({ order: apps.filter((a) => !a.exeMissing).map((a) => a.id) })}>
          全选
        </Button>
        <Button variant="text" small onClick={() => setLp({ order: [] })} disabled={!order.length}>
          清空
        </Button>
        <span className="lp-item__spacer" />
        <Button variant="text" small icon="add" onClick={addCustom}>
          手动添加
        </Button>
      </div>

      <div className="divider" />

      <Row label="走 Steam 启动" hint="用官方协议 steam://rungameid/<appid>；关掉就直接跑 exe（虚拟形象类会带 -nosteam）">
        <Switch value={useSteam} onChange={(v) => setLp({ useSteam: v })} />
      </Row>
      <Row label="已经在跑的就不再拉一遍" hint="OBS 被重复启动会弹「已在运行」的警告框">
        <Switch value={skipRunning} onChange={(v) => setLp({ skipRunning: v })} />
      </Row>
      <Row label="拉完自动连直播间" hint="用上面填的直播间号直接接上，省一次手点">
        <Switch value={autoConnect} onChange={(v) => setLp({ autoConnect: v })} />
      </Row>
      <Row label="每个之间等多久" hint="给上一个程序留点起身时间；Steam 没开时第一个还得先把 Steam 唤起来">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 220 }}>
          <Slider value={gapMs} onChange={(v) => setLp({ gapMs: v })} min={0} max={8000} step={100} />
          <span className="mono" style={{ whiteSpace: 'nowrap' }}>
            {(gapMs / 1000).toFixed(1)} 秒
          </span>
        </div>
      </Row>

      <div className="row" style={{ gap: 12, marginTop: 16 }}>
        <Button onClick={run} disabled={busy || !order.length} icon="power">
          {busy ? '正在开播…' : `一键开播${order.length ? `（${order.length} 个）` : ''}`}
        </Button>
        {connect ? (
          <span className={connect.ok ? 'tip' : 'tip tip--warn'}>
            {connect.ok
              ? `已连上${connect.title ? ` ${connect.title}` : ''}（房间 ${connect.realRoomId || ''}）`
              : `连直播间失败：${connect.message || '未知原因'}`}
          </span>
        ) : null}
      </div>
    </Card>
  )
}
