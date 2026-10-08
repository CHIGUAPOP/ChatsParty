import { api } from './api'

/**
 * B站用户主页链接。
 *
 * 只认 uid —— 昵称不唯一、还可能带不可见字符，拼出来的链接未必对得上人。
 * uid 为 0 的情况是有的：匿名/未登录观众、以及部分被风控隐藏 uid 的包。
 * 这时候宁可不给链接，也不要跳到一个随机用户的主页上。
 */
export function userSpaceUrl(uid: number | string | undefined | null): string | null {
  const n = Number(uid)
  if (!Number.isFinite(n) || n <= 0) return null
  return `https://space.bilibili.com/${Math.floor(n)}`
}

/**
 * 用系统默认浏览器打开用户主页。
 *
 * 渲染层开不了窗口，走主进程的 `app:openExternal`（那边只放行 http(s)，
 * 挡住 file:// 之类）。失败就算了 —— 点个头像没打开不值得弹错误框打断主播。
 */
export async function openUserSpace(uid: number | string | undefined | null): Promise<boolean> {
  const url = userSpaceUrl(uid)
  if (!url) return false
  try {
    const r = await api.app.openExternal(url)
    return Boolean(r?.ok)
  } catch {
    return false
  }
}
