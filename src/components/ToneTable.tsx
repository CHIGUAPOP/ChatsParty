import React from 'react'
import { Button, Icon } from './ui'

/**
 * 「纯标点弹幕 → 语气词」那张表的结构化编辑器。
 *
 * 原来是一整块文本框：格式（「符号 + 若干候选词」）只写在占位文字里 ——
 * 想知道哪些符号认、想删掉一个说法，都得自己对着格式改行。现在按符号逐条列：
 * 一个符号一行、候选词是能点掉的标签、加词有专门的输入框，改一下就落一次盘。
 *
 * 符号集合是**固定**的：主进程只认 `? ! . ~` 的组合和省略号（连发先折叠成一个），
 * 别的符号写进去永远不会命中，所以界面上只列这七个。这张清单只是「显示用」
 * （符号怎么画、观众实际会发成什么样）；词表本身住在配置里，不在这儿另存一份。
 */
type ToneRow = { key: string; words: string[] }

const SYMBOLS: { key: string; glyph: string; ex: string }[] = [
  { key: '?', glyph: '？', ex: '？？？ 也算' },
  { key: '!', glyph: '！', ex: '！！！ 也算' },
  { key: '?!', glyph: '？！', ex: '？？！ 也算' },
  { key: '!?', glyph: '！？', ex: '！！？ 也算' },
  { key: '.', glyph: '。', ex: '' },
  { key: '~', glyph: '～', ex: '～～ 也算' },
  { key: '…', glyph: '…', ex: '…… 也算' },
]

/**
 * 全角折半角 + 两点以上收敛成省略号。
 * ⚠️ 和 electron/main.cjs 的 normalizeTone 是同一套映射，改一边要改另一边
 * （smoke 里有断言盯着这两处）。
 */
function foldSymbol(s: string) {
  return String(s || '')
    .replace(/？/g, '?')
    .replace(/！/g, '!')
    .replace(/[。．]/g, '.')
    .replace(/～/g, '~')
    .replace(/\.{2,}|…+/g, '…')
}

/** 表里的键 → 规范化符号。认不出的返回空：那种行主进程那边也永远不会命中 */
function canonSymbol(raw: string) {
  const s = foldSymbol(raw).replace(/(.)\1+/g, '$1')
  if (s === '…') return '…'
  return /^[?!.~]+$/.test(s) ? s : ''
}

/** 配置文本 → 行。手写的全角符号会折到一起，同一个符号的多行会合并 */
function parseRows(raw: string) {
  const found = new Map<string, string[]>()
  const dropped: string[] = []
  for (const line of String(raw || '').split('\n')) {
    const parts = line.trim().split(/\s+/).filter(Boolean)
    if (parts.length < 2) continue
    const key = canonSymbol(parts[0])
    if (!key) {
      dropped.push(parts[0])
      continue
    }
    const words = found.get(key) || []
    for (const w of parts.slice(1)) if (!words.includes(w)) words.push(w)
    found.set(key, words)
  }
  return { found, dropped }
}

/** 界面上的行：七个固定符号（没写说法的显示成「保持静音」）+ 表里多出来的（手写的） */
function buildRows(raw: string): ToneRow[] {
  const { found } = parseRows(raw)
  const known = SYMBOLS.map((s) => ({ key: s.key, words: found.get(s.key) || [] }))
  const extra = [...found]
    .filter(([k]) => !SYMBOLS.some((s) => s.key === k))
    .map(([key, words]) => ({ key, words }))
  return known.concat(extra)
}

/**
 * 行 → 配置文本。只写有说法的行 —— 一个说法都没有的行就是「这个符号保持静音」，
 * 主进程也是这么读的（少于两段的行直接跳过）。
 */
function serializeRows(rows: ToneRow[]) {
  return rows
    .filter((r) => r.words.length)
    .map((r) => [r.key, ...r.words].join(' '))
    .join('\n')
}

/** 加一个说法。点开才展开成输入框：默认状态下它就是个「＋」标签，不占地方 */
function WordAdder({ onAdd }: { onAdd: (w: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState('')
  const ref = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    if (open) ref.current?.focus()
  }, [open])

  if (!open) {
    return (
      <button type="button" className="tone-add" onClick={() => setOpen(true)}>
        <Icon name="add" size={16} />
        加一个说法
      </button>
    )
  }

  const commit = () => {
    // 空格是这张表的分隔符，说法里不能带 —— 顺手清掉，免得多出一个说不出口的词
    const w = text.replace(/\s+/g, '').trim()
    if (w) onAdd(w)
    setText('')
    // 加完不收起输入框：同一个人一般会连着加好几个说法
  }
  const close = () => {
    setOpen(false)
    setText('')
  }

  return (
    <input
      ref={ref}
      className="tone-add__input"
      value={text}
      placeholder="例如 啊？"
      onChange={(e) => setText(e.target.value)}
      onBlur={close}
      onKeyDown={(e) => {
        // 输入法选词的回车不算提交
        if ((e.nativeEvent as any).isComposing) return
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') close()
      }}
    />
  )
}

export function ToneTableEditor({
  tones,
  builtin,
  ellipsis,
  onChange,
}: {
  /** 主播自己写的那张表。空 = 用内置 */
  tones: string
  /** 内置表（store 里那份，只读） */
  builtin: string
  /** 省略号是否也念。关着的时候「…」那行不生效，得在界面上说明 */
  ellipsis: boolean
  /** 写回配置。传 '' 就是恢复内置默认 */
  onChange: (v: string) => void
}) {
  const custom = String(tones || '').trim() !== ''
  const effective = custom ? tones : builtin
  const { dropped } = parseRows(effective)

  const [rows, setRows] = React.useState<ToneRow[]>(() => buildRows(effective))
  /**
   * 自己刚写下去的值会原样回灌一次（配置要绕主进程一圈再回来）。
   * 在那期间不能拿**旧**值把界面盖回去 —— 否则点掉一个词会被自己弹回来。
   */
  const sent = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (sent.current !== null) {
      if (effective === sent.current) sent.current = null
      return
    }
    setRows(buildRows(effective))
  }, [effective])

  const commit = (next: ToneRow[]) => {
    setRows(next)
    const text = serializeRows(next)
    sent.current = text
    onChange(text)
  }

  const addWord = (key: string, word: string) => {
    let hit = false
    const next = rows.map((r) => {
      if (r.key !== key || r.words.includes(word)) return r
      hit = true
      return { ...r, words: [...r.words, word] }
    })
    if (!hit) return
    commit(next)
  }

  const removeWord = (key: string, word: string) => {
    commit(rows.map((r) => (r.key === key ? { ...r, words: r.words.filter((x) => x !== word) } : r)))
  }

  const reset = () => {
    // 清空 = 用内置表。先把界面切过去，别等配置绕一圈回来
    setRows(buildRows(builtin))
    sent.current = null
    onChange('')
  }

  return (
    <>
      <div className="tone-table">
        {rows.map((r) => {
          const sym = SYMBOLS.find((s) => s.key === r.key)
          // 省略号那行还要过一遍上面的开关：关着的时候在这儿写什么都没用
          const inert = r.key === '…' && !ellipsis
          return (
            <div className={`tone-row${inert ? ' is-inert' : ''}`} key={r.key}>
              <div className="tone-row__sym">
                <div className="tone-row__glyph">{sym ? sym.glyph : r.key}</div>
                {sym?.ex ? <div className="tone-row__ex">{sym.ex}</div> : null}
              </div>
              <div className="tone-row__words">
                {r.words.length === 0 && <span className="tone-row__silent">保持静音</span>}
                {r.words.map((w) => (
                  <span className="tone-word" key={w}>
                    {w}
                    <button
                      type="button"
                      className="tone-word__del"
                      title={`删掉「${w}」`}
                      aria-label={`删掉 ${w}`}
                      onClick={() => removeWord(r.key, w)}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </span>
                ))}
                <WordAdder onAdd={(w) => addWord(r.key, w)} />
                {inert && <span className="tone-row__note">上面的「省略号也念」关着，这行不生效</span>}
              </div>
            </div>
          )
        })}
      </div>

      {dropped.length > 0 && (
        <div className="tone-warn">
          有 {dropped.length} 行的符号认不出来，已经忽略：{dropped.join('、')} —— 只认 ？ ！ 。 ～ 的组合（连发会先折叠）和省略号。
        </div>
      )}

      <div className="tone-foot">
        <div className="tone-foot__text">
          <div>{custom ? '当前用的是你自己写的表。' : '当前用的是内置默认表。'}符号只认 ？ ！ 。 ～ 的组合和省略号，连发会折叠成一个。</div>
          <div>把一个符号的说法全删掉，观众只发它时就什么也不念。说法随机抽一个，所以同一条弹幕会念出不同说法，合成缓存的命中率大约是 1/候选数。</div>
        </div>
        {custom && (
          <Button variant="text" small icon="refresh" onClick={reset}>
            恢复内置默认
          </Button>
        )}
      </div>
    </>
  )
}
