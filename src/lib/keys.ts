/**
 * 密钥文本的界面侧镜像：清洗规则和指纹格式与 electron/lib/keytext.cjs 保持一致。
 * 这里只为了在输入时就能给出提示（「有零宽字符」「长度 32 · ab12…9f3c」），
 * 真正入库的清洗发生在主进程，先看那边。
 */

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/
const WIDE_SPACE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/
const QUOTES_EDGE = /^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g

export function normalizeKey(raw: string): string {
  let s = String(raw ?? '')
  s = s.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
  s = s.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
  s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
  s = s.replace(/^\s*authorization\s*:\s*/i, '')
  s = s.replace(/^\s*bearer\s+/i, '')
  return s.replace(QUOTES_EDGE, '')
}

export interface KeyInfo {
  len: number
  fp: string
  empty: boolean
  warnings: string[]
}

export function inspectKey(raw: string): KeyInfo {
  const original = String(raw ?? '')
  const s = normalizeKey(original)
  const warnings: string[] = []
  if (ZERO_WIDTH.test(original)) warnings.push('含有零宽字符（不可见）')
  if (WIDE_SPACE.test(original)) warnings.push('含有全角/不换行空格')
  if (CONTROL.test(original)) warnings.push('含有换行或控制字符')
  if (/^\s*authorization\s*:/i.test(original)) warnings.push('含有 Authorization: 前缀')
  if (/^\s*bearer\s+/i.test(original)) warnings.push('含有 Bearer 前缀')
  if (/^[\s"'`“”‘’]|[\s"'`“”‘’]$/.test(original)) warnings.push('首尾带引号或多个空白')
  if (!s) return { len: 0, fp: '（空）', empty: true, warnings }
  const fp = s.length <= 10 ? `${s.slice(0, 1)}***` : `${s.slice(0, 4)}…${s.slice(-4)}`
  return { len: s.length, fp, empty: false, warnings }
}

export function keySummary(raw: string): string {
  const i = inspectKey(raw)
  return i.empty ? '未填写' : `长度 ${i.len} · ${i.fp}`
}
