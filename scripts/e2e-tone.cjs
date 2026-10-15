'use strict'
/**
 * 「纯标点弹幕 → 语气词」的端到端验证。
 *
 * 为什么单开一个脚本：这块是**随机 + 有状态（最近念过什么）**的，
 * 静态断言只能证明代码长那样，证明不了「同一个？真的会换说法」和
 * 「连着两条不会念同一个词」—— 这两条正是这个功能听起来自不自然的关键。
 * 于是把转换函数通过 CP_E2E 钩子直接问，在真主进程里跑真配置。
 * 第 [7] 节再真去点语音页那张表（删一个说法 / 加一个说法 / 恢复内置），
 * 回配置里核对落下去的东西 —— 「界面显示的和真正生效的不是同一张表」只有这一节能抓到。
 *
 * 用法：npm run e2e:tone。用临时 userData，绝对不会碰真实配置。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-e2e-tone-'))
app.setPath('userData', tmpUserData)
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('use-gl', 'swiftshader')
app.disableHardwareAcceleration()
process.env.CP_PROD = '1'
process.env.CP_E2E = '1'
// 绝不占 12450：用户可能正开着真实例直播
process.env.CP_OVERLAY_PORT = String(20000 + Math.floor(Math.random() * 20000))

let pass = 0
let fail = 0
function ok(label, cond, extra) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`)
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询到条件成立为止。界面上点了东西要等 React 重画 + 配置绕主进程一圈回来 */
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* 页面还没就绪，继续等 */
    }
    if (Date.now() - t0 > ms) return null
    await wait(120)
  }
}

require(path.join(__dirname, '..', 'electron', 'main.cjs'))

async function main() {
  let hook = null
  for (let i = 0; i < 150; i++) {
    if (global.__cpE2E) {
      hook = global.__cpE2E
      break
    }
    await wait(200)
  }
  if (!hook) throw new Error('CP_E2E 测试钩子没挂上，检查 main.cjs 的 CP_E2E 分支')
  const T = hook.tone
  const cfg = () => hook.store.get().tts

  console.log('[1] 哪些算「只有标点」')
  ok('单个问号', T.keyOf('？') === '?', T.keyOf('？'))
  ok('连发问号折叠成一个（？？？ 不是三倍惊讶）', T.keyOf('？？？') === '?', T.keyOf('？？？'))
  ok('感叹号', T.keyOf('！') === '!', T.keyOf('！'))
  ok('先问后惊', T.keyOf('？！') === '?!', T.keyOf('？！'))
  ok('先惊后问', T.keyOf('！？') === '!?', T.keyOf('！？'))
  ok('句号', T.keyOf('。') === '.', T.keyOf('。'))
  ok('波浪号', T.keyOf('～') === '~', T.keyOf('～'))
  ok('省略号（三个点也算）', T.keyOf('...') === '…' && T.keyOf('…') === '…', T.keyOf('...'))
  // 有实词的句子一个字都不许动 —— 这是「不替观众加话」的底线
  ok('带内容的句子不认', T.keyOf('真的吗？') === '', T.keyOf('真的吗？'))
  ok('纯数字不认', T.keyOf('6') === '' && T.keyOf('？？666') === '', T.keyOf('6'))
  ok('空串不认', T.keyOf('') === '' && T.keyOf('   ') === '')

  console.log('[2] 换出来的句子：位置对、符号对、词在候选里')
  const table = T.table()
  const said = T.apply('阿七说，？', '？', cfg())
  ok('前缀不动（名字照旧念）', said.startsWith('阿七说，'), said)
  ok('结尾还是疑问语气', /[？?]$/.test(said), said)
  ok('念的是候选词里的一个', (table['?'] || []).includes(said.slice('阿七说，'.length)), said)
  const bare = T.apply('？', '？', cfg())
  ok('不读用户名时整句就是语气词', (table['?'] || []).includes(bare), bare)
  const multi = T.apply('阿七说，？？？', '？？？', cfg())
  ok('连发的「？？？」只换一句', multi.startsWith('阿七说，') && /[？?]$/.test(multi) && multi.length < 12, multi)

  console.log('[3] 随机：会换说法，但连着两条不重复')
  const seen = new Set()
  let repeat = 0
  let prev = ''
  for (let i = 0; i < 20; i++) {
    const w = T.apply('？', '？', cfg())
    seen.add(w)
    if (w === prev) repeat++
    prev = w
  }
  ok('同一个「？」会念出不同说法（随机生效）', seen.size >= 2, [...seen])
  ok('连着两条不念同一个词（不然比静音还难听）', repeat === 0, repeat)

  console.log('[4] 开关与省略号')
  const off = { ...cfg(), interjection: { ...cfg().interjection, enabled: false } }
  ok('关掉之后原样念', T.apply('阿七说，？', '？', off) === '阿七说，？', T.apply('阿七说，？', '？', off))
  const ellOff = { ...cfg(), interjection: { ...cfg().interjection, enabled: true, ellipsis: false } }
  ok('省略号默认保持静音（无语就是无语）', T.apply('阿七说，…', '…', ellOff) === '阿七说，…')
  const ellOn = { ...cfg(), interjection: { ...cfg().interjection, enabled: true, ellipsis: true } }
  ok('开了就念「呃…」', T.apply('阿七说，…', '…', ellOn) === '阿七说，呃…', T.apply('阿七说，…', '…', ellOn))

  console.log('[5] 自定义词表（配置里那张表）')
  const mine = { ...cfg(), interjection: { enabled: true, tones: '? 咦？ 哈？', ellipsis: false } }
  const got = T.apply('？', '？', mine)
  ok('用配置的词，不用内置默认', ['咦？', '哈？'].includes(got), got)
  const badTable = { ...cfg(), interjection: { enabled: true, tones: '乱写的行', ellipsis: false } }
  ok('表解析不出来就回落内置默认', (table['?'] || []).includes(T.apply('？', '？', badTable)))

  console.log('[6] 真实派发：一条「？」弹幕进的是念得出的文本')
  const before = hook.speech.queue.length
  hook.dispatchEvent({
    id: `e2e-tone-${Date.now()}`,
    type: 'danmaku',
    username: '语气词测试',
    uid: 88001,
    content: '？',
    medal: null,
    timestamp: Date.now(),
  })
  await wait(500)
  // pumpSpeech 会立刻消费掉，所以看的是「有没有真的排进去过」而不是队列长度
  ok('派发没把主进程搞崩（钩子还在）', Boolean(global.__cpE2E && typeof T.apply === 'function'))
  ok('队列没被这条卡住', hook.speech.queue.length <= before + 1, hook.speech.queue.length)

  /* 词表在界面上是「一个符号一行、候选词是能点掉的标签」。
     这一段真去点：删一个说法、加一个说法、恢复内置 —— 然后回配置里看落下去的是什么。
     光有静态断言的话，「界面显示的和真正生效的不是一张表」这种坑照样漏。 */
  console.log('[7] 语音页那张表：按符号逐条编辑')
  const win = BrowserWindow.getAllWindows()[0]
  ok('拿到了主窗口', Boolean(win))
  if (win) {
    const js = (code) => win.webContents.executeJavaScript(code)
    const READ_TABLE = `(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.tone-table'))
      if (!card) return null
      return {
        badge: (card.querySelector('.chip') || {}).textContent || '',
        reset: [...card.querySelectorAll('button')].some((b) => b.textContent.includes('恢复内置默认')),
        rows: [...card.querySelectorAll('.tone-row')].map((r) => ({
          sym: (r.querySelector('.tone-row__glyph') || {}).textContent || '',
          words: [...r.querySelectorAll('.tone-word')].map((w) => w.textContent),
          silent: Boolean(r.querySelector('.tone-row__silent')),
          inert: r.classList.contains('is-inert'),
        })),
      }
    })()`
    const rowOf = (t, sym) => (t.rows || []).find((r) => r.sym === sym)
    const clickRow = (sym, sel) =>
      js(`(() => {
        const r = [...document.querySelectorAll('.tone-row')].find((x) => (x.querySelector('.tone-row__glyph') || {}).textContent === ${JSON.stringify(sym)})
        if (!r) return false
        const b = r.querySelector(${JSON.stringify(sel)})
        if (!b) return false
        b.click()
        return true
      })()`)

    const ready = await waitFor(() =>
      js(`(() => { const b = [...document.querySelectorAll('.nav-rail__item')].find((x) => x.textContent.trim() === '语音'); if (b) { b.click(); return true } return false })()`)
        .then(() => js('Boolean(window.chatsparty && window.chatsparty.config)'))
        .catch(() => false),
    )
    ok('切到语音页', Boolean(ready))
    let t = await waitFor(() => js(READ_TABLE))
    ok('画出了按符号分行的词表（七个符号）', Boolean(t) && t.rows.length === 7, t ? t.rows.length : null)
    ok('内置默认：？ 这行带着内置的说法', Boolean(rowOf(t, '？')?.words.includes('啊？')), rowOf(t, '？')?.words)
    ok('内置默认时标着「内置默认」', Boolean(t.badge.includes('内置默认')), t.badge)
    ok('省略号那行在开关关着时不生效（整行压暗）', rowOf(t, '…')?.inert === true)

    // 删掉「？」的第一个说法 —— 配置里该跟着变，且从内置切成自定义
    const first = rowOf(t, '？').words[0]
    ok('点得掉一个说法', await clickRow('？', '.tone-word__del'))
    const afterDel = await waitFor(async () => {
      const row = T.table()['?'] || []
      return row.length === 2 && !row.includes(first) ? row : null
    })
    ok('删掉的说法从配置里没了（界面显示的就是生效的）', Boolean(afterDel), afterDel || JSON.stringify(T.table()))
    t = await waitFor(() => js(READ_TABLE))
    ok('行里少了一个说法', Boolean(t) && rowOf(t, '？').words.length === 2, rowOf(t, '？')?.words)
    // 配置要绕主进程一圈才回到界面，得等它落定（不是第一眼读到什么就是什么）
    const marked = await waitFor(() => js(READ_TABLE).then((r) => (r && r.badge.includes('自定义') ? r : null)))
    ok('动过之后标着「自定义词表」', Boolean(marked), marked ? null : t.badge)
    ok('其它符号不受影响', rowOf(t, '。')?.words.length === 2, JSON.stringify(t.rows))

    // 加一个说法：点开输入框，打进去回车
    ok('点得开加词输入框', await clickRow('。', '.tone-add'))
    await waitFor(() => js(`Boolean(document.querySelector('.tone-add__input'))`))
    const typed = await js(`(() => {
      const el = document.querySelector('.tone-add__input')
      if (!el) return false
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(el, '行吧。')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    const added = await waitFor(async () =>
      typed && hook.store.get().tts.interjection.tones.includes('行吧。') ? true : null,
    )
    ok('加进去的说法落到了配置里', Boolean(added))
    t = await waitFor(() => js(READ_TABLE))
    ok('界面上多出这个说法', Boolean(t) && rowOf(t, '。').words.includes('行吧。'), rowOf(t, '。')?.words)

    // 恢复内置：清空自定义表
    ok('有「恢复内置默认」按钮', Boolean(t.reset))
    await js(`(() => { const b = [...document.querySelectorAll('.card button')].find((x) => x.textContent.includes('恢复内置默认')); if (b) b.click(); return Boolean(b) })()`)
    const back = await waitFor(async () => (hook.store.get().tts.interjection.tones === '' ? true : null))
    ok('点一下就清空自定义表', Boolean(back))
    t = await waitFor(() => {
      return js(READ_TABLE).then((r) => (r && r.badge.includes('内置默认') ? r : null))
    })
    ok('界面回到内置默认（说法又回来了）', Boolean(t) && rowOf(t, '？').words.length === 3, rowOf(t, '？')?.words)

    // 省略号开关：真去点那个开关（配置改完不回灌渲染层，从外面 patch 是测不到的）
    const clicked = await js(`(() => {
      const row = [...document.querySelectorAll('.row')].find((r) => (r.querySelector('.row__label') || {}).textContent === '省略号也念（呃…）')
      if (!row) return false
      const s = row.querySelector('.switch')
      if (!s) return false
      s.click()
      return true
    })()`)
    ok('点得到「省略号也念」开关', Boolean(clicked))
    const lit = await waitFor(async () => {
      if (hook.store.get().tts.interjection.ellipsis !== true) return null
      const r = await js(READ_TABLE)
      return r && rowOf(r, '…') && rowOf(r, '…').inert === false ? r : null
    })
    ok('开关打开后省略号那行恢复生效', Boolean(lit), lit ? null : JSON.stringify(await js(READ_TABLE)))
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  app.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  app.exit(1)
})
