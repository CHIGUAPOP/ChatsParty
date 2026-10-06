'use strict'
const fs = require('node:fs')
const path = require('node:path')

/**
 * 极小 diagnostics 日志。
 * GUI 应用里 console 看不见，排查问题全靠猜，所以往 userData 里落一份。
 * 单文件上限 512KB，写满就砍掉前半段。
 */
const MAX_SIZE = 512 * 1024

class Logger {
  constructor(dir) {
    this.file = path.join(dir, 'chatsparty.log')
    this.enabled = true
  }

  write(level, ...parts) {
    if (!this.enabled) return
    try {
      const line = `[${new Date().toISOString()}] ${level} ${parts.map(stringify).join(' ')}\n`
      fs.appendFileSync(this.file, line)
      const size = fs.statSync(this.file).size
      if (size > MAX_SIZE) {
        const kept = fs.readFileSync(this.file, 'utf8').slice(-Math.floor(MAX_SIZE / 2))
        fs.writeFileSync(this.file, kept)
      }
    } catch {
      /* 日志写不进去不能影响主流程 */
    }
  }

  info(...p) {
    this.write('INFO ', ...p)
  }
  warn(...p) {
    this.write('WARN ', ...p)
  }
  error(...p) {
    this.write('ERROR', ...p)
  }
}

function stringify(v) {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack || v.message
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

module.exports = { Logger }
