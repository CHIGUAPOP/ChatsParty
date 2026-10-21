import { useEffect, useSyncExternalStore } from 'react'
import { api, type EmoticonBook, type EmoticonItem, type LiveEvent } from './api'

/**
 * 表情图册（渲染层那份）。
 *
 * 为什么要有它 —— 弹幕包里的 `emots` 只在发送端带了表情数据时才出现，
 * 而且键的格式并不统一（收藏集给 `[dog]`，通用表情给 `啊`）。
 * 只靠事件自带的字段，命中率很低，剩下的一律退回成「[表情名]」文字。
 *
 * 所以主进程维护一份全量表（直播面板 + 评论面板合并），这里做三件事：
 *   1. 缓存一份，供同步渲染时查（renderContent 是同步的，拿不到 Promise）
 *   2. 订阅更新 —— 图册换代时 `useEmoticons()` 返回值变化，列表重新渲染
 *   3. 统一查表口径：先试事件自带的 emots，再试全量表；两边都容忍方括号 / 大小写差异
 */

/** 表情名最长多少字，和主进程 electron/emoticons.cjs 的 MAX_NAME 保持一致 */
export const EMOTE_NAME_MAX = 24

/** 匹配弹幕里的 `[表情名]`。名字可能带下划线、中文、数字，最长 24 字 */
export const EMOTE_RE = /\[([^\]]{1,24})\]/g

let book: EmoticonBook = {}
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

function setBook(next: EmoticonBook | null | undefined) {
  const value = next && typeof next === 'object' ? next : {}
  // 同一个引用反复推过来时不要触发重渲染（图册换代才会换引用）
  if (value === book) return
  book = value
  emit()
}

/** 当前图册（同步读，给非组件环境用） */
export function getEmoticonBook(): EmoticonBook {
  return book
}

/**
 * 查一张表情图（纯函数版，表由调用方给）。
 *
 * 事件自带的 `emots` 优先 —— 那是发送端为这一条给出的精确结果（可能是限时表情），
 * 但它的键可能带括号也可能不带，两种都试；都没有再去全量表里找。
 * 传 book 而不是内部读模块变量，是为了让组件对「图册换代」保持响应式。
 */
export function lookupEmoticon(
  ev: LiveEvent | null | undefined,
  book: EmoticonBook,
  name: string,
): EmoticonItem | null {
  if (!name) return null
  const local = ev?.emots
  if (local) {
    const hit = local[name] || local[`[${name}]`] || local[name.toLowerCase()]
    if (hit?.url) return hit
  }
  const global = book[name] || book[name.toLowerCase()]
  return global?.url ? global : null
}

/** 同上，用当前已缓存的那份图册 */
export function findEmoticon(ev: LiveEvent | null | undefined, name: string): EmoticonItem | null {
  return lookupEmoticon(ev, book, name)
}

/** 图册订阅。组件里用它拿最新那份，图册更新后弹幕列表会重新渲染 */
export function useEmoticons(): EmoticonBook {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => book,
    () => book,
  )
}

/**
 * 拉一次图册并挂上订阅。
 *
 * 放在 App 顶层调一次就够：主进程那边按「登录成功 / 进房间 / 30 分钟」的节奏推，
 * 弹幕浮窗也跑同一份渲染层，所以每个窗口各自订阅自己的那一份。
 */
export function useEmoticonBookSync() {
  useEffect(() => {
    let alive = true
    api.emoticons
      ?.get?.()
      .then((b) => {
        if (alive) setBook(b)
      })
      .catch(() => {})
    const off = api.emoticons?.onChanged?.((b) => setBook(b))
    return () => {
      alive = false
      off?.()
    }
  }, [])
}
