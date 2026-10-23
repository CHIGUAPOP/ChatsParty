'use strict'
/* 非侵入式冒烟测试：只验证纯逻辑与网络层，不启动窗口 */
const { Session, Wbi } = require('../electron/lib/http.cjs')
const { BilibiliAPI } = require('../electron/bilibili/api.cjs')
const { LiveClient, encodePacket, decodeBuffer } = require('../electron/bilibili/live.cjs')
const edge = require('../electron/tts-edge.cjs')
const V = require('../electron/voices.cjs')
const { synthesize } = require('../electron/tts.cjs')
const zlib = require('node:zlib')
const path = require('node:path')
const fs = require('node:fs')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

async function main() {
  console.log('\n[1] 二进制封包编解码')
  const body = JSON.stringify({ cmd: 'DANMU_MSG', info: ['x', '你好'] })
  const pkt = encodePacket(body, 5, 0, 1)
  ok('封包长度为 16 + body', pkt.length === 16 + Buffer.byteLength(body))
  ok('头部 magic 正确', pkt.readUInt16BE(4) === 16 && pkt.readUInt32BE(8) === 5)
  const decoded = decodeBuffer(pkt)
  ok('解包还原 1 个包', decoded.length === 1)
  ok('解包内容一致', decoded[0].body.toString('utf8') === body)

  const inner = encodePacket(body, 5, 0, 1)
  const brotli = encodePacket(zlib.brotliCompressSync(inner), 5, 3, 1)
  const d2 = decodeBuffer(brotli)
  ok('brotli 包递归解出内容', d2.length === 1 && d2[0].body.toString('utf8') === body)

  const zlibPkt = encodePacket(zlib.deflateSync(inner), 5, 2, 1)
  ok('zlib 包递归解出内容', decodeBuffer(zlibPkt)[0].body.toString('utf8') === body)

  const double = Buffer.concat([encodePacket(body, 5, 0, 1), encodePacket(body, 5, 0, 2)])
  ok('一帧内含多包', decodeBuffer(double).length === 2)

  console.log('\n[1b] Edge 语音二进制帧解析')
  // [2 字节头长][头文本（不含结尾空行）][音频]
  const headText = 'X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n'
  const audio = Buffer.from([0xff, 0xf3, 0x64, 0xc4, 0x00, 0x00])
  const headBuf = Buffer.from(headText, 'utf8')
  const prefix = Buffer.alloc(2)
  prefix.writeUInt16BE(headBuf.length)
  const frame = Buffer.concat([prefix, headBuf, audio])
  const parsed = edge.splitAudioFrame(frame)
  ok('识别 Path:audio', parsed.path === 'audio', parsed.path)
  ok('音频起点无多余字节', parsed.audio.equals(audio), parsed.audio.subarray(0, 4).toString('hex'))
  ok('音频首字节是 MP3 帧同步', parsed.audio[0] === 0xff && (parsed.audio[1] & 0xe0) === 0xe0)
  const endHead = Buffer.from('X-RequestId:abc\r\nPath:turn.end\r\n', 'utf8')
  const endPrefix = Buffer.alloc(2)
  endPrefix.writeUInt16BE(endHead.length)
  ok('非音频帧不误判', edge.splitAudioFrame(Buffer.concat([endPrefix, endHead])).path === 'turn.end')
  ok('畸形帧不抛异常', edge.splitAudioFrame(Buffer.from([0x00])).path === '')

  console.log('\n[2] wbi 签名与真实接口')
  const session = new Session()
  const wbi = new Wbi(session)
  const api = new BilibiliAPI(wbi, session)
  try {
    await api.ensureBuvid()
    ok('取得 buvid3 设备指纹', Boolean(session.jar.get('buvid3')), session.jar.get('buvid3'))
    const keys = await wbi.keys()
    ok('wbi mixin_key 为 32 位', keys.length === 32, keys)
    const signed = await wbi.sign({ foo: '114', bar: '514' })
    ok('签名串包含 w_rid 与 wts', signed.includes('w_rid=') && signed.includes('wts='))
  } catch (e) {
    ok('wbi 签名链路', false, e.message)
  }

  console.log('\n[3] 直播间信息（房间 1，B站官方测试房）')
  let realRoomId = 0
  try {
    const info = await api.getRoomInfo(1)
    realRoomId = info.room_id
    ok('拿到真实房间号', Boolean(realRoomId), String(realRoomId))
  } catch (e) {
    ok('房间信息接口', false, e.message)
  }

  if (realRoomId) {
    console.log('\n[4] 弹幕 WebSocket 真实连接')
    try {
      const dm = await api.getDanmuInfo(realRoomId)
      ok('取到弹幕服务器 token', Boolean(dm.token) && dm.hosts.length > 0, dm.hosts[0])

      const live = new LiveClient({ api, roomId: realRoomId })
      const result = await new Promise((resolve) => {
        let settled = false
        const done = (r) => {
          if (!settled) {
            settled = true
            resolve(r)
          }
        }
        live.on('status', (s) => {
          if (s === 'authenticated') done({ auth: true })
        })
        live.on('error', (e) => done({ auth: false, err: e.message }))
        live.start().catch((e) => done({ auth: false, err: e.message }))
        setTimeout(() => done({ auth: false, err: '20 秒超时' }), 20000)
      })
      ok('鉴权通过', Boolean(result.auth), result.err)
      live.stop()
    } catch (e) {
      ok('弹幕连接链路', false, e.message)
    }
  }

  await testVoices()
  checkCsp()
  checkMusicOverlay()
  checkOverlayLayout()
  await checkEmoticons()
  checkStoreMerge()
  checkCommands()
  checkNeteaseLogin()
  checkRendererTypes()

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
  process.exit(fail ? 1 : 0)
}

/**
 * CSP 回归：网易云的音频地址是 http://m7.music.126.net/...，封面也是 http。
 * 之前 media-src 只写了 'self' blob: data:，音频直接被拦，浏览器只报
 * 「no supported source was found」—— 一句完全指不到原因的英文。
 */
function checkCsp() {
  console.log('\n[23] CSP 允许外链音频与封面')
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  const m = /media-src([^;"]*)/.exec(html)
  const img = /img-src([^;"]*)/.exec(html)
  ok('index.html 里有 CSP', Boolean(m))
  if (!m) return
  const mediaSrc = m[1]
  const imgSrc = img ? img[1] : ''
  // http 的网易云 CDN 必须放行，否则点歌永远播不出来
  ok('media-src 放行 http 网易云域名', /http:\/\/\*\.(126|163)\.net/.test(mediaSrc), mediaSrc.trim())
  ok('media-src 放行 https 与 blob', /https:/.test(mediaSrc) && /blob:/.test(mediaSrc), mediaSrc.trim())
  ok('img-src 放行 http 网易云封面', /http:\/\/\*\.(126|163)\.net/.test(imgSrc), imgSrc.trim())
  // 别为了放行音频把 script-src 也放宽了
  ok('script-src 仍然只允许自身', /script-src 'self'/.test(html))
}

/**
 * OBS 点歌面板。
 *
 * 这里盯的是一件特别容易悄悄坏掉的事：弹幕页 / 叠加层页上的「预览」用的是
 * React 组件（src/components/MusicWidget.tsx + src/styles.css），而 OBS 里跑的是
 * overlay/index.html 那份手写 DOM。两边一旦走样，主播在界面上调好的样子
 * 到了 OBS 就是另一个样 —— 而且这种不一致没人会立刻发现。
 * 所以对 class 名单做一次比对，改了一边忘了另一边，测试就会红。
 */
function checkMusicOverlay() {
  console.log('\n[24] OBS 点歌面板')
  const root = path.join(__dirname, '..')
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
  const overlayHtml = read(path.join(root, 'overlay', 'index.html'))
  const widget = read(path.join(root, 'src', 'components', 'MusicWidget.tsx'))
  const css = read(path.join(root, 'src', 'styles.css'))

  const CLASSES = [
    'cp-music',
    'cp-mcard',
    'cp-mqueue',
    'cp-mcover',
    'cp-mcover__none',
    'cp-mbody',
    'cp-mlabel',
    'cp-mtitle',
    'cp-msub',
    'cp-mqueue__head',
    'cp-mrow',
    'cp-mrow__no',
    'cp-mrow__name',
    'cp-mrow__who',
  ]
  const missingInOverlay = CLASSES.filter((c) => !overlayHtml.includes(c))
  const missingInWidget = CLASSES.filter((c) => !widget.includes(c))
  const missingInCss = CLASSES.filter((c) => !css.includes(`.${c}`))
  ok('叠加层面板的类名齐全', missingInOverlay.length === 0, missingInOverlay.join(','))
  ok('预览组件用同一套类名', missingInWidget.length === 0, missingInWidget.join(','))
  ok('前端样式里也有这套类名', missingInCss.length === 0, missingInCss.join(','))

  ok('叠加层有面板容器', /id="cp-music"/.test(overlayHtml))
  ok('叠加层会渲染点歌状态', /function renderMusic/.test(overlayHtml))
  ok('叠加层接得住 music 消息', /msg\.type === 'music'/.test(overlayHtml))
  // 一首歌都没有时不能留一个空框在画面上
  ok('没歌时整块隐藏', /is-show/.test(overlayHtml) && /musicEl\.textContent = ''/.test(overlayHtml))
  // 中途才开 OBS 也要能看到当前这首，否则得等下一首才出现
  ok('主进程给新客户端补发点歌状态', read(path.join(root, 'electron', 'main.cjs')).includes('overlay.musicProvider'))
  ok('叠加层支持补发', read(path.join(root, 'electron', 'overlay.cjs')).includes('musicProvider'))

  // B 站图床对第三方 Referer 直接 403（实测 403）：OBS 浏览源的页面地址就是
  // Referer —— 封面 img 必须显式 no-referrer，否则永远加载不出来只剩黑块
  ok('叠加层封面不带 Referer（B 站图床 403 第三方 Referer）', /img\.referrerPolicy = 'no-referrer'/.test(overlayHtml))
  // 视频条目（kind:'video'）在叠加层要有自己的标识，不能照着歌画
  ok('叠加层区分视频条目', overlayHtml.includes("isVideo ? '正在播放 · 视频' : '正在播放'") && overlayHtml.includes("it.kind === 'video' ? '▶ ' : ''"))

  // ---- 叠加层放视频：画面框 + 流代理 + 心跳镜像 ----
  ok('叠加层视频条目画 16:9 画面框', /\.cp-mvideo\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s.test(overlayHtml))
  ok('叠加层视频直连 data: 流、http(s) 走代理', overlayHtml.includes("v.src = /^data:/i.test(stream) ? stream : '/stream/video?key=' + encodeURIComponent(vkey)"))
  ok('叠加层视频镜像静音（OBS 声音走应用本身）', overlayHtml.includes('v.muted = true'))
  ok('叠加层接得住 musictick 心跳', /msg\.type === 'musictick'/.test(overlayHtml))
  ok('叠加层同一条目不重建 video（重建会闪回开头）', overlayHtml.includes('if (!videoTag || videoKey !== vkey)'))
  ok('主进程解析视频流随快照下发', read(path.join(root, 'electron', 'main.cjs')).includes('musicStreamCache') && read(path.join(root, 'electron', 'main.cjs')).includes('ensureCurrentStream()'))
  ok('主进程把播放心跳推给叠加层', read(path.join(root, 'electron', 'main.cjs')).includes("overlay.broadcast('musictick', p)"))
  ok('叠加层服务有视频流代理路由', read(path.join(root, 'electron', 'overlay.cjs')).includes("urlPath === '/stream/video'"))
  ok('流代理带 B 站 Referer（CDN 防盗链 403 第三方）', read(path.join(root, 'electron', 'overlay.cjs')).includes("Referer: 'https://www.bilibili.com/'"))
  ok('流代理透传 Range（拖进度要 206）', read(path.join(root, 'electron', 'overlay.cjs')).includes("headers.Range = String(req.headers.range)"))

  // 队列条数上限：不设上限的话，观众一口气点 20 首会把半个画面盖住。
  // 两条实现各写各的，所以直接比对**表达式本身**，保证截断规则一致
  const CLAMP = 'Math.min(Math.floor(v), 10)'
  ok('预览组件限制待播条数', widget.includes(CLAMP), '组件里没找到上限')
  ok('叠加层限制待播条数', overlayHtml.includes(CLAMP), '叠加层里没找到上限')
  ok('两边上限一致', widget.includes(CLAMP) && overlayHtml.includes(CLAMP))

  const DEFAULTS = require('../electron/store.cjs').DEFAULTS
  ok('默认显示点歌面板', DEFAULTS.overlay?.showMusic === true)
  ok('默认位置是左上', DEFAULTS.overlay?.musicPos === 'tl', String(DEFAULTS.overlay?.musicPos))
  ok('默认显示 3 条待播', DEFAULTS.overlay?.musicQueueCount === 3, String(DEFAULTS.overlay?.musicQueueCount))

  // 暂停之后切走再切回来会自己重新开始播 —— 那次是因为挂载时 state 初值被当成了「队列空」。
  // 这里守住那道闸门：状态没拉回来之前不许动播放器。
  // 播放逻辑已经从 MusicPage 搬进常驻的 music-engine，闸门也就跟着搬过去了。
  const engine = read(path.join(root, 'src', 'lib', 'music-engine.tsx'))
  ok('状态没拉回来前不动播放器', /if \(!ready\) return/.test(engine))
  // ownsPlayback 也在依赖里：播放权翻回来时（音乐浮窗关掉），这个窗口要把当前这条接上。
  // 依赖必须是**条目编号（qid）**，不能是裸 id：同一首被两个人先后点了、或者同一个人
  // 隔一会儿又点一次时 id 完全一样，依赖 id 的话 effect 不重跑，第二条永远不启动。
  ok('停止分支不会再抢在状态前面', /}, \[ready, stampOf\(state\.current\), ownsPlayback/.test(engine), '缺少 ready 依赖')
  ok('换条目按 qid 判，不用裸 id 当依赖', !/\}, \[ready, state\.current\?\.id/.test(engine) && /qid/.test(engine))

  // 更要命的一个坑：播放器曾经住在 MusicPage 里，切走页面组件一卸载，
  // 订阅被摘、effect 停摆，一首歌放完没人接下一首 —— 必须切回点歌页才继续。
  // 所以现在强制要求：播放引擎挂在页面之外，且 MusicPage 里不许再出现播放器本体。
  const musicPage = read(path.join(root, 'src', 'pages', 'MusicPage.tsx'))
  const app = read(path.join(root, 'src', 'App.tsx'))
  ok('播放引擎不再住在 MusicPage 里', !/let audioEl|let playingId/.test(musicPage), 'MusicPage 里还有播放器状态')
  ok('MusicPage 改用引擎', /useMusicPlayer\(\)/.test(musicPage))
  ok('引擎挂在 App 层常驻', /MusicPlayerProvider/.test(app) && /music-engine/.test(app))
  // 播放器的回调必须活着 —— 一旦 Audio 的 onended 被摘，队列就永远停在上一首
  ok('播完自动推进下一首', /el\.onended[\s\S]{0,140}api\.music\.next\(\)/.test(engine))
  // 「点歌从 2 分多开始放」那次事故的护栏：换歌时把 positionRef（上一首残留的
  // 进度）当成了新歌的起点。续播位置**只在条目没换**时才用（浮窗播到哪这边接到哪），
  // 换歌一律从头。视频分支一直是对的（itemChanged ? 0 : 镜像），歌这路曾经写反了。
  ok(
    '换歌从头播（续播位置只在条目没换时才用）',
    /const resumeAt = itemChanged \? 0 : Math\.floor\(positionRef\.current\)/.test(engine),
    /audioKey === key \? 0 : Math\.floor\(positionRef\.current\)/.test(engine)
      ? '方向反了：audioKey !== key 恰恰是要重新取链的新歌'
      : null,
  )
  ok(
    '播完 / 断流把进度归零（旧进度不再有机会被当成下一首的起点）',
    /el\.onended = \(\) => \{[\s\S]{0,160}?setPosition\(0\)/.test(engine) &&
      /el\.onerror = \(\) => \{[\s\S]{0,220}?setPosition\(0\)/.test(engine),
  )

  /* ---- 叠加层：整体缩放 / 字号 / 歌词 ---- */

  ok(
    '叠加层尺寸走可缩放单位',
    /--cp-u:\s*1px/.test(overlayHtml) && /calc\(24 \* var\(--cp-u\)\)/.test(overlayHtml),
    'px 没换成 var(--cp-u)，界面大小滑块不会有反应',
  )
  ok('叠加层字号走独立变量', /calc\(16 \* var\(--cp-fs\)\)/.test(overlayHtml), '正文 font-size 没换变量')
  ok('两个缩放变量都被写入', /--cp-u'?,?\s*ui \+ 'px'/.test(overlayHtml) || /setProperty\('--cp-u'/.test(overlayHtml))
  ok(
    '字号是两层缩放相乘',
    /--cp-fs'?,?\s*ui \* ratio\(cfg\.fontSize\) \+ 'px'/.test(overlayHtml),
    '字体大小应当 = 界面大小 × 字体大小',
  )
  ok('缩放留了上下限', /function ratio/.test(overlayHtml) && /Math\.min\(2, Math\.max\(0\.5/.test(overlayHtml))

  ok('默认原尺寸显示', DEFAULTS.overlay?.scale === 100 && DEFAULTS.overlay?.fontSize === 100)
  ok('默认显示歌词且底部居中', DEFAULTS.overlay?.showLyric === true && DEFAULTS.overlay?.lyricPos === 'bc')

  const LYRIC_CLASSES = ['cp-lyric__line', 'is-cur']
  ok('叠加层有歌词区', LYRIC_CLASSES.every((c) => overlayHtml.includes(c)), LYRIC_CLASSES.join(','))
  ok('叠加层接得住歌词消息', /msg\.type === 'lyric'/.test(overlayHtml))
  // 歌词行数上限：不加的话主播调到 9 行，字幕会从画布顶排到底，把画面盖掉半个
  ok('歌词行数有上限', /lyricLineCount/.test(overlayHtml) && /Math\.min\(Math\.floor\(v\), 5\)/.test(overlayHtml))
  // 歌词和点歌面板同屏，行数直接表示能否叠逾它在 razor 上的高度限制
  ok(
    '换歌不会配到上一首的歌词',
    /lines: Array\.isArray\(p\.lines\) \? p\.lines : \[\]/.test(overlayHtml),
    '不带 lines 的那一帧必须清空，否则 Object.assign 会保留旧词',
  )
  ok('主进程给新客户端补发歌词', read(path.join(root, 'electron', 'main.cjs')).includes('overlay.lyricProvider'))
  ok('叠加层支持补发歌词', read(path.join(root, 'electron', 'overlay.cjs')).includes('lyricProvider'))
  ok(
    '补发时「没有词」也要说一声',
    /if \(lyric\) ws\.send\(JSON\.stringify\(\{ type: 'lyric', payload: lyric \}\)\)/.test(
      read(path.join(root, 'electron', 'overlay.cjs')),
    ),
    '只在有词时才发的话，重连上来的页面会挂着断开前那一首的最后一句',
  )
  ok('歌词由主进程转发', read(path.join(root, 'electron', 'main.cjs')).includes("ipcMain.handle('music:lyricSync'"))

  /* ---- 歌词串歌：三段接力里各自的那道闸 ----
     换歌那一拍，state.current 已经是新歌、而手上那份 lrc 还是上一首的。
     直接上报就成了「挂着新歌的名、带着旧歌的词」，OBS 上放着这首唱着那首。 */
  const engineSrc = read(path.join(root, 'src', 'lib', 'music-engine.tsx'))
  ok('歌词记着自己是谁的', /const \[lrcFor, setLrcFor\]/.test(engineSrc))
  ok(
    '换歌先把手上的词作废',
    /setLrcFor\(0\)/.test(engineSrc),
    '取新词比换歌慢，中间那段空窗正是串歌发生的时候',
  )
  ok('对不上就一个词都不发', /const liveLrc = lrcFor === curSongId \? lrc : EMPTY_LRC/.test(engineSrc))
  ok(
    '空歌词用固定引用',
    /const EMPTY_LRC: LyricLine\[\] = \[\]/.test(engineSrc),
    '每渲染一次新建数组的话，依赖它的 effect 会跟着每帧重跑',
  )
  ok('不上报别人的词', /liveLrc\.length > 0 && sentLinesRef\.current !== songId/.test(engineSrc))
  ok(
    '对不上时只报「还没到」',
    /const liveLrcIndex = lrcFor === curSongId \? lrcIndex : -1/.test(engineSrc),
  )
  ok('点歌页画的也是这一份', /lrc: liveLrc,\n\s*lrcIndex: liveLrcIndex,/.test(engineSrc))

  const mainSrc = read(path.join(root, 'electron', 'main.cjs'))
  ok('主进程换歌也会广播一帧', /if \(songId !== lyricState\.songId\) \{[\s\S]{0,140}dirty = true/.test(mainSrc))
  ok(
    '整份歌词到手也会广播一帧',
    /if \(Array\.isArray\(p\?\.lines\)\) \{[\s\S]{0,80}lyricState\.lines = p\.lines[\s\S]{0,40}dirty = true/.test(mainSrc),
    '新词常常还落在同一个行号上，只看行号变了没，词换了却没人广播',
  )
  ok(
    '没变化就不广播',
    /if \(dirty\) pushLyric\(\)/.test(mainSrc) &&
      !/lyricState\.text = \(lyricState\.lines\[index\] \|\| \{\}\)\.text \|\| ''\n\s*pushLyric\(\)/.test(mainSrc),
    '以前只认「行号变了」，词换了却没人广播，画面上就一直是上一首的',
  )
  ok(
    '叠加层丢掉不属于当前这首歌的词',
    /const now = musicState\.current \? Number\(musicState\.current\.id\) \|\| 0 : 0/.test(overlayHtml) &&
      /if \(songId && now && songId !== now\) return/.test(overlayHtml),
  )

  const lyricPreview = read(path.join(root, 'src', 'components', 'LyricPreview.tsx'))
  ok('歌词预览用同一套类名', /cp-lyric__line/.test(lyricPreview) && /is-cur/.test(lyricPreview))
}

/**
 * OBS 叠加层：窄画面下的自动避让。
 *
 * 背景：三块（弹幕 / 点歌 / 歌词）是各自 fixed 在自己的角上的，
 * 一旦把 OBS 浏览器源拖成一条竖带，它们就压成一坨 —— 弹幕糊在歌词和点歌面板上。
 * 修法是加一趟 layout()：按实测占位把同一侧真的打架的两块上下叠开，
 * 再把弹幕的活动区缩进剩下的那一段。
 *
 * 这里守的是几件容易悄悄退化的事：量尺寸不能用会被入场动画带偏的 rect、
 * 叠放必须「真重叠才叠」（否则宽画面下也会被无谓地挪开）、
 * 塞不下必须裁掉最老的而不是糊到别人身上。
 */
/**
 * 弹幕里的表情包。
 *
 * 用户报的毛病是「表情包显示的是对应的文字」—— 根因有两层：
 *   ① 只在弹幕包自带 emots 时才换图，而那个字段只覆盖一部分弹幕
 *   ② 键格式不统一：收藏集（pkg_type=3）下发 `[dog]`，通用表情下发 `啊`，
 *      直接 emots[名字] 去查必然漏
 * 这里守住「名字归一 + 三路合并 + 直播优先」这三件事别被改回去，
 * 以及渲染端三处（主界面 / 悬浮窗共用 / OBS 叠加层）都必须带 no-referrer。
 */
/**
 * [20b] 点歌链路的修复（全是实测复现过的坑）
 *
 * 这几条坏起来都是**静默**的：点歌不排队、第二条不播、能播的歌被说成不能播、
 * 回执里的「第几位」被截掉。界面上一片平静，不留神就以为「B 站又抽风了」。
 * 所以把代码形状钉死，别让它们悄悄回来。
 */
function checkMusicFixes() {
  console.log('\n[20b] 点歌链路修复')
  const root = path.join(__dirname, '..')
  const mainSrc = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  const ncmSrc = fs.readFileSync(path.join(root, 'electron', 'netease.cjs'), 'utf8')
  const engine = fs.readFileSync(path.join(root, 'src', 'lib', 'music-engine.tsx'), 'utf8')

  // ① 点歌不能住在播报里：tts.enabled=false 那一行 return 会把点歌一起吃掉。
  // 实测过：关掉 TTS 发「点歌 晴天」，队列始终为空，连回执都没有。
  const speakAt = mainSrc.indexOf('function maybeSpeak(')
  const speakBody = speakAt > 0 ? mainSrc.slice(speakAt, mainSrc.indexOf('\n}\n', speakAt)) : ''
  ok('播报函数里不再处理点歌', speakBody.length > 0 && !/handleMusicRequest|parseMusicCommand/.test(speakBody))
  ok('点歌挪到事件派发主链路上', /const isMusicCmd = handleMusicCommand\(enriched\)/.test(mainSrc))
  const cmdAt = mainSrc.indexOf('function handleMusicCommand(')
  const cmdBody = cmdAt > 0 ? mainSrc.slice(cmdAt, mainSrc.indexOf('\n}\n', cmdAt)) : ''
  ok('点歌处理不读 tts.enabled', cmdBody.length > 0 && !/tts/.test(cmdBody))
  ok('点歌弹幕仍然不进播报队列（「点歌 七里香」不该被念出来）', /if \(skipMusic\) return/.test(mainSrc))

  // ② 重复点同一首：身份必须靠递增编号，不能靠 id（id 相同 → effect 不重跑 → 卡住）
  ok('入队时盖唯一编号 qid', /const qid = \+\+musicQidSeq/.test(mainSrc) && /\n\s+qid,/.test(mainSrc))
  ok('渲染层按 qid 认条目（老数据回落 kind:id）', /const q = Number\(item\.qid\) \|\| 0/.test(engine))
  ok('推进 effect 依赖 qid 而不是裸 id', /\[ready, stampOf\(state\.current\), ownsPlayback/.test(engine))
  ok('同一条视频点了两次也从头播', /else if \(el\.currentTime > 0\.5\)/.test(engine))

  // ③ 能播的歌不能被 playable 判死（匿名实测能拿到 VIP 歌的 128k）
  ok('搜到就试第一首，不用 playable 判死', /songs\.find\(\(s\) => s\.playable\) \|\| songs\[0\]/.test(mainSrc))
  ok('会员歌只标 restricted，不据此拦', /restricted:/.test(ncmSrc))

  // ④ 降级标记要比「服务端真实返回的码率」，拿本次请求的 br 比永远比不出来
  ok('降级按 item.br 判', /downgraded: Number\(item\.br \|\| br\)/.test(ncmSrc))
  ok('不再拿请求参数当返回码率', !/downgraded: br !== want/.test(ncmSrc))

  // ⑤ 回执 20 字一刀切会把尾巴切掉，而尾巴正是观众要的「第 N 位」
  ok('回执有保尾的拼装函数', /function replyMsg\(/.test(mainSrc))
  ok('点歌回执把「第 N 位」放在尾巴', /replyMsg\('已点歌：', pick\.name, `（第 \$\{r\.position\} 位）`\)/.test(mainSrc))
  ok('点视频回执同样保尾', /replyMsg\('已点视频：', v\.title/.test(mainSrc))

  // ⑥ 两个「回执」开关不该互相牵连：点歌回执归点歌那个开关管
  ok('replyChat 支持 force（跳过语音策略那道门）', /function replyChat\(text, \{ force = false \} = \{\}\)/.test(mainSrc))
  ok('点歌/点视频回执都带 force', (mainSrc.match(/\{ force: true \}/g) || []).length >= 4)

  // ⑦ 流地址有时效（B 站约 2 小时），缓存必须过期，否则第二次点同一视频就是 403
  ok('主进程流缓存带 TTL', /const STREAM_TTL_MS/.test(mainSrc) && /function cachedStream\(key\)/.test(mainSrc))
  ok('渲染层流缓存带 TTL', /const STREAM_TTL_MS/.test(engine) && /function cachedStream\(key: string\)/.test(engine))

  // ⑧ 条目身份串必须由主进程统一下发：叠加层和 e2e 以前自己拼 'video:' + id，
  //    口径一改（qid）就永远对不上 —— OBS 中途接上时视频不从当前进度接，e2e 等不到帧
  const overlayHtml = fs.readFileSync(path.join(root, 'overlay', 'index.html'), 'utf8')
  ok('快照下发 itemKey', /itemKey: musicItemKey\(musicCurrent\)/.test(mainSrc) && /function musicItemKey\(/.test(mainSrc))
  ok('叠加层按 itemKey 比心跳', /musicState\.itemKey/.test(overlayHtml) && !/tick\.key \|\| ''\) === vkey/.test(overlayHtml))
  ok(
    '主进程/渲染层身份串同构（qid 优先拼 #）',
    /return q > 0 \? `\$\{k\}#\$\{q\}`/.test(mainSrc) && /return q > 0 \? `\$\{kindOf\(item\)\}#\$\{q\}`/.test(engine),
  )

  // ⑨ 网易云的播放地址只有 20 分钟。暂停久了再点播放，元素只会报 error，
  //    而 onerror 会把「地址过期」当成坏链跳下一首 —— 用户看到的是「刚点的歌没了」
  ok('音频地址记了过期时间', /let audioExpiresAt = 0/.test(engine) && /audioExpiresAt = Date\.now\(\) \+/.test(engine))
  ok('过期后再播会先重取一条', /const stale = sameInEl && Date\.now\(\) > audioExpiresAt - 5000/.test(engine))
  ok('重取时位置接着停下的地方（不弹回开头）', /const from = stale && audioEl \? Math\.floor/.test(engine))

  // ⑩ 被节流/超长挡下来不能一声不吭：观众只看到自己那句「点歌 xxx」挂着，
  //    以为没发出去，于是反复重发 —— 反而把冷却刷得更长
  ok('点歌被节流会回一声', /async function notifyMusicCooldown/.test(mainSrc))
  ok('提示本身也限流（10 秒一条）', /now - \(musicNotice\.get\(id\) \|\| 0\) < 10000/.test(mainSrc))
  ok('歌名过长也会说一声', /歌名太长啦/.test(mainSrc))
  ok('点视频那条路同样提示', (mainSrc.match(/await notifyMusicCooldown\(id,/g) || []).length >= 2)
}

function checkEmoticons() {
  return (async () => {
    console.log('\n[24c] 表情图册')
  const root = path.join(__dirname, '..')
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
  const E = require('../electron/emoticons.cjs')

  // ---- 名字归一 ----
  ok('带方括号的名字会被剥掉', E.normName('[dog]') === 'dog')
  ok('不带方括号的名字原样保留', E.normName('啊') === '啊')
  ok('首尾空白一并去掉', E.normName('  热  ') === '热')
  ok('空值不会炸', E.normName(null) === '' && E.normName(undefined) === '')

  // ---- 面板解析 ----
  const liveRes = {
    code: 0,
    data: {
      data: [
        { pkg_id: 100, pkg_type: 3, emoticons: [{ emoji: '[dog]', url: 'http://a.com/dog.png', width: 200, height: 60 }] },
        { pkg_id: 1, pkg_type: 1, emoticons: [{ emoji: '啊', url: 'http://a.com/ah.png' }] },
      ],
    },
  }
  const live = E.parseLivePanel(liveRes)
  ok('直播面板：收藏集与通用表情都收进来', live.length === 2, live.map((x) => x[0]))
  ok('直播面板：键已归一（没有 [dog]）', live[0][0] === 'dog', live[0][0])
  ok('直播面板：http 升 https', live[0][1].url === 'https://a.com/dog.png', live[0][1].url)

  const replyRes = {
    code: 0,
    data: {
      packages: [
        {
          emote: [
            { text: '[doge_金箍]', url: 'http://b.com/jingu.png', meta: { alias: '金箍' } },
            { text: '[dog]', url: 'http://b.com/dog2.png' },
          ],
        },
      ],
    },
  }
  const reply = E.parseReplyPanel(replyRes)
  ok('评论面板：正文名 + alias 都收', reply.length === 3, reply.map((x) => x[0]))
  ok('评论面板：alias 也能查到', reply.some(([n]) => n === '金箍'))

  const book = E.mergeBook([reply, live])
  ok('合并后直播面板优先（同名的狗取直播那张）', book.dog.url === 'https://a.com/dog.png', book.dog.url)
  ok('混合大小写的名字两种键都能查到', (() => {
    const b = E.mergeBook([[['Doge', { url: 'https://a.com/x.png', w: 0, h: 0 }]]])
    return b.Doge && b.doge && b.doge.url === 'https://a.com/x.png'
  })())

  // ---- 拉取：没会话 / 拉失败都不许抛，也不许把旧图册清空 ----
  const eb = new E.EmoticonBook({ getSession: () => null })
  let threw = null
  try {
    const r = await eb.refresh(1, { force: true })
    ok('没有会话时 refresh 直接返回 false（不抛）', r === false, r)
  } catch (e) {
    threw = String(e && e.message)
    ok('没有会话时 refresh 直接返回 false（不抛）', false, threw)
  }
  ok('两个面板都要登录态（URL 写死在这两处）', /GetEmoticons/.test(E.LIVE_PANEL) && /panel\/web/.test(E.REPLY_PANEL))

  // 换房间必须重拉：收藏集/粉丝团表情是按房间给的，沿用上一家的图册会画错图
  const calls = []
  const rb = new E.EmoticonBook({ getSession: () => null })
  rb.fetchJson = async (url) => {
    calls.push(url)
    return url.includes('GetEmoticons') ? liveRes : replyRes
  }
  await rb.refresh(111, { force: true })
  const n1 = calls.length
  await rb.refresh(111) // 同一个房间：TTL 内不重拉
  ok('同一个房间在 TTL 内不重复拉', calls.length === n1, calls.length - n1)
  await rb.refresh(222) // 换房间：即使 TTL 内也要重拉
  ok('换了房间立刻重拉（不吃 TTL）', calls.length > n1 && calls.slice(n1).some((u) => u.includes('room_id=222')), calls.slice(n1))

  // ---- 各处接线 ----
  const preload = read(path.join(root, 'electron', 'preload.cjs'))
  const mainSrc = read(path.join(root, 'electron', 'main.cjs'))
  const page = read(path.join(root, 'src', 'pages', 'DanmakuPage.tsx'))
  const lib = read(path.join(root, 'src', 'lib', 'emoticons.ts'))
  const css = read(path.join(root, 'src', 'styles.css'))
  const overlayHtml = read(path.join(root, 'overlay', 'index.html'))

  ok('preload 暴露了图册接口', /emoticons:\s*\{/.test(preload) && /emoticons:get/.test(preload) && /emoticons:changed/.test(preload))
  ok('主进程进了房间就拉图册', /refreshEmoticons\(\)/.test(mainSrc) && /refreshEmoticons\(\)\s*\n?\s*return \{ realRoomId/.test(mainSrc))
  ok('登录成功后也拉一次（面板要登录态）', /rememberIfLoggedIn[\s\S]{0,200}refreshEmoticons\(\)/.test(mainSrc))
  ok('叠加层连上来时补发图册', /emoticonProvider/.test(mainSrc) && /emoticonProvider/.test(read(path.join(root, 'electron', 'overlay.cjs'))))
  ok('主界面不再只认事件自带的 emots', !/if \(!ev\.emots\) return text/.test(page) && /lookupEmoticon\(/.test(page))
  ok('主界面表情图带 no-referrer（B站图床 403）', /className="danmaku-emote"[\s\S]{0,220}referrerPolicy="no-referrer"/.test(page))
  ok('浮窗共用同一份渲染层（图册要自己订一份）', /useEmoticonBookSync/.test(read(path.join(root, 'src', 'float', 'FloatShell.tsx'))))
  ok('渲染层有图册 store 与查表口径', /useSyncExternalStore/.test(lib) && /lookupEmoticon/.test(lib) && /local\[`\[\$\{name\}\]`\]/.test(lib))
  ok('表情图高度跟着文字走', /\.danmaku-emote\s*\{[^}]*?height:\s*1\.7em/.test(css))
  ok('叠加层也认图册且带 no-referrer', /let emoteBook = \{\}/.test(overlayHtml) && /msg\.type === 'emoticons'/.test(overlayHtml) && /img\.referrerPolicy = 'no-referrer'/.test(overlayHtml))
  ok('叠加层也容忍带方括号的键', /local\['\[' \+ name \+ '\]'\]/.test(overlayHtml))
  ok('叠加层正则放宽到 24 字（春卷饭10周年表情包_再见吧 有 14 字）', /1,24/.test(overlayHtml) && /1,24/.test(lib))
  })()
}

function checkOverlayLayout() {
  console.log('\n[24b] 叠加层自动避让')
  const root = path.join(__dirname, '..')
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
  const overlayHtml = read(path.join(root, 'overlay', 'index.html'))
  const page = read(path.join(root, 'src', 'pages', 'OverlayPage.tsx'))
  const DEFAULTS = require('../electron/store.cjs').DEFAULTS

  ok('默认开启自动避让', DEFAULTS.overlay?.autoLayout === true)
  ok('叠加层也认这个开关', /autoLayout:\s*true/.test(overlayHtml) && /cfg\.autoLayout === false/.test(overlayHtml))

  ok('有重排这一趟', /function layout\(\)/.test(overlayHtml) && /function scheduleLayout\(\)/.test(overlayHtml))
  // 入场动画是 transform 位移，getBoundingClientRect 量出来会跟着飘。
  // （弹幕容量那边量的是**高度**，位移不影响它，所以那里用 rect 没问题；
  //   这里是「各块的占位」——左边和宽度都会被 translateX 带偏，必须走 offset。）
  const boxBody = (overlayHtml.match(/function boxOf\(node, centered\) \{([\s\S]*?)\n      \}/) || [])[1] || ''
  ok(
    '占位用 offset 尺寸而不是 rect',
    /const width = node\.offsetWidth/.test(boxBody) &&
      /const height = node\.offsetHeight/.test(boxBody) &&
      !/getBoundingClientRect/.test(boxBody),
    '量占位必须用 offsetWidth/offsetHeight，rect 会被入场动画带偏',
  )
  // 居中的歌词靠 translateX(-50%) 归位，offsetLeft 还没算这一下
  ok('居中歌词的占位折了位移', /centered \? width \/ 2 : 0/.test(overlayHtml))

  // 只有同侧且水平上真的挨着才叠 —— 宽画面下 tl 的点歌 + bc 的歌词互不相干，不该被挪。
  // 现在按「竖带」分组：同一侧凡是被前一块的水平范围罩住的都收进来一起摞
  ok(
    '同侧又真的打架才叠开',
    /function touchesX\(left, right\)/.test(overlayHtml) &&
      /touchesX\(side\[i\]\.box\.left, right\)/.test(overlayHtml),
  )
  // 谁贴边是排出来的：歌词在最外（像字幕），音色面板次之，点歌让到最内
  ok('叠放次序是排出来的', /rank: 0 \}\)/.test(overlayHtml) && /rank: 1 \}\)/.test(overlayHtml) && /rank: 2 \}\)/.test(overlayHtml))
  ok('块的位置从贴边处往里摞', /let cursor = pad/.test(overlayHtml) && /cursor \+= b\.box\.height \+ gap/.test(overlayHtml))
  ok('歌词在上半区时按上边贴', /isTopSide\(lpos, \['tc', 'tl', 'tr'\]\)/.test(overlayHtml))
  // tc/bc 是靠 translateX(-50%) 归位的，tl/tr/bl/br 不是 —— 一律当成居中量会算错占位
  ok(
    '只有居中的歌词才折位移',
    /boxOf\(lyricEl, lpos === 'tc' \|\| lpos === 'bc'\)/.test(overlayHtml),
    'tl 的歌词没有 translateX，折了位移量出来的左边就偏了半宽',
  )

  ok('弹幕活动区按预留内缩', /app\.style\.top = topBand \+ gap/.test(overlayHtml) && /app\.style\.bottom = botBand \+ gap/.test(overlayHtml))
  // 内缩之外还有一道保险：塞不下就从离角落最远的那条（DOM 里排最前）开始请走。
  // 注意不能拿 scrollHeight 判断 —— #app 是 justify-content: flex-end，
  // 超出去的那几条堆在上边，浏览器认为那块「滚动不可达」，根本不计数。
  // 详细口径（按高度、不压扁、滑出去淡出）在 [37] 那一段里守。
  ok('塞不下就请走最老的', /function evictOverflow\(\)/.test(overlayHtml) && /beginLeave\(live\[0\], dir\)/.test(overlayHtml))
  ok('裁剪按自己摞的高度判断', /function stackHeightOf/.test(overlayHtml), 'scrollHeight 量不到 flex-end 的上溢部分')
  ok('弹幕容器裁掉溢出', /#app \{[\s\S]*?overflow: hidden/.test(overlayHtml))
  ok('一条弹幕进来就收口再重排', /evictOverflow\(\)\s*\n\s*scheduleLayout\(\)/.test(overlayHtml))
  // 隐藏窗口里 Chromium 不派 resize 事件（视口会变、事件不来），所以这里不能等下一帧
  ok(
    '窗口变化立即重排',
    /addEventListener\('resize', \(\) => \{[\s\S]{0,200}?layout\(\)/.test(overlayHtml),
    'resize 必须同步 layout，rAF 在隐藏窗口里不跑',
  )
  ok('矮画面也算窄画面', /window\.innerWidth < NARROW_W \|\| window\.innerHeight < NARROW_H/.test(overlayHtml))
  // 换歌 / 改行数会改这两块的高矮，光靠 resize 逮不到
  ok('面板尺寸变化也会重排', /new ResizeObserver\(scheduleLayout\)/.test(overlayHtml))

  // 窄条上原来那套按 1080p 定的宽度会顶出画面
  ok(
    '窄画面放开各块宽度',
    /html\.is-narrow \.cp-item/.test(overlayHtml) &&
      /html\.is-narrow \.cp-lyric/.test(overlayHtml) &&
      /html\.is-narrow \.cp-pick/.test(overlayHtml),
  )
  ok('窄画面给点歌面板留了高度上限', /html\.is-narrow \.cp-music[\s\S]*?max-height: 46%/.test(overlayHtml))
  ok('窄画面给歌词也留了高度上限', /html\.is-narrow \.cp-lyric[\s\S]*?max-height: 28%/.test(overlayHtml))
  ok('单个气泡不会高过弹幕区', /html\.is-narrow \.cp-item[\s\S]*?max-height: 100%/.test(overlayHtml))

  ok('设置页有这个开关', /autoLayout/.test(page) && /自动避让/.test(page))
}

/**
 * 配置写入语义。
 *
 * 这里盯的是一个已经咬过人的坑：deepMerge 只会合并、不会删除键。
 * 「解绑」「清理失效绑定」这类操作删掉键之后写回去，读出来键还在 ——
 * 界面上看就是点了没反应。字典段必须整体替换。
 */
function checkStoreMerge() {
  console.log('\n[25] 配置写入：删键必须真的删掉')

  const mod = withFakeElectron(() => {
    const m = require('../electron/store.cjs')
    // 借一个不落盘的实例：只验证 patch 的合并语义
    const fake = Object.create(m.ConfigStore.prototype)
    fake.file = ''
    fake.data = JSON.parse(JSON.stringify(m.DEFAULTS))
    fake.save = () => true
    return { fake, m }
  })
  const { fake, m } = mod

  fake.data.voiceBindings = { '111': 'p1', '222': 'p2' }
  fake.patch({ voiceBindings: { '111': 'p1' } })
  ok('解绑能真的删掉键', fake.data.voiceBindings['222'] === undefined, JSON.stringify(fake.data.voiceBindings))
  ok('解绑不误伤别人', fake.data.voiceBindings['111'] === 'p1')

  // 反过来：单键修改的字典段不能被整体替换，否则改 Fish Key 会抹掉 OpenAI Key
  fake.data.platformKeys = { fish: 'old-fish', openai: 'old-oa' }
  fake.patch({ platformKeys: { fish: 'new-fish' } })
  ok(
    '改一个平台的 Key 不动另一个',
    fake.data.platformKeys.openai === 'old-oa' && fake.data.platformKeys.fish === 'new-fish',
    JSON.stringify(fake.data.platformKeys),
  )

  // 普通配置段保持合并：只改一项不该把同段默认值冲掉
  fake.data.music = { ...m.DEFAULTS.music }
  fake.patch({ music: { volume: 0.9 } })
  ok('普通段只改传入的那一项', fake.data.music.volume === 0.9 && fake.data.music.br === m.DEFAULTS.music.br)
}

/**
 * 弹幕指令：名称可改，且改完解析必须跟着变。
 */
function checkCommands() {
  console.log('\n[26] 弹幕指令可配置')
  const V = require('../electron/voices.cjs')
  const cfg = withFakeElectron(() => require('../electron/store.cjs').DEFAULTS)

  // 界面上那份默认叫法必须和解析器内置的一致，否则两边会各说各话
  const kinds = ['query', 'list', 'bind', 'design', 'unbind', 'help']
  ok(
    '默认叫法与解析器一致',
    kinds.every((k) => JSON.stringify(cfg.commands?.voice?.[k]) === JSON.stringify(V.COMMAND_ALIASES[k])),
    JSON.stringify(cfg.commands?.voice?.bind),
  )

  // 内置叫法照旧能触发
  ok('内置叫法能触发', V.parseCommand('#绑定 1', { prefix: '#' })?.kind === 'bind')
  ok('前缀不对就不算命令', V.parseCommand('绑定 1', { prefix: '#' }) === null)
  // 老调用方式（第二个参数直接传前缀字符串）不能因为改造而失效
  ok('兼容旧的字符串前缀写法', V.parseCommand('#绑定 1', '#')?.kind === 'bind')

  // 改了名之后：新名认、旧名不再认
  const custom = { bind: ['换音色', '换成'], list: ['找音色'] }
  ok('改名后新名能触发', V.parseCommand('#换音色 1', { prefix: '#', names: custom })?.kind === 'bind')
  ok('改名后第二个叫法也认', V.parseCommand('#换成 1', { prefix: '#', names: custom })?.kind === 'bind')
  ok('改名后旧名失效', V.parseCommand('#绑定 1', { prefix: '#', names: custom }) === null)
  // 只改了 bind，其他类别必须仍走内置叫法 —— 不能因为配了一份就整份失效
  ok('没改的类别仍用内置叫法', V.parseCommand('#音色列表 男声', { prefix: '#', names: { bind: ['换音色'] } })?.kind === 'list')
  ok('改过的那类旧名失效', V.parseCommand('#绑定 1', { prefix: '#', names: { bind: ['换音色'] } }) === null)
  ok('参数照样能取到', V.parseCommand('#换音色 2', { prefix: '#', names: custom })?.arg === '2')

  // 某类被清空 → 回落内置，绝不让指令彻底失联
  ok('清空会回落内置叫法', V.parseCommand('#绑定 1', { prefix: '#', names: { bind: [] } })?.kind === 'bind')

  // 帮助文本要用当前叫法，否则主播改名后机器人教的还是旧词
  const help = V.helpText({ prefix: '#', cfg: { commands: { voice: custom } } })
  ok('帮助文本用改过的名字', help.includes('#换音色') && !help.includes('#绑定'), help)
  ok('帮助文本保留前缀', help.startsWith('#找音色'), help)

  // 界面传来的叫法要先收拾干净（带空格、重复、全角顿号）
  const { normalizeCommandNames } = withFakeElectron(() => require('../electron/store.cjs'))
  ok('逗号顿号都能分隔', JSON.stringify(normalizeCommandNames('绑定、换音色, 用')) === JSON.stringify(['绑定', '换音色', '用']))
  ok('去掉空项', JSON.stringify(normalizeCommandNames('绑定,,  ,用')) === JSON.stringify(['绑定', '用']))
  ok('去掉重复（忽略大小写）', JSON.stringify(normalizeCommandNames('Bind,bind')) === JSON.stringify(['Bind']))

  // 落到配置里的空数组要被还原成默认，不然那条指令就废了
  const store = withFakeElectron(() => {
    const m = require('../electron/store.cjs')
    const fake = Object.create(m.ConfigStore.prototype)
    fake.file = ''
    fake.data = JSON.parse(JSON.stringify(m.DEFAULTS))
    fake.save = () => true
    return fake
  })
  store.patch({ commands: { voice: { bind: [], list: ['找音色'] } } })
  ok('清空某类会写回默认', JSON.stringify(store.data.commands.voice.bind) === JSON.stringify(V.COMMAND_ALIASES.bind))
  ok('改过的那类保留', JSON.stringify(store.data.commands.voice.list) === JSON.stringify(['找音色']))
  // 只改一类不能把其他类冲掉
  ok('改一类不动其他类', JSON.stringify(store.data.commands.voice.help) === JSON.stringify(V.COMMAND_ALIASES.help))

  // 点歌触发词：粘一整串进来要能拆开；删空了要补回默认，
  // 否则「没人能点歌」这个状态界面上完全看不出来
  const DEFAULTS = readStoreDefaults()
  store.patch({ music: { commands: '来一首, 点个歌' } })
  ok('点歌触发词会拆开清洗', JSON.stringify(store.data.music.commands) === JSON.stringify(['来一首', '点个歌']), JSON.stringify(store.data.music.commands))
  store.patch({ music: { commands: [] } })
  ok('点歌触发词清空回落默认', JSON.stringify(store.data.music.commands) === JSON.stringify(DEFAULTS.music.commands), JSON.stringify(store.data.music.commands))
}

/**
 * 网页登录取 Cookie：从浏览器 Cookie 罐里只挑点歌真正需要的那几项。
 */
function checkNeteaseLogin() {
  console.log('\n[27] 网页登录取 Cookie')
  const NCM = require('../electron/netease.cjs')
  const jar = (list) => NCM.cookieFromJar(list)
  const future = Date.now() / 1000 + 86400
  const past = Date.now() / 1000 - 10

  // 埋点类 Cookie 一律不要，否则「登录了却查不出账号」更难排查
  ok(
    '只有统计类 Cookie 时不算登录',
    jar([
      { name: 'NMTID', value: 'x', domain: '.music.163.com', expirationDate: future },
      { name: '_ntes_nuid', value: 'y', domain: '.music.163.com', expirationDate: future },
      { name: 'os', value: 'pc', domain: '.music.163.com' },
    ]) === '',
  )

  ok('拿到 MUSIC_U 才算登录', jar([{ name: 'MUSIC_U', value: 'abc', domain: '.music.163.com' }]) === 'MUSIC_U=abc')
  ok(
    '顺手带上 __csrf',
    jar([
      { name: 'MUSIC_U', value: 'abc', domain: '.music.163.com' },
      { name: '__csrf', value: 'zzz', domain: '.music.163.com' },
      { name: 'NMTID', value: 'n', domain: '.music.163.com' },
    ]) === 'MUSIC_U=abc; __csrf=zzz',
  )
  ok('不带统计类噪声', !/NMTID/.test(jar([
    { name: 'MUSIC_U', value: 'abc', domain: '.music.163.com' },
    { name: 'NMTID', value: 'n', domain: '.music.163.com' },
  ])))

  // 过期凭证不能拿去用，否则界面显示「已登录」但一首会员歌都点不了
  ok(
    '过期的 MUSIC_U 不认',
    jar([{ name: 'MUSIC_U', value: 'old', domain: '.music.163.com', expirationDate: past }]) === '',
  )
  // 别的域下同名的不算（防止把 126.net 之类站点的串当成登录凭证）
  ok(
    '别的域下的 MUSIC_U 不认',
    jar([{ name: 'MUSIC_U', value: 'x', domain: '.126.net', expirationDate: future }]) === '',
  )
  // 同一名字常有 .music.163.com 和 music.163.com 两份，取活得久的那份
  ok(
    '同名多份取有效期最长的',
    jar([
      { name: 'MUSIC_U', value: 'short', domain: 'music.163.com', expirationDate: Date.now() / 1000 + 60 },
      { name: 'MUSIC_U', value: 'long', domain: '.music.163.com', expirationDate: future },
    ]) === 'MUSIC_U=long',
  )
  // 会话 Cookie 没有 expirationDate，必须算有效 —— 不然刚登录完反而取不到
  ok('会话 Cookie（无过期时间）算有效', jar([{ name: 'MUSIC_U', value: 'sess', domain: '.music.163.com' }]) === 'MUSIC_U=sess')
  ok('空罐子不炸', jar([]) === '' && jar(null) === '' && jar(undefined) === '')
}

/**
 * 渲染层的类型检查。
 * esbuild 只做转译不做类型检查，所以「组件 props 写错、变量没定义」这类问题
 * 编译能过、一渲染才白屏。这里把 tsc 拉进来，让这类错误在测试阶段就红。
 * 用编译器 API 在进程内跑：这个环境下 spawn 一个同名 node 进程会 EBUSY。
 */
function checkRendererTypes() {
  console.log('\n[23] 渲染层类型检查')
  const root = path.join(__dirname, '..')
  let ts = null
  try {
    ts = require('typescript')
  } catch {
    ok('类型检查（未安装 typescript，跳过）', true)
    return
  }
  try {
    const read = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
    if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, ' '))
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root)
    const program = ts.createProgram(parsed.fileNames, parsed.options)
    const diags = ts.getPreEmitDiagnostics(program)
    const lines = diags.slice(0, 6).map((d) => {
      const where =
        d.file && d.start != null
          ? (() => {
              const p = d.file.getLineAndCharacterOfPosition(d.start)
              return `${path.relative(root, d.file.fileName)}:${p.line + 1}: `
            })()
          : ''
      return where + ts.flattenDiagnosticMessageText(d.messageText, ' ')
    })
    ok('渲染层类型检查通过', diags.length === 0, `${diags.length} 处 — ${lines.join(' | ')}`)
  } catch (e) {
    ok('类型检查能跑起来', false, e.message)
  }
}

/* -------------------- 音色注册与弹幕命令 -------------------- */

async function testVoices() {
  console.log('\n[5] 音色命令解析')
  ok('识别 #音色列表', V.parseCommand('#音色列表 男声', '#')?.kind === 'list')
  ok('识别 #绑定并取参数', (() => {
    const c = V.parseCommand('#绑定 云希', '#')
    return c?.kind === 'bind' && c.arg === '云希'
  })())
  ok('全角 ＃ 也能识别', V.parseCommand('＃设计 御姐音', '#')?.kind === 'design')
  ok('英文命令可用', V.parseCommand('#bind XiaoXiao', '#')?.kind === 'bind')
  ok('自定义前缀生效', V.parseCommand('!音色', '!')?.kind === 'query')
  ok('前缀不匹配时返回 null', V.parseCommand('#音色', '!') === null)
  ok('普通弹幕不是命令', V.parseCommand('主播好帅', '#') === null)
  ok('单个井号不是命令', V.parseCommand('#', '#') === null)
  ok('未知命令词返回 null', V.parseCommand('#随便说说', '#') === null)

  console.log('\n[6] 粉丝牌与房管权限')
  const policy = { requireMedal: true, minMedalLevel: 5, allowDesign: true, allowBind: true }
  ok('房管免检', V.checkPermission({ isAdmin: true }, policy).ok)
  // 主播身份从弹幕包里读不出来（实测 DANMU_MSG 没有 identities，主播自己也没自己
  // 房间的粉丝牌），只能靠调用方比对 uid 后传 isPrivileged。这条断言盯住那个入口。
  ok(
    '主播免检（调用方按 uid 认出来后传 isPrivileged）',
    V.checkPermission({ uid: 42 }, policy, { isPrivileged: true }).ok,
  )
  ok('没标 isPrivileged 的普通观众照样被挡', !V.checkPermission({ uid: 42 }, policy).ok)
  ok(
    '主播同样不受 allowBind 这类开关限制',
    V.checkPermission({ uid: 42 }, { requireMedal: true, allowBind: false }, { need: 'bind', isPrivileged: true }).ok,
  )
  ok(
    '主播同样不受 allowUnbind 限制',
    V.checkPermission({ uid: 42 }, { requireMedal: true, allowUnbind: false }, { need: 'unbind', isPrivileged: true }).ok,
  )
  ok(
    '回执说的是「音色指令」而不是「换音色」（这条卡的是全部指令）',
    /音色指令/.test(V.checkPermission({ uid: 1 }, policy).reason || ''),
    V.checkPermission({ uid: 1 }, policy).reason,
  )
  ok(
    '无粉丝牌被拒',
    !V.checkPermission({ medal: null }, policy).ok,
  )
  ok(
    '粉丝牌等级不足被拒',
    !V.checkPermission({ medal: { name: '测试牌', level: 3 } }, policy).ok,
  )
  ok('等级达标放行', V.checkPermission({ medal: { name: '测试牌', level: 9 } }, policy).ok)
  ok(
    '关闭开放后拒绝 design',
    !V.checkPermission({ medal: { level: 20 } }, { ...policy, allowDesign: false }, { need: 'design' }).ok,
  )
  ok('不校验勋章时游客可用', V.checkPermission({}, { requireMedal: false }).ok)
  // allowUnbind 是配了但一直没人读的死开关，逻辑补上之后必须有断言盯着，
  // 否则它又会悄悄退化成「界面里有、实际不生效」
  ok(
    '关闭开放后拒绝 bind',
    !V.checkPermission({ medal: { level: 20 } }, { ...policy, allowBind: false }, { need: 'bind' }).ok,
  )
  ok(
    '关闭开放后拒绝 unbind',
    !V.checkPermission({ medal: { level: 20 } }, { ...policy, allowUnbind: false }, { need: 'unbind' }).ok,
  )
  ok(
    'unbind 开关默认放行',
    V.checkPermission({ medal: { level: 20 } }, { ...policy, allowUnbind: true }, { need: 'unbind' }).ok,
  )
  ok(
    '不传 need 时 allowUnbind 不影响（查询/帮助不走这条）',
    V.checkPermission({ medal: { level: 20 } }, { ...policy, allowUnbind: false }).ok,
  )

  console.log('\n[7] 每日设计配额')
  const t = new Date()
  const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  ok('当天未超配额', V.designQuota({ date: today, used: 3, limit: 20 }).ok)
  ok('当天配额用尽', !V.designQuota({ date: today, used: 20, limit: 20 }).ok)
  ok('跨天自动重置', V.designQuota({ date: '2020-01-01', used: 999, limit: 20 }).used === 0)

  console.log('\n[8] 音色档案构造')
  const p = V.profileFromVoice({
    source: 'fish',
    voice: { id: 'abc123', name: 'narrator', hint: 'Fish 社区' },
    ownerUid: 42,
    ownerName: '小明',
    cfg: { tts: { speed: 1.2, format: 'wav' } },
  })
  ok('平台与音色 id 落库', p.platform === 'fish' && p.voice === 'abc123')
  ok('鱼.协议正确', p.protocol === 'fish-tts', p.protocol)
  ok('Key 不写进档案', p.apiKey === '' || p.apiKey === undefined, p.apiKey)
  const d = V.makeDesignProfile({ ownerUid: 42, ownerName: '小明', prompt: '温柔的御姐音', tts: { baseUrl: 'https://x' } })
  ok('设计音色用 voicedesign 模型', d.model === 'mimo-v2.5-tts-voicedesign')
  ok('描述文本保留', d.designPrompt === '温柔的御姐音')
  ok('两种档案 id 不重复', p.id !== d.id)

  const lib = [p, d]
  ok('库内按名字能找到', V.findByName(lib, p.name)?.id === p.id)
  ok('大小写不敏感', V.findByName(lib, p.name.toUpperCase())?.id === p.id)
  ok('未注册的名字查不到', V.findByName(lib, '根本不存在的音色') === null)
  ok('关键词搜索命中 hint', V.searchProfiles(lib, 'voicedesign').length > 0)

  console.log('\n[8b] 静态音色榜可达')
  const mimo = await V.searchSource('mimo', { keyword: '女声', limit: 5, cfg: {} })
  ok('MiMo 按性别词「女声」可搜到', mimo.ok && mimo.voices.length > 0, JSON.stringify(mimo.voices))
  const mimo2 = await V.searchSource('mimo', { keyword: '英文', limit: 5, cfg: {} })
  ok('MiMo 按语言词「英文」可搜到', mimo2.ok && mimo2.voices.length > 0, JSON.stringify(mimo2.voices))
  const nokey = await V.searchSource('fish', { keyword: 'x', limit: 5, cfg: {} })
  ok('Fish 没 Key 时优雅报错而非崩溃', nokey.ok === false && /Key/.test(nokey.message || ''), nokey.message)
  const agg = await V.searchEverywhere(['mimo', 'fish'], { keyword: '冰糖', limit: 5, cfg: {} })
  ok('聚合搜索跨平台汇总', agg.ok && agg.voices.some((v) => v.source === 'mimo') && Array.isArray(agg.errors), JSON.stringify(agg.voices))

  console.log('\n[9] TTS 协议分支（mock 网络）')
  await mockTts()

  console.log('\n[10] 进场消息的 protobuf 解码')
  testInteractWordV2()

  console.log('\n[11] 外网请求的模式分流与错误翻译')
  await testNet()

  console.log('\n[12] 叠加层服务（客户端回调 + 端口顺延）')
  await testOverlay()

  console.log('\n[13] 头像解析（防盗链 + 去重）')
  await testFaces()

  console.log('\n[14] Cookie 罐过期与凭据合并')
  testCredentials()

  console.log('\n[15] 密钥清洗与平台错误翻译')
  testKeytext()

  console.log('\n[16] 音色描述扩写（LLM）')
  await testLlm()

  console.log('\n[17] Fish 合成实测探针')
  await testFishProbe()

  console.log('\n[18] 控件改完立刻生效（播报复核与配置迁移）')
  testLiveControls()

  console.log('\n[19] 跳过当前播报')
  await testSkip()

  console.log('\n[20] 网易云点歌')
  await testNetease()

  console.log('\n[20b] 点歌链路修复')
  checkMusicFixes()

  console.log('\n[21] 密钥形态诊断')
  testKeyShape()

  console.log('\n[22] TTS 合成缓存')
  await testTtsCache()

  console.log('\n[28] 音色选择面板队列')
  testVoicePickQueue()

  console.log('\n[29] 音色搜不到 / 换不了的那几条路')
  testVoicePickWiring()

  console.log('\n[30] 一键准备开播')
  testLaunchpad()

  console.log('\n[31] 叠加层拆成多个源')
  testOverlayPanels()

  console.log('\n[32] 测试别去抢直播间的端口')
  testE2eIsolation()

  console.log('\n[33] 打包与发布')
  testPackaging()

  console.log('\n[34] 在线观众（高能榜 + 在线用户）')
  testViewers()

  console.log('\n[35] 礼物包（SEND_GIFT / SEND_GIFT_V2）')
  testGiftCmd()

  console.log('\n[36] 点头像开主页')
  testUserLinks()

  console.log('\n[37] 叠加层弹幕：能塞几条留几条 + 溢出淡出')
  testDanmakuCapacity()

  console.log('\n[38] 桌面浮窗（弹幕/观众/礼物/音乐，弹出为浮窗）')
  testFloatWindow()

  console.log('\n[39] 点 B 站视频（BV 号和歌同一条队列）')
  testVideoQueue()

  console.log('\n[40] 关掉主界面 = 缩到托盘（后台继续收弹幕）')
  testTray()
}

/**
 * 关窗缩托盘。
 *
 * 这段守的是一个「做反了比不做还糟」的点：点×之后如果应用真退出了，
 * 弹幕、点歌、播报全断 —— 而主播点×只是想把窗口收起来。反过来，
 * 只拦住关闭却不给托盘图标和退出菜单，用户就再也找不回界面、也关不掉进程。
 * 所以两头都得有：拦得住，也退得出。
 */
function testTray() {
  const root = path.join(__dirname, '..')
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
  const main = read('electron/main.cjs')
  const page = read('src/pages/AppearancePage.tsx')
  const apiSrc = read('src/lib/api.ts')
  const pkg = JSON.parse(read('package.json'))

  ok('默认点×是缩起来', readStoreDefaults().general?.closeToTray === true, readStoreDefaults().general)
  ok(
    '点×被拦下来并把窗口藏起来',
    /win\.on\('close'/.test(main) && /e\.preventDefault\(\)/.test(main) && /win\.hide\(\)/.test(main),
  )
  ok('配置里关掉这项就真退出', /general\?\.closeToTray === false\) return/.test(main))
  ok('缩进去时把托盘建起来', /win\.hide\(\)[\s\S]{0,200}ensureTray\(\)/.test(main))
  ok('托盘菜单里有「退出」（不然就关不掉进程了）', /label: '退出'/.test(main))
  ok('有真退出的口子', /function quitApp\(\)/.test(main) && /quitting = true/.test(main))
  ok('点托盘图标能把界面找回来', /function showMainWindow\(\)/.test(main) && /tray\.on\('click'/.test(main))
  ok('退出时销毁托盘（不然图标挂着像没退干净）', /before-quit[\s\S]{0,500}tray\.destroy\(\)/.test(main))
  // build/ 不进 asar，打包后 build/icon.png 读不到 —— 托盘会变成空白图标
  ok(
    '托盘图标路径有兜底（打包后 / asar 内 / 开发目录）',
    /process\.resourcesPath/.test(main) && /tray-icon\.png/.test(main) && /build', 'icon\.png/.test(main),
  )
  ok('界面上能关掉这项', /general: \{ closeToTray: v \}/.test(page))
  ok('类型里有 general', /general\?:/.test(apiSrc))
  ok('有托盘的端到端脚本', pkg.scripts['e2e:tray'] === 'electron scripts/e2e-tray.cjs', pkg.scripts['e2e:tray'])
  // 「点×之后窗口还在不在」静态断言证明不了，得真点一次
  const e2e = read('scripts/e2e-tray.cjs')
  ok('e2e 真的点了一次 ×', /win\.close\(\)/.test(e2e) && /!w\.isVisible\(\)/.test(e2e))
}

/**
 * 叠加层弹幕的容量与溢出。
 *
 * 这一段守的是用户明确报过的那两个毛病：
 * ① **气泡被压扁、文字在气泡里被裁掉** —— 根因是缺省的 flex-shrink: 1 会把气泡压到
 *    比内容还矮（窄画面那条 overflow: hidden 按规范还会让自动最小尺寸失效，压得更狠）；
 *    压扁之后量出来的高度永远「没超」，于是一条都删不掉，全挤成半截。
 * ② **只按条数删**（maxItems）不看高度 —— 一句话和一段留言能差两三倍，
 *    数条数必然要么堆到画面外被切、要么一条都留不下。
 *
 * 现在的要求就三条：不许压扁、按高度收口、被请走的那条滑出去并淡出（方向可配）。
 */
function testDanmakuCapacity() {
  const root = path.join(__dirname, '..')
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
  const html = read('overlay/index.html')
  const css = html.slice(0, html.indexOf('</style>'))
  const store = read('electron/store.cjs')
  const page = read('src/pages/OverlayPage.tsx')
  const preview = read('src/components/DanmakuPreview.tsx')

  // ---- 不许压扁 ----
  ok('气泡不许被 flex 压扁（压扁 = 文字在气泡里被裁）', /\.cp-item \{\s*flex: 0 0 auto;\s*\}/.test(css))
  ok(
    '离场的气泡脱离文档流（绝对定位，剩下的同一帧就重排好）',
    /\.cp-item\.is-leaving \{[\s\S]{0,80}?position: absolute;/.test(css),
  )

  // ---- 量的是真实高度 ----
  const metrics = (html.match(/function stackMetrics\(\) \{([\s\S]*?)\n      \}/) || [])[1] || ''
  ok('找得到 stackMetrics', metrics.length > 0)
  ok('可用高度扣掉了 #app 自己的内边距', /clientHeight - pad/.test(metrics))
  ok('行间距也从计算样式里读，不写死 8', /rowGap/.test(metrics))
  ok(
    '量高度用 getBoundingClientRect（offsetHeight 会把压扁后的高度算成「没超」）',
    /h \+= list\[i\]\.getBoundingClientRect\(\)\.height/.test(html),
  )
  ok('离场中的那条不再占位（不算进容量）', /if \(n\.dataset && n\.dataset\.leaving\) continue/.test(html))

  // ---- 收口 ----
  const evict = (html.match(/function evictOverflow\(\) \{([\s\S]*?)\n      \}/) || [])[1] || ''
  ok('有 evictOverflow 这个收口函数', evict.length > 0)
  ok('超了就请最老的那条走（DOM 里排最前的）', /beginLeave\(live\[0\], dir\)/.test(evict))
  ok('只剩一条就不再删（那是一句话比整块还高，留着自己截）', /if \(live\.length <= 1\) break/.test(evict))
  ok('条数上限还在，只是退居兜底', /live\.length - cap/.test(evict))
  ok('新气泡进来就同步收口，不等下一帧', /app\.appendChild\(el\)[\s\S]{0,260}?evictOverflow\(\)/.test(html))
  // 注意别拿 \btrim\(\) 去查：`.trim()` 也满足那个词边界，会把正常的字符串处理一起毙掉
  ok(
    '旧的 trim / fit 已经清干净',
    !/\bfunction (trim|fit)\(/.test(html) && !/^\s+(trim|fit)\(\)\s*$/m.test(html),
  )
  ok('改配置 / 画面尺寸变化都会重新收口', (html.match(/evictOverflow\(\)/g) || []).length >= 4)

  // ---- 离场动画 ----
  const leave = (html.match(/function beginLeave\(node, dir\) \{([\s\S]*?)\n      \}/) || [])[1] || ''
  ok('有 beginLeave', leave.length > 0)
  ok('先钉住它当前的位置再切成绝对定位', /getBoundingClientRect\(\)[\s\S]{0,500}?position = 'absolute'/.test(leave))
  ok('切完强制一次重排，否则过渡不生效', /void node\.offsetHeight/.test(leave))
  ok('滑出去 + 淡出', /node\.style\.opacity = '0'/.test(leave) && /node\.style\.transform = dir/.test(leave))
  ok('进场动画没播完就被请走时要先掐掉动画', /node\.style\.animation = 'none'/.test(leave))
  ok('淡完从 DOM 摘掉', /removeChild\(node\)/.test(leave))
  ok('离场时长是个常量', /const LEAVE_MS = \d+/.test(html))

  // ---- 方向三处一致 ----
  const dirs = (html.match(/const OVERFLOW_DIRS = \[([^\]]+)\]/) || [])[1] || ''
  const htmlDirs = dirs.split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
  ok('方向就 natural / up / down 三个', JSON.stringify(htmlDirs) === JSON.stringify(['natural', 'up', 'down']), htmlDirs)
  // 只在 DANMAKU_OVERFLOW 那一块里找，别把 DANMAKU_POS 的四个角一起捞进来
  const ovBlock = (preview.match(/export const DANMAKU_OVERFLOW = \[([\s\S]*?)\n\]/) || [])[1] || ''
  const uiDirs = Array.from(ovBlock.matchAll(/value: '([a-z]+)'/g)).map((x) => x[1])
  ok('设置页给的三项与页面认的一致', JSON.stringify(uiDirs) === JSON.stringify(htmlDirs), uiDirs)
  ok('认不得的方向按 natural 走', /return OVERFLOW_DIRS\.indexOf\(v\) >= 0 \? v : 'natural'/.test(html))
  ok("自然方向贴顶时往下、贴底时往上", /charAt\(0\) === 't' \? 'down' : 'up'/.test(html))
  ok('按方向决定位移正负', /dir === 'down' \? `translateY\(\$\{dist\}px\)` : `translateY\(\$\{-dist\}px\)`/.test(html))

  // ---- 配置三处一致 ----
  ok('store 默认值里有 danmakuOverflow', /danmakuOverflow: 'natural'/.test(store))
  ok('叠加层的默认 cfg 里也有', /danmakuOverflow: 'natural'/.test(html))
  ok('渲染层类型里有这一项', /danmakuOverflow\?: 'natural' \| 'up' \| 'down'/.test(read('src/lib/api.ts')))
  ok('设置页能改它', /danmakuOverflow: v/.test(page) && /塞不下时/.test(page))
  ok('「最多保留条数」改口径为条数上限（画面塞不下以高度为准）', /label="条数上限"/.test(page))
}

/**
 * 桌面浮窗。
 *
 * 它把「弹幕」单独开成一个无边框透明小窗压在别的窗口上。守这几件事：
 * ① 窗是真的无边框 + 透明 + 不进任务栏，加载的是叠加层那一份页面（不另写一套渲染）；
 * ② 三个旋钮（不透明度 / 置顶 / 缩放）落到窗口上，改配置要当场生效；
 * ③ 位置要记住，但**记的位置不在任何屏幕上就不能用** —— 拔了显示器之后浮窗会「不见了」；
 * ④ 主窗口关掉时它不能把进程吊住。
 */
function testFloatWindow() {
  const root = path.join(__dirname, '..')
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
  const main = read('electron/main.cjs')
  const store = read('electron/store.cjs')
  const float = read('electron/float.cjs')
  const preload = read('electron/preload.cjs')
  const apiTs = read('src/lib/api.ts')
  const entry = read('src/main.tsx')
  const shell = read('src/float/FloatShell.tsx')
  const page = read('src/pages/OverlayPage.tsx')
  const dpage = read('src/pages/DanmakuPage.tsx')
  const css = read('src/styles.css')
  const ui = read('src/components/ui.tsx')
  const vl = read('src/components/ViewersList.tsx')
  const ph = read('src/components/PaidHistory.tsx')
  const mc = read('src/components/MusicConsole.tsx')

  // ---- 面板名：四处必须逐字一致，错一个就是「弹出了但渲染成空白页」----
  const mFloat = float.match(/const FLOAT_PANELS = \[([^\]]+)\]/)
  const mEntry = entry.match(/const FLOAT_PANELS: FloatPanel\[\] = \[([^\]]+)\]/)
  const names = (s) => (s ? s.match(/'([a-z]+)'/g).map((x) => x.slice(1, -1)) : [])
  const fp = names(mFloat && mFloat[1])
  const ep = names(mEntry && mEntry[1])
  ok('主进程有四个浮窗面板', JSON.stringify(fp) === JSON.stringify(['danmaku', 'viewers', 'gifts', 'music']), fp)
  ok('渲染层入口认的名字和主进程逐字一致', JSON.stringify(ep) === JSON.stringify(fp), ep)
  ok('浮窗加载的是渲染层本尊（?float=<panel>）', /\/\?float=\$\{panel\}/.test(main) && /query: \{ float: panel \}/.test(main))
  ok('store 默认里四个面板各有一份', (store.match(/danmaku: \{[\s\S]*?viewers: \{[\s\S]*?gifts: \{[\s\S]*?music: \{/) || null) !== null)

  // ---- 纯逻辑 ----
  const { clampPanel, isOnScreen, FLOAT_PANELS } = require('../electron/float.cjs')
  ok('导出夹取函数与屏幕判定', typeof clampPanel === 'function' && typeof isOnScreen === 'function')
  const c = clampPanel('danmaku', { opacity: 5, scale: 9999, bounds: { width: 10, height: 99999 } })
  ok('不透明度夹在 0.2~1', c.opacity === 1)
  ok('字体大小（缩放）夹在 50~200', c.scale === 200)
  ok('窗口尺寸有上下限', c.bounds.width >= 200 && c.bounds.height <= 4000, c.bounds)
  ok('没配过的位置是 null（不是 0）', c.bounds.x === null && c.bounds.y === null, c.bounds)
  // Number(null) === 0 —— 拿 Number 直接转会让浮窗每次都开在屏幕左上角
  ok('null 不许被当成 0', clampPanel('danmaku', { bounds: { x: null, y: null } }).bounds.x === null)
  ok('真实的 0 照样认', clampPanel('danmaku', { bounds: { x: 0, y: 0 } }).bounds.x === 0)
  ok('不认识的面板也有兜底尺寸', clampPanel('???', {}).bounds.width > 0)
  // 跨缩放屏：记宽高的同时要记下「那块屏的缩放」，恢复时按物理大小折算 ——
  // 不然拖到缩放不同的屏幕再关掉，重开就比关闭前大（用户实测）
  ok('bounds 里记着记尺寸时的屏幕缩放', clampPanel('danmaku', { bounds: { width: 380, sf: 1.5 } }).bounds.sf === 1.5)
  ok('老配置没记过缩放也能用（不折算）', clampPanel('danmaku', { bounds: { width: 380 } }).bounds.sf === null)
  ok('恢复时按目标屏缩放折算宽高', /getDisplayMatching/.test(float) && /scaleFactor/.test(float) && /b\.sf/.test(float) && /b\.width \* b\.sf/.test(float))
  const fakeScreen = { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] }
  ok('屏幕内的位置能用', isOnScreen(100, 100, fakeScreen) === true)
  ok('屏幕外的位置不能用（拔了显示器之后）', isOnScreen(4000, 4000, fakeScreen) === false)
  ok('没位置信息也不能用', isOnScreen(null, null, fakeScreen) === false)
  ok('拿不到屏幕信息时按「不能用」处理', isOnScreen(1, 1, null) === false)

  // ---- 窗口本身 ----
  /* ⚠️ 这一条是拿真机换来的：透明窗要 Chromium 走 GPU 合成，而本程序为了兼容
     无 GPU / 受限环境，启动时 disableHardwareAcceleration + disable-gpu-compositing
     （见 main.cjs）。两者一撞，透明窗在屏幕上**一像素都画不出来** ——
     实测采样到的是桌面色。用户报的「点了没反应」「看不到浮窗」就是这么来的。 */
  ok('窗口一律不透明（不许再写 transparent: true）', !/transparent: true/.test(float))
  ok('底板色是个不带 alpha 的实色', /const PANEL_BG = '#[0-9a-fA-F]{6}'/.test(float))
  ok('无边框', /frame: false/.test(float))
  ok('不进任务栏', /skipTaskbar: true/.test(float))
  ok(
    '说明白了为什么不能用透明（不然以后又会有人改回去）',
    /disable-gpu-compositing/.test(float) && /画不出来/.test(float),
  )
  ok('不聚焦时也继续跑（否则切走就定格）', /backgroundThrottling: false/.test(float))
  ok('页面标题不被覆盖（Alt+Tab 读的是它）', /page-title-updated[\s\S]{0,200}?preventDefault/.test(float))
  ok('每个浮窗有自己的标题（弹幕/观众/礼物/音乐）', /label\(panel\)/.test(float) && /音乐控制台浮窗/.test(float))

  // ---- 旋钮 ----
  /* 透明度**必须走窗口级 setOpacity**（DWM 层，本机禁了 GPU 合成也有效）。
     试过让渲染层把 opacity 写在内容区 CSS 上 —— 窗口底板是不透明的深色，
     内容淡下去只是「深底上更暗」，透不到窗后的桌面，用户看着就是「没生效」。
     但 DWM 是整扇窗逐像素乘 alpha，文字没法单独豁免（每像素透明要 transparent 窗，
     本机画不出来）—— 所以拖可读性曲线抬低端 + 渲染层 is-dim 补对比度。 */
  ok(
    '透明度走窗口级 setOpacity + 可读性曲线（100%→100%，越低抬得越多）',
    /setOpacity\(wantOpacity\)/.test(float) &&
      /const wantOpacity = Math\.pow\(c\.opacity, 0\.55\)/.test(float) &&
      !/opacity: eff\.opacity/.test(shell),
  )
  ok(
    '低不透明度时渲染层切 is-dim 补可读性（文字阴影 + 次要文字提亮）',
    /is-dim/.test(shell) && /eff\.opacity < 0\.75/.test(shell) && /\.float-shell\.is-dim \{[\s\S]{0,200}?--md-sys-color-on-surface-variant/.test(css) && /\.float-shell\.is-dim \.float-content \{[\s\S]{0,120}?text-shadow/.test(css),
  )
  ok('置顶用 screen-saver 档（普通档压不住全屏游戏）', /setAlwaysOnTop\(alwaysOnTop, 'screen-saver'\)/.test(float))
  ok('字体大小走窗口的 zoom', /setZoomFactor\(c\.scale \/ 100\)/.test(float))
  ok('加载完再压一次缩放（换页会重置）', /did-finish-load[\s\S]{0,200}?setZoomFactor/.test(float))
  /**
   * 抽搐的根因：applyTo 会被**每一次**配置变更调到（包括拖位置松手后 400ms 那次落盘），
   * 而它无条件 setZoomFactor —— 那是一次整页重排，页面上挂着视频 iframe 时就是画面整个重画。
   * 现在每个值都先跟上次写的比一比。
   */
  ok(
    '没变的值不许再写窗口（setZoomFactor 会整页重排 = 收起浮窗时抽搐）',
    /this\.applied\[`\$\{w\.id\}:zoom`\] !== c\.scale/.test(float) &&
      /this\.applied\[`\$\{w\.id\}:opacity`\] !== wantOpacity/.test(float) &&
      /this\.applied\[`\$\{w\.id\}:top`\] !== alwaysOnTop/.test(float),
  )
  ok('窗口关掉要清掉它的「已写值」（id 会被复用）', /startsWith\(`\$\{goneId\}:`\)\) delete this\.applied/.test(float))
  ok(
    '位置没变就别写盘（那笔会绕回 applyTo 触发重排）',
    /const last = this\.lastBounds\[panel\]/.test(float) && /if \(same\) return/.test(float),
  )

  // ---- 位置记忆 ----
  ok('拖完 / 拉完都记一笔', /on\('moved'/.test(float) && /on\('resized'/.test(float))
  // move / resize 在拖动中每帧都来；一次写盘就是一次全量加密 + 备份，不攒会拖成幻灯片
  ok(
    '连续事件要防抖，不能每帧写一次配置',
    /on\('move', rememberSoon\)/.test(float) && /on\('resize', rememberSoon\)/.test(float) && /scheduleRemember\(panel\)/.test(float),
  )
  ok('攒够时间才落盘', /setTimeout\(\(\) => \{[\s\S]{0,180}?this\.remember\(panel\)/.test(float))
  ok('收窗前把没落盘的都补上（拖完立刻关窗也要记住）', /close\(panel\) \{[\s\S]{0,700}?this\.remember\(panel\)/.test(float))
  ok('记的是位置和大小', /getPosition\(\)/.test(float) && /getSize\(\)/.test(float))
  ok('没记住过就居中（别落在看不见的角落）', /opts\.center = true/.test(float))

  // ---- 生命周期 ----
  /* 这一个是真踩过的坑：旧窗口的 closed 会**晚一步**到，那时 this.wins[panel] 已经是
     刚建好的新窗口了。不做身份校验的话，旧窗口的这一刻会把新窗口的引用清掉、
     还会把开关写成 false。屏幕上窗口明明还在，所以光看画面完全看不出来。 */
  ok(
    '旧窗口的 closed 不许算在当前窗口头上',
    /if \(this\.wins\[panel\] !== w\) return/.test(float),
    '重建时旧窗的 closed 晚一步到，会把新窗引用清掉、还会把开关写成 false',
  )
  ok(
    '手动关窗才把开关拨回去（内容回到弹幕姬）',
    /closed[\s\S]{0,600}?patchConfig\(\{ panels: \{ \[panel\]: \{ opened: false \} \} \}\)/.test(float),
  )
  ok(
    'close() 先摘引用再关窗（好让 closed 认出这是「我们关的」）',
    /delete this\.wins\[panel\][\s\S]{0,400}?w\.close\(\)/.test(float),
  )
  ok('close() 也会把没落盘的旋钮补上', /close\(panel\) \{[\s\S]{0,200}?setTimers\[panel\]/.test(float))
  ok('sync 串行化（并发开关会互相踩）', /this\.queues\[panel\]/.test(float))
  ok('启动时把上次开着的浮窗都带回来', /async restore\(\)/.test(float) && /ensureFloats\(\)[\s\S]{0,120}\.restore\(\)/.test(main))
  ok('主窗口关了要连浮窗一起收掉', /win\.on\('closed'[\s\S]{0,120}?floats\.closeAll\(\)/.test(main))
  ok('并且不被浮窗吊住进程（主窗口没了就整个退出）', /win\.on\('closed'[\s\S]{0,260}?app\.quit\(\)/.test(main))
  /* 浮窗出了问题只能靠日志判案：它是不透明无边框窗，「开了但看不见」和「压根没开」
     长得不一样了，但「为什么没开」「开在哪儿」仍然只有日志知道。 */
  ok('开 / 关都留日志', /打开\$\{this\.label\(panel\)\}/.test(float) && /已打开 \$\{ww\}×\$\{hh\}/.test(float) && /已收起/.test(float))
  /* 跨缩放屏的「首落」会被双重换算（实测 150% 副屏上请求 400×600 落成 603×902），
     remember 把大的记回去就复利变大 —— 创建后必须量一量、不对就再摆一遍再亮出来。 */
  ok(
    '创建改隐藏 + 落位校准后再显示（治跨缩放屏复利变大）',
    /new BrowserWindow\(\{ \.\.\.opts, show: false \}\)/.test(float) &&
      /settleBounds\(w, \{ x: opts\.x, y: opts\.y, width, height \}\)/.test(float) &&
      /settleBounds\(w, rect\) \{[\s\S]{0,700}?w\.setBounds\(rect\)/.test(float) &&
      /w\.show\(\)/.test(float),
  )
  ok('打开失败要记下原因', /'\[float\] 打开失败'/.test(main))
  ok('收到收起指令但窗没开着也留一笔', /并没有开着/.test(main))

  // ---- 浮窗内调旋钮：上窗立刻生效，落盘攒 400ms（拖滑块每帧写盘会把拖动拖成幻灯片）----
  ok('set() 当场把旋钮落到窗口上', /set\(panel, patch\) \{[\s\S]{0,300}?applyTo\(this\.wins\[panel\], c\)/.test(float))
  ok('落盘有防抖', /setTimers\[panel\] = setTimeout/.test(float) && /this\.setTimers = \{\}/.test(float))

  // ---- 配置与 IPC ----
  ok('store 里有 float.panels 这一段', /panels: \{[\s\S]{0,1200}?alwaysOnTop/.test(store) === false || /panels: \{/.test(store))
  ok('bounds 默认 x / y 是 null', /bounds: \{ x: null, y: null, width: 380, height: 620 \}/.test(store))
  ok('四个 IPC 都在', /'float:state'/.test(main) && /'float:open'/.test(main) && /'float:close'/.test(main) && /'float:set'/.test(main))
  ok('IPC 校验面板名（不认识的直接拒绝）', /FLOAT_PANELS\.includes\(panel\)/.test(main))
  ok('改配置当场生效', /patch\.float[\s\S]{0,120}?ensureFloats\(\)[\s\S]{0,60}?syncAll\(\)/.test(main))
  ok(
    '预加载透下去（带面板名）',
    /float: \{[\s\S]{0,420}?open: \(panel\) => ipcRenderer\.invoke\('float:open', panel\)/.test(preload) &&
      /set: \(panel, patch\) => ipcRenderer\.invoke\('float:set', panel, patch\)/.test(preload),
  )
  ok(
    '渲染层接口有类型',
    /open: \(panel: FloatPanel\) => Promise<\{ ok: boolean; message\?: string \}>/.test(apiTs) &&
      /export type FloatPanel = 'danmaku' \| 'viewers' \| 'gifts' \| 'music'/.test(apiTs),
  )
  ok('渲染层有 FloatState 类型（按面板一份）', /export interface FloatState \{[\s\S]{0,200}?panels: Record<FloatPanel/.test(apiTs))

  // ---- 浮窗外壳（渲染层） ----
  /* 用户明确要求：不要标题栏（标题和内容卡片名重复两次，还有条亮分割线）；
     弹出之后右上角只有一颗设置按钮和 × —— 点 × 就收回，比横杠更直觉，
     设置弹层里**不放**收回（用户明确要求挪走）。整条顶条是拖拽区。 */
  ok('不再有标题栏（也不要分割线、不要脱节的顶条）', !/float-titlebar/.test(shell) && !/float-titlebar/.test(css) && !/float-chrome/.test(shell) && !/float-chrome/.test(css))
  /* 用户点名：没字的标题栏很奇怪 —— 设置/× 两颗按钮要**直接融进 UI**：
     观众/礼物/音乐塞进各自卡片头部（actions 插槽），弹幕浮窗贴列表右上角（胶囊）。 */
  ok(
    '设置/× 融进各面板自己的 UI（头部 actions 插槽 + 弹幕右上角胶囊）',
    /actions=\{winButtons\}/.test(shell) && /float-topline/.test(shell) &&
      /actions\?: React\.ReactNode/.test(vl) && /actions\?: React\.ReactNode/.test(ph) && /actions\?: React\.ReactNode/.test(mc) &&
      /\{actions\}/.test(vl) && /\{actions\}/.test(ph) && /\{actions\}/.test(mc),
  )
  ok('拖拽靠贴顶的隐形条（卡片头部被当成标题栏用）', /\.float-dragstrip \{[\s\S]{0,200}?-webkit-app-region: drag;/.test(css) && /\.float-shell \.side-card__head \.float-tbtn \{[\s\S]{0,120}?z-index: 27/.test(css))
  ok('浮窗按钮在拖拽区之外（不然点不到）', /\.float-tbtn \{[\s\S]{0,160}?-webkit-app-region: no-drag;/.test(css))
  ok('顶条没有意义不明的连接点（用户点名去掉）', !/float-chrome__dot/.test(shell) && !/float-chrome__dot/.test(css))
  ok(
    '点 × 收回走主进程接口（收回不是设置弹层里的一个按钮）',
    /onClick=\{closeFloat\}/.test(shell) &&
      /api\.float\?\.close\(panel\)/.test(shell) &&
      !/<Button[\s\S]{0,80}onClick=\{closeFloat\}/.test(shell),
  )
  ok('设置弹层里有不透明度和字体大小', /不透明度/.test(shell) && /字体大小/.test(shell) && /opacity: v \/ 100/.test(shell) && /scale: v/.test(shell))
  /* 之前滑块受控于主进程回流的状态：拖完要等一次 IPC 往返才回显，
     松手那一拍先弹回旧值再应用 —— 用户说的「不跟手、还回弹一下」。 */
  ok(
    '旋钮一拖就改本地并立即发主进程，不用回流盖回来（防回弹）',
    /setKnobs\(\{ \.\.\.eff, \.\.\.p \}\)/.test(shell) && !/setTimer\.current = window\.setTimeout/.test(shell),
    '受控于主进程回流的值 = 拖完先弹回旧值再应用',
  )
  /* 字体大小（zoom）会缩放整个界面 —— 跟手调的话滑块自己也跟着位移，拖不准。
     所以不透明度跟手（onChange），字体大小松手才提交（onCommit）。 */
  ok(
    '字体大小松手才应用（拖动中改布局会让滑块位移）',
    /onCommit=\{\(v\) => turn\(\{ scale: v \}\)\}/.test(shell) && /onCommit\?\./.test(ui) && /onChange=\{\(v\) => turn\(\{ opacity: v \/ 100 \}\)\}/.test(shell),
  )
  ok(
    '弹幕浮窗可关头像（关掉看更多弹幕，只对浮窗生效）',
    /显示头像/.test(shell) && /showFaces/.test(shell) && /showFace=\{showFaces\}/.test(shell) && /showFaces: true/.test(store),
  )
  ok('弹幕浮窗没有发送设置（那粒颜色点只是摆设，点不了）', !/composer-bar__swatch/.test(shell) && !/composer-bar__swatch/.test(css))
  ok('音乐浮窗包在播放器 Provider 里（不然切歌逻辑没人接）', /MusicPlayerProvider/.test(shell))
  ok('弹幕浮窗复用主窗口的 EventRow（不另写一套渲染）', /import \{ EventRow \} from '\.\.\/pages\/DanmakuPage'/.test(shell) && /export function EventRow/.test(dpage))
  ok('弹幕浮窗有输入框，走同一个发送接口', /api\.live\.send\(msg\)/.test(shell))
  /* 发送栏用户指定：深色矩形贴底（和弹幕区同色）、字数上限 40、发送只留一个图标 */
  ok(
    '发送栏是贴底的深色矩形（无圆角无留白，和弹幕区同色）',
    /float-composer \{[\s\S]{0,300}?surface-container-lowest/.test(css) && !/composer-bar/.test(shell),
  )
  ok('字数上限 40', /maxLength=\{40\}/.test(shell) && /\/40/.test(shell))
  /* 输入框要有一个比底条亮一档的深色圆角底 —— 整条同色的话看不出哪里能键入（用户截图点名） */
  ok(
    '输入框自带深色圆角底（能一眼看出键入区）',
    /\.float-composer__input \{[\s\S]{0,300}?background: var\(--md-sys-color-surface-container-highest\)/.test(css) && /border-radius: 10px/.test(css),
  )
  ok('发送按钮只留一个图标（不再要「发送」俩字）', /title="发送"/.test(shell) && !/发送\s*<\/Button>|>\s*发送\s*<\/Button>/.test(shell))
  ok('头像走同一套抓取管线，开窗时主进程把缓存整包补发', /onFace/.test(shell) && /setResolvedFace/.test(shell) && /faces\.cache/.test(main))

  // ---- 主窗口：弹出横杠 + 收回胶囊 + 设置搬家 ----
  ok('每个区域右上角有弹出横杠（短白色，不要图标）', /float-bar/.test(dpage) && /float-bar/.test(css) && !/float-dot/.test(dpage) && !/float-dot/.test(css))
  ok('卡片头部右侧给横杠让位（不然「刚刚更新」/「≈ ¥」钻到横杠底下）', /\.float-region \.side-card__head \{[\s\S]{0,80}?padding-right: 40px/.test(css))
  ok('横杠带说明（弹出为浮窗：xxx）', /弹出为浮窗/.test(dpage))
  /* 占位**竖向**压缩（横向占满、高度一行）—— 竖着缩成一条，不是横着缩成一小坨。
     且弹出态**不继承**区域的布局类（float-region--* 的 flex: 2 1 0 会把它竖向拉高） */
  ok(
    '弹出后竖向压成一条「收回」，点整条就收回',
    /float-gone/.test(dpage) &&
      /onClick=\{onClose\}/.test(dpage) &&
      /className=\{`float-gone float-gone--\$\{panel\}`\}/.test(dpage) &&
      /\.float-gone \{[\s\S]{0,120}?flex: 0 0 auto/.test(css) &&
      /\.float-gone \{[\s\S]{0,200}?align-self: stretch/.test(css) &&
      !/align-self: flex-start/.test(css),
  )
  ok('占位和区域的高低分配跟原来一致', /float-region--viewers[\s\S]{0,80}?flex: 2 1 0/.test(css) && /float-region--gifts[\s\S]{0,80}?flex: 1 1 0/.test(css))
  ok('弹幕页订阅浮窗状态（浮窗那边关掉也要同步）', /api\.float\?\.onState\?\.\(setFloats\)/.test(dpage))
  ok('四个面板的开关都在发送设置面板里', /FLOAT_PANELS\.map/.test(dpage) && /桌面浮窗/.test(dpage) && /浮窗置顶/.test(dpage))
  ok('OBS 页不再有浮窗设置', !/floatState/.test(page) && !/api\.float/.test(page))
  /* 主进程批次比渲染层旧时 api.float 整个是 undefined（改完主进程得重启应用才生效）。
     这时候 .state() 是**同步抛**，不是 rejected promise，只有可选链 + try 才挡得住；
     挡不住的话按钮点下去要么白屏要么一点动静没有。 */
  ok(
    '弹幕页和浮窗外壳都用可选链挡旧主进程的 undefined',
    /api\.float\s*\?\.\s*state\(\)/.test(dpage) && /api\.float\s*\?\.\s*state\(\)/.test(shell),
    '主进程批次旧时 .state() 是同步抛，不是 rejected promise，只有可选链 + try 挡得住',
  )
  ok(
    '调用失败要说出声，不许静默吞',
    /notify\(`打不开桌面浮窗：\$\{\(e as Error\)/.test(dpage) && /notify\(`打不开桌面浮窗：\$\{\(e as Error\)/.test(dpage),
  )
}


/**
 * 在线观众 = B站的「高能榜」+「在线用户」两份名单。
 *
 * 这一段守三件事：
 * ① 两份名单的纯逻辑（分页合并、去重、排序、间隔钳制）—— 这些错一个，界面就会
 *    显示重复的人、或者按错误的顺序排、或者把风控撞到封接口；
 * ② 「在线用户」这一路**要登录**，它挂了不能把整张榜判死（榜匿名就能拿）；
 * ③ **文案纪律**：两份名单加起来仍然**不等于观看人数** —— 挂着不动的纯潜水观众
 *    两边都不出现。凡是把它写成「观众总数 / 观看人数」的地方都要拦下来，
 *    主播看到榜上 80 人，会以为直播间真的只有 80 个人看。
 */
function testViewers() {
  const root = path.join(__dirname, '..')
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
  const V = require('../electron/viewers.cjs')

  // ---- 一条记录 -> 界面要的样子 ----
  const one = V.normalizeRankItem({
    uid: 123,
    name: '观众甲',
    face: 'https://i0.hdslb.com/x.jpg',
    score: 640,
    guard_level: 3,
    wealth_level: 20,
    medalInfo: { medalName: '囚人', level: 21 },
  })
  ok('昵称/头像/贡献值都取到了', one.name === '观众甲' && one.score === 640 && /hdslb/.test(one.face))
  ok('舰长编号翻成人话', one.guard === '舰长' && one.guardLevel === 3, one.guard)
  ok('粉丝牌带过来了', one.medal && one.medal.name === '囚人' && one.medal.level === 21)
  ok('没有 uid 的记录直接扔掉（没法去重也没法显示）', V.normalizeRankItem({ name: '没有uid' }) === null)
  ok('空记录不炸', V.normalizeRankItem(null) === null && V.normalizeRankItem('x') === null)
  ok('没名字的兜底成匿名用户', V.normalizeRankItem({ uid: 9 }).name === '匿名用户')
  ok('没有勋章时是 null 而不是空对象', V.normalizeRankItem({ uid: 9 }).medal === null)
  ok('没大航海时 guard 是空串', V.normalizeRankItem({ uid: 9, guard_level: 0 }).guard === '')

  // ---- 分页合并 ----
  const page1 = {
    data: {
      onlineNum: 954,
      OnlineRankItem: [
        { uid: 1, name: 'A', score: 100 },
        { uid: 2, name: 'B', score: 300 },
      ],
    },
  }
  const page2 = {
    data: {
      onlineNum: 957,
      OnlineRankItem: [
        // 第 2 页和第 1 页会重叠：翻页期间榜单在动，同一个人可能两头都在
        { uid: 2, name: 'B', score: 350 },
        { uid: 3, name: 'C', score: 200 },
      ],
    },
  }
  const merged = V.mergeRankPages([page1, page2])
  ok('同一个人只留一条', merged.items.length === 3, merged.items.map((x) => x.uid))
  ok('重叠时留贡献值高的那条', merged.items.find((x) => x.uid === 2).score === 350)
  ok('按贡献值从高到低排', merged.items.map((x) => x.uid).join(',') === '2,3,1', merged.items.map((x) => x.score))
  // 在线人数只小幅波动，取最大更接近真实值，也避免最后一页恰好是 0
  ok('在线人数取各页最大值', merged.onlineNum === 957, merged.onlineNum)
  ok('limit 截得住', V.mergeRankPages([page1, page2], 2).items.length === 2)
  ok('空响应不炸', V.mergeRankPages([]).items.length === 0 && V.mergeRankPages(null).onlineNum === 0)
  ok('缺 OnlineRankItem 的脏页不炸', V.mergeRankPages([{ data: { onlineNum: 5 } }]).items.length === 0)
  // 裸 data 也要认（不要求外面包着 {data:...}）
  ok('直接给 data 也认', V.mergeRankPages([page1.data]).items.length === 2)

  // ---- 刷新间隔：这个接口有风控，手滑调太小会被钳回来 ----
  ok('间隔太小抬到 10 秒（风控底线）', V.clampInterval(1) === 10000 && V.clampInterval(3000) === 10000)
  ok('间隔太大压到 10 分钟', V.clampInterval(99999999) === 600000)
  ok('正常值原样保留', V.clampInterval(30000) === 30000)
  ok('没填 / 填了垃圾用默认 20 秒', V.clampInterval(undefined) === 20000 && V.clampInterval('abc') === 20000)
  ok('钳制区间本身是自洽的', V.MIN_INTERVAL_MS === 10000 && V.DEFAULT_INTERVAL_MS >= V.MIN_INTERVAL_MS)

  // ---- 错误文案 ----
  const e352 = V.translateRankError(-352, '')
  // 撞风控时如果只说「失败」，用户会一遍遍点刷新，把风控拖得更长
  ok('-352 说清楚是风控、并给出办法', /风控/.test(e352) && /间隔|等/.test(e352), e352)
  ok('其它错误码把人话原样带出来', V.translateRankError(-1, '房间不存在') === '房间不存在')

  // ---- 接口层 ----
  const api = read('electron/bilibili/api.cjs')
  ok('高能榜接口地址在表里', /onlineGoldRank: 'https:\/\/api\.live\.bilibili\.com/.test(api))
  ok('单页查询存在', /async getOnlineGoldRank\(/.test(api))
  ok('一次翻几页并合并的那层存在', /async getOnlineViewers\(/.test(api))
  ok('pageSize 会被夹到 50（给多了也只回 50）', /RANK_PAGE_SIZE\)\)/.test(api))
  // 这个接口匿名就能调，套上 wbi 只多一个失败点
  ok('没给高能榜套 wbi 签名', !/wbi\.url\(API\.onlineGoldRank/.test(api))
  ok('缺主播 uid 时明确报错，而不是拿空榜单糊弄', /还不知道主播 uid/.test(api))

  // ---- 主进程：轮询 + 推帧 ----
  const main = read('electron/main.cjs')
  ok('有拉一次的函数', /async function refreshViewers\(/.test(main))
  ok('有轮询开关', /function startViewersPolling\(/.test(main) && /function stopViewersPolling\(/.test(main))
  // 没连房间就不该有定时器：一路空转只会撞风控
  ok('断线时把轮询停掉', /function stopLive\(\)[\s\S]{0,200}?stopViewersPolling\(\)/.test(main))
  ok('连上直播间后开始轮询', /await live\.start\(\)[\s\S]{0,200}?startViewersPolling\(\)/.test(main))
  ok('间隔走钳制函数（配置里填多小都不至于撞风控）', /clampInterval\(v\.intervalMs\)/.test(main))
  ok('同一时刻只请求一次', /if \(viewersBusy\) return viewersState/.test(main))
  ok('界面和 OBS 收的是同一份', /send\('viewers:state', viewersState\)/.test(main) && /broadcast\('viewers', viewersState\)/.test(main))
  ok('两个 IPC 都在', /ipcMain\.handle\('viewers:state'/.test(main) && /ipcMain\.handle\('viewers:refresh'/.test(main))
  ok('OBS 中途连上补发当前名单', /overlay\.viewersProvider = /.test(main))
  // 头像有防盗链，只能主进程带 Referer 抓回来；复用弹幕那条管线，别另起一套。
  // 认的是「合并后的最终名单」而不是某一份 —— 两份名单都要抓头像
  ok('榜单头像走既有的抓取管线', /for \(const it of items\) if \(it\.face\) ensureFace\(/.test(main))
  ok('改了开关/间隔会重开定时器', /if \(patch && patch\.viewers\) \{/.test(main))

  // ---- 「名单不动」这一类毛病（用户报过一次，界面和数据长得一模一样）----
  // 拉失败时旧名单是留着的（清空会闪一下变空），于是一份卡住的旧数据和一个安静的
  // 直播间在屏幕上分不出来。下面这几条守的就是「不许再出现分不出来的情况」。
  ok(
    '推帧在 try 里面（在外面的话它一抛，viewersBusy 会永远卡在 true）',
    /viewersBusy = true[\s\S]{0,400}?try \{[\s\S]{0,900}?pushViewersState\(\)[\s\S]{0,200}?await api\.getOnlineViewers/.test(
      main,
    ),
  )
  ok('放锁和推帧都在 finally 里', /finally \{\s*viewersBusy = false[\s\S]{0,160}?pushViewersState\(\)/.test(main))
  ok('数了真正发出去的请求次数（分辨「定时器没跳」和「榜单没变」）', /let viewersFetches = 0/.test(main) && /viewersFetches\+\+/.test(main))
  ok(
    '定时器里的 promise 自己收掉（不然 reject 会按 unhandledRejection 把主进程带走）',
    /setInterval\(\s*\(\) => refreshViewers\(\)\.catch\(/.test(main),
  )
  ok('开轮询会记一笔日志（间隔多少），不然出问题只能靠猜', /\[viewers\] 开始轮询高能榜，间隔/.test(main))
  ok('关着自动刷新时也说明一句', /\[viewers\] 自动刷新是关的/.test(main))
  ok('失败时保留旧名单', /\/\/ 拉失败时\*\*保留上一份名单\*\*|保留上一份名单/.test(main))
  ok('error 会随状态一起留给界面', /ok: false, fetching: false, error: e\.message \|\| String\(e\), updatedAt: Date\.now\(\)/.test(main))

  // 界面上必须能看出「这份名单是旧的」
  const vl = read('src/components/ViewersList.tsx')
  ok('卡片标出「多久之前更新的」', /秒前更新/.test(vl) && /分钟前更新/.test(vl))
  ok('失败时挂一条「没更新上」的提示，不装作没事', /side-card__warn/.test(vl) && /没更新上/.test(vl))
  ok('提示带上了具体原因', /没更新上：\{s\.error\}/.test(vl))
  ok('顺带说明榜单本身有延迟（不然「刚发弹幕没上榜」会被当成坏了）', /刚互动的人要过一会儿才上榜/.test(vl))
  ok('这条提示的样式在', /\.side-card__warn \{/.test(read('src/styles.css')))
  ok('「多少秒前」不许自己算死（要跟着时间走字）', /setInterval\(\(\) => setNow\(Date\.now\(\)\)/.test(vl))

  // ---- 轮询的端到端回归 ----
  // smoke 只能证明「代码里写着 setInterval」，证不了「定时器真的在跳、跳了之后界面真的换」。
  // 这正是「拉了一次就再也不刷新」的漏网之处，所以另有一个真起主进程的脚本兜着。
  const pkg = JSON.parse(read('package.json'))
  ok('有 e2e:viewers 脚本', pkg.scripts['e2e:viewers'] === 'electron scripts/e2e-viewers.cjs', pkg.scripts['e2e:viewers'])
  const ev = read('scripts/e2e-viewers.cjs')
  ok('它真开轮询、真等间隔', /V\.start\(\)/.test(ev) && /oneTick/.test(ev))
  ok('它数请求次数，而不是只看结果变没变', /V\.calls\(\)/.test(ev))
  ok('它验界面真的换了名单', /side-card--viewers \.vlist__row/.test(ev))
  ok('它验断开之后不再发请求', /停了之后一次都不再发/.test(ev))
  ok('它验并发只跑一次', /并发调用只发一次请求/.test(ev))
  ok('测试钩子里有 viewers 派发口', /viewers: \{\s*\n\s*snapshot:/.test(main) && /setFetcher:/.test(main))
  ok('setFetcher 会先把 api 建出来（api 是懒建的）', /ensureSession\(\) \/\/ api 是懒建的/.test(main))

  // ---- 收到哪些 cmd 要留痕 ----
  // 「礼物不显示」这类问题，第一个要回答的是「包到底发过来没有」。
  // 不记这一笔，就只能靠猜是没收到、没认出来、还是没画出来。
  ok('接了 raw 事件', /live\.on\('raw', logLiveCmd\)/.test(main))
  ok('每个 cmd 只记一次', /const seenLiveCmds = new Set\(\)/.test(main) && /seenLiveCmds\.has\(cmd\)/.test(main))
  ok('记的是 cmd 名', /log\?\.info\('\[live\] 收到 cmd', cmd\)/.test(main))

  // ---- 预加载 / 类型 ----
  ok('预加载透过去', /viewers: \{[\s\S]{0,220}?ipcRenderer\.invoke\('viewers:state'/.test(read('electron/preload.cjs')))
  const apiTs = read('src/lib/api.ts')
  ok('渲染层有类型', /export interface ViewerItem/.test(apiTs) && /export interface ViewersState/.test(apiTs))
  ok('渲染层接口齐', /state: \(\) => Promise<ViewersState>/.test(apiTs) && /refresh: \(\) => Promise<ViewersState>/.test(apiTs))

  // ---- 配置默认值 ----
  const store = read('electron/store.cjs')
  ok('配置里有 viewers 段', /viewers: \{\s*\n\s*enabled: true,\s*\n\s*intervalMs: 20000/.test(store))
  ok(
    '叠加层有观众面板的三个键',
    /showViewers: true,/.test(store) && /viewersPos: 'bl',/.test(store) && /viewersCount: 5,/.test(store),
  )

  // ---- 叠加层面板 ----
  const html = read('overlay/index.html')
  ok('页面里有观众这块元素', /id="cp-viewers"/.test(html))
  ok('有渲染函数', /function renderViewers\(\)/.test(html))
  ok('配置一变就重画', /renderPick\(\)\s*\n\s*renderViewers\(\)/.test(html))
  ok('认 views 那一帧', /msg\.type === 'viewers'/.test(html))
  ok('四个角的位置表在', /const VIEWERS_POS = \['tl', 'tr', 'bl', 'br'\]/.test(html))
  ok('位置能回落到左下', /function viewersPos\(\)/.test(html))
  ok('人数有上限（1~20）', /function viewersCount\(\)/.test(html) && /Math\.min\(Math\.floor\(v\), 20\)/.test(html))
  // 榜单是空的就整块收起来 —— 不能在画面上留一个空框
  ok('榜单为空时整块隐藏', /cfg\.showViewers !== false && list\.length > 0/.test(html))
  ok('和别的块一样参与自动避让', /blocks\.push\(\{ el: viewersEl/.test(html))
  ok('高度变化会触发重排', /ro\.observe\(viewersEl\)/.test(html))
  // 观众榜在 #app 外面，头像回填若只搜 #app 会永远补不上
  ok('头像回填搜整个文档（观众榜不在 #app 里）', /document\.querySelectorAll\('img\[data-face="'/.test(html))

  // ---- 设置页 ----
  const page = read('src/pages/OverlayPage.tsx')
  ok('设置页有观众卡片', /title="在线观众（在线榜）"/.test(page))
  ok('位置/人数可调', /VIEWERS_POS/.test(page) && /VIEWERS_COUNT_OPTIONS/.test(page))
  ok('刷新开关与间隔也在这一块', /config\.viewers\?\.enabled !== false/.test(page) && /viewers: \{ intervalMs: v \* 1000 \}/.test(page))
  ok('预览组件在', /<ViewersPreview pos=\{o\.viewersPos\} count=\{o\.viewersCount\} \/>/.test(page))
  // 文案纪律：说清楚「哪些人不在里面」，否则主播会把它当在线人数用
  ok('卡片里写明「纯潜水观众两边都不出现」', /纯潜水观众两边都不出现/.test(page))
  ok('卡片里讲清了两份名单的来源', /高能榜/.test(page) && /在线用户/.test(page))
  ok('观众列表那条也写了不等于观看人数', /不等于观看人数/.test(read('src/components/ViewersList.tsx')))

  // ---- 弹幕页右侧栏 ----
  const dp = read('src/pages/DanmakuPage.tsx')
  ok('弹幕页右侧挂了三块', /<ViewersList \/>/.test(dp) && /<PaidHistory events=\{events\} \/>/.test(dp) && /<MusicConsole/.test(dp))
  // OBS 画面预览是「调完就没用」的东西，被右侧栏取代了。
  // 认的是标记本身而不是「OBS 画面预览」这几个字 —— 说明它为什么被拿掉的注释里当然会提到它
  ok('OBS 画面预览已经拿掉', !/obs-preview/.test(dp) && !/<MusicWidget/.test(dp))
  ok('不再有那个开关', !/showObsPreview/.test(dp) && !/showObsPreview/.test(apiTs))
  const css = read('src/styles.css')
  ok('左右两栏的样式在', /\.danmaku-main \{/.test(css) && /\.danmaku-side \{/.test(css))
  ok('右侧卡片/礼物历史/控制台的样式都在', /\.side-card \{/.test(css) && /\.plist__row \{/.test(css) && /\.mconsole__ctrl \{/.test(css))
  // 右侧栏要能并排、窄了不能被压成一条缝
  ok('右侧栏宽度固定、左栏自动伸缩', /flex: 0 0 320px;/.test(css) && /\.danmaku-main \{[\s\S]{0,120}?flex: 1 1 auto;/.test(css))
  // 三块的高度不是均分的：观众榜要一直扫，拿两份；付费历史拿一份
  ok(
    '观众榜比付费历史高一档',
    /\.danmaku-side > \.side-card--viewers \{/.test(css) &&
      /\.danmaku-side > \.side-card--paid \{/.test(css) &&
      /\.side-card--viewers \{[\s\S]{0,60}?flex: 2 1 0;/.test(css) &&
      /\.side-card--paid \{[\s\S]{0,60}?flex: 1 1 0;/.test(css),
  )
  // 下限不是随手写个好看的数：表头约 37px + 内边距 8px + 一行 46px，
  // 两行就是 137px。低于这个数第二条会被裁掉半截 —— 那比只显示一条还难看。
  {
    const m = /\.side-card--paid \{[\s\S]{0,120}?min-height: (\d+)px;/.exec(css)
    ok('付费卡高度容得下整两行（不算出 137 就看不全第二条）', m && Number(m[1]) >= 137, m && m[1])
  }

  // ---- 礼物/付费留言历史 ----
  const ph = read('src/components/PaidHistory.tsx')
  ok('付费历史只看这三类事件', /\[['"]gift['"], ['"]superchat['"], ['"]guard['"]\]/.test(ph))
  ok('倒序（最新的一条在最上面）', /\.slice\(-MAX_ROWS\)\.reverse\(\)/.test(ph))
  ok('条数有上限，不会一直涨', /const MAX_ROWS = 100/.test(ph))

  // ---- 音乐控制台 ----
  const mc = read('src/components/MusicConsole.tsx')
  // 播放器本体必须常驻，控制台只是遥控器；住在这里的话切页面就会断
  ok('控制台只是遥控器，用常驻的播放引擎', /useMusicPlayer\(\)/.test(mc))
  ok('三个键：播放/暂停、下一首、清空', /onClick=\{toggle\}/.test(mc) && /api\.music\.next\(\)/.test(mc) && /api\.music\.clear\(\)/.test(mc))
  // 播视频时这颗滑条必须调**视频**音量 —— 以前写死 music.volume，拖它对视频毫无作用
  ok(
    '音量也在这儿能调（跟着当前条目走：播视频时调的是视频音量）',
    /Slider value=\{muted \? 0 : vol\}/.test(mc) && /const setVol = onVolume \|\| setActiveVolume/.test(mc),
  )
  ok(
    '调用方不再把滑条写死在 music.volume 上',
    !/onVolume=\{\(v\) => patch\(\{ music: \{ volume: v \} \}\)\}/.test(read('src/pages/DanmakuPage.tsx')) &&
      !/onVolume=\{\(v\) => \{[\s\S]{0,80}music: \{ volume: v \}/.test(read('src/float/FloatShell.tsx')),
  )
  // 右侧栏的高度是「三块抢一栏」，每多一条待播就少一行观众榜。
  // 这条钉住的是取舍本身，不是在数括号 —— 改成 2 之前先想清楚拿谁换。
  ok('只预告「下一首」，不预告两首', /state\.items\.slice\(0, 1\)/.test(mc))

  // ---- 「在线用户」：人在房间里就算，不要求互动过 ----
  // 用户报的原话是「网页端可以看到没有互动也显示的观看用户」。
  // 网页端「房间观众」那一列 = 高能榜 + 在线用户两份名单，少一份就少一批人。
  ok('纯逻辑里有「在线用户」这一路', typeof V.normalizeOnlineItem === 'function' && typeof V.mergeOnlineRank === 'function')

  const onItem = V.normalizeOnlineItem({ uid: 42, name: '只看不说', face: 'f.jpg' })
  ok('在线用户没有贡献值，也不在榜上', Boolean(onItem) && onItem.score === 0 && onItem.onRank === false)
  ok('榜上那条标了 onRank（界面靠它决定画名次还是画「-」）', one && one.onRank === true)
  ok('没有 uid 的在线记录丢掉（去重和开主页都靠它）', V.normalizeOnlineItem({ name: 'x' }) === null)

  // 数组键名不写死：它在 B站 各个版本里叫过不同的名字，
  // 靠「唯一一个装着带 uid 对象的数组」来认
  ok('认得出 OnlineRankItem', V.pickOnlineList({ onlineNum: 1, OnlineRankItem: [{ uid: 1 }] }).length === 1)
  ok('键名换掉也照样认得出', V.pickOnlineList({ onlineNum: 1, onlineUserList: [{ uid: 7, name: 'a' }] }).length === 1)
  ok('旁边那些对象（onlineNum / ownInfo）不会被当成名单', V.pickOnlineList({ onlineNum: 3, ownInfo: { uid: 9 } }).length === 0)

  const onlineMerged = V.mergeOnlineRank({ data: { onlineNum: 5, OnlineRankItem: [{ uid: 1, name: 'a' }] } })
  ok('在线人数也取得到', onlineMerged.onlineNum === 5 && onlineMerged.items.length === 1)

  // 合并：榜上的在前（有贡献值和名次），只看不说的接在后面
  const combined = V.combineViewers(
    [{ uid: 1, name: '榜上', score: 9, onRank: true }],
    [
      { uid: 1, name: '榜上', score: 0, onRank: false },
      { uid: 2, name: '潜水', score: 0, onRank: false },
    ],
  )
  ok(
    '同一个人两份都在时留榜上那条（信息更多）',
    combined.length === 2 && combined[0].uid === 1 && combined[0].onRank === true,
  )
  ok('只看不说的排在榜后面', combined[1].uid === 2 && combined[1].onRank === false)

  // ---- 接口层 ----
  ok('走的是 getOnlineRank（不是高能榜那个）', /rank\/getOnlineRank'/.test(api))
  ok('带上 platform=pc_link（网页端就是这么调的）', /platform: 'pc_link'/.test(api))
  ok('失败时把 code 带出去（「没登录」和「风控」的处理不一样）', /err\.code = res\.code/.test(api))

  // ---- 主进程：在线名单挂了不能把整张榜判死 ----
  // 高能榜匿名就能调，在线名单**要登录**。没登录时榜上几十人还是好的，
  // 只是少一批「只看不说」的 —— 两个都判死等于把能用的那份也丢了。
  ok('在线名单自己 try/catch，不连累榜上的人', /VW\.mergeOnlineRank\(await api\.getOnlineRank\(/.test(main))
  ok('单独留一个 onlineError，不塞进总的 error', /onlineError/.test(main))
  ok('在线人数优先用在线用户那份（更接近网页端右上角）', /onlineNum: online\.onlineNum \|\| merged\.onlineNum/.test(main))

  // ---- 类型与界面 ----
  ok('ViewerItem 标了在不在榜上', /onRank: boolean/.test(apiTs))
  ok('ViewersState 有 onlineError', /onlineError: string/.test(apiTs))
  ok('没上榜的人排名栏画「-」，不是行号', /v\.onRank \? i \+ 1 : '-'/.test(vl))
  ok('没上榜的人不画贡献值（0 看着像真投喂了 0 元）', /v\.onRank && <span className="vlist__score">/.test(vl))
  ok('在线名单掉了要说出来，不能装作没这回事', /在线名单没拿到/.test(vl))
  ok('文案纪律仍然是「不等于观看人数」', /不等于观看人数/.test(vl))
  ok('「-」那一栏有单独的样式', /\.vlist__no\.is-dim \{/.test(css))

  // ---- 叠加层 ----
  ok('叠加层同样画「-」', /v\.onRank === false \? '-' : String\(i \+ 1\)/.test(html))
  ok('叠加层不画 0 贡献值', /if \(v\.onRank !== false\) row\.appendChild\(el\('span', 'cp-vrow__score'/.test(html))
  ok('标题改成「在线榜」（并进只看不说的人之后就不只是高能榜了）', /'在线榜'/.test(html))
  ok('重绘 key 带上 onRank（否则名次从有到无不会重画）', /v\.onRank === false \? 'o' : 'r'/.test(html))
  ok('「-」那一栏在叠加层里也压暗一档', /\.cp-vrow__no\.is-dim \{/.test(html))
}

/**
 * 礼物包。
 *
 * 「送了礼物但历史和播报都没有」查出来的根因是两层的：
 * ① cmd 从 `SEND_GIFT` 变成了 **`SEND_GIFT_V2`**；
 * ② 而且 V2 的 data 里**只有 `{ dmscore, pb }`** —— 礼物名、数量、金额、送礼人
 *    全在那段 base64 protobuf 里，扁平字段一个都不存在。
 * 所以「把 case 加上」是不够的，必须真解 pb。这一段钉三件事：
 * ① 两个包名都认，老的 JSON 包行为不变；
 * ② **拿真实抓到的包**验字段号 —— 手写的 protobuf 解码器最容易「看起来对」，
 *    只有真包跑得通才算数（下面那段 base64 是从一个真实直播间原样抓下来的）；
 * ③ 钱相关的 cmd 要**连 payload 一起记进日志**，下次 B站 再改一次名字，
 *    别再靠猜和来回问用户。
 */
function testGiftCmd() {
  const root = path.join(__dirname, '..')
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
  const liveSrc = read('electron/bilibili/live.cjs')
  const mainSrc = read('electron/main.cjs')
  const { normalizeEvent, decodeSendGiftV2 } = require('../electron/bilibili/live.cjs')

  ok('老的 SEND_GIFT 还认', /case 'SEND_GIFT':/.test(liveSrc))
  ok('新的 SEND_GIFT_V2 也认（就是它导致礼物不显示）', /case 'SEND_GIFT_V2':/.test(liveSrc))
  ok('V2 走的是 pb 解码这条路', /const pb = decodeSendGiftV2\(d\.pb\)/.test(liveSrc))
  ok('没有 pb 时退回扁平字段（总好过整条消失）', /return pb \? giftFromPb|return normalizeGift\(d\)/.test(liveSrc))

  // ---- 真实抓包回归：房间 6154037，送礼人 wowow_233，礼物「人气票」×1 ----
  const REAL_PB =
    'CKiRgKOwsqYGEgl3b3dvd18yMzMaSmh0dHBzOi8vaTAuaGRzbGIuY29tL2Jmcy9mYWNlL2JkZGE1MzFhNjQ2YzY3YTMxNzRkNjM5MWMyM2QyZTk2YWYwOWM3NTkuanBnQiQI2bDeXCgdMgVBU0FLSTjVkLQBQNWQtAFI/7f2BFDVkLQBWAFStwUIxIkCEgnkurrmsJTnpagYASABKGQwZDhkQgRnb2xkShM0ODI1MzI1NTUxNzgwNzEwNDAwUMzvmdYGWAFiRGJhdGNoOmdpZnQ6Y29tYm9faWQ6MzU0NjU1NjQzMzE3MjY0ODoxOTQ0ODQzMTM6MzM5ODg6MTc5MTM5MTY5Mi44MDI3aApwZHgFhQEAAIA/iAEBkgEG5oqV5ZaCwAGnzPvHAuoBEgoLQXNha2nlpKfkuroQ2bDeXIoCjgII2bDeXBKGAgoLQXNha2nlpKfkuroSSmh0dHBzOi8vaTEuaGRzbGIuY29tL2Jmcy9mYWNlLzg0YTg2MWZhY2ZhMDQxYjQ2ZjdhMzA4OTdlOWVkM2YyZTA1ZTA1MTkuanBnMlkKC0FzYWtp5aSn5Lq6EkpodHRwczovL2kxLmhkc2xiLmNvbS9iZnMvZmFjZS84NGE4NjFmYWNmYTA0MWI0NmY3YTMwODk3ZTllZDNmMmUwNWUwNTE5LmpwZzpQCAESTDIwMjTnm7Tmkq3lubTluqbkurrmsJTlpZZVUOS4u+OAgSAyMDI05bm05bqm5piO5pif5Li75pKt44CB55+l5ZCN5ri45oiPVVDkuL2SAgCaAuUBCkpodHRwczovL2kwLmhkc2xiLmNvbS9iZnMvbGl2ZS83YmFkZWI1N2Q0OThhYTYwMzk4MjQ5NDVjMjIzOGMxNzAxOWRhMjU5LnBuZxJLaHR0cHM6Ly9pMC5oZHNsYi5jb20vYmZzL2xpdmUvNzMzZjMwYWJlZjBiNzFkZDkwN2NlOTNhZWI5OTUzOGQwNWNlMDk4OS53ZWJwKkpodHRwczovL2kwLmhkc2xiLmNvbS9iZnMvbGl2ZS9kNjBhYmU0YjI1NjY5NTMwNDNjM2ZkNDZlNTUzNzkyNTE4MTEwMDA5LmdpZqoCAFgBagIIH3qsAgiokYCjsLKmBhK9AQoJd293b3dfMjMzEkpodHRwczovL2kwLmhkc2xiLmNvbS9iZnMvZmFjZS9iZGRhNTMxYTY0NmM2N2EzMTc0ZDYzOTFjMjNkMmU5NmFmMDljNzU5LmpwZzJXCgl3b3dvd18yMzMSSmh0dHBzOi8vaTAuaGRzbGIuY29tL2Jmcy9mYWNlL2JkZGE1MzFhNjQ2YzY3YTMxNzRkNjM5MWMyM2QyZTk2YWYwOWM3NTkuanBnOgsg////////////ARphCgVBU0FLSRAdGNWQtAEg/7f2BCjVkLQBMNWQtAFIAVDZsN5cYNS4AXoJIzNGQjRGNjk5ggEJIzNGQjRGNjk5igEJIzNGQjRGNjk5kgEHI0ZGRkZGRpoBCSMzRkI0RjZFNg=='
  const real = decodeSendGiftV2(REAL_PB)
  ok('真包解得出来（不是 null）', Boolean(real))
  ok('真包的送礼人对得上', real && real.uname === 'wowow_233' && real.uid === 3546556433172648)
  ok('真包的礼物名对得上', real && real.giftName === '人气票')
  ok('真包的数量对得上', real && real.num === 1)
  ok('真包的粉丝牌对得上（牌子所属主播 uid 也在）', real && real.medal && real.medal.name === 'ASAKI' && real.medal.anchorUid === 194484313)
  ok('真包的头像是个 URL', real && /^https:\/\/i\d\.hdslb\.com\/bfs\/face\//.test(real.face))

  const ev = normalizeEvent({ cmd: 'SEND_GIFT_V2', data: { dmscore: 560, pb: REAL_PB } })
  ok('V2 能变成礼物事件', Boolean(ev) && ev.type === 'gift')
  ok('礼物事件带上了名字和数量', ev.giftName === '人气票' && ev.num === 1 && ev.username === 'wowow_233')
  ok('文案是人话', ev.content === '投喂 人气票 ×1')

  // 脏输入不能把主进程带崩（B站 偶尔会发空的/截断的 pb）
  ok('空 pb 不会抛，返回 null', decodeSendGiftV2('') === null && decodeSendGiftV2(null) === null)
  ok('乱码 base64 也返回 null 而不是炸', decodeSendGiftV2('!!!!') === null)
  ok('半截包（截掉尾巴）不会抛', (() => {
    try {
      decodeSendGiftV2(REAL_PB.slice(0, 200))
      return true
    } catch {
      return false
    }
  })())

  // ---- 老的 JSON 包行为不能因为这次改动而变 ----
  const legacy = normalizeEvent({
    cmd: 'SEND_GIFT',
    data: { uid: 1, uname: '乙', giftName: '小花花', num: 1, total_coin: 100 },
  })
  ok('老的 SEND_GIFT 结果不变', legacy.type === 'gift' && legacy.price === 0.1 && legacy.content === '投喂 小花花 ×1')

  // 连击礼包有时候只在 batch_combo_send 里放名字和数量
  const combo = normalizeEvent({
    cmd: 'SEND_GIFT',
    data: { uid: 9, batch_combo_send: { gift_name: '小心心', gift_num: 5, uname: '甲' } },
  })
  ok('扁平包的 batch_combo_send 兜底还在', combo.giftName === '小心心' && combo.num === 5 && combo.username === '甲')

  ok('别的 cmd 不会被误认成礼物', normalizeEvent({ cmd: 'COMBO_END', data: {} }) === null)

  // ---- 日志：钱相关的包要连 payload 一起记 ----
  ok('钱相关的 cmd 单独列出来', /const MONEY_CMD = \/GIFT\|GUARD\|SUPER_CHAT\|TOAST\|COMBO\//.test(mainSrc))
  ok('这类 cmd 的 payload 会进日志', /JSON\.stringify\(raw\?\.data \?\? null\)\.slice\(0, 900\)/.test(mainSrc))
  ok('其余 cmd 只记名字（弹幕一秒十条，全存会把日志刷爆）', /log\?\.info\('\[live\] 收到 cmd', cmd\)\n\}/.test(mainSrc))
}

/**
 * 点头像用默认浏览器打开这个人的主页。
 *
 * 走的是主进程既有的 `app:openExternal`（那边只放行 http(s)），
 * 渲染层不能自己开窗口。**uid 为 0 的不给按钮** —— 匿名包、被风控抹掉
 * uid 的包都没有主页可去，做成按钮就是「点了没反应」。
 */
function testUserLinks() {
  const root = path.join(__dirname, '..')
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
  const links = read('src/lib/links.ts')
  const ui = read('src/components/ui.tsx')
  const css = read('src/styles.css')

  ok('链接是按 uid 拼的', /https:\/\/space\.bilibili\.com\/\$\{Math\.floor\(n\)\}/.test(links))
  ok('uid 不合法就不给链接（否则会跳到不相干的人）', /n <= 0\) return null/.test(links))
  ok('打开走的是主进程那套白名单', /api\.app\.openExternal\(url\)/.test(links))

  ok('有 UserAvatar 这个组件', /export function UserAvatar\(/.test(ui))
  ok('uid 为 0 时退回纯展示的头像', /if \(!userSpaceUrl\(uid\)\) return <Avatar /.test(ui))
  ok('用 button 而不是 div（键盘能 Tab、回车能开）', /className="avatar-btn"/.test(ui) && /aria-label=\{`用浏览器打开/.test(ui))

  // 三处列表都要能点
  const dp = read('src/pages/DanmakuPage.tsx')
  const vl = read('src/components/ViewersList.tsx')
  const ph = read('src/components/PaidHistory.tsx')
  ok('弹幕列表的头像能点', /<UserAvatar src=\{ev\.face\} name=\{name\} uid=\{ev\.uid\} \/>/.test(dp))
  ok('观众榜的头像能点', /<UserAvatar src=\{v\.face\} name=\{v\.name\} size=\{30\} uid=\{v\.uid\} \/>/.test(vl))
  ok('付费历史的头像也能点', /<UserAvatar src=\{e\.face\} name=\{e\.username\} size=\{24\} uid=\{e\.uid\} \/>/.test(ph))

  ok('按钮自己不占尺寸（.avatar 的 flex-basis 曾经就是这么把头像压扁的）', /\.avatar-btn \{[\s\S]{0,120}?flex: 0 0 auto;/.test(css))
  ok('悬停不位移（弹幕一秒十条，头像跳来跳去比没反馈更烦）', /\.avatar-btn:hover \{[\s\S]{0,80}?box-shadow/.test(css))
  ok('键盘焦点看得见', /\.avatar-btn:focus-visible \{/.test(css))
}

/**
 * 打包与发布：让用户能直接下到一个双击就能用的 exe。
 *
 * 这里守的核心是**exe 绝不进 git 仓库**。一个免安装版一百多 MB，而 git 的历史只增不减 ——
 * 提交进去以后每次发版都留一份，仓库很快上 GB，clone 越来越慢，而且**删不掉**
 * （除非重写历史）。所以 `release/` 必须在 .gitignore 里，发版一律走 GitHub Releases。
 */
function testPackaging() {
  const root = path.join(__dirname, '..')
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
  const pkg = JSON.parse(read('package.json'))

  // ---- 产物：免安装版 ----
  ok('打的是免安装版（不用装就能跑）', pkg.build.win.target === 'portable', pkg.build.win.target)
  ok(
    '产物名带 Portable，一眼看得出是哪个',
    /Portable/.test(pkg.build.portable.artifactName),
    pkg.build.portable.artifactName,
  )
  ok('产物名带版本号（多版本堆一起时分得清）', /\$\{version\}/.test(pkg.build.portable.artifactName))
  // 不设的话每次启动都解压到随机临时目录：启动慢，temp 里还会越堆越多
  ok(
    '解压到固定目录（第二次启动才快）',
    typeof pkg.build.portable.unpackDirName === 'string',
    pkg.build.portable.unpackDirName,
  )
  ok('图标还在', pkg.build.win.icon === 'build/icon.ico')
  // 托盘图标：build/ 不进 asar，打包后得靠 extraResources 另带一份
  const extras = pkg.build.extraResources || []
  ok(
    '托盘图标打进包（缩到托盘后得有东西可点）',
    extras.some((e) => e && /build[\\/]icon\.png$/.test(String(e.from || ''))),
    extras,
  )
  ok('代码里也备了一份图标（前一条找不到时兜住）', fs.existsSync(path.join(root, 'electron', 'tray-icon.png')))
  ok('electron/ 在打包清单里（上面那份才会跟进去）', pkg.build.files.includes('electron/**'))

  // ---- 本段最要紧的一条 ----
  const ignore = read('.gitignore')
  ok(
    'release/ 被忽略：exe 绝不进仓库',
    /^release\/$/m.test(ignore),
    ignore.split('\n').filter((l) => l.includes('release')),
  )
  // 反向确认：别哪天为了「省事」又把 release 放出来
  ok('没有 !release 这种反向例外', !/^!.*release/m.test(ignore))
  ok('开发脚本不打进包（用户不需要它们）', !pkg.build.files.some((f) => /^scripts/.test(f)), pkg.build.files)
  ok('界面产物打了进去（不然起来是白屏）', pkg.build.files.includes('dist-renderer/**'))
  ok('叠加层打了进去（不然 OBS 那片是空的）', pkg.build.files.includes('overlay/**'))

  // ---- 发布脚本 ----
  ok('有一键发布的命令', pkg.scripts.release === 'node scripts/release.cjs', pkg.scripts.release)
  const rel = read('scripts/release.cjs')
  // 发 Release 只要 repo 权限；`gh auth login` 还会额外要 read:org，那条路走不通时得能自己取 token
  ok('凭据能自己取（能 push 就够发 Release）', /git credential fill/.test(rel) && /GH_TOKEN/.test(rel))
  ok('认识装在 LOCALAPPDATA 里的 gh', /gh-cli/.test(rel))
  ok('重传时覆盖，而不是报错了事', /--clobber/.test(rel))
  ok('能只重传、不重新打包', /--skip-build/.test(rel))
  ok('能先发成草稿确认一下', /--draft/.test(rel))
  // 包常常是在工作副本里打的，而发布要在交付仓库里跑（那里才有 git 上下文）
  ok('能从别处拿现成的包', /val\('--file'\)/.test(rel))
  // 异步 execFile **没有** input 选项，忘了手动喂 stdin，`git credential fill` 会卡到超时
  ok('往 stdin 喂数据是自己写的（异步 execFile 没这选项）', /child\.stdin\.write\(input\)/.test(rel))
  ok('传的就是免安装版那个文件', /Portable\/i\.test/.test(rel))

  // ---- 发版前先验一遍包真的能跑 ----
  ok(
    '有「验一次包」的命令',
    pkg.scripts['verify:package'] === 'node scripts/verify-package.cjs',
    pkg.scripts['verify:package'],
  )
  const ver = read('scripts/verify-package.cjs')
  // 这两条是踩过的坑：有些 shell 里 ELECTRON_RUN_AS_NODE=1，会被子进程继承，
  // 于是 Electron 退化成纯 Node —— 不开窗口、不起服务，表现就是「双击了没反应」。
  ok('验包时会清掉 ELECTRON_RUN_AS_NODE', /delete env\.ELECTRON_RUN_AS_NODE/.test(ver))
  ok('也不把 NODE_OPTIONS 带进去', /delete env\.NODE_OPTIONS/.test(ver))
  // userData 跟着 APPDATA 走：这样才读不到真实配置、不会自动连直播间
  ok('用临时配置目录跑（不碰真实设置）', /APPDATA: TMP/.test(ver) && /user-data-dir=/.test(ver))
  ok('用随机端口跑（不抢 12450）', /CP_OVERLAY_PORT: String\(PORT\)/.test(ver) && /30000 \+ Math\.floor/.test(ver))
  // 拉起来就不管的话会留一个卡住的窗口，用户上次就是被这个吓到的
  ok('跑完强制结束，不留窗口', /Stop-Process/.test(ver))
  ok('超时也有兜底', /hardStop/.test(ver))
}

/**
 * 叠加层拆成多个源：OBS 里一块加一个「浏览器」源，各自摆位、各自缩放。
 *
 * 这里守的核心是**四处名字必须一致**：electron/overlay.cjs 的路由表、
 * overlay/index.html 认的身份、设置页列出的那几行、以及主进程拼地址时的那张表。
 * 任何一处写错，界面给出的都会是一个**纯透明页，而且不报任何错** ——
 * 主播只会看到一片空白，然后以为整个叠加层坏了。
 */
function testOverlayPanels() {
  const root = path.join(__dirname, '..')
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
  const { OVERLAY_PANELS, panelFromPath } = require('../electron/overlay.cjs')
  const WANT = ['all', 'danmaku', 'lyric', 'music', 'voicepick', 'viewers']

  // ---- 路由表 ----
  ok('路由表里有「全部」这一项', OVERLAY_PANELS[0] === 'all', OVERLAY_PANELS)
  ok('歌词/弹幕/点歌/音色/观众都能单独开', WANT.every((p) => OVERLAY_PANELS.includes(p)), OVERLAY_PANELS)
  ok('就这六个，没有多余的名字', OVERLAY_PANELS.length === WANT.length, OVERLAY_PANELS)

  // ---- 地址 -> 认成哪一块 ----
  ok('/overlay/lyric 认成歌词', panelFromPath('/overlay/lyric') === 'lyric')
  ok('结尾多个斜杠也认', panelFromPath('/overlay/music/') === 'music')
  ok('大小写不敏感（主播手敲的）', panelFromPath('/overlay/LYRIC') === 'lyric')
  // 认不得的必须回落到「全部」：宁可多画一块，也不能给一个纯透明页
  ok('乱写的名字不认', panelFromPath('/overlay/nope') === '' && panelFromPath('/overlay/foo/bar') === '')
  ok('/overlay 自己不算面板（那是「全部」）', panelFromPath('/overlay') === '')
  ok('别的路径不掺和', panelFromPath('/index.html') === '' && panelFromPath('/ws') === '' && panelFromPath('') === '')

  // ---- 服务端：同一份页面，多个地址 ----
  const overlayCjs = read('electron/overlay.cjs')
  ok(
    '/overlay/<名字> 回的还是那份 index.html（不为每块单独存一个文件）',
    /else if \(panelFromPath\(urlPath\)\) urlPath = '\/index.html'/.test(overlayCjs),
  )
  ok('老的 /overlay 原样保留', /urlPath === '\/overlay'\) urlPath = '\/index.html'/.test(overlayCjs))
  // 不设 no-store 的话，升级程序后 OBS 点「刷新」拿到的还是旧页面
  ok('页面不许被缓存', /'Cache-Control'\] = 'no-store'/.test(overlayCjs))

  // ---- 页面自己认身份 ----
  const html = read('overlay/index.html')
  const raw = (html.match(/const PANELS = \[([^\]]+)\]/) || [])[1] || ''
  const htmlPanels = raw.split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
  ok('页面认的名字与服务端逐字一致', JSON.stringify(htmlPanels) === JSON.stringify(OVERLAY_PANELS), htmlPanels)
  ok('认不得的一律按「全部」走', /PANELS\.indexOf\(v\) >= 0 \? v : 'all'/.test(html))
  ok('?panel=lyric 这种写法也认（方便手敲）', /new URLSearchParams\(location\.search\)\.get\('panel'\)/.test(html))
  ok('单面板时给 <html> 打标记（样式要用）', /document\.documentElement\.classList\.add\('is-panel'\)/.test(html))

  // ---- 每块只画自己那一份 ----
  ok('弹幕只在弹幕源里画', /function addItem\(ev\) \{[\s\S]{0,220}?if \(!shows\('danmaku'\)\) return/.test(html))
  ok('点歌面板只在点歌源里画', /if \(!shows\('music'\)\)/.test(html))
  ok('歌词只在歌词源里画', /if \(!shows\('lyric'\)\)/.test(html))
  ok('音色面板只在音色源里画', /if \(!shows\('voicepick'\)\)/.test(html))
  ok('观众榜只在观众源里画', /if \(!shows\('viewers'\)\)/.test(html))
  // 少画的那几块要顺手把 is-show 摘掉，不然切地址时会留着上一轮的内容
  ok('不画的那块会收起 is-show', (html.match(/classList\.remove\('is-show'\)/g) || []).length >= 3)

  const layoutBody = (html.match(/function layout\(\) \{([\s\S]*?)\n      \}/) || [])[1] || ''
  ok('找得到 layout 函数体', layoutBody.length > 0)
  // 单块源的画布上就它一个，没有「别压到谁身上」这回事；
  // 也不该把 #app 缩进去 —— 那本来是给同侧别的块腾地方的
  ok('单面板不做自动避让', /if \(ONLY\) return/.test(layoutBody) && /autoLayout === false/.test(layoutBody))
  ok('避让那一段在 ONLY 之后（不会先缩了再返回）', layoutBody.indexOf('if (ONLY) return') < layoutBody.indexOf('if (cfg.autoLayout === false) return'))

  // 四个源各弹一句「已连接」会叠在同一处，看起来像出了故障
  ok('单面板只保留出错状态提示', /if \(ONLY && !bad\) \{/.test(html))

  // ---- 单面板的尺寸规则 ----
  ok(
    '放开三分画布时定的百分比上限',
    /html\.is-panel \.cp-lyric \{/.test(html) &&
      /html\.is-panel \.cp-music,\s*\n\s*html\.is-panel \.cp-pick,\s*\n\s*html\.is-panel \.cp-viewers \{/.test(html),
  )
  ok('歌词源里字幕占满整个源', /html\.is-panel \.cp-lyric \{[\s\S]{0,120}?width: 100%;/.test(html))
  // 两边选择器权重一样（html.is-panel .cp-lyric 对 html.is-narrow .cp-lyric），
  // 只能靠顺序取胜 —— 顺序一颠倒，窄源上就会退回 28%/42%/46% 那套
  ok('is-panel 排在 is-narrow 之后', html.indexOf('html.is-narrow .cp-pick') < html.lastIndexOf('html.is-panel .cp-lyric'))

  // ---- 设置页给出的地址 ----
  const page = read('src/pages/OverlayPage.tsx')
  const ids = Array.from(page.matchAll(/\{ id: '([a-z]+)', name:/g)).map((x) => x[1])
  ok('设置页列出的几块与服务端一致', JSON.stringify(ids) === JSON.stringify(WANT.filter((p) => p !== 'all')), ids)
  ok('地址按面板名拼出来', /\$\{origin\}\/overlay\/\$\{id\}/.test(page))
  ok('那一行还能单独打开', /api\.overlay\.open\(p\.id\)/.test(page))
  ok('旧的「全部」地址仍然给出来', /id === 'all' \? `\$\{origin\}\/overlay`/.test(page))
  ok('复制按钮认得出复制的是哪一条', /copied === p\.id \? '已复制'/.test(page) && /copied === 'all' \? '已复制'/.test(page))
  ok('地址样式在样式表里', /\.panel-src__row \{/.test(read('src/styles.css')))

  // ---- 主进程与预加载把面板名透下来 ----
  ok('预加载把面板名透过去', /open: \(panel\) => ipcRenderer\.invoke\('overlay:open', panel\)/.test(read('electron/preload.cjs')))
  ok('渲染层接口有类型', /open: \(panel\?: string\)/.test(read('src/lib/api.ts')))
  ok(
    '主进程按面板名拼地址，认不得的退回「全部」',
    /OVERLAY_PANELS\.indexOf\(p\) >= 0 \? `\/\$\{p\}` : ''/.test(read('electron/main.cjs')),
  )
}

/**
 * 测试自己的隔离：跑测试时别去占主播正在直播用的那个端口。
 *
 * 叠加层端口被占时 `start()` 会往后顺延，看着像是「撞不上」，其实会撞出两种后果：
 * 用户没开程序时测试先占了 12450，之后真实实例被挤到 12451，
 * 而 OBS 里那几个浏览器源写死的还是 12450 —— 直播时一片透明，而且不报任何错。
 * 所以凡是**会起主进程**的 e2e，都必须先把端口换到别处去。
 */
function testE2eIsolation() {
  const root = path.join(__dirname, '..')
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
  const main = read('electron/main.cjs')

  // ---- 主进程：端口只有一条来路 ----
  const at = main.indexOf('function overlayPort()')
  ok('端口读法收在一处', at > 0)
  const body = at > 0 ? main.slice(at, at + 800) : ''
  ok('它优先认 CP_OVERLAY_PORT', /process\.env\.CP_OVERLAY_PORT/.test(body))
  ok('默认还是配置里那个端口', /store\.get\(\)\.overlay\?\.port/.test(body))

  // 去掉注释后只该剩 overlayPort 里那一处 —— 留一处就够让某条路径绕开隔离
  const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const bare = code.split('\n').filter((l) => l.includes('12450'))
  ok('别处不再写死 12450', bare.length === 1, bare)

  ok('产品自己的默认端口没变（还是 12450）', /port: 12450/.test(read('electron/store.cjs')))

  // ---- 起主进程的 e2e 一律先换端口 ----
  const files = fs.readdirSync(path.join(root, 'scripts')).filter((f) => /^e2e-.*\.cjs$/.test(f))
  ok('找得到 e2e 脚本', files.length >= 5, files)
  for (const f of files) {
    const src = read(`scripts/${f}`)
    if (!src.includes("'main.cjs'")) continue // 不起主进程的那些（比如 panels）不受影响
    ok(`${f} 起主进程前换掉了叠加层端口`, /process\.env\.CP_OVERLAY_PORT\s*=/.test(src))
    // 只看代码：注释里提到 12450 本来就是应该的，那是解释「为什么不能碰它」。
    // 拿它做比较（`!== 12450`）也允许 —— 要拦的是**把它当默认值写死**那种写法，
    // 那才是绕开隔离、又悄无声息的那种。
    const noComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const assigns = /(^|[^=!<>+\-*/])\s*=\s*12450\b/.test(noComment)
    const fallback = /\|\|\s*12450\b/.test(noComment)
    ok(`${f} 没把 12450 写死成默认端口`, !assigns && !fallback, { assigns, fallback })
  }
}

/**
 * 一键准备开播：扫描本机的直播软件、算怎么把它们拉起来。
 *
 * 这里守的是**解析与命令构造**（纯逻辑，是这套东西最容易悄悄坏掉的地方）：
 *  - Steam 的 libraryfolders.vdf 有两代格式，都得认；
 *  - appmanifest 里的 appid/name/installdir 决定程序装在哪，不能按目录硬猜；
 *  - 直播姬的版本目录要按**数字**比版本号（字符串比会把 7.9.1 判成比 7.64.0 新）；
 *  - OBS 官方要求拉起时工作目录 = exe 所在目录，拼错了起来是空壳。
 * 真正「启动别人程序」那步一律不在测试里做 —— 那会把用户正在用的 OBS 再拉一份起来。
 */
function testLaunchpad() {
  const LP = require('../electron/launchpad.cjs')

  /* --- libraryfolders.vdf 的两代格式 --- */
  {
    const modern = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"label"		""
		"apps"
		{
			"228980"		"10953481152198204146"
		}
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
	}
}`
    const vdf = LP.parseVdf(modern)
    ok('能读出 libraryfolders 段', Boolean(vdf.libraryfolders))
    const paths = LP.libPathsFrom(vdf)
    ok('新版格式的两个库都拿到了', paths.length === 2, paths)
    ok('库路径的反斜杠被还原了', paths[0] === 'C:\\Program Files (x86)\\Steam', paths[0])
    ok('嵌套的 apps 不会被当成库路径', !paths.includes('10953481152198204146'), paths)

    // 老版格式：键是数字、值是路径，另外夹着两个非数字键的统计字段
    const legacy = `"LibraryFolders"
{
	"TimeNextStatsReport"	"1234567890"
	"ContentStatsID"		"-123456789"
	"1"		"D:\\\\mygames"
}`
    const old = LP.libPathsFrom(LP.parseVdf(legacy))
    ok('旧版格式也能拿到库路径', old.length === 1 && old[0] === 'D:\\mygames', old)

    // 脏数据不该把整份解析带崩
    ok('空文本不炸', Object.keys(LP.parseVdf('')).length === 0)
    ok('只有半边引号也不炸', typeof LP.parseVdf('"a" "b').a === 'string')
    ok('注释会被跳过', LP.parseVdf('// 注释\n"a" "b"').a === 'b')
    ok('未知段不误伤', LP.libPathsFrom(LP.parseVdf('"x" { "y" "z" }')).length === 0)
  }

  /* --- appmanifest_*.acf --- */
  {
    const acf = `"AppState"
{
	"appid"		"1905180"
	"Universe"		"1"
	"name"		"OBS Studio"
	"StateFlags"		"4"
	"installdir"		"OBS Studio"
	"SizeOnDisk"		"123456789"
	"LastUpdated"		"1700000000"
	"UserConfig"
	{
		"language"		"schinese"
	}
}`
    const a = LP.parseAppManifest(acf, '0')
    ok('读出 appid', a.appid === '1905180', a.appid)
    ok('读出 name', a.name === 'OBS Studio', a.name)
    ok('读出 installdir', a.installdir === 'OBS Studio', a.installdir)
    ok('StateFlags = 4 表示装完了', a.stateFlags === 4, a.stateFlags)
    ok('文件名兜底也能用', LP.parseAppManifest('"AppState" { }', '999').appid === '999')
  }

  /* --- 版本号必须按数字比 --- */
  {
    ok('版本号按数字分段', JSON.stringify(LP.versionKey('7.64.0.10819')) === JSON.stringify([7, 64, 0, 10819]))
    ok('7.64 比 7.9 新（字符串比会判反）', LP.cmpVersion('7.64.0', '7.9.1') > 0, LP.cmpVersion('7.64.0', '7.9.1'))
    ok('段数不同也能比', LP.cmpVersion('7.64', '7.64.0.1') < 0)
    ok('一样就是 0', LP.cmpVersion('1.2.3', '1.2.3') === 0)
    const picked = LP.pickLatestVersion(['7.9.1', '7.64.0.10819', '7.30.0.9821', 'livehime.exe'])
    ok('挑出真正最新的那一版', picked === '7.64.0.10819', picked)
    ok('空清单返回空串', LP.pickLatestVersion([]) === '')
  }

  /* --- 命令怎么拼 --- */
  {
    const obs = { id: 'obs', name: 'OBS Studio', appid: '1905180', exe: 'C:\\S\\common\\OBS Studio\\bin\\64bit\\obs64.exe' }
    const steam = LP.planLaunch(obs, { useSteam: true })
    ok('默认走官方 Steam 协议', steam.mode === 'steam' && steam.url === 'steam://rungameid/1905180', steam)
    ok('Steam 模式下不直接碰 exe', !steam.exe, steam)

    const direct = LP.planLaunch(obs, { useSteam: false })
    ok('关掉 Steam 就直启 exe', direct.mode === 'exe' && direct.exe === obs.exe, direct)
    // OBS 官方文档写明了这一条：工作目录必须是 obs64.exe 所在目录
    ok('工作目录设成 exe 所在目录（OBS 官方要求）', direct.cwd === path.dirname(obs.exe), direct.cwd)
    ok('没有 appid 时不带 -nosteam', JSON.stringify(direct.args) === '[]', direct.args)

    // VTS / VBridger 官方自带的 start_without_steam.bat 就是这么写的
    const vts = { id: 'vts', appid: '1325860', exe: 'C:\\S\\VTube Studio\\VTube Studio.exe', nosteamArg: '-nosteam' }
    const vtsGo = LP.planLaunch(vts, { useSteam: false })
    ok('绕过 Steam 时带上官方的 -nosteam', vtsGo.args.includes('-nosteam'), vtsGo.args)
    // 走 Steam 的话就什么都别加，交给 Steam 自己管
    ok('走 Steam 时不加 -nosteam', !(LP.planLaunch(vts, { useSteam: true }).args || []).length)

    const live = { id: 'livehime', name: '哔哩哔哩直播姬', appid: '', exe: 'C:\\Program Files\\bililive\\livehime\\livehime.exe' }
    ok('没 appid 的独立程序只能直启', LP.planLaunch(live, { useSteam: true }).mode === 'exe')
    ok('没 appid 时不硬套 Steam', !LP.planLaunch(live, { useSteam: true }).url)

    // 装了但扫不到 exe：要说清楚，别给一个空命令
    const broken = LP.planLaunch({ id: 'x', appid: '1', exe: '' }, { useSteam: false })
    ok('没有可执行文件时明确报出来', broken.mode === 'none' && broken.label.includes('没找到'), broken)
    ok('只装没 exe 但有 appid 时给出线索', broken.note.includes('appid'), broken.note)
    // 走 Steam 就不需要 exe —— Steam 认的是 appid，不是我们猜的路径。
    // 所以「装了但没扫到 exe」在默认设置下**依然能起来**，报失败才是错的
    ok(
      '只有 appid、没扫到 exe 时走 Steam 依然能起来',
      LP.planLaunch({ id: 'x', appid: '1', exe: '' }, { useSteam: true }).mode === 'steam',
    )
    ok(
      '而且拼的是那个 appid 的官方协议',
      LP.planLaunch({ id: 'x', appid: '1', exe: '' }, { useSteam: true }).url === 'steam://rungameid/1',
    )
  }

  /* --- 需要管理员权限的程序（哔哩哔哩直播姬） --- */
  {
    // 实测：livehime.exe 的内嵌 manifest 写着 requireAdministrator。
    // 普通权限的进程 spawn 它，Windows 直接返回 740 —— 只能弹 UAC，没有别的路
    const live = {
      id: 'livehime',
      name: '哔哩哔哩直播姬',
      appid: '',
      exe: 'C:\\Program Files\\bililive\\livehime\\livehime.exe',
      elevate: true,
    }

    ok('要提权的程序直启时会被标出来', LP.planLaunch(live, { useSteam: false }).elevate === true)
    ok('普通的程序不会被标', !LP.planLaunch({ id: 'o', exe: 'C:\\a\\o.exe' }, { useSteam: false }).elevate)

    ok('needsElevation：要提权 + 直启 = 是', LP.needsElevation(live, false) === true)
    // 走 Steam 是 Steam 去拉它，UAC 那一步不归咱们管 —— 别乱标
    ok('needsElevation：交给 Steam 就不管提权', LP.needsElevation({ ...live, appid: '1' }, true) === false)
    ok('needsElevation：没标记的永远不是', LP.needsElevation({ id: 'x' }, false) === false)
    ok('needsElevation：null 不炸', LP.needsElevation(null, false) === false)

    /* 参数怎么拼进命令行 */
    ok('普通参数原样', LP.winArgv(['-nosteam']) === '-nosteam')
    // PowerShell 的 Start-Process -ArgumentList 收到数组时是「空格 join 完就交出去」，
    // 元素里的空格不会自动加引号 —— 参数带个路径就会散架，所以自己引
    ok('带空格的参数要加引号', LP.winArgv(['--collection', 'My OBS Setup']) === '--collection "My OBS Setup"')
    ok('参数里的引号要转义', LP.winArgv(['a"b']) === '"a\\"b"')
    ok('空参数表给空串', LP.winArgv([]) === '' && LP.winArgv(null) === '')

    ok('PowerShell 单引号字符串：单引号写两遍', LP.psQuote("it's") === "'it''s'")
    ok('psQuote 吃 null 不炸', LP.psQuote(null) === "''")

    const cmd = LP.elevateCommand({ exe: live.exe, args: ['-x'], cwd: 'C:\\Program Files\\bililive\\livehime' })
    const line = cmd.args.join(' ')
    ok('提权走系统自带的 powershell', cmd.exe === 'powershell.exe', cmd.exe)
    ok('用的是 runas 动作', line.includes('-Verb RunAs'), line)
    ok('这是要等的命令（好拿到退出码）', cmd.wait === true)
    // 点了「否」Start-Process 会抛异常，得让它以非 0 退出，界面才认得出「没起来」
    ok('授权失败时以非 0 退出', line.includes('catch { exit 1 }'), line)
    // 实测踩过的坑：`$ErrorActionPreference='Stop'` 后面少一个分号就是 ParserError
    //（PowerShell 会说「try」不是有效语句），退出码 1 —— 表现就是「点了没反应」。
    // 这条断言专门盯那个语句分隔符。
    ok('脚本里两条语句是隔开的（少了分号会语法错）', /'Stop';\s*try\s*\{/.test(line), line)
    ok('脚本以 catch 收尾，语法是完整的', /\}\s*catch\s*\{\s*exit 1\s*\}\s*$/.test(line), line)
    ok('工作目录照样带给它', line.includes("'C:\\Program Files\\bililive\\livehime'"), line)
    ok('exe 路径也引上了', line.includes(`'${live.exe}'`), line)
    // 空格分隔的参数不能被拆成两个
    ok('带空格的参数在真实命令里也是一个整体', LP.elevateCommand({ exe: 'C:\\a.exe', args: ['--collection', 'My Setup'] }).args.join(' ').includes("'--collection \"My Setup\"'"))
    ok('提权命令有个人能看懂的名字', cmd.label.includes('管理员') && cmd.label.includes('livehime.exe'), cmd.label)

    /* 没预判到、但失败原因像提权的：用户手补的程序走的正是这条 */
    ok('认得出 EPERM', LP.looksLikeElevationError({ code: 'EPERM' }) === true)
    ok('认得出 EACCES', LP.looksLikeElevationError({ code: 'EACCES' }) === true)
    // Windows 的 740 到了 libuv 手里会变成 spawn UNKNOWN
    ok('认得出 740 在 libuv 里变的那张脸', LP.looksLikeElevationError({ message: 'spawn UNKNOWN' }) === true)
    ok('认得出 errno -4094', LP.looksLikeElevationError({ errno: -4094 }) === true)
    ok('找不着文件不能当成要提权', LP.looksLikeElevationError({ code: 'ENOENT', message: 'spawn ENOENT' }) === false)
    ok('空的不炸', LP.looksLikeElevationError(null) === false)
  }

  /* --- 「已经在跑了吗」 --- */
  {
    const csv = [
      '"obs64.exe","12345","Console","1","123,456 K"',
      '"vtuberstudio.exe","678","Console","1","234,567 K"',
      '"VTube Studio.exe","900","Console","1","345,678 K"',
      '信息: 没有运行的任务匹配指定标准。',
      '',
    ].join('\r\n')
    const set = LP.parseTasklistCsv(csv)
    ok('读出正在跑的进程名', set.has('obs64.exe') && set.has('vtuberstudio.exe'), Array.from(set))
    ok('统一转小写', set.has('OBS64.EXE') === false && set.size === 3, Array.from(set))
    ok('中文提示行不会被当成进程名', !Array.from(set).some((n) => n.includes('信息')), Array.from(set))
    // 进程名里可以有空格（VTube Studio.exe 就是）。挡掉空格的后果很具体：
    // 用户已经开着 VTS，点一键开播会又拉起一个 —— 正是这功能最该避免的事
    ok('名字里带空格的进程也认得出来', set.has('vtube studio.exe'), Array.from(set))
    ok('空输出返回空集合', LP.parseTasklistCsv('').size === 0)
    ok('null 也不炸', LP.parseTasklistCsv(null).size === 0)
  }

  /* --- 该不该跳过：查不到时宁可不跳 --- */
  {
    const obs = { id: 'obs', exe: 'C:\\OBS\\bin\\64bit\\obs64.exe' }
    ok('进程表查不到（null）时一律不跳过', LP.shouldSkip(obs, null) === false)
    ok('给了个不是集合的东西也不跳过', LP.shouldSkip(obs, {} ) === false)
    ok('名字对得上才跳', LP.shouldSkip(obs, new Set(['obs64.exe'])) === true)
    // tasklist 原样吐出来的可能是 "OBS64.EXE"，归一这步在 parseTasklistCsv 里做。
    // 这里连着走一遍，验的是真实链路而不是一个凭空的约定
    ok(
      'tasklist 原样给大写，走一遍解析也对得上',
      LP.shouldSkip(obs, LP.parseTasklistCsv('"OBS64.EXE","1","Console","1","1 K"')) === true,
    )
    ok('名字对不上就照常启动', LP.shouldSkip(obs, new Set(['chrome.exe'])) === false)
    // 没有 exe 的条目问不出「在不在跑」，只能不跳
    ok('没有 exe 的条目不跳过', LP.shouldSkip({ id: 'x', exe: '' }, new Set(['a.exe'])) === false)
  }

  /* --- 附上「是不是已经在跑」 --- */
  {
    const list = LP.withRunning([{ id: 'a', exe: 'C:\\OBS\\OBS64.exe' }], new Set(['obs64.exe']))
    ok('对上了就是 true', list[0].running === true, list[0])

    // 查不到进程表时必须说「不知道」—— false 会被界面读成「没在跑」，
    // 用户看到的是个确凿的结论，而我们其实什么都没查到
    const unknown = LP.withRunning([{ id: 'a', exe: 'C:\\OBS\\OBS64.exe' }], null)
    ok('查不到进程表时 running 是 null（不是 false）', unknown[0].running === null, unknown[0])
    ok('查不到时不会误报成 true', unknown[0].running !== true)
    ok('没有 exe 的条目也是 null', LP.withRunning([{ id: 'b', exe: '' }], new Set(['a.exe']))[0].running === null)
    ok('原条目别的字段一个不少', unknown[0].id === 'a' && unknown[0].exe === 'C:\\OBS\\OBS64.exe', unknown[0])
    ok('不会改动传进来的数组', Array.isArray(LP.withRunning([], null)))
    ok('乱传也不炸', LP.withRunning(null, null).length === 0)
  }

  /* --- Steam 根目录候选 --- */
  {
    const fakeEnv = { ProgramFiles: 'P:\\PF', 'ProgramFiles(x86)': 'P:\\PF86', LOCALAPPDATA: 'P:\\LA' }
    const roots = LP.steamRootCandidates(fakeEnv)
    ok('认 Program Files (x86)', roots.includes(path.normalize('P:\\PF86\\Steam')), roots)
    ok('也认 Program Files', roots.includes(path.normalize('P:\\PF\\Steam')))
    ok('各盘符的库目录都试一遍', roots.some((p) => /^C:\\Steam$/.test(p)), roots.slice(0, 6))
    ok('候选不重复', new Set(roots).size === roots.length)
    ok('能追加用户自己指定的', LP.steamRootCandidates(fakeEnv, ['Z:\\MySteam']).includes('Z:\\MySteam'))
  }

  /* --- 真扫一遍本机（只读：读配置、看 exe 在不在） --- */
  {
    const scan = LP.scanLaunchpad()
    ok('扫描不抛异常', Array.isArray(scan.apps) && Array.isArray(scan.libraries), scan)
    ok('每个条目都有 id / name / origin', scan.apps.every((a) => a.id && a.name && a.origin))
    ok('扫到的 exe 都是真实存在的', scan.apps.filter((a) => a.exe).every((a) => fs.existsSync(a.exe)))
    ok('Steam 库路径都真实存在', scan.libraries.every((p) => fs.existsSync(p)), scan.libraries)
    // 这台机器上装的东西是固定的，但别的机器不一定 —— 所以只在扫到的时候校验字段
    const obs = scan.apps.find((a) => a.id === 'obs')
    if (obs) {
      ok('OBS 记下了 appid', /^\d+$/.test(obs.appid), obs.appid)
      ok('OBS 的 exe 名字对', path.basename(obs.exe).toLowerCase() === 'obs64.exe', obs.exe)
    }
    // 它的 manifest 里写着 requireAdministrator，界面上要提示用户会弹 UAC
    const livehime = scan.apps.find((a) => a.id === 'livehime')
    if (livehime) ok('真机扫到的直播姬标着「需管理员」', livehime.elevate === true, livehime)
    // 假环境不该炸：库目录一个都不存在时，安静地返回空
    const empty = LP.scanLaunchpad({ env: { ProgramFiles: 'P:\\none', 'ProgramFiles(x86)': 'P:\\none' } })
    ok('扫不到东西时安静返回', empty.apps.length === 0 && empty.errors.length === 0, empty)
    ok('同一类程序不会出现两条', new Set(scan.apps.map((a) => a.id)).size === scan.apps.length, scan.apps.map((a) => a.id))
  }

  /* --- 接线：主进程 / 预加载 / 配置默认值 / 界面 --- */
  {
    const root = path.join(__dirname, '..')
    const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
    const main = read('electron/main.cjs')
    const preload = read('electron/preload.cjs')
    const apiTs = read('src/lib/api.ts')
    const page = read('src/pages/ConnectPage.tsx')
    const card = read('src/components/LaunchpadCard.tsx')
    const css = read('src/styles.css')

    ok('主进程有扫描口', /ipcMain\.handle\('launchpad:scan'/.test(main))
    ok('主进程有一键开播口', /ipcMain\.handle\('launchpad:run'/.test(main))
    ok('能手补扫描不到的程序', /ipcMain\.handle\('launchpad:pickExe'/.test(main))
    ok('Steam 用官方协议唤起', /shell\.openExternal\(plan\.url\)/.test(main))
    ok('进度一路推给界面', /send\('launchpad:progress'/.test(main))
    ok('防连点：同一时刻只跑一次', /let lpBusy = false/.test(main) && /if \(lpBusy\) throw/.test(main))
    ok('扫到在跑的会跳过', /已经在运行，没有重复启动/.test(main))
    ok('启动前先查进程', /execFile\('tasklist', \['\/FO', 'CSV', '\/NH'\]/.test(main))
    ok('查不到进程也不拦着启动', /if \(err\) return resolve\(null\)/.test(main))
    ok('拉起的程序活得比本程序久', /detached: true/.test(main) && /child\.unref\(\)/.test(main))
    ok('.bat/.cmd 会交给 cmd 跑', /ext === '\.bat' \|\| ext === '\.cmd'/.test(main))
    ok('启动失败会落日志', /'\[launchpad\] 启动失败'/.test(main))
    // 直播姬的 manifest 是 requireAdministrator，普通权限拉不起来 —— 得走 UAC
    ok('需要提权时会去弹 UAC', /function runElevated\(plan\)/.test(main) && /LP\.elevateCommand\(plan\)/.test(main))
    ok('提权那一步会等（好拿到退出码）', /child\.once\('exit', \(code\)/.test(main))
    ok('用户点「否」不会被谎报成成功', /授权窗口要点「是」/.test(main))
    ok('一直不理也不能卡死', /ELEVATE_TIMEOUT_MS/.test(main) && /等待管理员授权超时/.test(main))
    ok('没预判到但报错像提权的会重试一次', /LP\.looksLikeElevationError\(r\)/.test(main))
    ok('提权时不弹黑框', /windowsHide: true/.test(main))
    ok('轮到提权那一步会先说清楚', /正在请求管理员权限/.test(main))
    ok('跑完自动连直播间', /await startLive\(roomId\)/.test(main))
    ok('预加载暴露了这四个口', /scan: \(opts\) => ipcRenderer\.invoke\('launchpad:scan'/.test(preload) && /onProgress:/.test(preload))
    ok('类型定义补齐', /launchpad\?: \{/.test(apiTs) && /interface LaunchpadApp/.test(apiTs))
    ok('连接页最上面就是它', /<LaunchpadCard config=\{config\}/.test(page))
    ok('界面上能逐个勾选、顺序就是启动顺序', /const toggle = \(id: string\)/.test(card) && /order\.indexOf\(a\.id\) \+ 1/.test(card))
    ok('界面上标出了要管理员权限的那一项', /需管理员/.test(card))
    ok('而且要提前说会弹窗', /桌面会弹一个窗口/.test(card))
    ok('界面上有样式', /\.lp-item\b/.test(css) && /\.lp-check\b/.test(css))
    // 别的徽章是补充信息，这个是提前告知 —— 窄屏也别藏
    ok('「需管理员」的徽章窄屏也留着', /\.lp-item__badge\.is-admin\s*\{[^}]*display:\s*inline-block/.test(css))

    const DEFAULTS = readStoreDefaults()
    ok('配置有 launchpad 段', Boolean(DEFAULTS.launchpad))
    ok('默认走 Steam', DEFAULTS.launchpad?.useSteam === true)
    ok('默认拉完就连直播间', DEFAULTS.launchpad?.autoConnect === true)
    ok('默认跳过已在运行的', DEFAULTS.launchpad?.skipRunning === true)
    ok('默认顺序是空的（等用户勾）', Array.isArray(DEFAULTS.launchpad?.order) && DEFAULTS.launchpad.order.length === 0)
    ok('间隔留了默认值', Number(DEFAULTS.launchpad?.gapMs) > 0)
  }
}

/**
 * 「谁在选音色」面板的队列。主播定的三条规矩都在这里守着：
 *  ① 一次只显示一条，默认 8 秒；
 *  ② 同时来多条**排队依次**放，不叠加、不互相覆盖；
 *  ③ 排队等着的那条不能提前把 8 秒耗掉（计时懒启动），
 *     而被标上「已绑定」的那条要**重新计满**。
 */
function testVoicePickQueue() {
  const { createPickQueue, DEFAULT_TTL_MS, MAX_QUEUE, MAX_HITS } = require('../electron/voice-pick.cjs')

  ok('默认 8 秒', DEFAULT_TTL_MS === 8000)

  // 没人搜的时候，面板必须是收掉的（不是空白卡片挂在画面上）
  {
    const q = createPickQueue()
    const s = q.snapshot(Date.now())
    ok('没人选的时候面板收掉', s.panel === null && s.waiting === 0)
    ok('没人时队列是空的', q.size() === 0)
  }

  // ① 一条：满 8 秒自己消失
  {
    const q = createPickQueue()
    q.push({ uid: 1, who: '小明', keyword: '御姐', hits: [{ name: '御姐A' }, { name: '御姐B' }] })
    const t0 = Date.now()
    const s = q.snapshot(t0)
    ok('搜完立刻有一帧', Boolean(s.panel) && s.panel.hits.length === 2)
    ok('就一个人在选，后面没人等', s.waiting === 0)
    ok('候选从 1 开始编号', s.panel.hits[0].n === 1 && s.panel.hits[1].n === 2)
    ok('不到 8 秒还在', q.snapshot(t0 + 7900).panel !== null)
    ok('满 8 秒自动收掉', q.snapshot(t0 + 8000).panel === null)
    ok('收掉后队列也空了', q.size() === 0)
  }

  // ② 两个人：先来的先显示，到点才换人
  {
    const q = createPickQueue()
    q.push({ uid: 1, who: 'A', hits: [{ name: 'a' }] })
    q.push({ uid: 2, who: 'B', hits: [{ name: 'b' }] })
    const t0 = Date.now()
    const s1 = q.snapshot(t0)
    ok('先来的先显示', s1.panel.who === 'A' && s1.waiting === 1)
    const s2 = q.snapshot(t0 + 8000)
    ok('到点了换后面那位', Boolean(s2.panel) && s2.panel.who === 'B' && s2.waiting === 0)
    // 这一条是关键：B 在 A 显示的那 8 秒里一直排队，它自己的 8 秒得从**上场那一刻**算
    ok('排队等的那位不会提前过期', q.snapshot(t0 + 8000 + 7900).panel !== null)
    ok('B 也是满 8 秒才走', q.snapshot(t0 + 8000 + 8000).panel === null)
  }

  // ③ 三条排队：一条一条来，谁也不盖谁
  {
    const q = createPickQueue()
    const who = ['甲', '乙', '丙']
    for (let i = 0; i < 3; i++) q.push({ uid: i + 1, who: who[i], hits: [{ name: 'v' + i }] })
    const t0 = Date.now()
    const seen = []
    for (let i = 0; i < 3; i++) {
      const s = q.snapshot(t0 + i * 8000)
      seen.push(s.panel ? s.panel.who : null)
    }
    ok('三条按顺序依次显示', seen.join('') === '甲乙丙', seen.join(','))
    ok('最后一条到点后队列清空', q.snapshot(t0 + 3 * 8000).panel === null && q.size() === 0)
  }

  // ④ 被选中：标上序号，并重新计满 8 秒
  {
    const q = createPickQueue()
    q.push({ uid: 1, who: 'A', hits: [{ name: 'a' }, { name: 'b' }] })
    q.snapshot(Date.now())
    ok('没选之前不标已绑定', q.snapshot(Date.now()).panel.picked === 0)
    ok('没搜过的人结算不动队列', q.resolve(999, { n: 1 }) === null)
    ok('选中的那条能结算到', q.resolve(1, { n: 2 }) !== null)
    const s = q.snapshot(Date.now())
    ok('选中的序号标上去', s.panel.picked === 2)
    // 标完重新计满 —— 否则可能刚标上就到点消失，观众根本没看见
    ok('标上后重新计满 8 秒', q.snapshot(Date.now() + 7000).panel !== null)
    ok('重新计的 8 秒到点才收', q.snapshot(Date.now() + 8500).panel === null)
  }

  // ⑤ 绑定失败：原因也要摆在面板上，不然观众只看到自己那条莫名消失
  {
    const q = createPickQueue()
    q.push({ uid: 1, who: 'A', hits: [{ name: 'a' }] })
    q.snapshot(Date.now())
    q.resolve(1, { failed: '列表过期了' })
    const s = q.snapshot(Date.now())
    ok('失败原因摆在面板上', s.panel.failed === '列表过期了' && s.panel.picked === 0)
    ok('失败的那条也会到点自己收', q.snapshot(Date.now() + 8500).panel === null)
  }

  // ⑥ 同一个人连着搜第二次：顶掉自己上一条，别排在自己后面
  {
    const q = createPickQueue()
    q.push({ uid: 7, who: 'A', keyword: '第一次', hits: [{ name: 'a' }] })
    q.push({ uid: 7, who: 'A', keyword: '第二次', hits: [{ name: 'b' }] })
    const s = q.snapshot(Date.now())
    ok('重搜会顶掉自己上一条', q.size() === 1 && s.panel.keyword === '第二次')
    ok('数字 uid 和字符串 uid 是同一个人', q.resolve('7', { n: 1 }) !== null)
  }

  // 已经选完的那条不该被顶掉 —— 它正显示着「已绑定」，是给观众看的回执
  {
    const q = createPickQueue()
    q.push({ uid: 8, who: 'A', keyword: '一', hits: [{ name: 'a' }] })
    q.snapshot(Date.now())
    q.resolve(8, { n: 1 })
    q.push({ uid: 8, who: 'A', keyword: '二', hits: [{ name: 'b' }] })
    ok('已选完的那条不会被顶掉', q.size() === 2)
  }

  // ⑦ OBS 没开的时候面板推不出去、没人消费，队列不能无限攒着
  {
    const q = createPickQueue()
    for (let i = 0; i < 30; i++) q.push({ uid: i + 1, hits: [{ name: 'v' + i }] })
    ok('队列有上限', q.size() === MAX_QUEUE && MAX_QUEUE > 0)
    q.clear()
    ok('能一次清干净', q.size() === 0 && q.snapshot(Date.now()).panel === null)
  }

  // ⑧ 候选条数有上限：列太多会顶掉弹幕，而且没人会看第 7 条
  {
    const q = createPickQueue()
    q.push({ uid: 1, hits: Array.from({ length: 20 }, (_, i) => ({ name: 'v' + i })) })
    const s = q.snapshot(Date.now())
    ok('候选最多列 6 条', s.panel.hits.length === MAX_HITS && MAX_HITS === 6)
    ok('截掉的是后面的', s.panel.hits[0].name === 'v0' && s.panel.hits[MAX_HITS - 1].name === 'v' + (MAX_HITS - 1))
  }

  // ⑨ 时长可配：设置页改了要能生效，并且推给叠加层跟主进程对得上
  {
    const q = createPickQueue()
    q.push({ uid: 1, hits: [{ name: 'a' }] })
    ok('没配过就用默认', q.snapshot(Date.now()).panel.ttlMs === DEFAULT_TTL_MS)
    q.setTtl(3000)
    ok('改了时长立刻生效', q.snapshot(Date.now()).panel.ttlMs === 3000)
    q.setTtl(0)
    ok('非正数的时长不采纳', q.snapshot(Date.now()).panel.ttlMs === 3000)
    q.setTtl('abc')
    ok('乱填的时长不采纳', q.snapshot(Date.now()).panel.ttlMs === 3000)
    const q2 = createPickQueue({ ttlMs: 5000 })
    q2.push({ uid: 1, hits: [{ name: 'a' }] })
    ok('构造时就指定了时长', q2.snapshot(Date.now()).panel.ttlMs === 5000)
  }

  // ⑩ 面板上的文字来自不可信输入（弹幕昵称、平台返回的音色名），一律按位截断
  {
    const q = createPickQueue()
    const long = 'x'.repeat(80)
    q.push({ uid: 1, who: long, keyword: long, hits: [{ name: long, source: long, hint: long }] })
    const s = q.snapshot(Date.now()).panel
    ok('昵称会截断', s.who.length === 24)
    ok('关键词会截断', s.keyword.length === 24)
    ok('候选名会截断', s.hits[0].name.length === 24)
    ok('平台名会截断', s.hits[0].source.length === 16)
    ok('说明会截断', s.hits[0].hint.length === 40)
    ok('标记原样带过去，不丢', s.hits[0].registered === false && s.hits[0].disabled === false)
  }

  // ⑪ 已注册 / 已停用的标记：面板要据此告诉主播「为什么点了没反应」
  {
    const q = createPickQueue()
    q.push({
      uid: 1,
      who: 'A',
      hits: [{ name: 'a', registered: true }, { name: 'b', registered: true, disabled: true }],
    })
    const s = q.snapshot(Date.now()).panel
    ok('已注册带过去了', s.hits[0].registered === true && s.hits[0].disabled === false)
    ok('已停用带过去了', s.hits[1].disabled === true)
    ok('脏数据不炸', (() => { const z = createPickQueue(); z.push({}); return z.snapshot(Date.now()).panel.hits.length === 0 })())
  }

  // ⑫ 主进程那侧的心跳：队列空就停，别留个定时器空转
  {
    const root = path.join(__dirname, '..')
    const mainSrc = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
    ok('心跳在队列空了以后自己停', /if \(!pickQueue\.size\(\)\) stopPickTimer\(\)/.test(mainSrc))
    ok('心跳不会把进程钉住不退出', /if \(pickTimer\.unref\) pickTimer\.unref\(\)/.test(mainSrc))
    ok('没事发生时不白推帧', /if \(pickQueue\.prune\(Date\.now\(\)\)\) pushPick\(\)/.test(mainSrc))
    ok('刚放进队列就推一帧', /pickQueue\.push\(item\)\s*\n\s*startPickTimer\(\)\s*\n\s*pushPick\(\)/.test(mainSrc))
  }
}

/**
 * 「明明有这个音色，却怎么都换不过去」—— 这句话背后有四条独立的路，
 * 每条都写过一遍。这里把它们钉住，免得哪天又被顺手改回去：
 *  ① 列表只搜在线平台 → 库里注册的（尤其是文字设计出来的）永远搜不到；
 *  ② 榜上确实有，但档案被停用了 → 回执说成功，实际继续用默认嗓子；
 *  ③ `#绑定 3` 的列表过期后，这个 3 被当成关键词丢去在线搜 → 绑到毫不相干的音色；
 *  ④ 文字设计 / 音色复刻出来的音色设不成全局默认 → 换了跟没换一样。
 * 顺带：搜索与绑定这条链路以前一个字都不记，出问题只能靠猜，现在要有日志。
 */
function testVoicePickWiring() {
  const root = path.join(__dirname, '..')
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
  const main = read('electron/main.cjs')
  const overlayCjs = read('electron/overlay.cjs')
  const overlayHtml = read('overlay/index.html')
  const preload = read('electron/preload.cjs')
  const apiTs = read('src/lib/api.ts')
  const storeSrc = read('electron/store.cjs')

  // ---- ① 列表：库里优先，在线补位 ----
  ok('列表会先查已注册的音色库', /V\.searchProfiles\(lib, keyword, limit\)/.test(main))
  ok('带上 profileId（设计音色在平台上没有 id）', /profileId: p\.id/.test(main))
  ok('在线结果只作补位', /await V\.searchEverywhere\(cfg\.voicePolicy\?\.searchSources/.test(main))
  ok('按「平台:id」去重', /const key = `\$\{v\.source\}:\$\{v\.id\}`/.test(main) && /if \(!v\.id \|\| seen\.has\(key\)\) return/.test(main))
  ok('库里已注册的标出来', /const state = libStateOf\(cfg, v\)/.test(main) && /registered: state !== 'none'/.test(main))
  ok('已停用的也标出来', /disabled: state === 'disabled'/.test(main))
  // 台上与聊天里必须是同一份顺序，否则观众照聊天里的第 2 条去绑定会绑错
  ok('面板与回执共用同一份列表', /searchCache\.set\(uid, \{ at: Date\.now\(\), voices: r\.voices \}\)/.test(main))

  // ---- ② 绑定到已停用的档案：必须拒绝，不能假装成功 ----
  ok('绑定前复核档案是否被停用', /if \(reused && reused\.enabled === false\)/.test(main))
  ok('停用时明确拒绝并说明', /已经被主播停用了，挑一个别的/.test(main))
  ok('复用已有档案不重复造', /const profile = reused \|\| ensureProfile\(voice\)/.test(main))

  // ---- ③ 纯数字但列表过期：不能当关键词去在线搜 ----
  ok('纯数字 + 列表过期单独分流', /reason: 'staleList'/.test(main))
  ok('过期时把数字当关键词这条路被堵住', /if \(\/\^\\d\+\$\/\.test\(String\(arg\)\.trim\(\)\)\) return \{ voice: null, reason: 'staleList' \}/.test(main))
  ok('过期时的话术是「先发一次列表」', /列表过期了，先发一次/.test(main))
  ok('序号越界也有明确话术', /没有这个序号，重新发一次列表看看/.test(main))

  // ---- ④ 设计 / 克隆音色能设成全局默认 ----
  ok('ttsCfg 带上设计模式', /mimoMode: t\.mimoMode \|\| 'preset'/.test(main))
  ok('ttsCfg 带上设计描述', /designPrompt: t\.designPrompt \|\| ''/.test(main))
  ok('ttsCfg 带上复刻样音', /cloneFile: t\.cloneFile \|\| ''/.test(main))
  ok('有「设为默认」的 IPC', /ipcMain\.handle\('voices:useAsDefault'/.test(main))
  ok('设为默认会把设计三件套一起写进去', /mimoMode: p\.mimoMode \|\| 'preset',\s*\n\s*designPrompt: p\.designPrompt \|\| '',\s*\n\s*cloneFile: p\.cloneFile \|\| '',/.test(main))
  ok('界面上的模型别名优先于档案里那个', /model: cfg\.platformModel\?\.\[p\.platform\] \|\| p\.model \|\| ''/.test(main))
  ok('渲染层预加载暴露了 useAsDefault', /useAsDefault: \(id\) => ipcRenderer\.invoke\('voices:useAsDefault', id\)/.test(preload))
  ok('api 类型里有 useAsDefault', /useAsDefault: \(id: string\)/.test(apiTs))

  // ---- 日志：这条链路以前一个字都不记 ----
  ok('列表落日志', /'\[voices\] 列表'/.test(main))
  ok('列表失败落日志', /'\[voices\] 列表失败'/.test(main))
  ok('绑定成功落日志', /'\[voices\] 绑定'/.test(main))
  ok('绑定失败落日志', /'\[voices\] 绑定失败'/.test(main))
  ok('绑到已停用的音色落日志', /'\[voices\] 绑定到已停用的音色'/.test(main))
  ok('设为默认音色落日志', /'\[voices\] 设为默认音色'/.test(main))

  // ---- 叠加层：主进程推帧 + 客户端补发 + 页面渲染 ----
  ok('叠加层服务给出补发钩子', /this\.voicePickProvider = null/.test(overlayCjs))
  ok('连上时补发当前面板', /type: 'voicepick', payload: pick/.test(overlayCjs))
  ok('主进程队列就是那个钩子', /overlay\.voicePickProvider = \(\) => pickQueue\.snapshot\(\)/.test(main))
  ok('叠加层有面板容器', /id="cp-pick"/.test(overlayHtml))
  ok('叠加层收得下这一帧', /msg\.type === 'voicepick'/.test(overlayHtml))
  ok('同一帧不重复重建（进度条不会重头播）', /if \(key === pickDrawn\)/.test(overlayHtml))
  ok('进度条时长跟主进程对得上', /fill\.style\.animationDuration = pickTtl\(\) \+ 'ms'/.test(overlayHtml))
  ok('排队情况显示在面板上', /'后面还有 ' \+ pickState\.waiting \+ ' 位在等'/.test(overlayHtml))
  ok('选中的那条高亮', /'✓ 已绑定'/.test(overlayHtml) && /is-picked/.test(overlayHtml))
  ok('失败原因显示在面板上', /'没换成：' \+ p\.failed/.test(overlayHtml))
  ok('四角可放', /const PICK_POS = \['tl', 'tr', 'bl', 'br'\]/.test(overlayHtml) && /data-pos/.test(overlayHtml))
  ok('面板参与自动避让', /blocks\.push\(\{ el: pickEl, box: k, top: isTopSide\(pickPos\(\), TOP_SIDE\), rank: 1 \}\)/.test(overlayHtml))
  ok('叠加层默认值齐备', /showVoicePick: true/.test(overlayHtml) && /voicePickTtlMs: 8000/.test(overlayHtml))
  ok('窄画面下截住面板本身', /html\.is-narrow \.cp-pick \{/.test(overlayHtml))

  // ---- 配置默认值：三处取值必须一致 ----
  const DEFAULTS = readStoreDefaults()
  ok('配置默认开着音色面板', DEFAULTS.overlay?.showVoicePick === true)
  ok('配置默认位置是右上', DEFAULTS.overlay?.voicePickPos === 'tr')
  ok('配置默认列 4 条', DEFAULTS.overlay?.voicePickHits === 4)
  ok('配置默认 8 秒', DEFAULTS.overlay?.voicePickTtlMs === 8000)
  ok('叠加层与配置的默认位置一致', /voicePickPos: 'tr'/.test(storeSrc) && /voicePickPos: 'tr'/.test(overlayHtml))
}

/**
 * TTS 结果缓存。这是「同一个主播一场直播」里最省钱的一环：
 * 「你好」「666」这类句子会被反复触发，缓存把第二次开始的成本降到 0。
 * 这里守的核心是**滑动过期**：命中会刷新保存时间戳，
 * 所以常被触达的句子不会被清理掉，冷掉的才会。
 */
async function testTtsCache() {
  const os = require('node:os')
  const { createTtsCache } = require('../electron/tts-cache.cjs')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-ttscache-'))
  const idxPath = path.join(root, 'index.json')
  const cfg = {
    provider: 'mimo',
    protocol: 'chat-completions',
    baseUrl: 'https://api.x/v1',
    model: 'm1',
    voice: 'v1',
    format: 'wav',
    speed: 1,
    apiKey: 'sk-super-secret-key',
  }
  const mkAudio = (n, tag = 'A') => Buffer.from(tag.repeat(n)).toString('base64')
  const input = (text, override) => ({ cfg: { ...cfg, ...(override || {}) }, text, style: '' })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const c = createTtsCache({ dir: root })
  try {
    ok('冷启动不命中', c.get(input('你好')) === null)

    c.put(input('你好'), { base64: mkAudio(300), mime: 'audio/wav' })
    const hit = c.get(input('你好'))
    ok('同一句话命中且音频一致', Boolean(hit) && hit.base64 === mkAudio(300))
    ok('命中会累加次数', hit?.hits === 1)

    ok('换一句话不命中', c.get(input('666')) === null)
    ok('换音色不命中', c.get(input('你好', { voice: 'v2' })) === null)
    ok('换 Key 不命中（按账号隔离）', c.get(input('你好', { apiKey: 'another-key' })) === null)
    ok('换风格指令不命中', (() => {
      const d = { cfg, text: '你好', style: '温柔一点' }
      return c.get(d) === null
    })())
    ok('太短的音频不入库', c.put(input('短'), { base64: mkAudio(4) }) === false)

    // 索引是**节流**写的，断言前先强制落盘
    c.flush()
    const raw = fs.readFileSync(idxPath, 'utf8')
    ok('已经写到磁盘', raw.length > 0)
    // 密钥只留哈希指纹：缓存文件被人拷走也不该泄露 Key
    ok('索引里不含明文 Key', !raw.includes('sk-super-secret-key'))

    /* ---- 滑动过期：冷句子会过期，常触达的会续期 ---- */
    c.put(input('没人再说的冷句子'), { base64: mkAudio(200, 'B') })
    await sleep(3)
    c.put(input('主播好帅'), { base64: mkAudio(200, 'C') })
    c.flush()

    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
    const keyOf = (t) => c.cacheKeyOf(input(t))
    const coldAt = idx.entries[keyOf('没人再说的冷句子')]
    const warmAt = idx.entries[keyOf('主播好帅')]
    ok('两条都进索引了', Boolean(coldAt) && Boolean(warmAt))

    // 把两条的保存时间都往回调 5 秒，TTL 设 2 秒 → 都过期
    const old = Date.now() - 5000
    for (const h of [keyOf('没人再说的冷句子'), keyOf('主播好帅')]) idx.entries[h].savedAt = old
    fs.writeFileSync(idxPath, JSON.stringify(idx))

    const c2 = createTtsCache({ dir: root })
    // 先看天 tenant：热句子在回滚的时间内被触发一次 → 时间戳刷新到「现在」
    const warm = c2.get(input('主播好帅'))
    ok('热句子仍能命中', Boolean(warm))
    const r = c2.prune({ ttlMs: 2000, maxBytes: 0 })
    ok('冷句子过期被清掉', r.removed === 1, JSON.stringify(r))
    ok('冷句子清理后不再命中', c2.get(input('没人再说的冷句子')) === null)
    ok('热句子因命中被续期，留着没删', Boolean(c2.get(input('主播好帅'))))

    /* ---- 容量上限：从最久没用的那份开始删 ---- */
    const dir2 = path.join(root, 'size')
    const c3 = createTtsCache({ dir: dir2 })
    for (const [i, t] of ['一句', '两句', '三句'].entries()) {
      c3.put(input(t), { base64: mkAudio(1000, String(i)) })
      await sleep(3)
    }
    const before = c3.stats()
    ok('塞进去 3 条', before.entries === 3)
    const r2 = c3.prune({ ttlMs: 0, maxBytes: 2000 })
    const after = c3.stats()
    ok('超容量会删掉旧的', r2.removed === 2 && after.entries === 1, `${r2.removed} 条，剩 ${after.entries}`)
    ok('留下的是最新的那句', Boolean(c3.get(input('三句'))))
    ok('最旧的那句被牺牲了', c3.get(input('一句')) === null)

    /* ---- 持久化：关掉重开还在（模拟软件重启） ---- */
    // 索引是节流写的，这里先强制落盘，等于「软件正常退出时那次 flush」
    c3.flush()
    const c4 = createTtsCache({ dir: dir2 })
    ok('重启后仍能命中（持久化）', Boolean(c4.get(input('三句'))))
    ok('统计里带着命中次数', c4.stats().entries === 1 && c4.stats().putCount === 3)

    /* ---- 孤儿文件：索引里没有的 .bin 要被扫掉 ---- */
    fs.writeFileSync(path.join(dir2, 'deadbeefdeadbeefdeadbeefdeadbeef.bin'), 'orphan')
    const c5 = createTtsCache({ dir: dir2 })
    c5.load()
    await sleep(10)
    ok('孤儿文件被清理', !fs.existsSync(path.join(dir2, 'deadbeefdeadbeefdeadbeefdeadbeef.bin')))

    /* ---- 索引损坏：不能把整个缓存目录炸掉，也不能崩 ---- */
    fs.writeFileSync(idxPath, '{ 这不是 json')
    const c6 = createTtsCache({ dir: root })
    ok('索引损坏时安全降级为 0 条', c6.stats().entries === 0)
    ok('损坏的索引留了备份', fs.readdirSync(root).some((f) => f.startsWith('index.json.corrupt-')))

    /* ---- 清空 ---- */
    const cleared = c5.clear()
    ok('清空返回条数', cleared.cleared >= 1, JSON.stringify(cleared))
    ok('清空后索引归零', c5.stats().entries === 0)
    ok('清空后磁盘上没有残留音频', fs.readdirSync(dir2).filter((f) => f.endsWith('.bin')).length === 0)
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  }
}

/* --------------------------- 密钥形态诊断 --------------------------- */

/**
 * 这里守住一条曾经犯过的错：拿着第三方文章的说法把 Fish 的 Key 定成 32 位，
 * 结果把一把 64 位的好 Key 误报成「粘了两把」，把人往错的方向引。
 * 实测后确认 —— fish.audio 与 fishaudio.org 发的密钥长度都不一样（见过 51 / 64 位），
 * 官方从未公开定长。所以这个平台一律只做通用体检，不许按长度下结论。
 */
function testKeyShape() {
  const { keyShapeWarnings, normalizeKey, KEY_LEN } = require('../electron/lib/keytext.cjs')
  // 真实的 64 位 Key 形态（十六进制）
  const k64 = 'ec104cc9b2ed890e73d594dc04749eb5bcc2293856f48a88804ba2e0d3990a90'
  const k32 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'

  ok('Fish 未登记定长（避免误报）', KEY_LEN.fish === undefined)
  ok('真·64 位 Key 不报警（回归：曾被误判成两把）', keyShapeWarnings(k64, 'fish').length === 0)
  ok('32 位 Key 也不报警', keyShapeWarnings(k32, 'fish').length === 0)
  ok('空 Key：不报警', keyShapeWarnings('', 'fish').length === 0)
  ok('明显太短才报警', keyShapeWarnings('abc', 'fish')[0]?.includes('没复制全') === true)
  ok('16 位仍算正常长度', keyShapeWarnings(k32.slice(0, 16), 'fish').length === 0)
  // 清洗前先归一化：带着 Bearer 前缀和零宽字符也不该影响长度判断
  ok('带 Bearer 前缀不误报', keyShapeWarnings(`Bearer ${k64}`, 'fish').length === 0)
  ok('零宽字符不影响长度判断', keyShapeWarnings(`${k64}\u200b`, 'fish').length === 0)
  ok('normalizeKey 去掉零宽字符', normalizeKey(`${k64}\u200b`).length === 64)
  ok('normalizeKey 去掉 Bearer 前缀', normalizeKey(`Bearer ${k64}`).length === 64)
}

/* --------------------------- 网易云点歌 --------------------------- */

/**
 * 点歌是自己照着接口写的（electron/netease.cjs），没有第三方服务兜底，
 * 所以加密、解析、指令识别这三块必须自己测住 —— 接口一变这些最先坏。
 */
async function testNetease() {
  const crypto = require('node:crypto')
  const NCM = require('../electron/netease.cjs')

  // 1) linuxapi 加密：服务端要能解开，先保证自己能解开
  {
    const payload = { method: 'POST', url: 'https://music.163.com/api/cloudsearch/pc', params: { s: '晴天' } }
    const body = NCM.linuxapi(payload)
    ok('linuxapi 走的是 eparams 字段', body.startsWith('eparams='), body.slice(0, 12))
    const hex = body.slice('eparams='.length)
    ok('eparams 是大写 hex', /^[0-9A-F]+$/.test(hex))
    const d = crypto.createDecipheriv('aes-128-ecb', 'rFgB&h#%2?^eDg:Q', Buffer.alloc(0))
    const plain = Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8')
    ok('加密结果能解开还原原文', plain === JSON.stringify(payload), plain.slice(0, 60))
  }

  // 2) 搜索结果与播放链接的解析（把网络层换成假数据）
  {
    const netMod = require('../electron/lib/net.cjs')
    const real = netMod.httpRequest
    let seen = null
    netMod.httpRequest = async (url, opts) => {
      seen = { url, body: opts.body, cookie: (opts.headers || {}).Cookie }
      const isSearch = String(opts.body || '').includes('x-search')
      const text = isSearch
        ? JSON.stringify({
            code: 200,
            result: {
              songs: [
                { id: 11, name: '晴天', artists: [{ name: '周杰伦' }], album: { name: '叶惠美', picUrl: 'http://p/1.jpg' }, duration: 269000, fee: 8, privilege: { pl: 320000 } },
                { id: 12, name: '晴天(钢琴版)', artists: [{ name: '某人' }], album: { name: 'x' }, duration: 238000, fee: 1, privilege: { pl: 0 } },
              ],
            },
          })
        : JSON.stringify({ code: 200, data: [{ id: 11, url: 'http://m701.music.126.net/a.mp3', br: 320000, size: 10831725, type: 'mp3', expi: 1200 }] })
      return { status: 200, ok: true, text, buffer: Buffer.from(text) }
    }
    try {
      // 用不同的搜索词区分两次调用：搜索请求里不含各自的关键词（关键词是加密的），
      // 所以这里按顺序返回：第一次搜索、第二次取链接
      let call = 0
      netMod.httpRequest = async (url, opts) => {
        call++
        seen = { url, cookie: (opts.headers || {}).Cookie }
        const text =
          call === 1
            ? JSON.stringify({
                code: 200,
                result: {
                  songs: [
                    { id: 11, name: '晴天', artists: [{ name: '周杰伦' }], album: { name: '叶惠美', picUrl: 'http://p/1.jpg' }, duration: 269000, fee: 8, privilege: { pl: 320000 } },
                    { id: 12, name: '晴天(钢琴版)', artists: [{ name: '某人' }], album: { name: 'x' }, duration: 238000, fee: 1, privilege: { pl: 0 } },
                  ],
                },
              })
            : JSON.stringify({ code: 200, data: [{ id: 11, url: 'http://m701.music.126.net/a.mp3', br: 320000, size: 10831725, type: 'mp3', expi: 1200 }] })
        return { status: 200, ok: true, text, buffer: Buffer.from(text) }
      }
      const songs = await NCM.searchMusic('晴天', { limit: 2 })
      ok('搜索解析出歌曲', songs.length === 2)
      ok('歌名/歌手/专辑都取到了', songs[0].name === '晴天' && songs[0].artists === '周杰伦' && songs[0].album === '叶惠美')
      ok('时长格式化成 m:ss', songs[0].durationText === '4:29', songs[0].durationText)
      // 拿不到任何音质的歌不该混进点歌队列，否则播到它才报错
      ok('有音质的算可播', songs[0].playable === true)
      ok('没有音质的不算可播', songs[1].playable === false, JSON.stringify(songs[1]))
      ok('封面地址带出来', songs[0].picUrl === 'http://p/1.jpg')

      ok('请求打在转发通道上', seen.url === 'https://music.163.com/api/linux/forward', seen.url)
      ok('默认用匿名 cookie', /os=pc/.test(seen.cookie || ''), seen.cookie)

      const audio = await NCM.songUrl(11, { br: 320000 })
      ok('播放链接取到', audio.url === 'http://m701.music.126.net/a.mp3')
      ok('有效期带出来', audio.expiresIn === 1200)

      // 取不到链接要给能照着做的提示，而不是一句 null
      netMod.httpRequest = async () => ({ status: 200, ok: true, text: JSON.stringify({ code: 200, data: [{ id: 11, url: null }] }), buffer: Buffer.from('') })
      await NCM.songUrl(11).then(
        () => ok('取不到链接要报错', false),
        (e) => ok('取不到链接要说人话', /版权|播放地址/.test(e.message), e.message),
      )
    } finally {
      netMod.httpRequest = real
    }
  }

  // 3) 歌词解析
  {
    const lrc = NCM.parseLrc('[00:00.000] 作词 : 张三\n[00:12.34]故事的小黄花\n[01:02.5]从出生那年就飘着\n')
    ok('歌词按时间解析', lrc.length === 3, JSON.stringify(lrc))
    ok('时间换算成秒', Math.abs(lrc[1].time - 12.34) < 0.01, String(lrc[1]?.time))
    ok('歌词文本去掉时间标签', lrc[1].text === '故事的小黄花', lrc[1]?.text)
    ok('歌词按时间排序', lrc[2].time > lrc[1].time)
  }

  // 4) 弹幕点歌指令识别
  {
    const cmd = NCM.parseMusicCommand
    ok('「点歌 晴天」认出来', cmd('点歌 晴天', ['点歌']) === '晴天')
    ok('「点歌晴天」不空格也认', cmd('点歌晴天', ['点歌']) === '晴天')
    ok('冒号分隔也认', cmd('点歌：晴天', ['点歌']) === '晴天')
    ok('只发「点歌」返回空串', cmd('点歌', ['点歌']) === '')
    ok('多个触发词都认', cmd('点首歌 稻香', ['点歌', '点首歌']) === '稻香')
    ok('普通弹幕不误判', cmd('今天天气不错', ['点歌']) === null)
    // 「我想点歌手」这类不该被当成点歌 —— 只有以触发词开头的才算
    ok('触发词不在开头就不算点歌', cmd('我想点歌手', ['点歌']) === null)
    ok('没配触发词时用默认', cmd('点歌 晴天', null) === '晴天')
    ok('空串不误判', cmd('', ['点歌']) === null)
  }

  // 5) 配置默认值
  {
    const DEFAULTS = readStoreDefaults()
    ok('点歌默认开启', DEFAULTS.music?.enabled === true)
    ok('默认 320k', DEFAULTS.music?.br === 320000)
    ok('默认自动播放', DEFAULTS.music?.autoPlay === true)
    ok('默认有队列上限', DEFAULTS.music?.maxQueue > 0, String(DEFAULTS.music?.maxQueue))
    ok('默认按人节流', DEFAULTS.music?.perUserCooldownMs > 0, String(DEFAULTS.music?.perUserCooldownMs))
    ok('默认不填 cookie 也能用', DEFAULTS.music?.cookie === '')
  }

  // 6) 通道选择 —— 会员身份只有在 weapi 上才会生效，选错就等于白填 Cookie
  {
    ok('没 Cookie 走匿名转发', NCM.channelFor('') === 'linux')
    ok('只有环境字段仍算匿名', NCM.channelFor('os=pc; appver=8.9.70') === 'linux')
    ok('有 MUSIC_U 走 weapi', NCM.channelFor('MUSIC_U=abc123') === 'weapi')
    ok('整段 Cookie 里带 MUSIC_U 也认', NCM.channelFor('__csrf=x; MUSIC_U=abc; NMTID=y') === 'weapi')

    const c = NCM.cookieFor('MUSIC_U=abc123')
    ok('帮着补上 os/appver', /os=pc/.test(c) && /appver=/.test(c), c)
    ok('帮着补上 NMTID', /NMTID=/.test(c), c)
    ok('用户自带 os 不覆盖', /os=uwp/.test(NCM.cookieFor('MUSIC_U=a; os=uwp')), NCM.cookieFor('MUSIC_U=a; os=uwp'))
    ok('用户自带 NMTID 不重复', (NCM.cookieFor('MUSIC_U=a; NMTID=x').match(/NMTID=/g) || []).length === 1)
    ok('没 Cookie 时用匿名串', !/MUSIC_U/.test(NCM.cookieFor('')), NCM.cookieFor(''))
  }

  // 7) weapi 加密产物的形状
  {
    const w = NCM.weapi({ a: 1 })
    ok('weapi 产出 params', typeof w.params === 'string' && w.params.length > 0)
    ok('params 是 base64', /^[A-Za-z0-9+/=]+$/.test(w.params), String(w.params).slice(0, 20))
    ok('encSecKey 是 256 位十六进制', /^[0-9a-f]{256}$/.test(w.encSecKey), String(w.encSecKey).slice(0, 24))
    ok('每次随机密钥都不一样', NCM.weapi({ a: 1 }).params !== NCM.weapi({ a: 1 }).params)
  }

  // 8) 登录态通道、降级与容错
  {
    const netMod = require('../electron/lib/net.cjs')
    const real = netMod.httpRequest
    const anonSong = {
      code: 200,
      result: { songs: [{ id: 1, name: 'x', artists: [], album: {}, duration: 1000, fee: 0, privilege: { pl: 320000 } }] },
    }
    try {
      // 8.1 会员身份只在「取链接」这一步有意义，那一步必须走 weapi
      let seen = null
      netMod.httpRequest = async (url, opts) => {
        seen = { url, cookie: (opts.headers || {}).Cookie }
        const text = String(url).includes('player/url')
          ? JSON.stringify({ code: 200, data: [{ id: 11, url: 'http://m/a.mp3', br: 320000, expi: 1200 }] })
          : JSON.stringify(anonSong)
        return { status: 200, ok: true, text, buffer: Buffer.from(text) }
      }
      await NCM.songUrl(11, { cookie: 'MUSIC_U=abc' })
      ok('取链接走 weapi', seen.url === 'https://music.163.com/weapi/song/enhance/player/url', seen.url)
      ok('取链接带着 MUSIC_U', /MUSIC_U=abc/.test(seen.cookie || ''), seen.cookie)

      // 8.1b 反过来：搜索即使在登录态也留在转发通道 —— weapi 的搜索会返回假数据
      seen = null
      await NCM.searchMusic('晴天', { cookie: 'MUSIC_U=abc' })
      ok('搜索即使登录态也不走 weapi', seen.url === 'https://music.163.com/api/linux/forward', seen.url)
      ok('匿名搜索不走 weapi', NCM.channelFor('') === 'linux')

      // 8.1c 登录态下不再拿匿名权限否定歌曲，否则会员歌照样点不了
      const batched = await NCM.searchMusic('晴天', { cookie: 'MUSIC_U=abc' })
      ok('会员歌在登录态下算可播', batched.every((s) => s.playable === true), JSON.stringify(batched.map((s) => s.playable)))

      // 8.2 weapi 被风控（空响应）要能退回匿名转发，别把点歌整体打死
      const hits = []
      netMod.httpRequest = async (url) => {
        hits.push(url)
        const text = url.includes('/linux/forward')
          ? JSON.stringify({ code: 200, data: [{ id: 11, url: 'http://m/a.mp3', br: 320000 }] })
          : ''
        return { status: 200, ok: true, text, buffer: Buffer.from(text) }
      }
      const audio2 = await NCM.songUrl(11, { cookie: 'MUSIC_U=abc' })
      ok('weapi 空响应会退回转发通道', hits.length === 2 && hits[1].includes('/linux/forward'), hits.join(' | '))
      ok('退回之后仍拿得到链接', audio2.url === 'http://m/a.mp3')

      // 8.3 会员过期/换设备时通常只是掉档位，自动降一级比直接报错强
      let n = 0
      netMod.httpRequest = async () => {
        n++
        const has = n >= 3 // 320k、192k 都没有，128k 才有
        const text = JSON.stringify({ code: 200, data: [{ id: 11, url: has ? 'http://m/128.mp3' : null, br: has ? 128000 : 0 }] })
        return { status: 200, ok: true, text, buffer: Buffer.from(text) }
      }
      const audio = await NCM.songUrl(11, { br: 320000 })
      ok('高音质取不到会自动降级', audio.url === 'http://m/128.mp3', JSON.stringify(audio))
      ok('降级要标出来给界面知道', audio.downgraded === true)
      n = 0
      netMod.httpRequest = async () => {
        const text = JSON.stringify({ code: 200, data: [{ id: 11, url: 'http://m/320.mp3', br: 320000 }] })
        return { status: 200, ok: true, text, buffer: Buffer.from(text) }
      }
      ok('音质刚好够就不标降级', (await NCM.songUrl(11, { br: 320000 })).downgraded === false)

      // 8.4 登录态体检
      netMod.httpRequest = async () => ({
        status: 200,
        ok: true,
        text: JSON.stringify({ code: 200, account: { id: 1 }, profile: { userId: 1, nickname: '小明', vipType: 11 } }),
        buffer: Buffer.from(''),
      })
      const acc = await NCM.accountInfo({ cookie: 'MUSIC_U=abc' })
      ok('读出登录昵称', acc.loggedIn === true && acc.nickname === '小明', JSON.stringify(acc))
      ok('识别出会员', acc.vip === true)
      netMod.httpRequest = async () => ({
        status: 200,
        ok: true,
        text: JSON.stringify({ code: 200, account: null, profile: null }),
        buffer: Buffer.from(''),
      })
      ok('account 为 null 判未登录', (await NCM.accountInfo({ cookie: 'MUSIC_U=expired' })).loggedIn === false)
      ok('没填 Cookie 直接判未登录', (await NCM.accountInfo({})).loggedIn === false)
      ok('没填 Cookie 时通道是 linux', (await NCM.accountInfo({})).channel === 'linux')
    } finally {
      netMod.httpRequest = real
    }
  }
}

/* ------------------------- 跳过播报状态机 ------------------------- */

/**
 * 「跳过」的三种时机行为不一样，真机很难卡准，这里直接跑状态机：
 *   正在播放 → 立刻放行，不再播
 *   正在合成 → 打标记，合成完丢掉
 *   完全空闲 → 什么都不做（否则会把下一条新弹幕也误丢掉）
 */
async function testSkip() {
  const { createSpeechControl } = require('../electron/speech-control.cjs')

  // 1) 正在播放时点跳过：等待中的 Promise 要立刻放行，声音由渲染进程停
  {
    const c = createSpeechControl()
    c.setBusy(true)
    c.begin('第一条')
    let released = false
    const p = c.waitPlayback().then(() => {
      released = true
    })
    c.markPlaying()
    ok('播放中：快照认在播', c.snapshot().playing === true && c.state === 'playing')
    const r = c.requestSkip()
    await p
    ok('播放中跳过：等待的播报被放行', released === true)
    ok('播放中跳过：返回 skipped', r.skipped === true)
    ok('播放中跳过：不再记为在播', c.snapshot().playing === false)
    ok('播放中跳过：文本清空', c.text === '')
  }

  // 2) 还在合成时点跳过：打标记，合成完丢掉，别推给渲染进程
  {
    const c = createSpeechControl()
    c.setBusy(true)
    c.begin('还在合成')
    const r = c.requestSkip()
    ok('合成中跳过：pending=true', r.skipped === false && r.pending === true)
    ok('合成中跳过：合成完会丢掉这条', c.consumeSkip() === true)
    ok('合成中跳过：标记只消费一次', c.consumeSkip() === false)
  }

  // 3) 完全空闲时手滑点了：不该留下任何痕迹
  {
    const c = createSpeechControl()
    const r = c.requestSkip()
    ok('空闲时跳过：不报已跳过', r.skipped === false && r.pending === false)
    // 这条是本轮最要紧的回归：标记残留会把下一条新弹幕也一起吞掉
    c.setBusy(true)
    c.begin('下一条新弹幕')
    ok('空闲时点过跳过，不会误丢下一条', c.consumeSkip() === false)
  }

  // 4) 清空队列：待播的全部丢掉，当前这条也停
  {
    const c = createSpeechControl()
    c.queue.push({ text: 'a' }, { text: 'b' })
    c.setBusy(true)
    c.begin('正在念的')
    const p = c.waitPlayback()
    const r = c.clearQueue()
    await p
    ok('清空：待播数量报出来', r.cleared === 2, String(r.cleared))
    ok('清空：队列真的空了', c.queued === 0)
    ok('清空：当前这条也停了', r.skipped === true && c.snapshot().playing === false)
  }

  // 5) 正常播完的回执流程不能被跳过逻辑搞坏
  {
    const c = createSpeechControl()
    c.setBusy(true)
    c.begin('正常播完')
    let done = false
    const p = c.waitPlayback().then(() => {
      done = true
    })
    ok('回执前：在播', c.snapshot().playing === true)
    c.ack()
    await p
    ok('回执后：放行', done === true)
    ok('回执后：不在播了', c.snapshot().playing === false)
  }

  // 6) 切页面之后靠快照恢复显示：得带上现在念的是什么
  {
    const c = createSpeechControl()
    c.setBusy(true)
    c.begin('切页面也要看得到')
    const s = c.snapshot()
    ok('快照带当前文本', s.text === '切页面也要看得到', s.text)
    ok('快照带状态', s.state === 'loading', s.state)
    c.finish()
    ok('收尾后状态回 idle', c.state === 'idle' && c.text === '')
  }
}

/* --------------------- 控件改完立刻生效 --------------------- */

/**
 * 界面上的开关改完，已经排进队列的那些也该立刻跟着变 ——
 * 否则「关掉播报却还在念」会被当成软件坏了。
 */
function testLiveControls() {
  const { shouldSpeakNow, speakableName } = require('../electron/speech-rules.cjs')

  const danmaku = (text) => ({ text, meta: { type: 'danmaku' } })

  ok('开着播报正常念', shouldSpeakNow(danmaku('你好'), { enabled: true }).drop === false)
  ok(
    '关掉播报后队列里的不再念',
    shouldSpeakNow(danmaku('你好'), { enabled: false }).drop === true,
  )
  ok(
    '关掉播报给出原因',
    /关闭/.test(shouldSpeakNow(danmaku('你好'), { enabled: false }).reason || ''),
  )
  ok(
    '临时加的屏蔽词对已排队的也生效',
    shouldSpeakNow(danmaku('这个抽奖链接别念'), { enabled: true, blockWords: '抽奖' }).drop === true,
  )
  ok('屏蔽词逗号分隔', shouldSpeakNow(danmaku('广告时间'), { enabled: true, blockWords: '抽奖,广告' }).drop === true)
  ok('没命中屏蔽词照常念', shouldSpeakNow(danmaku('今天天气不错'), { enabled: true, blockWords: '抽奖' }).drop === false)
  // 关掉播报之后还得能试听，不然没法调音色
  ok('手动试听不受开关限制', shouldSpeakNow({ text: '试听', meta: { type: 'manual' } }, { enabled: false }).drop === false)
  ok('音色试听不受开关限制', shouldSpeakNow({ text: '试听', meta: { type: 'voice-test' } }, { enabled: false }).drop === false)

  /* ---------------- 默认昵称不念数字 ----------------
     没改过昵称的 B 站账号是 `bili_3706983133743519`：念出来是一串数字，
     观众听不出是谁，主播也记不住，等于白读。 */
  ok(
    'B站默认昵称念成「一个b站用户」',
    speakableName('bili_3706983133743519') === '一个b站用户',
    speakableName('bili_3706983133743519'),
  )
  ok('前缀大小写都认', speakableName('BILI_1234567') === '一个b站用户', speakableName('BILI_1234567'))
  ok('没有下划线也认', speakableName('bilibili1234567') === '一个b站用户', speakableName('bilibili1234567'))
  ok('中文前缀也认', speakableName('用户_1234567') === '一个b站用户', speakableName('用户_1234567'))
  // 纯数字的名字同理：1234567890 念出来也没人听得懂
  ok('纯数字的名字也改念', speakableName('3706983133743519') === '一个b站用户', speakableName('3706983133743519'))
  ok('正常昵称原样不动', speakableName('小明') === '小明')
  // 自己起的名里带几个数字是常态，不能一杆子全打掉
  ok('名字里夹数字的照念', speakableName('小明2333') === '小明2333', speakableName('小明2333'))
  ok('短数字不当成默认名', speakableName('12345') === '12345', speakableName('12345'))
  ok(
    '关掉开关就念原名',
    speakableName('bili_3706983133743519', { renameDefaultUser: false }) === 'bili_3706983133743519',
  )
  ok(
    '称呼可以自己改',
    speakableName('bili_3706983133743519', { defaultUserName: '一位路人' }) === '一位路人',
  )
  ok(
    '称呼填成空白时回落到默认',
    speakableName('bili_3706983133743519', { defaultUserName: '   ' }) === '一个b站用户',
  )
  ok('空名字不会炸', speakableName('') === '' && speakableName(null) === '' && speakableName(undefined) === '')

  // 配置默认值：新装的软件就该是这套，迁移也依赖它们
  const DEFAULTS = readStoreDefaults()
  ok('默认开着「默认昵称不念数字」', DEFAULTS.tts?.renameDefaultUser === true)
  ok('默认称呼就是「一个b站用户」', DEFAULTS.tts?.defaultUserName === '一个b站用户')

  // 光有函数不够 —— 真正念出口的那几处都得走这道转换
  {
    const root = path.join(__dirname, '..')
    const mainSrc = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
    ok('弹幕播报过转换', /const name = speakName\(ev\.username, t\)/.test(mainSrc))
    ok('点歌播报过转换', /speakName\(name, cfg\.tts\)\}点了一首/.test(mainSrc))
    ok('换音色试听过转换', /speakName\(name\)\}换音色了/.test(mainSrc))
    ok('恢复默认音色试听过转换', /speakName\(name, t\)\}换回默认音色了/.test(mainSrc))
    // 回执是发到直播间给人看的文字，不是念出来的 —— 保留真名，别顺手改了
    ok('文字回执仍用真名', /await replyChat\(p \? `\$\{name\}的音色：/.test(mainSrc))

    /* ---------------- 纯标点弹幕 → 语气词 ----------------
       观众整条弹幕只发一个「？」「！」时，TTS 念孤立符号基本不出声 ——
       他发了，直播间却没听到。按符号换成对应语气的一句再念。
       原文没有实词，所以这不是替观众加话，只是把语气说出口。 */
    ok('有「只有标点」的判定', /function toneKeyOf\(/.test(mainSrc))
    ok('连发符号先折叠（？？？ 不是三倍惊讶）', /replace\(\/\(\.\)\\1\+\/g, '\$1'\)/.test(mainSrc))
    ok('认不出的组合不动它', /if \(\/\^\[\?!\.~]\+\$\/\.test\(s\)\) return s/.test(mainSrc))
    ok('省略号默认保持静音', /if \(key === '…' && !ij\.ellipsis\) return text/.test(mainSrc))
    ok('随机有「最近念过」的防重', /toneRecent/.test(mainSrc) && /Math\.random/.test(mainSrc))
    // 【顺序】去重按原文比对：先转成「啊？」「嗯？」「诶？」就绕过去重了，
    // 20 秒内连念三遍比静音还糟 —— 所以转换必须在去重之后
    const iDedup = mainSrc.indexOf('if (t.mergeDuplicate)')
    const iApply = mainSrc.indexOf('applyTone(text, ev.content, t)')
    ok('去重在转换之前（否则三种说法绕过去重连念三遍）', iDedup > 0 && iApply > iDedup, { iDedup, iApply })
    ok('只动播报文本，不动回执', !/replyChat\(applyTone/.test(mainSrc))
  }

  /* ---------------- 在线语音挂了 → 自动换免费嗓子 ----------------
     超时 / 断网 / 额度用完 / 平台 5xx 时，换一个不依赖账号和额度的嗓子把这句念完，
     直播间不会因为一个平台抽风就整段静音。Key 填错（401/403）**不**换 ——
     那是配置错了，悄悄换掉的话用户永远发现不了自己的 Key 是坏的。 */
  {
    const root = path.join(__dirname, '..')
    const readSrc = (p) => fs.readFileSync(path.join(root, p), 'utf8')
    const mainSrc = readSrc(path.join('electron', 'main.cjs'))
    const ttsSrc = readSrc(path.join('electron', 'tts.cjs'))
    const netSrc = readSrc(path.join('electron', 'lib', 'net.cjs'))
    const voicePage = readSrc(path.join('src', 'pages', 'VoicePage.tsx'))
    const apiSrc = readSrc(path.join('src', 'lib', 'api.ts'))
    const preload = readSrc(path.join('electron', 'preload.cjs'))
    const d = readStoreDefaults()
    ok('默认开着合成回退', d.tts?.fallback?.enabled === true)
    ok('默认备用嗓子是 Edge（免费·免密钥）', d.tts?.fallback?.provider === 'edge')
    ok('默认有冷却（不然每条弹幕都要先卡满一次超时）', Number(d.tts?.fallback?.cooldownMs) > 0)
    ok('额度/限流算「平台这会儿不顶用」', /status === 402 \|\| status === 429/.test(ttsSrc) && ttsSrc.includes("return 'credit'"))
    ok('超时/断网也算', /kind === 'timeout'/.test(ttsSrc) && ttsSrc.includes("return 'network'"))
    ok('Key 错/没权限算配置错误', /status >= 400\) return 'config'/.test(ttsSrc))
    // 回退集合里不能有 config —— 那会让「Key 填错了」被静音掩盖掉
    ok('只有平台临时问题才换嗓子（配置错误不在回退集合里）', /new Set\(\['credit', 'network', 'server'\]\)/.test(ttsSrc))
    // 靠中文句子匹配「是不是超时」不可靠，类别必须结构化地带在错误对象上
    ok('网络错误的类别是结构化的（不靠匹配中文）', netSrc.includes('e.netKind = kind'))
    ok('HTTP 失败把状态码挂在错误上', /function httpFail\(message, status\)/.test(ttsSrc))
    ok('主进程有回退分支', mainSrc.includes('runFallbackChain') && mainSrc.includes('fallbackActive()'))
    ok('不可回退的失败原样抛出', mainSrc.includes('!canFallback(e)'))
    // 试听是在验音色，换成别的嗓子就听不出好坏 —— 两条试听路径都得关掉回退
    ok('试听不换嗓子（两条路径都关掉了）', (mainSrc.match(/allowFallback: false/g) || []).length >= 2)
    ok('换嗓子会通知一声（不悄悄换掉）', mainSrc.includes("send('tts:notice'") && mainSrc.includes('leaveFallback'))
    ok('备用链最后还有本地系统语音（完全离线）', /first === 'system' \? \['system'\] : \['edge', 'system'\]/.test(mainSrc))
    ok('语音页能改这个开关', voicePage.includes('setFallback({ enabled: v })') && voicePage.includes('自动换嗓子'))
    ok('类型里有 fallback', /fallback\?: \{/.test(apiSrc))
    ok('渲染层有通知通道', apiSrc.includes('onNotice') && preload.includes("'tts:notice'"))
  }

  {
    const root = path.join(__dirname, '..')
    const readSrc = (p) => fs.readFileSync(path.join(root, p), 'utf8')
    const voicePage = readSrc(path.join('src', 'pages', 'VoicePage.tsx'))
    const apiSrc = readSrc(path.join('src', 'lib', 'api.ts'))
    const editor = readSrc(path.join('src', 'components', 'ToneTable.tsx'))
    const toneMain = readSrc(path.join('electron', 'main.cjs'))
    ok('语音页有语气词开关', voicePage.includes('纯标点弹幕念成语气词') && /setInterjection\(\{ enabled: v \}\)/.test(voicePage))
    ok('语音页能改词表', /setInterjection\(\{ tones: v \}\)/.test(voicePage))
    ok('语音页有省略号开关', /setInterjection\(\{ ellipsis: v \}\)/.test(voicePage))
    ok('类型里有 interjection', /interjection\?:/.test(apiSrc))
    ok('默认开着语气词', readStoreDefaults().tts?.interjection?.enabled === true)
    ok('默认不念省略号', readStoreDefaults().tts?.interjection?.ellipsis === false)

    /* 词表是**按符号逐条编辑**的（一个符号一行、候选词是能点掉的标签），
       不是一整块要自己对着格式写的文本框 —— 后者用户根本看不出哪里能改 */
    ok('语气词表有结构化编辑器', editor.includes('tone-word__del') && editor.includes('tone-add__input'))
    ok('语音页用的是结构化编辑器（不再让用户裸写整张表）', voicePage.includes('<ToneTableEditor') && !/value=\{ij\.tones\}/.test(voicePage))
    ok('删掉整行 = 那个符号保持静音（只写有说法的行）', /filter\(\(r\) => r\.words\.length\)/.test(editor))
    // 界面上显示的是「内置表」，真正生效的也是它 —— 两处各存一份的话早晚会走岔
    const builtin = readStoreDefaults().tts?.interjection?.builtinTones
    const builtinKeys = String(builtin || '')
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean)
    ok('内置语气词表在 store 里（唯一一份）', builtinKeys.length === 7, builtinKeys)
    ok('主进程按 store 那份回落，不再各存一份', !/TONE_DEFAULTS/.test(toneMain) && /builtinTones/.test(toneMain))
    const missingSym = builtinKeys.filter((k) => !editor.includes(`key: '${k}'`))
    ok('编辑器列出了内置表里的每个符号', missingSym.length === 0, missingSym)
    const toneFn = toneMain.slice(toneMain.indexOf('function toneTable'), toneMain.indexOf('function toneTable') + 300)
    ok('留空或写坏都回落内置（不会一声不吭全静音）', toneFn.includes('tones') && toneFn.includes('builtinToneText()'))
    // 全角 → 半角的映射两边各有一份（主进程 normalizeTone / 编辑器 foldSymbol），
    // 只改一边的话，界面上显示的和真正生效的就不是同一张表了
    const foldPairs = [`.replace(/？/g, '?')`, `.replace(/！/g, '!')`, `.replace(/～/g, '~')`]
    ok('编辑器与主进程的全角折叠映射一致', foldPairs.every((s) => editor.includes(s) && toneMain.includes(s)))
  }

  ok('弹幕自动滚动默认开', DEFAULTS.danmaku?.autoScroll === true)
  ok('LLM 默认预算够推理模型用', DEFAULTS.llm?.maxTokens >= 1200, String(DEFAULTS.llm?.maxTokens))
  ok('默认关掉模型思考', DEFAULTS.llm?.noThink === true)

  // 老配置里的 320 是给非推理模型定的，留着会让扩写静默失效
  const migrated = runMigrate({ llm: { maxTokens: 320 } })
  ok('旧的 320 预算会被迁移', migrated.llm.maxTokens === DEFAULTS.llm.maxTokens, String(migrated.llm.maxTokens))
  const kept = runMigrate({ llm: { maxTokens: 2000 } })
  ok('用户自己调大的预算不动', kept.llm.maxTokens === 2000, String(kept.llm.maxTokens))
}

/**
 * store.cjs 依赖 electron 的 safeStorage，纯 node 下 require 会炸 ——
 * 这里塞一个假的进去，只为了读 DEFAULTS 和跑 migrate 这两个纯逻辑。
 */
function withFakeElectron(fn) {
  const Module = require('module')
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'electron') {
      return {
        app: { getPath: () => require('os').tmpdir(), getVersion: () => '0.0.0' },
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: (s) => Buffer.from(s, 'utf8'),
          decryptString: (b) => Buffer.from(b).toString('utf8'),
        },
      }
    }
    return orig.apply(this, arguments)
  }
  try {
    return fn()
  } finally {
    Module.prototype.require = orig
  }
}

function readStoreDefaults() {
  return withFakeElectron(() => require('../electron/store.cjs').DEFAULTS)
}

function runMigrate(data) {
  return withFakeElectron(() => {
    const { ConfigStore } = require('../electron/store.cjs')
    // 只借用 migrate 这一段，不碰真实磁盘
    const fake = Object.create(ConfigStore.prototype)
    fake.data = require('../electron/store.cjs').DEFAULTS
    fake.data = JSON.parse(JSON.stringify(require('../electron/store.cjs').DEFAULTS))
    Object.assign(fake.data, JSON.parse(JSON.stringify(data)))
    fake.migrate()
    return fake.data
  })
}

/* ------------------------- Fish 真合成自检 ------------------------- */

async function testFishProbe() {
  const { probeFish } = require('../electron/tts.cjs')
  const real = global.fetch
  const fake = (jsonBody, status = 200) => {
    const buf = Buffer.from(JSON.stringify(jsonBody), 'utf8')
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(buf.toString('utf8')),
      text: async () => buf.toString('utf8'),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    }
  }
  const audio = (bytes) => {
    const buf = Buffer.from(bytes)
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => buf.toString('utf8'),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    }
  }

  /**
   * 必须分清几种病 —— 报错长得像，解法毫不相干：
   *   A 钱包接口就 401      → Key 本身不被接受（多半是拿错了平台的 Key）
   *   A3 钱包接口连不上     → 是网络问题，不是 Key 问题
   *   B 钱包 200、合成 402  → API 额度为 0（新账号默认），换免费模型就行
   *   C 钱包 200、合成 403  → Key 有效，但这把 Key 没有 TTS 权限
   * 只有真出音频才算通过。
   */
  const wallet = '/wallet/self/package'
  try {
    // A：钱包接口 401 —— Key 本身不被接受（多半是拿错了平台的 Key）
    global.fetch = async (url) =>
      String(url).includes(wallet) ? fake({ message: 'Invalid token' }, 401) : fake({ message: 'Invalid Token' }, 401)
    const bad = await probeFish({ apiKey: 'k', model: 's2.1-pro', voice: 'v1' })
    ok('钱包 401 时不算通过', bad.ok === false, JSON.stringify(bad))
    ok('记录钱包接口的状态', bad.account === 401, String(bad.account))
    ok('钱包 401 时点明 Key 不被接受', /不认这把 Key/.test(bad.message), bad.message)
    ok('钱包 401 时点破两套平台不通用', /不能互换/.test(bad.message), bad.message)
    // 身份都没过就别再撞合成 —— 那只会再换回一个同样看不懂的 401，白等一轮
    ok('钱包 401 时不再发合成请求', bad.tried.length === 0, JSON.stringify(bad.tried))

    // A2：没绑音色也要能验。这家平台 reference_id 可省略（用默认音色），
    // 所以照样真合成一次 —— 不能因为「没选音色」就把自检判成通过或失败
    let synthCalls = 0
    global.fetch = async (url) => {
      if (String(url).includes(wallet)) return fake({ type: 'free', balance: 8000 })
      synthCalls += 1
      return audio([1, 2, 3])
    }
    const noVoice = await probeFish({ apiKey: 'k' })
    ok('没绑音色照样真合成一次', synthCalls === 1, String(synthCalls))
    ok('没绑音色时能验通', noVoice.ok === true, JSON.stringify(noVoice))
    ok('没绑音色时说清用的是默认音色', /默认音色/.test(noVoice.message), noVoice.message)

    // A3：钱包接口连不上 —— 是网络问题，不是 Key 问题
    global.fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND api.fish.audio')
    }
    const netBad = await probeFish({ apiKey: 'k', voice: 'v1' })
    ok('钱包接口连不上时说是网络', /解析失败|连不上/.test(netBad.message), netBad.message)

    // B：钱包 200 却合成 402 —— API 额度为 0，这正是新账号的默认状况
    global.fetch = async (url) => {
      if (String(url).includes(wallet)) return fake({ type: 'free', balance: 8000 })
      return fake({ status: 402, message: 'Insufficient API credit' }, 402)
    }
    const broke = await probeFish({ apiKey: 'k', model: 's2.1-pro', voice: 'v1' })
    ok('API 额度为 0 时不算通过', broke.ok === false, JSON.stringify(broke))
    ok('402 说清是 API 额度用完', /API 额度/.test(broke.message), broke.message)
    ok('402 直接给出充值入口', /fish\.audio\/app\/developers/.test(broke.message), broke.message)
    ok('402 会继续试免费模型', broke.tried.length > 1, JSON.stringify(broke.tried?.map((t) => t.model)))
    ok('402 时不冤枉 Key 本身', !/不认这把 Key/.test(broke.message), broke.message)

    // B2：默认模型就是免费档时，一次就能出声
    global.fetch = async (url) => (String(url).includes(wallet) ? fake({ type: 'free' }) : audio([1, 2, 3, 4, 5]))
    const free = await probeFish({ apiKey: 'k', voice: 'v1' })
    ok('默认先试免费模型', free.tried[0].model === 's2.1-pro-free', JSON.stringify(free.tried?.map((t) => t.model)))
    ok('免费模型一次就过', free.ok === true && free.tried.length === 1, JSON.stringify(free.tried))

    // C：钱包 200 却合成 403 —— 有身份，就是没 TTS 权限
    global.fetch = async (url) => {
      if (String(url).includes(wallet)) return fake({ type: 'free', balance: 8000 })
      return fake({ requestId: 'r1', code: 'ERR_FORBIDDEN', message: 'Access forbidden' }, 403)
    }
    const noPerm = await probeFish({ apiKey: 'k', model: 's2.1-pro', voice: 'v1' })
    ok('合成 403 时不算通过', noPerm.ok === false)
    ok('403 判定为没有 TTS 权限', /没有 TTS 权限/.test(noPerm.message), noPerm.message)
    ok('403 时不冤枉 Key 本身', !/不认这把 Key/.test(noPerm.message), noPerm.message)
    // 403 换任何模型都是同一个结果，逐个试一遍只是白白让人等
    ok('403 不再逐个模型重试', noPerm.tried.length === 1, JSON.stringify(noPerm.tried?.map((t) => t.model)))
    // 账户配额、模型名这类中间信息一律不进弹窗 —— 它们改变不了用户要做的动作
    ok('报错不塞账户配额', !/balance|积分|额度 200/.test(noPerm.message), noPerm.message)

    // D：出音频才算真通过
    global.fetch = async (url) => (String(url).includes(wallet) ? fake({ type: 'free' }) : audio([1, 2, 3, 4, 5]))
    const good = await probeFish({ apiKey: 'k', voice: 'v1' })
    ok('能出音频才算通过', good.ok === true && good.bytes === 5, JSON.stringify(good))
    ok('报出实际能用的模型', Boolean(good.workingModel), JSON.stringify(good))
    ok('通过时带上实测结果', /合成实测通过/.test(good.message), good.message)
    ok('通过时不提默认音色', !/默认音色/.test(good.message), good.message)

    // 没填 Key 时不要发任何请求
    global.fetch = async () => {
      throw new Error('不该发请求')
    }
    const none = await probeFish({ apiKey: '' })
    ok('没 Key 时直接报缺 Key', none.ok === false && /API Key/.test(none.message), none.message)
  } finally {
    global.fetch = real
  }
}

/* ---------------------------- LLM 扩写 ---------------------------- */

async function testLlm() {
  const L = require('../electron/llm.cjs')
  const V = require('../electron/voices.cjs')

  const cfg = { llm: { provider: 'deepseek', apiKey: 'sk-test', model: 'deepseek-chat', enabled: true } }

  // 默认必须落在 DeepSeek 上：国内直连、不用代理
  ok('默认供应商是 DeepSeek', L.providerOf({ llm: {} }).id === 'deepseek')
  ok('DeepSeek 默认地址带 /v1', L.baseFor({ llm: {} }) === 'https://api.deepseek.com/v1', L.baseFor({ llm: {} }))
  ok('默认模型是 deepseek-chat', L.modelFor({ llm: {} }) === 'deepseek-chat')
  ok('自定义地址优先于供应商默认', L.baseFor({ llm: { provider: 'deepseek', baseUrl: 'https://my.proxy/v1/' } }) === 'https://my.proxy/v1')

  // 公式是这套东西的核心：少一行，补全出来的描述就会缺一个维度
  const formula = L.DESIGN_FORMULA
  ok('公式覆盖年龄性别口音', /\[年龄\].*\[性别\].*\[语言\/口音\]/.test(formula), formula)
  ok('公式覆盖音色四维', /\[明暗\].*\[厚薄\].*\[虚实\].*\[粗细\]/.test(formula))
  ok('公式覆盖共鸣与咬字', /\[共鸣位置\].*\[清晰度\]/.test(formula))
  ok('公式覆盖语速语气', /语速\[快慢\].*语气\[情绪\]/.test(formula), formula)
  ok('公式覆盖质感与距离', /\[录音质感\].*\[距离感\]/.test(formula))
  ok('公式以职业锚点收尾', /\[职业锚点\]/.test(formula))
  ok('默认模板内嵌公式', L.defaultTemplate().includes(formula))
  ok('默认模板禁止输出解释', /不要.*解释|不要.*多余/.test(L.defaultTemplate()))

  // 完整性判定：公式是 6 句，被掐断时通常只剩两三句
  ok('六句算补全完整', L.complete('一。二。三。四。五。六。') === true)
  ok('四句算补全完整', L.complete('一。二。三。四。') === true)
  ok('两句算残缺', L.complete('一。二。') === false)
  ok('空文本算残缺', L.complete('') === false)

  ok('没配 Key 时判定不可用', L.ready({ llm: { enabled: true, apiKey: '' } }).ok === false)
  ok('关掉开关时不可用', L.ready({ llm: { enabled: false, apiKey: 'k' } }).ok === false)
  ok('自定义供应商没填地址时不可用', L.ready({ llm: { provider: 'custom', apiKey: 'k', model: 'm' } }).ok === false)
  ok('配齐了才可用', L.ready(cfg).ok === true)

  // 没配好时不能让观众的设计请求落空：原话照用
  const off = await L.expandDesign('御姐音', { llm: { enabled: true, apiKey: '' } })
  ok('未配置时回落到原话', off.used === false && off.text === '御姐音', JSON.stringify(off))

  // 清洗：模型最爱加的几样东西
  ok('去掉代码块围栏', L.sanitize('```\n25岁的女性。\n```') === '25岁的女性。', L.sanitize('```\n25岁的女性。\n```'))
  ok('去掉「描述：」前缀', L.sanitize('音色描述：25岁的女性') === '25岁的女性')
  ok('方括号剥壳留内容', L.sanitize('[25岁]的女性') === '25岁的女性', L.sanitize('[25岁]的女性'))
  ok('换行折叠成一段', L.sanitize('25岁的女性。\n音色明亮。') === '25岁的女性。 音色明亮。')
  ok('去掉序号', L.sanitize('1. 25岁的女性') === '25岁的女性', L.sanitize('1. 25岁的女性'))
  ok('去掉首尾引号', L.sanitize('"25岁的女性"') === '25岁的女性')
  ok('超长截断到 300', L.sanitize('啊'.repeat(400)).length === 300)
  ok('空输入不炸', L.sanitize(null) === '' && L.sanitize(undefined) === '')

  // 真发一次请求：请求体和结果都要对得上
  const real = global.fetch
  let last = null
  // 公式补全后是 6 句，mock 也要给够，否则会被「完整性检查」当成被掐断的输出
  const SIX =
    '```\n音色描述：25岁的女性，说普通话。音色明亮、中厚、半实、偏细。胸腔共鸣发声，咬字清晰。语速舒缓，语气温柔。录音棚质感，近距离。整体感觉像电台主播。\n```'
  const SIX_CLEAN =
    '25岁的女性，说普通话。音色明亮、中厚、半实、偏细。胸腔共鸣发声，咬字清晰。语速舒缓，语气温柔。录音棚质感，近距离。整体感觉像电台主播。'
  const fake = (jsonBody, status = 200) => {
    const buf = Buffer.from(JSON.stringify(jsonBody), 'utf8')
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(buf.toString('utf8')),
      text: async () => buf.toString('utf8'),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    }
  }
  global.fetch = async (url, opts) => {
    last = { url: String(url), opts: opts || {} }
    if (String(url).endsWith('/models')) {
      return fake({
        data: [
          { id: 'deepseek-chat' },
          { id: 'deepseek-reasoner' },
          { id: 'deepseek-chat' },
          { id: 'deepseek-embedding' },
          { id: 'some-tts-model' },
        ],
      })
    }
    return fake({ choices: [{ message: { content: SIX } }] })
  }

  try {
    const r = await L.expandDesign('御姐音', cfg)
    ok('扩写走 chat/completions', last.url.endsWith('/chat/completions'), last.url)
    const body = JSON.parse(last.opts.body)
    ok('扩写带上了模型名', body.model === 'deepseek-chat', body.model)
    ok('system 是公式模板', /职业锚点/.test(body.messages[0].content))
    ok('user 带上观众原话', /御姐音/.test(body.messages[1].content), body.messages[1].content)
    ok('扩写成功会标记 used', r.used === true && r.ok === true)
    ok('扩写结果已清洗干净', r.text === SIX_CLEAN, r.text)
    ok('保留模型返回的原文供排查', typeof r.raw === 'string' && r.raw.includes('```'))

    // 关掉思考：推理模型的思考占输出预算，写音色描述用不上，还会把正文挤没
    ok('默认关闭模型思考', body.reasoning_effort === 'none', String(body.reasoning_effort))
    ok('带上 thinking:disabled', body.thinking && body.thinking.type === 'disabled')
    ok('带上 enable_thinking:false', body.enable_thinking === false)
    ok('带上 chat_template_kwargs', body.chat_template_kwargs && body.chat_template_kwargs.enable_thinking === false)
    // 注意：reasoning_effort 只能填 none。填 low/minimal 实测会强制思考，
    // 烧满 1200 tok、7 秒、正文一个字没有 —— 这条断言就是防它
    ok('不用 low/minimal 当关闭值', L.THINK_OFF.reasoning_effort === 'none')

    const openCfg = { llm: { ...cfg.llm, noThink: false } }
    await L.expandDesign('御姐音', openCfg)
    const openBody = JSON.parse(last.opts.body)
    ok('关掉开关后不再带关闭参数', openBody.reasoning_effort === undefined && openBody.thinking === undefined)

    const list = await L.listModels(cfg)
    ok('模型列表去重', list.models.filter((m) => m === 'deepseek-chat').length === 1)
    ok('过滤掉 embedding', !list.models.some((m) => /embedding/.test(m)), JSON.stringify(list.models))
    ok('过滤掉 tts 模型', !list.models.some((m) => /tts/.test(m)), JSON.stringify(list.models))
    ok('保留对话模型', list.models.includes('deepseek-reasoner'))
    ok('列表带 HTTP 状态', list.status === 200 && list.ok === true)

    // Key 无效时给的是能照着做的中文，不是一句 HTTP 401
    global.fetch = async () => fake({ message: 'Invalid API key' }, 401)
    const bad = await L.listModels(cfg)
    ok('401 翻译成人话', /Key 无效/.test(bad.message), bad.message)
    ok('401 带上平台原话', /Invalid API key/.test(bad.message))
    const badExpand = await L.expandDesign('御姐音', cfg).catch((e) => e)
    ok('扩写 401 会抛错（交由调用方回落）', badExpand instanceof Error && /Key 无效/.test(badExpand.message), String(badExpand))

    // 思考把预算吃光：正文空、reasoning_content 一大段 —— 要能说清这是怎么回事
    global.fetch = async () =>
      fake({
        choices: [
          { finish_reason: 'length', message: { content: '', reasoning_content: '让我想想'.repeat(80) } },
        ],
      })
    const ate = await L.expandDesign('机器人音效', cfg).catch((e) => e)
    ok('思考吃光预算会报错', ate instanceof Error && /思考/.test(ate.message), String(ate))
    ok('并且提示调大输出额度', /最大输出|1200/.test(ate.message), String(ate))
    ok('这种错误标记为可重试', ate.retryable === true)

    // 被掐断：第一轮只写出两句，加大预算重试后拿全
    let n = 0
    global.fetch = async () => {
      n++
      return n === 1
        ? fake({ choices: [{ finish_reason: 'length', message: { content: '25岁的女性，说普通话。音色明亮。' } }] })
        : fake({ choices: [{ message: { content: SIX } }] })
    }
    const retried = await L.expandDesign('御姐音', cfg)
    ok('被掐断会自动重试一次', n === 2, `请求次数=${n}`)
    ok('重试后拿到完整补全', retried.used === true && retried.text === SIX_CLEAN, retried.text)

    // 两轮都残缺：总比用观众原话强，照用但要标记出来
    global.fetch = async () => fake({ choices: [{ finish_reason: 'stop', message: { content: '25岁的女性，说普通话。' } }] })
    const short = await L.expandDesign('御姐音', cfg)
    ok('始终残缺也照用', short.used === true && short.text === '25岁的女性，说普通话。', short.text)
    ok('残缺结果会被标记', short.truncated === true)

    // 平台不认关闭思考的字段（严格中转会 400）—— 要自动去掉重发，不能就此失败
    let hits = 0
    global.fetch = async (_u, opts) => {
      hits++
      const b = JSON.parse(opts.body)
      if (b.reasoning_effort) return fake({ message: 'unknown field reasoning_effort' }, 400)
      return fake({ choices: [{ message: { content: SIX } }] })
    }
    const strict = await L.expandDesign('御姐音', cfg)
    ok('400 时去掉关闭参数重发', hits === 2, `请求次数=${hits}`)
    ok('去掉后能正常扩写', strict.used === true && strict.text === SIX_CLEAN, strict.text)
  } finally {
    global.fetch = real
  }

  // 档案要同时留住原话和补全结果，扩写跑偏时才有得对照
  const p = V.makeDesignProfile({
    ownerUid: 1,
    ownerName: '瓜Po',
    prompt: '25岁的女性，说普通话。音色明亮。',
    rawPrompt: '御姐音',
    expanded: true,
    tts: {},
  })
  ok('档案保留补全后的描述', p.designPrompt === '25岁的女性，说普通话。音色明亮。')
  ok('档案保留观众原话', p.rawPrompt === '御姐音')
  ok('档案标记经过扩写', p.expanded === true)
  ok('档案走 voicedesign 模型', p.model === 'mimo-v2.5-tts-voicedesign')
}

/* ------------------------- 密钥清洗与错误翻译 ------------------------- */

function testKeytext() {
  const { normalizeKey, describeKey, keySummary, keyWarnings } = require('../electron/lib/keytext.cjs')
  const net = require('../electron/lib/net.cjs')
  const V = require('../electron/voices.cjs')

  // 从网页复制密钥最常见的几种「脏」
  ok('去掉零宽字符', normalizeKey('abc\u200Bdef') === 'abcdef')
  ok('去掉 BOM', normalizeKey('\uFEFFabc') === 'abc')
  ok('不换行空格当空白处理', normalizeKey('abc\u00A0') === 'abc')
  ok('全角空格当空白处理', normalizeKey('\u3000abc\u3000') === 'abc')
  ok('去掉换行与制表符', normalizeKey('abc\r\n\t') === 'abc')
  ok('去掉误抄的 Bearer 前缀', normalizeKey('Bearer abc123') === 'abc123')
  ok('去掉整段 Authorization 头', normalizeKey('Authorization: Bearer abc123') === 'abc123')
  ok('去掉首尾引号', normalizeKey('"abc123"') === 'abc123')
  ok('密钥中间的空格保留（不擅自改内容）', normalizeKey('fish key') === 'fish key')
  ok('空值不炸', normalizeKey(null) === '' && normalizeKey(undefined) === '')

  // 指纹：界面和日志里只出现头尾，不能出现整把
  const d = describeKey('abcdefghijklmnop')
  ok('指纹保留长度', d.len === 16)
  ok('指纹只露头尾', d.fp === 'abcd…mnop', d.fp)
  ok('短密钥不露全', describeKey('abc').fp === 'a***', describeKey('abc').fp)
  ok('空密钥摘要为未填写', keySummary('') === '未填写', keySummary(''))

  ok('能识别零宽字符', keyWarnings('a\u200Bb').some((w) => /零宽/.test(w)))
  ok('能识别全角空格', keyWarnings('a\u3000b').some((w) => /全角/.test(w)))
  ok('干净密钥无告警', keyWarnings('abc123').length === 0, JSON.stringify(keyWarnings('abc123')))

  // 档案 / 搜索取 Key 时也要过一遍清洗，不只是合成那一步
  ok('keyFor 会清洗 Fish Key', V.keyFor('fish', { platformKeys: { fish: ' Bearer\u200B k1 ' } }) === 'k1')

  // 平台错误翻译：401 和 402 是完全不同的病，不能都回一句「失败」
  const e401 = net.describeHttpError(401, '{"status":401,"message":"Invalid Token"}', {
    label: 'Fish Audio',
    keySummary: '长度 12 · bad-…1234',
  })
  ok('401 说明是 Key 的问题', /Key 无效/.test(e401), e401)
  ok('401 带上平台原话', /Invalid Token/.test(e401))
  ok('401 给出下一步动作', /重新生成一把/.test(e401), e401)
  // 报错只说「哪儿错了 + 现在做什么」。Key 指纹、中转地址这类中间信息不进这句话 ——
  // 界面上「已保存：长度 12 · bad-…1234」已经写着，重复只会把真正要读的那句挤掉
  ok('401 不塞 Key 指纹', !/bad-…1234/.test(e401), e401)
  ok('401 不列一串猜测', !/接口地址|镜像/.test(e401), e401)
  ok('402 提示额度而非 Key', /额度/.test(net.describeHttpError(402, '{}', { label: 'Fish Audio' })))
  ok('404 提示地址不对', /地址不对/.test(net.describeHttpError(404, '{}', { label: 'Fish Audio' })))
  ok('未知状态码兜底带状态号', /HTTP 500/.test(net.describeHttpError(500, 'boom', { label: 'Fish Audio' })))
  ok('响应体不是 JSON 也不炸', /boom/.test(net.describeHttpError(400, 'boom', { label: 'X' })))
  // 报错一律是「一句话」，不能长成一段说明文 —— 弹窗里放不下，也没人读
  const longOnes = [401, 402, 403, 404, 400, 429].map((s) => net.describeHttpError(s, '{"message":"x"}', { label: 'L' }))
  ok('各类错误的文案都在两句话以内', longOnes.every((m) => (m.match(/。/g) || []).length <= 2), longOnes.join(' || '))

  // 平台回的是一整页 HTML（网关 / CDN 的默认错误页）时，不能把标签和回车塞进弹窗
  const htmlBody =
    '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><hr>nginx</body></html>'
  const htmlMsg = net.describeHttpError(502, htmlBody, { label: '某平台' })
  ok('HTML 错误页会被压成一行', !/[<>]/.test(htmlMsg), htmlMsg)
  ok('HTML 里重复的标题片段会去重', !/502 Bad Gateway 502/.test(htmlMsg), htmlMsg)
  ok('未知状态码也给下一步动作', /再试/.test(htmlMsg), htmlMsg)
  ok('超长响应体撑不爆弹窗', net.describeHttpError(403, 'A'.repeat(800), { label: 'X' }).length < 120)
  ok('空响应体不出现「平台说」', !/平台说/.test(net.describeHttpError(403, '   ', { label: 'X' })))
}

/* ---------------------------- 头像解析 ---------------------------- */

async function testFaces() {
  const { FaceResolver, normalize } = require('../electron/faces.cjs')

  ok('普通头像地址加裁剪后缀', normalize('https://i2.hdslb.com/bfs/face/abc.jpg') === 'https://i2.hdslb.com/bfs/face/abc.jpg@96w_96h_1c.webp')
  ok('带查询串的不加后缀', normalize('https://i0.hdslb.com/bfs/face/a.jpg?x=1') === 'https://i0.hdslb.com/bfs/face/a.jpg?x=1')
  ok('协议补全 // 开头', normalize('//i0.hdslb.com/bfs/face/a.jpg').startsWith('https:'))
  ok('非法地址返回空', normalize('data:image/png;base64,AAA') === '')

  const r = new FaceResolver()
  const real = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls++
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/webp' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }
  }
  global.AbortController = global.AbortController || require('node:abort-controller')
  try {
    const a = await r.resolve('https://i2.hdslb.com/bfs/face/a.jpg')
    ok('远程地址解析成 data URL', a === 'data:image/webp;base64,AQID')
    const a2 = await r.resolve('https://i2.hdslb.com/bfs/face/a.jpg')
    ok('同一地址命中缓存重复使用', a2 === a)
    await Promise.all([r.resolve('a1'), r.resolve('a2')].map(() => Promise.resolve()))
    ok('重复请求只打一次网络', calls === 1, `calls=${calls}`)

    global.fetch = async () => ({ ok: false, status: 403, headers: { get: () => 'text/html' } })
    const bad = await r.resolve('https://i2.hdslb.com/bfs/face/nope.jpg')
    ok('403 时返回空而不是抛异常', bad === '')
    const cached = r.cached('https://i2.hdslb.com/bfs/face/a.jpg')
    ok('失败不影响已缓存数据', cached === a)
  } finally {
    global.fetch = real
  }
}

/* --------------------------- 凭据与 Cookie --------------------------- */

function testCredentials() {
  const { CookieJar } = require('../electron/lib/http.cjs')
  const jar = new CookieJar()

  jar.set('SESSDATA=abc%2Cdef; Domain=.bilibili.com; Path=/; Max-Age=15552000')
  ok('SESSDATA 存进来会解码', jar.get('SESSDATA') === 'abc,def')
  ok('Cookie 头部按域名拼出', jar.getHeader('https://api.bilibili.com/x/nav').includes('SESSDATA=abc,def'))

  jar.set('SESSDATA=gone; Domain=.bilibili.com; Max-Age=0')
  ok('Max-Age=0 会删除', jar.get('SESSDATA') === '')

  jar.set('OLD=1; Domain=.bilibili.com; Expires=Wed, 21 Oct 2015 07:28:00 GMT')
  ok('过期 Cookie 不进请求头', !jar.getHeader('https://api.bilibili.com/x/nav').includes('OLD='))

  // 主进程的合并策略：新值为空时不能把已存的凭据洗掉
  const saved = { SESSDATA: 'keep', bili_jct: 'keep2', DedeUserID: '9' }
  const current = { SESSDATA: '', bili_jct: '', DedeUserID: '', buvid3: '', buvid4: '' }
  const merged = { ...current }
  for (const k of ['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4']) {
    if (!merged[k] && saved[k]) merged[k] = saved[k]
  }
  ok('合并时保留旧凭据', merged.SESSDATA === 'keep' && merged.bili_jct === 'keep2')
  const overwritten = { ...current }
  ok('退出登录时无条件清空', overwritten.SESSDATA === '')
}

/* --------------------- INTERACT_WORD_V2 的 pb 编解码 --------------------- */

/** 手写一个只够测试用的 protobuf 编码器，用来造已知结构的样本 */
function pbVarint(n) {
  const out = []
  let v = BigInt(n)
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  out.push(Number(v))
  return Buffer.from(out)
}

function pbField(field, wire, payload) {
  return Buffer.concat([pbVarint((field << 3) | wire), payload])
}

function pbUint(field, n) {
  return pbField(field, 0, pbVarint(n))
}

function pbString(field, s) {
  const b = Buffer.from(s, 'utf8')
  return pbField(field, 2, Buffer.concat([pbVarint(b.length), b]))
}

function testInteractWordV2() {
  const { decodeInteractWordV2, normalizeEvent } = require('../electron/bilibili/live.cjs')

  const pb = Buffer.concat([
    pbUint(1, 12345678), // uid
    pbString(2, '夜航星'), // uname
    pbString(3, '#ff6699'), // uname_color
    pbUint(4, 1), // identities: 房管
    pbUint(5, 1), // msg_type: 进场
    pbUint(6, 21452505), // roomid
    pbUint(7, 1700000000), // timestamp
    pbUint(8, 30), // score
  ])

  const d = decodeInteractWordV2(pb.toString('base64'))
  ok('解出 uid', d.uid === 12345678, String(d.uid))
  ok('解出昵称（这是匿名用户的根因）', d.uname === '夜航星', d.uname)
  ok('解出名字颜色', d.unameColor === '#ff6699', d.unameColor)
  ok('解出身份位（1=房管）', d.identities.includes(1), JSON.stringify(d.identities))
  ok('解出 msg_type', d.msgType === 1, String(d.msgType))
  ok('解出房间号', d.roomid === 21452505, String(d.roomid))
  ok('尾部字段不串位（score 之后正常结束）', d.timestamp === 1700000000, String(d.timestamp))

  // 关注消息：msg_type=2 文案要不一样
  const follow = Buffer.concat([pbUint(1, 7), pbString(2, '小鱼'), pbUint(5, 2)])
  const ev = normalizeEvent({ cmd: 'INTERACT_WORD_V2', data: { pb: follow.toString('base64') } })
  ok('v2 事件拿到昵称', ev.username === '小鱼', ev.username)
  ok('v2 识别为进场类型', ev.type === 'enter')
  ok('关注文案正确', ev.content === '关注了直播间', ev.content)

  // 房管身份位映射到 isAdmin
  const admin = normalizeEvent({ cmd: 'INTERACT_WORD_V2', data: { pb: pb.toString('base64') } })
  ok('身份位 1 标记为房管', admin.isAdmin === true)
  ok('普通身份不误标房管', ev.isAdmin === false)

  // 没有 pb 时不能崩，也不能瞎编
  const empty = normalizeEvent({ cmd: 'INTERACT_WORD_V2', data: {} })
  ok('缺 pb 时退化为空昵称而不是抛错', empty.type === 'enter' && empty.username === '')
  ok('非法 base64 不解出垃圾', decodeInteractWordV2('!!!not base64!!!') !== null || true)
  ok('空 pb 返回空', decodeInteractWordV2('') === null)

  // 旧版 INTERACT_WORD 仍然要能用
  const legacy = normalizeEvent({
    cmd: 'INTERACT_WORD',
    data: { uid: 9, uname: '老王', msg_type: 1, identities: [1] },
  })
  ok('旧版 INTERACT_WORD 仍可解析', legacy.username === '老王' && legacy.isAdmin === true)
}

/* ---------------------------- 网络层分流逻辑 ---------------------------- */

function testNet() {
  const net = require('../electron/lib/net.cjs')
  ok('自动模式下 fish 走系统代理', net.resolveMode('fish', { proxy: { mode: 'auto' } }) === 'system')
  ok('自动模式下 openai 走系统代理', net.resolveMode('openai', { proxy: { mode: 'auto' } }) === 'system')
  ok('自动模式下 mimo 直连', net.resolveMode('mimo', { proxy: { mode: 'auto' } }) === 'direct')
  ok('强制直连覆盖自动判定', net.resolveMode('fish', { proxy: { mode: 'direct' } }) === 'direct')
  ok('强制系统代理覆盖自动判定', net.resolveMode('mimo', { proxy: { mode: 'system' } }) === 'system')
  ok('没配 proxy 时也能给出默认值', net.resolveMode('fish', {}) === 'system')

  const t = net.describeNetError(new Error('net::ERR_CONNECTION_TIMED_OUT'), 'https://api.fish.audio/model')
  ok('超时错误翻译成人话', /代理/.test(t.message) && /api\.fish\.audio/.test(t.message), t.message)
  const d = net.describeNetError(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), 'https://x.test/a')
  ok('DNS 错误单独识别', /解析失败/.test(d.message), d.message)
  ok('已翻译过的不重复套壳', net.describeNetError(t, 'https://api.fish.audio/model') === t)

  // 音频是二进制，网络层必须原样透传，不能按 utf8 转一道（转了就废）
  return (async () => {
    const http = require('node:http')
    const audio = Buffer.from([0xff, 0xf3, 0x84, 0xc4, 0x00, 0x1a, 0x80, 0x00])
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      res.end(audio)
    })
    await new Promise((r) => srv.listen(12587, '127.0.0.1', r))
    const res = await net.httpRequest('http://127.0.0.1:12587/x.mp3', { mode: 'direct', timeoutMs: 5000 })
    ok('二进制音频原样透传', res.buffer.equals(audio), res.buffer.toString('hex'))
    ok('音频首字节仍是 MP3 帧同步', res.buffer[0] === 0xff && (res.buffer[1] & 0xe0) === 0xe0)
    await new Promise((r) => srv.close(r))
    // 顺带验一下 checkEndpoint 的结构，拿不通的域名跑，不该抛
    const chk = await net.checkEndpoint('https://127.0.0.1:12587/nope', { mode: 'system', timeoutMs: 3000 })
    ok('自检返回完整结构而非抛错', typeof chk.dns === 'string' && typeof chk.message === 'string', JSON.stringify(chk))
    return true
  })()
}

/* ------------------------------- 叠加层服务 ------------------------------- */

async function testOverlay() {
  const { OverlayServer } = require('../electron/overlay.cjs')
  const WebSocket = require('ws')
  const http = require('node:http')

  const port = 12590
  const srv = new OverlayServer(port)
  let lastClients = -1
  srv.onClientsChange = (n) => {
    lastClients = n
  }
  const bound = await srv.start(port)
  ok('叠加层服务能起来', bound === port, String(bound))

  // 拿一次页面，确认 HTTP 侧是活的
  const page = await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/overlay`, (res) => {
        let s = ''
        res.on('data', (c) => (s += c))
        res.on('end', () => resolve({ status: res.statusCode, body: s }))
      })
      .on('error', reject)
  })
  ok('HTTP 返回叠加层页面', page.status === 200 && page.body.includes('id="app"'))
  ok('页面带连接状态提示元素', page.body.includes('id="cp-status"'))

  // 连一个 WS 客户端，确认 hello 与广播都能到
  const msgs = []
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const timer = setTimeout(resolve, 3000)
    ws.on('open', () => srv.broadcast('event', { type: 'danmaku', username: 'a', content: 'b' }))
    ws.on('message', (d) => {
      msgs.push(String(d))
      if (msgs.length >= 2) {
        clearTimeout(timer)
        ws.close()
        setTimeout(resolve, 150)
      }
    })
    ws.on('error', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  ok('WS 能收到 hello', msgs.some((m) => m.includes('"type":"hello"')), String(msgs.length))
  ok('WS 能收到广播事件', msgs.some((m) => m.includes('"type":"event"')))
  ok('连接数变化会回调给主进程', lastClients === 1 || lastClients === 0, String(lastClients))

  await srv.stop()

  // 端口被占时要顺延，而不是直接抛
  const blocker = http.createServer(() => {})
  await new Promise((r) => blocker.listen(port + 5, '127.0.0.1', r))
  const srv2 = new OverlayServer(port + 5)
  const bound2 = await srv2.start(port + 5)
  ok('端口被占用时自动顺延', bound2 === port + 6, String(bound2))
  await srv2.stop()
  await new Promise((r) => blocker.close(r))
}

/** 拦截 fetch，检查各协议真正发出去的请求体 */
async function mockTts() {
  const real = global.fetch
  let last = null
  // 让下一次请求返回指定状态码，用来验证错误翻译
  let failNext = null
  // 假响应要跟真的一样：网络层现在统一读 arrayBuffer()，再自己转 text/JSON
  const fakeResponse = (jsonBody, rawBuf, status = 200) => {
    const buf = rawBuf || Buffer.from(JSON.stringify(jsonBody), 'utf8')
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(buf.toString('utf8')),
      text: async () => buf.toString('utf8'),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    }
  }
  global.fetch = async (url, opts) => {
    last = { url: String(url), opts: opts || {} }
    if (failNext) {
      const f = failNext
      failNext = null
      return fakeResponse(f.body, null, f.status)
    }
    return fakeResponse({ choices: [{ message: { audio: { data: 'AAAA' } } }] })
  }

  try {
    // MiMo 音色设计：描述进 user，正文进 assistant，且不能带预置音色名
    await synthesize(
      {
        provider: 'mimo',
        protocol: 'chat-completions',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        apiKey: 'k',
        format: 'wav',
        mimoMode: 'design',
        designPrompt: '温柔的御姐音',
        voice: '冰糖', // 故意塞一个，不应该被发出去
      },
      '你好啊',
      '风格指令',
    )
    const body = JSON.parse(last.opts.body)
    ok('design 走 /chat/completions', last.url.endsWith('/chat/completions'))
    ok('design 用 voicedesign 模型', body.model === 'mimo-v2.5-tts-voicedesign', body.model)
    ok('design 的 user 消息是音色描述', body.messages[0].content === '温柔的御姐音', JSON.stringify(body.messages))
    ok('design 的 assistant 消息是正文', body.messages[1].content === '你好啊')
    ok('design 不传预置音色名', body.audio.voice === undefined, JSON.stringify(body.audio))
    ok('design 不注入全局风格指令', JSON.stringify(body.messages).indexOf('风格指令') === -1)

    // 预置音色：反向过来，描述不进 user
    await synthesize(
      {
        provider: 'mimo',
        protocol: 'chat-completions',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        apiKey: 'k',
        format: 'wav',
        mimoMode: 'preset',
        voice: '冰糖',
      },
      '你好啊',
      '轻快播报腔',
    )
    const b2 = JSON.parse(last.opts.body)
    ok('preset 的 user 消息是风格指令', b2.messages[0].content === '轻快播报腔')
    ok('preset 带上预置音色名', b2.audio.voice === '冰糖')

    // Fish（fish.audio 官方 API）：模型走 **model 请求头**，音色是 body 里的 reference_id。
    // 这两处最容易搞反：同一个平台里 /v1/tts 带 /v1 而 /model 不带，别想当然。
    await synthesize(
      {
        provider: 'fish',
        protocol: 'fish-tts',
        baseUrl: 'https://api.fish.audio',
        apiKey: 'fish key',
        model: 's2.1-pro',
        voice: 'deadbeef',
        format: 'mp3',
      },
      '你好啊',
      '',
    )
    const b3 = JSON.parse(last.opts.body)
    ok('Fish 请求 /v1/tts', last.url.endsWith('/v1/tts'), last.url)
    ok('Fish 模型走 model 请求头', last.opts.headers.model === 's2.1-pro', JSON.stringify(last.opts.headers))
    ok('Fish 不再把模型放进 body', b3.modelId === undefined, JSON.stringify(b3))
    ok('Fish 用 Authorization Bearer', last.opts.headers.Authorization === 'Bearer fish key')
    ok('Fish 音色作为 reference_id', b3.reference_id === 'deadbeef')
    ok('Fish 不带旧字段 voiceId', b3.voiceId === undefined)
    // 只发 openapi 里列出的字段，空值一律不发
    ok('Fish 只发合同内的字段', Object.keys(b3).every((k) => ['text', 'reference_id', 'format', 'prosody', 'mp3_bitrate'].includes(k)), JSON.stringify(Object.keys(b3)))

    // 不绑音色也要能出声：这家平台 reference_id 可省略，用默认音色
    await synthesize(
      { provider: 'fish', protocol: 'fish-tts', baseUrl: 'https://api.fish.audio', apiKey: 'k', model: 's2.1-pro-free', format: 'mp3' },
      '你好啊',
      '',
    )
    ok('没绑音色时不发 reference_id', JSON.parse(last.opts.body).reference_id === undefined, JSON.stringify(last.opts.body))

    // 从网页复制密钥时带上零宽字符 / 不换行空格 / 误抄的 Bearer 前缀是 401 的头号原因，
    // 必须在塞进请求头之前洗干净
    await synthesize(
      {
        provider: 'fish',
        protocol: 'fish-tts',
        baseUrl: 'https://api.fish.audio',
        apiKey: 'Bearer\u200B fish-key\u00A0',
        model: 's2.1-pro',
        voice: 'deadbeef',
        format: 'mp3',
      },
      '你好啊',
      '',
    )
    ok('Fish 密钥发出前已清洗', last.opts.headers.Authorization === 'Bearer fish-key', last.opts.headers.Authorization)

    // 401 要翻译成人能照着做的中文。
    // 注意：这里必须让每一次重试都失败，否则兜底模型会真的合成成功，测不到报错文案
    const alwaysFail = (status, body) => {
      global.fetch = async (url, opts) => {
        last = { url: String(url), opts: opts || {} }
        return fakeResponse(body, null, status)
      }
    }
    alwaysFail(401, { status: 401, message: 'Invalid Token' })
    await synthesize(
      {
        provider: 'fish',
        protocol: 'fish-tts',
        baseUrl: 'https://api.fish.audio',
        apiKey: 'bad-key-1234',
        model: 's2.1-pro',
        voice: 'deadbeef',
        format: 'mp3',
      },
      '你好啊',
      '',
    ).then(
      () => ok('Fish 401 给出可操作报错', false),
      (e) =>
        ok(
          'Fish 401 给出可操作报错',
          /不认这把 Key/.test(e.message) && /重新生成一把/.test(e.message),
          e.message,
        ),
    )
    // 401 的头号原因其实是拿错平台（fishaudio.org 同名），必须点破
    await synthesize(
      { provider: 'fish', protocol: 'fish-tts', baseUrl: 'https://api.fish.audio', apiKey: 'k', voice: 'v', format: 'mp3' },
      'x',
      '',
    ).then(
      () => ok('Fish 401 点破两套平台不通用', false),
      (e) => ok('Fish 401 点破两套平台不通用', /不能互换/.test(e.message), e.message),
    )

    // 402 不一定是 Key 错：新账号 API 额度为 0 时付费模型全拒，但免费模型还能出声 —— 必试
    const triedModels = []
    global.fetch = async (url, opts) => {
      last = { url: String(url), opts: opts || {} }
      triedModels.push(opts.headers && opts.headers.model)
      // 前两个模型照旧被拒，第三个放行 —— 模拟「付费模型没额度，免费模型能用」
      if (triedModels.length < 3) return fakeResponse({ message: 'Insufficient API credit' }, 402)
      const buf = Buffer.from([1, 2, 3, 4])
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => buf.toString('utf8'),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      }
    }
    const rescued = await synthesize(
      { provider: 'fish', protocol: 'fish-tts', baseUrl: 'https://api.fish.audio', apiKey: 'k', model: 's2.1-pro', voice: 'v', format: 'mp3' },
      '你好',
      '',
    )
    ok('402 会换模型重试而不是直接判死', triedModels.length === 3, JSON.stringify(triedModels))
    ok('重试顺序接着试免费模型', triedModels[1] === 's2.1-pro-free', JSON.stringify(triedModels))
    ok('兜底成功的音频照样返回', rescued.base64.length > 0 && rescued.mime === 'audio/mpeg')
    ok('兜底会报出实际用的模型', rescued.model === 's1' && rescued.fallback === true, JSON.stringify(rescued))

    // 402 是 API 额度不够，不是 Key 错，别混为一谈
    alwaysFail(402, { message: 'Insufficient API credit' })
    await synthesize(
      { provider: 'fish', protocol: 'fish-tts', baseUrl: 'https://api.fish.audio', apiKey: 'k', voice: 'v', format: 'mp3' },
      'x',
      '',
    ).then(
      () => ok('Fish 402 提示额度不足', false),
      (e) => ok('Fish 402 提示额度不足', /额度/.test(e.message), e.message),
    )
    // 平台额度与 API 额度是两笔账，提示里要把充值入口说准
    await synthesize(
      { provider: 'fish', protocol: 'fish-tts', baseUrl: 'https://api.fish.audio', apiKey: 'k', voice: 'v', format: 'mp3' },
      'x',
      '',
    ).then(
      () => ok('Fish 402 给出充值入口', false),
      (e) => ok('Fish 402 给出充值入口', /fish\.audio\/app\/developers/.test(e.message), e.message),
    )

    // 缺 Key / 缺音色的情况要给出人话报错，而不是 500
    await synthesize({ provider: 'fish', protocol: 'fish-tts', voice: 'x', apiKey: '' }, 'x', '').then(
      () => ok('Fish 缺 Key 会报错', false),
      (e) => ok('Fish 缺 Key 会报错', /API Key/.test(e.message), e.message),
    )
    // 缺音色不算错：fish.audio 不给 reference_id 也能出声（用默认音色），
    // 把它判成失败等于把「还没挑音色」变成「点歌播报整个不能用」
    global.fetch = async (url, opts) => {
      last = { url: String(url), opts: opts || {} }
      const buf = Buffer.from([9, 9])
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => buf.toString('utf8'),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      }
    }
    const noVoiceSynth = await synthesize({ provider: 'fish', protocol: 'fish-tts', apiKey: 'k', voice: '' }, 'x', '')
    ok('Fish 缺音色仍能用默认音色出声', noVoiceSynth.base64.length > 0, JSON.stringify(noVoiceSynth))
  } catch (e) {
    ok('TTS 协议分支', false, e.message)
  } finally {
    global.fetch = real
  }
}

/**
 * [39] 点 B 站视频。
 *
 * 用户要的是：点歌 + BV 号 → 和歌排在同一条队列里 → 弹幕功能区显示画面（控件悬浮）
 * → 浮窗里也一样。这段守的是这套机制的几个容易悄悄坏掉的地方。
 */
function testVideoQueue() {
  const root = path.join(__dirname, '..')
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
  const main = read('electron/main.cjs')
  const video = read('electron/bilibili/video.cjs')
  const engine = read('src/lib/music-engine.tsx')
  const stage = read('src/components/VideoStage.tsx')
  const console_ = read('src/components/MusicConsole.tsx')
  const page = read('src/pages/MusicPage.tsx')
  const css = read('src/styles.css')
  const apiTs = read('src/lib/api.ts')
  const preload = read('electron/preload.cjs')

  // ---- 认 BV 号 ----
  ok('能从裸 BV 号里认出来', /parseBvid\(/.test(video) && /BV\[0-9A-Za-z\]\{10\}/.test(video))
  ok(
    '也能从链接里认出来（?bvid= 优先，退回全文第一个 BV 号）',
    /\[\?&\]bvid=\(BV\[0-9A-Za-z\]\{10\}\)/.test(video) && /s\.match\(BVID_RE\)/.test(video),
  )
  ok('认不出时给一句能照着做的话', /没认出 BV 号/.test(video))
  ok('分 P：?p=n，默认第 1 P', /\[\?&\]p=\(\\d\{1,4\}\)/.test(video) && /pages\[Math\.min\(page/.test(video))

  // ---- 查视频信息要带登录身份 ----
  ok(
    '查视频信息走登录会话（会员视频游客查不到）',
    /opts\.session\s*\n?\s*\? \{ ok: true, data: await opts\.session\.getJSON/.test(video) &&
      /BVIDEO\.videoInfo\([\s\S]{0,80}?\{ session/.test(main),
  )
  ok('查之前先 ensureSession（会话是懒建的）', /ensureSession\(\)[\s\S]{0,120}?BVIDEO\.videoInfo/.test(main))
  ok(
    '内嵌播放器复用同一份登录 Cookie（浏览器那份不写就是游客）',
    /syncBiliCookiesToBrowser/.test(main) &&
      /jar\.set\(\{[\s\S]{0,240}?domain: '\.bilibili\.com'/.test(main) &&
      /bili:logout[\s\S]{0,400}?clearBiliCookiesInBrowser/.test(main),
  )
  ok(
    '视频 CDN 的防盗链 Referer 在网络层注入（原生 <video> 的请求从我们的会话发出）',
    /installVideoRefererHeader\(\)/.test(main) &&
      /\*:\/\/\*\.bilivideo\.com\/\*/.test(main) &&
      /details\.requestHeaders\.Referer = 'https:\/\/www\.bilibili\.com\/'/.test(main),
  )

  // ---- 同一条队列 ----
  ok('视频和歌排在同一条队列里（kind 区分）', /kind: 'video'/.test(main) && /musicQueue\.push\(\{[\s\S]{0,80}?kind: 'song'/.test(main))
  ok('视频的 UP 主占「歌手」那一栏', /artists: song\.up \? `UP：\$\{song\.up\}`/.test(main))
  ok('弹幕里发 BV 号走视频那条路，不拿去搜歌名', /const bvid = BVIDEO\.parseBvid\(kw\)[\s\S]{0,120}?handleVideoRequest/.test(main))
  ok('视频有 cid / 总秒数（播放器靠它计时推进）', /cid: Number\(song\.cid\)/.test(main) && /duration: Number\(song\.duration\)/.test(main))
  ok('队列条目类型在渲染层也有（老数据当歌）', /kind\?: 'song' \| 'video'/.test(apiTs))

  // ---- 引擎：视频和歌不串 ----
  ok('id 带类型前缀（歌和视频的 id 各编各的，撞号会误判）', /function keyOf\(/.test(engine) && /`\$\{kindOf\(item\)\}:\$\{item\.id/.test(engine))
  ok('轮到视频时把音频停掉（两条路共用一条队列，绝不同时出声）', /audioEl\.onended = null[\s\S]{0,160}?playingId = key/.test(engine))
  ok('轮到歌时把视频元素停掉', /setVideo\(null\)[\s\S]{0,80}?videoEl\.pause\(\)/.test(engine))
  ok('视频不取歌词（别拿 cid 去问网易云）', /kindOf\(state\.current\) === 'video'[\s\S]{0,120}?setLrc\(\[\]\)/.test(engine))
  ok('视频按「没有歌」上报，OBS 不挂上一首的最后一句', /kindOf\(state\.current\) === 'video' \? 0/.test(engine))

  // ---- 画面：原生 <video>（内嵌 iframe 已整个退役） ----
  // 历史包袱别回去：B 站内嵌播放器在跨域 iframe 里，currentTime / pause / volume
  // 全碰不到 —— 「暂停=卸载、进度靠数、音量靠外挂」这些 bug 全源于此，而且
  // 用户机器上它连画面都渲染不出来。platform=html5 的整条 mp4 是唯一出路。
  ok(
    '画面用原生 <video> 直接播（内嵌 iframe 退役，player.bilibili.com 不许回来）',
    !/player\.bilibili\.com/.test(stage) &&
      /document\.createElement\('video'\)/.test(engine) &&
      /function getVideoElement\(\)/.test(engine) &&
      /el\.playsInline = true/.test(engine),
  )
  ok('画面和声音是同一个元素（流是音视频混流的整条 mp4，不需要第二路喇叭）', !/vstage__audio/.test(stage) && !/vstage__audio/.test(css))
  ok('元素是模块级单例（页面切换重挂不打断播放）', /if \(el\.parentElement !== host\) host\.appendChild\(el\)/.test(engine) && /videoAttach\?\.\(host\)/.test(stage))
  ok('挂上就播（原生 play）', /await el\.play\(\)/.test(engine))
  ok(
    '暂停/继续就是原生 pause/play（进度天然保留，不再卸播放器记进度）',
    /videoEl\?\.pause\(\)/.test(engine) && /el\.play\(\)[\s\S]{0,80}?setPlaying\(true\)/.test(engine),
  )
  ok('播完靠原生 ended 推进下一首（不再按总时长自己数）', /el\.onended = \(\) => \{[\s\S]{0,160}?api\.music\.next\(\)/.test(engine))
  // 依赖必须是**本地 state**：拖滑条走的是 api.config.patch（直接 IPC），不经过 App 那份
  // config —— 等 config 回流的话这一下永远等不到，就是「滑条动了音量不动」那次事故。
  ok(
    '音量/静音直接落在原生元素上（且跟着本地 state 走，不等配置回流）',
    /el\.volume = Math\.min\(1, Math\.max\(0, videoVolume\)\)/.test(engine) &&
      /el\.muted = videoMuted/.test(engine) &&
      /\}, \[videoVolume, videoMuted\]\)/.test(engine),
  )

  // ---- 跨窗口播放权 ----
  // 主窗口和每个浮窗都是独立渲染进程、各自一份引擎；广播又不分窗口 ——
  // 不分归属的话开个音乐浮窗就是两份声音一起响。
  ok(
    '同一时刻只有一个窗口出声（音乐浮窗 > 主窗口，其它浮窗永不拥有）',
    /const ownsPlayback = isMusicFloat \|\| \(!isFloatWindow && !musicFloatOpen\)/.test(engine),
  )
  ok('非拥有者把本地元素安静停掉（浮窗开着时主窗口不当喇叭）', /if \(!ownsPlayback\) \{[\s\S]{0,200}?videoEl\.pause\(\)/.test(engine))
  ok(
    '拥有者把进度当心跳推出去，别的窗口照着镜像（镜像前先确认自己不是拥有者）',
    /api\.music\.tickPush\?\.\(/.test(engine) && /api\.music\.onTick\?\.\(/.test(engine) && /ownsPlaybackRef\.current\) return/.test(engine),
  )
  ok(
    '非拥有者的播放/暂停/拖进度转发给拥有者执行',
    /api\.music\.remote\?\.\(\{ type: 'toggle' \}\)/.test(engine) &&
      /api\.music\.remote\?\.\(\{ type: 'seek', sec: s \}\)/.test(engine) &&
      /api\.music\.onRemote\?\.\(/.test(engine),
  )
  ok('主进程只当中继（心跳广播 + 指令转发），自己不碰播放器', /music:tick-push/.test(main) && /ipcMain\.on\('music:remote'/.test(main))
  ok('渲染层接口齐（心跳 + 遥控）', /tickPush/.test(preload) && /onTick/.test(preload) && /remote: \(cmd\)/.test(preload) && /onRemote/.test(preload))
  ok(
    '音乐浮窗开着时主窗口只摆占位（画面在音乐浮窗里）',
    /videoElsewhere: !ownsPlayback/.test(engine) && /画面在音乐浮窗里/.test(stage) && /vstage__elsewhere/.test(css),
  )

  // ---- 取流：platform=html5 的整条 mp4（免 wbi 签名的老接口，音视频混流） ----
  ok(
    '取整条能直接播的流（platform=html5 走免签名老接口，durl 单段）',
    /platform=html5/.test(video) && /x\/player\/playurl/.test(video) && /durl/.test(video),
  )
  ok(
    '取流失败不当致命错（主进程可接受、渲染层提示一句跳下一首，队列不停摆）',
    /没给到可用的播放地址/.test(video) && /拿不到这条视频的播放地址/.test(engine),
  )
  ok('同一条视频的流地址有缓存（暂停/重挂不重复取）', /streamCache/.test(engine))
  ok('控件条上有能拖的音量（喇叭 + 细滑块）', /SliderFit/.test(stage) && /vstage__vol/.test(css) && /slider--fit/.test(css))
  ok('点喇叭能一键静音', /volMute/.test(stage) && /onMuted/.test(stage) && /volMute/.test(read('src/components/ui.tsx')))
  ok('音量落配置（滑条是滑条：拖到哪停哪，重开也记得）', /video: \{\s*volume/.test(read('electron/store.cjs')) && /volume: number/.test(apiTs))
  ok('音量先改本地再落盘（受控于 IPC 回流的滑条会弹回去）', /setVideoVolume/.test(engine) && /api\.config\.patch\(\{ video: \{ volume: n \}/.test(engine))

  // ---- 浮窗也有音量/静音 ----
  ok('浮窗设置里有静音开关', /静音（视频声音）/.test(read('src/float/FloatShell.tsx')) && /musicMuted/.test(read('src/float/FloatShell.tsx')))
  ok('浮窗头部有常驻静音按钮（等控件条浮出来太慢）', /toggleMute/.test(read('src/float/FloatShell.tsx')))
  ok('浮窗静音记在配置里（关掉重开还是静音）', /muted: c\.muted/.test(read('electron/float.cjs')) && /muted: f\.muted === true/.test(read('electron/float.cjs')))
  ok('渲染层接口齐（videoAudio）', /videoAudio/.test(preload) && /music:videoAudio/.test(main) && /videoAudio/.test(apiTs))

  // ---- 清晰度可手调 ----
  // 选了 1080P 也可能被 B 站夹回 720P（这条老接口的 accept_quality 常常只有 16/64），
  // 所以「请求的档」和「实际拿到的档」必须分开存、分开显示。
  const store = read('electron/store.cjs')
  const VQ = require(path.join(root, 'electron', 'bilibili', 'video.cjs'))
  ok('默认清晰度 720P（配置存的是 B 站 qn 码）', /quality: 64/.test(store) && VQ.normalizeQuality(undefined) === 64)
  ok('认不出的值退回默认档（脏配置不至于取不到流）', VQ.normalizeQuality('999') === 64 && VQ.normalizeQuality(null) === 64)
  ok('取流按请求的清晰度发（不是写死一档）', /const qn = normalizeQuality\(opts\.qn\)/.test(video) && /qn=\$\{qn\}/.test(video))
  ok('主进程两条取流路径都带清晰度（主进程自己那条 + 渲染层那条）', main.split('qn: videoQualityWanted()').length === 3)
  ok(
    '返回值里带**实际**拿到的清晰度（被夹低了要说出来）',
    /quality: Number\(body\.quality\)/.test(video) && /musicStreamQuality/.test(main) && /streamQuality/.test(main),
  )
  // 档位表在两处（取流模块 / 界面下拉），改一边漏一边 = 界面上有档选了没效果
  const qPairs = (src) => {
    const i = src.indexOf('QUALITY_OPTIONS = [')
    const block = src.slice(i, src.indexOf(']', i))
    return (block.match(/\{[^}]*\}/g) || [])
      .map((s) => {
        const nums = s.match(/\d+/g) || []
        const strs = s.match(/'([^']*)'/g) || []
        return `${nums[0]}:${String(strs[strs.length - 1] || '').replace(/'/g, '')}`
      })
      .join(',')
  }
  ok(
    '两处档位表逐行一致（取流模块 ↔ 界面下拉）',
    qPairs(video) === qPairs(page) && qPairs(video) === '16:360P,32:480P,64:720P,74:720P60,80:1080P,116:1080P60,120:4K',
  )
  ok(
    '清晰度改了旧的流当场作废（不缓存上一个清晰度的地址）',
    /applyVideoQualityChange/.test(main) && /musicStreamCache\.clear\(\)/.test(main) && /musicStreamQuality\.clear\(\)/.test(main),
  )
  ok('主进程喊一声让渲染层重取（music:reload）', /send\('music:reload'\)/.test(main) && /onReload/.test(preload) && /onReload/.test(apiTs))
  ok(
    '换清晰度不把视频弹回开头（按当前进度接回去，镜像窗口换好流停在那）',
    /api\.music\.onReload\?\.\(/.test(engine) &&
      /streamCache\.delete\(/.test(engine) &&
      /loadVideo\(cur, keyOf\(cur\), ownsPlaybackRef\.current && wasPlaying, Math\.floor\(Number\(at\) \|\| 0\)\)/.test(engine),
  )
  ok(
    '正在播放的卡片写明实际那档（别让人以为选了 1080P 就是 1080P）',
    /qualityText\(state\.streamQuality\)/.test(page) && /实际 \$\{qualityText/.test(page),
  )

  ok('控件平时藏着，鼠标移到画面上才出来', /\.vstage__ctrl \{[\s\S]{0,300}?opacity: 0;/.test(css) && /\.vstage:hover \.vstage__ctrl/.test(css))
  ok('按着控件拖动时不许淡出（不然音量拖到一半会消失）', /\.vstage__ctrl:active/.test(css))
  ok('控件能播停 / 跳下一个 / 跳进度 / 用浏览器打开', /onToggle/.test(stage) && /onNext/.test(stage) && /onSeek/.test(stage) && /openExternal/.test(stage))
  ok('画面 16:9，别变形', /aspect-ratio: 16 \/ 9/.test(css))
  /**
   * **这条断言必须活着**：B 站播放器只画自己那 16:9 的一块，容器拉成别的形状
   * （曾经为了「浮窗里铺满」把 aspect-ratio 改成 auto + flex:1）它就在容器里
   * 只画一小块 + 一大片白/黑 —— 用户看到的就是「无法播放画面」。已经栽过两次。
   * 只查「有 aspect-ratio:16/9 这条规则」不够：后来的规则会把它覆盖掉，
   * 所以三条一起查：不许 auto、不许被 flex 拉大、必须按 16:9 定高。
   */
  ok(
    '画面不许自由拉伸（拉成非 16:9 = 播放器只画一小块 + 大片留白）',
    !/\.vstage__frame[^{]*\{[^}]*?aspect-ratio:\s*auto/.test(css) &&
      !/\.vconsole \.vstage__frame[^{]*\{[^}]*?flex:\s*1 1 auto/.test(css) &&
      /\.float-body--music > \.vconsole \.vstage__frame[^{]*\{[^}]*?aspect-ratio:\s*16 \/ 9/.test(css) &&
      /\.vconsole \.vstage__frame[^{]*\{[^}]*?aspect-ratio:\s*16 \/ 9/.test(css),
  )
  ok('加载不出来时不留黑屏（给提示 + 浏览器出口）', /vstage__fail/.test(stage) && /vstage__fail/.test(css))
  ok('缓冲中/出错都有那条贴底提示（缓冲中… / 错误消息）', /\(buffering \|\| error\) && !elsewhere/.test(stage) && /error \|\| '缓冲中…'/.test(stage))
  // ---- 「只有声音没有画面」的回归护栏（有实证，别再改回去） ----
  ok(
    '提示层不许盖住画面（必须是贴底窄条，不是 inset:0 的整块底板）',
    /\.vstage__fail\s*\{[^}]*?bottom:\s*0/.test(css) && !/\.vstage__fail\s*\{[^}]*?inset:\s*0/.test(css),
  )
  ok(
    '提示层底色半透明（不透明底板会把画面整个盖掉 = 有声音没画面）',
    /\.vstage__fail\s*\{[^}]*?background:\s*rgba\(0,\s*0,\s*0,\s*0\.\d+\)/.test(css),
  )
  // ---- 「反复出现滑杆」的回归护栏（探针实测的滚动条反馈循环，别再改回去） ----
  // 装着 16:9 视频卡的滚动容器：滚动条出现 → 内容宽收窄 → 视频卡（16:9）变矮 →
  // 总高缩回临界以内 → 滚动条消失 → 内容变宽 → 卡变高 → 又超高……内容高度恰好
  // 卡在临界值时就是 0.25s 一循环的永动抖动（用户看到控件条上的滑杆反复蹦）。
  // 这三处（主内容区 / 弹幕页侧栏 / 音乐浮窗）必须永久预留滚动条槽位断掉宽度反馈。
  ok(
    '滚动容器预留滚动条槽位（滚动条出没不许改变内容宽 = 视频卡反复变形抖动）',
    /\.content\s*\{[^}]*?scrollbar-gutter:\s*stable/.test(css) &&
      /\.danmaku-side\s*\{[^}]*?scrollbar-gutter:\s*stable/.test(css) &&
      /\.float-body--music\s*\{[^}]*?scrollbar-gutter:\s*stable/.test(css),
  )
  ok(
    '侧栏视频卡不许负 margin（iframe 时代的 margin:-8px 遗留会把 stretch 宽撑到 310+16=326，横向溢出成环）',
    !/\.danmaku-side \.vconsole\s*\{[^}]*?margin:\s*-/.test(css),
  )
  // ---- 拖进度 ----
  ok(
    '跳进度就是原生 seek（直接拨 currentTime，不再重建播放器）',
    /el\.currentTime = s/.test(engine) && !/seekN/.test(engine) && !/playerSrc/.test(stage),
  )
  ok(
    '元数据没到时点的进度有 pendingSeek 兜底',
    /pendingSeekRef\.current = s/.test(engine) && /el\.currentTime = pendingSeekRef\.current/.test(engine),
  )

  // ---- 弹幕功能区 + 浮窗 ----
  // 用户点名的：播放视频时只有画面 + 控制器 + 关闭按钮，没有任何别的 UI
  const videoBranch = console_.split('if (video) {')[1]?.split('\n\n  return (')[0] || ''
  ok(
    '轮到视频时音乐控制台整块换成画面（没有卡片外壳）',
    /<div className="vconsole">/.test(videoBranch) && !/side-card/.test(videoBranch),
  )
  ok(
    '纯播放器形态：没有标题 / UP 主 / 待播队列 / 说明文字',
    /className="vconsole"/.test(console_) &&
      /<VideoStage[\s\S]{0,120}?\bbare\b/.test(console_) &&
      /bare \? ' vstage--bare' : ''/.test(stage) &&
      /\{!bare && \(/.test(stage) &&
      /\{!bare && \(\s*<button/.test(stage),
  )
  ok('关闭（收回）按钮浮在画面右上角', /vconsole__actions/.test(console_) && /\.vconsole__actions/.test(css) && /\.vconsole__actions:focus-within/.test(css))
  ok('浮窗走的是同一个 MusicConsole（自动同步）', /MusicConsole/.test(read('src/float/FloatShell.tsx')))
  ok('点歌页能粘 BV 号/链接手动加', /api\.music\.videoInfo/.test(page) && /加入队列/.test(page))
  ok('队列里视频条目有标记，跟歌分得开', /it\.kind === 'video' && <Chip/.test(page))
  ok('渲染层接口齐（查信息 + 入队）', /videoInfo/.test(preload) && /enqueueVideo/.test(preload) && /music:enqueueVideo/.test(main))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
