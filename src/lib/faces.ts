/**
 * 头像 -> data URL 的映射表。
 *
 * B站图床有防盗链，界面直接 <img src="https://i0.hdslb.com/..."> 会拿到 403，
 * 所以主进程会带 Referer 抓回来转成 data: 地址，再通过 live:face 推过来。
 * 这里只做「原地址 → 可直接显示地址」的记账。
 */
const cache = new Map<string, string>()

export function setResolvedFace(src: string, data: string) {
  if (src && data) cache.set(src, data)
}

/**
 * 取可以真正显示的地址。
 * 还没解析完时返回空串（渲染成首字母占位），刻意不返回远程原地址 ——
 * 返回原地址会 403 并让 <img> 进入 error 状态，之后就算数据到了也可能刷不回来。
 */
export function resolveFace(src?: string): string {
  if (!src) return ''
  if (src.startsWith('data:')) return src
  return cache.get(src) || ''
}
