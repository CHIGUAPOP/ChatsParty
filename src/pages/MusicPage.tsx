import React from 'react'
import { api, AppConfig, MusicAccount, MusicSong } from '../lib/api'
import { Button, Card, Chip, Icon, Row, SectionTitle, Select, Slider, Switch, TextField, useLiveSave } from '../components/ui'
import { useMusicPlayer } from '../lib/music-engine'

interface Props {
  config: AppConfig
  patch: (p: Record<string, unknown>) => Promise<AppConfig>
  notify: (m: string, e?: boolean) => void
}

const BR_OPTIONS = [
  { value: '128000', label: '标准 128k' },
  { value: '192000', label: '较高 192k' },
  { value: '320000', label: '极高 320k' },
]

/** 逗号 / 顿号 / 换行分隔的一串触发词 → 数组（与 electron/store.cjs 的清洗规则一致） */
function splitList(s: string): string[] {
  return String(s || '')
    .split(/[,，、\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * 播放器和「当前这首的 id」放在组件外面：
 * 切到别的页面时 MusicPage 会被卸载，如果跟着组件走，切回来就会从头重播一遍。
 * 放外面则真正做到「切页面不影响听歌」，播完的回调也还在。
 */
/**
 * 这一页现在只是**遥控器**：界面上显示的一切都由常驻的播放引擎给了
 * （见 src/lib/music-engine.tsx）。
 *
 * 播放器本体曾经住在这里，后果是切到别的页面组件就被卸载，
 * 订阅一摘、effect 一停，歌放完也没人接着放下一首 —— 必须切回点歌页才继续。
 * 那套逻辑整体搬走之后，这一页怎么切都不影响听歌了。
 */
export default function MusicPage({ config, patch, notify }: Props) {
  const m = config.music
  const player = useMusicPlayer()
  const { state, playing, position, duration, loading: loadingUrl, lrc, lrcIndex, toggle } = player
  const [keyword, setKeyword] = React.useState('')
  const [results, setResults] = React.useState<MusicSong[]>([])
  const [searching, setSearching] = React.useState(false)
  const [acct, setAcct] = React.useState<MusicAccount | null>(null)
  const [acctChecking, setAcctChecking] = React.useState(false)

  // 触发词和 Cookie 都是边打边存：停手 600ms 自动落盘，失焦再补一次。
  // 以前要打回车才生效，粘完 Cookie 顺手点别处就白填了。
  const cmd = useLiveSave((m.commands || []).join('、'), (v) =>
    patch({ music: { commands: splitList(v) } }),
  )
  const cookie = useLiveSave(m.cookie || '', (v) => patch({ music: { cookie: v } }))

  const search = async () => {
    const kw = keyword.trim()
    if (!kw) return
    setSearching(true)
    try {
      const r = await api.music.search(kw, 10)
      setResults(r || [])
      if (!r?.length) notify('没搜到，换个关键词试试')
    } catch (e: any) {
      notify(String(e?.message || e), true)
    } finally {
      setSearching(false)
    }
  }

  const enqueue = async (song: MusicSong) => {
    const r = await api.music.enqueue(song, '主播')
    if (r.ok) notify(`已加入点歌队列（第 ${r.position} 位）`)
    else notify(r.reason === 'full' ? '歌单满了，先放完几首' : '加入失败', true)
  }

  const runCheck = async () => {
    try {
      const r = await api.music.check()
      const who = r.account?.loggedIn ? `（已登录 ${r.account.nickname}${r.account.vip ? ' · 会员' : ''}）` : ''
      notify(`网易云接口正常：${r.song.name}${who}（${r.latency}ms）`)
    } catch (e: any) {
      notify(String(e?.message || e), true)
    }
  }

  /**
   * 网页登录：开一个窗口让用户直接登 music.163.com，
   * 登录成功主进程会把 Cookie 存好并推事件回来，这里只负责把结果摆出来。
   */
  const [loginWaiting, setLoginWaiting] = React.useState(false)
  React.useEffect(() => api.music.onLogin((r) => {
    setLoginWaiting(false)
    if (!r.ok) {
      // 用户在登录窗口里自己关掉了：不是失败，别用报错样式吓人
      if (r.cancelled) {
        notify('已取消登录')
        return
      }
      notify(r.message || '登录没成功，再试一次', true)
      return
    }
    // Cookie 输入框跟着配置走：主进程存好之后 m.cookie 变了，框里会自动显示出来
    notify(r.nickname ? `已登录 ${r.nickname}${r.vip ? ' · 会员' : ''}，Cookie 已保存` : '登录成功，Cookie 已保存')
    // 立刻用新 Cookie 查一次，界面上的登录状态马上就对
    api.music.account().then(setAcct).catch(() => {})
  }), [notify])

  const startWebLogin = async () => {
    setLoginWaiting(true)
    try {
      const r = await api.music.login()
      if (!r.ok) {
        setLoginWaiting(false)
        notify(r.message || '打不开登录窗口', true)
      }
    } catch (e: any) {
      setLoginWaiting(false)
      notify(String(e?.message || e), true)
    }
  }

  /* 专门用来查「我这把 Cookie 到底还算不算登录」 */
  const checkingLogin = React.useRef(false)
  const checkLogin = async () => {
    if (checkingLogin.current) return
    checkingLogin.current = true
    setAcctChecking(true)
    try {
      // 输入框可能还聚焦着、防抖还没到点：先让它落盘，否则「粘贴完直接点检测」查的还是旧 Cookie
      cookie.onBlur()
      const typed = cookie.value.trim()
      const r = await api.music.account()
      setAcct(r)
      if (!r.loggedIn) notify(typed ? 'Cookie 没被认出来，可能已失效或被登出' : '当前是匿名身份，会员歌曲点不了', true)
    } catch (e: any) {
      notify(String(e?.message || e), true)
    } finally {
      setAcctChecking(false)
      checkingLogin.current = false
    }
  }

  const fmt = (s: number) => {
    if (!Number.isFinite(s) || s < 0) s = 0
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  }

  const cur = state.current

  return (
    <div className="music-page">
      <Card title="正在播放" desc={cur ? `${cur.requester || '主播'}点的` : '队列空着的时候这里是空的'}>
        <div className="music-now">
          <div className="music-now__cover">
            {cur?.picUrl ? <img src={cur.picUrl} alt="" /> : <Icon name="music" size={36} />}
          </div>
          <div className="music-now__main">
            <div className="music-now__title">{cur ? cur.name : '没有在播的歌'}</div>
            <div className="music-now__sub">{cur ? cur.artists : '搜一首，或者等观众在弹幕里点'}</div>
            <div className="music-now__ctrl">
              <Button variant="filled" small onClick={toggle} icon={playing ? 'stop' : 'play'}>
                {playing ? '暂停' : '播放'}
              </Button>
              <Button variant="outlined" small onClick={() => api.music.next()} icon="skip">
                下一首
              </Button>
              <span className="music-now__time">
                {fmt(position)} / {cur ? cur.durationText || fmt(duration) : '0:00'}
              </span>
              {loadingUrl && <span className="music-now__tip">取播放地址…</span>}
            </div>
          </div>
        </div>

        <div style={{ width: 220, marginTop: 4 }}>
          <Slider value={m.volume} min={0} max={1} step={0.05} onChange={(v) => patch({ music: { volume: v } })} />
        </div>

        {lrc.length > 0 && (
          <div className="music-lyric">
            {lrc.slice(Math.max(0, lrcIndex - 2), lrcIndex + 6).map((l, i) => {
              const realIndex = Math.max(0, lrcIndex - 2) + i
              return (
                <div key={realIndex} className={`music-lyric__line${realIndex === lrcIndex ? ' is-active' : ''}`}>
                  {l.text}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <Card title="点歌" desc="主播自己搜，或者让观众在弹幕里发「点歌 歌名」">
        <div className="row">
          <div className="music-search">
            <input
              className="field__input"
              placeholder="歌名 / 歌手，例如：晴天 周杰伦"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) search()
              }}
            />
            <Button onClick={search} disabled={searching || !keyword.trim()} icon="search">
              搜索
            </Button>
          </div>
        </div>

        {results.length > 0 && (
          <div className="music-results">
            {results.map((s) => (
              <div key={s.id} className="music-result">
                <div className="music-result__main">
                  <span className="music-result__name">{s.name}</span>
                  {s.alias && <span className="music-result__alias">{s.alias}</span>}
                  <span className="music-result__meta">
                    {s.artists}
                    {s.album ? ` · ${s.album}` : ''}
                  </span>
                </div>
                <span className="music-result__dur">{s.durationText}</span>
                {!s.playable && <Chip variant="guard">版权受限</Chip>}
                <Button variant="outlined" small onClick={() => enqueue(s)} icon="add" disabled={!s.playable}>
                  点歌
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={`待播队列（${state.queued}）`} desc="观众点的和主播点的都在这里，按顺序播">
        {state.items.length === 0 ? (
          <div className="empty-state" style={{ padding: 18 }}>
            还没有人点歌
          </div>
        ) : (
          <div className="music-results">
            {state.items.map((it, i) => (
              <div key={`${it.id}-${it.at}`} className="music-result">
                <span className="music-result__no">{i + 1}</span>
                <div className="music-result__main">
                  <span className="music-result__name">{it.name}</span>
                  <span className="music-result__meta">
                    {it.artists}
                    {it.requester ? ` · ${it.requester}点的` : ''}
                  </span>
                </div>
                <span className="music-result__dur">{it.durationText}</span>
                <button type="button" className="icon-btn" title="移除" onClick={() => api.music.remove(i)}>
                  <Icon name="delete" size={18} />
                </button>
              </div>
            ))}
            <div className="row">
              <Button variant="text" small onClick={() => api.music.clear()} icon="delete">
                清空队列
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card title="点歌设置" desc="接口是自己写的，不走第三方服务，也不需要登录">
        <Row label="开启弹幕点歌" hint="关掉之后观众发「点歌」不再响应">
          <Switch value={m.enabled} onChange={(v) => patch({ music: { enabled: v } })} />
        </Row>
        <Row label="自动播放" hint="有人点歌就立刻开播；关掉则只进队列，等你点播放">
          <Switch value={m.autoPlay} onChange={(v) => patch({ music: { autoPlay: v } })} />
        </Row>
        <Row label="点歌时念一句" hint="用 TTS 播报「谁点了什么歌」">
          <Switch value={m.announce} onChange={(v) => patch({ music: { announce: v } })} />
        </Row>
        <Row label="弹幕里回执" hint="点歌成功后在直播间发一条确认弹幕">
          <Switch value={m.replyInChat} onChange={(v) => patch({ music: { replyInChat: v } })} />
        </Row>
        <Row label="音质" hint="匿名身份通常能拿到 320k；换更高需要填 Cookie">
          <div style={{ width: 150 }}>
            <Select label="音质" value={String(m.br)} onChange={(v) => patch({ music: { br: Number(v) } })} options={BR_OPTIONS} />
          </div>
        </Row>
        <Row label="队列上限" hint="防止一个人把歌单刷满">
          <div style={{ width: 150 }}>
            <Select
              label="队列上限"
              value={String(m.maxQueue)}
              onChange={(v) => patch({ music: { maxQueue: Number(v) } })}
              options={[10, 20, 30, 50].map((n) => ({ value: String(n), label: `${n} 首` }))}
            />
          </div>
        </Row>
        <Row label="每人点歌间隔" hint="同一个观众多久才能再点一首">
          <div style={{ width: 150 }}>
            <Select
              label="间隔"
              value={String(m.perUserCooldownMs)}
              onChange={(v) => patch({ music: { perUserCooldownMs: Number(v) } })}
              options={[
                { value: '10000', label: '10 秒' },
                { value: '30000', label: '30 秒' },
                { value: '60000', label: '1 分钟' },
                { value: '300000', label: '5 分钟' },
              ]}
            />
          </div>
        </Row>
        <Row label="触发词" hint="逗号或顿号分隔，观众发「这些词 + 歌名」就能点歌">
          <div style={{ width: 220 }}>
            <TextField
              label="触发词"
              value={cmd.value}
              onChange={cmd.onChange}
              onBlur={cmd.onBlur}
            />
          </div>
        </Row>

        <SectionTitle>网易云 Cookie（可选）</SectionTitle>
        <div className="card__desc" style={{ marginBottom: 8 }}>
          留空也能正常点歌，但会员歌曲和更高音质点不了 —— 这两样需要登录身份。
          填 music.163.com 的 <b>MUSIC_U</b> 这一条就够了（在 Cookie-Editor 里找它，或整段粘进来也行），
          其余如 NMTID、os 都是统计用的，可以不管。改完点一下「检测登录」确认有没有认出来。
          会员歌曲拿不到时另一个常见原因是这首歌要单独付费买专辑，跟有没有会员无关 —— 换一版原唱试试。
        </div>
        <TextField
          label="Cookie"
          value={cookie.value}
          onChange={cookie.onChange}
          onBlur={cookie.onBlur}
          mono
        />
        {acct && (
          <div className="row" style={{ marginTop: 6 }}>
            {acct.loggedIn ? (
              <Chip variant="ok">
                已登录 {acct.nickname}
                {acct.vip ? ' · 会员' : ' · 未开通会员'}
              </Chip>
            ) : (
              <Chip variant="guard">{m.cookie ? 'Cookie 没被认出来，重新取一次' : '匿名身份'}</Chip>
            )}
          </div>
        )}
        <div className="row">
          <Button variant="outlined" small onClick={checkLogin} disabled={acctChecking}>
            {acctChecking ? '检测中…' : '检测登录'}
          </Button>
          <Button variant="outlined" small onClick={runCheck} icon="refresh">
            测试接口
          </Button>
        </div>

        <div className="tip" style={{ marginTop: 12 }}>
          <b>不想手动填？点下面的按钮，直接开一个窗口登录网易云官网</b> —— 扫码、手机号、账号密码都行，
          登录成功会自动把 Cookie 取回来存好，不用再复制粘贴。
          {loginWaiting && (
            <div style={{ marginTop: 6 }}>
              <Chip variant="gift">等待登录中… 在刚打开的窗口里登录，成功后这个窗口会自动关掉</Chip>
            </div>
          )}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <Button variant="tonal" small onClick={startWebLogin} disabled={loginWaiting} icon="plug">
            {loginWaiting ? '等待登录中…' : '登录网易云（自动取 Cookie）'}
          </Button>
          {loginWaiting && (
            <Button variant="text" small onClick={() => api.music.loginCancel().then(() => setLoginWaiting(false))}>
              取消
            </Button>
          )}
        </div>
      </Card>
    </div>
  )
}
