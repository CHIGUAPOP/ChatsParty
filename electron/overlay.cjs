'use strict'
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { WebSocketServer } = require('ws')

const OVERLAY_DIR = path.join(__dirname, '..', 'overlay')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/**
 * 本地叠加层服务。OBS 里加浏览器源填 http://127.0.0.1:<port>/overlay 即可，
 * 事件通过本地 WebSocket 实时推给页面，背景默认透明。
 */
class OverlayServer {
  constructor(port = 12450) {
    this.port = port
    this.server = null
    this.wss = null
    this.clients = new Set()
    this.configProvider = null
    // 新客户端连上时补发已解析的头像（{src,data}[]）
    this.faceProvider = null
    // 新客户端连上时补发当前点歌状态（{current,items}）。
    // 不补的话，中途才开 OBS 看到的就是空的「正在播放」，要等下一首才出现。
    this.musicProvider = null
    // 歌词：OBS 中途连上时补发当前这一句，否则要等下一行才出现字
    this.lyricProvider = null
    // 有客户端连上/断开时回调，主进程据此把「几个连接」推给界面
    this.onClientsChange = null
    this.requestedPort = port
  }

  /**
   * 起服务。端口被占就往后顺延，最多试 10 个 —— 之前这里直接抛异常，
   * 结果启动失败被上层吞掉，界面上只显示「未启动」，很难排查。
   */
  async start(port, { fallback = true } = {}) {
    if (port) this.requestedPort = port
    if (this.server) return this.port

    const tried = []
    const ports = fallback ? Array.from({ length: 10 }, (_, i) => this.requestedPort + i) : [this.requestedPort]
    for (const p of ports) {
      try {
        const bound = await this.listen(p)
        this.port = bound
        return bound
      } catch (e) {
        tried.push(`${p}（${e.code === 'EADDRINUSE' ? '被占用' : e.message}）`)
      }
    }
    const err = new Error(`端口起不来：${tried.join('、')}`)
    err.code = 'EADDRINUSE'
    throw err
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        let urlPath = (req.url || '/').split('?')[0]
        if (urlPath === '/' || urlPath === '/overlay') urlPath = '/index.html'
        const filePath = path.join(OVERLAY_DIR, path.normalize(urlPath).replace(/^([/\\])+/, ''))
        if (!filePath.startsWith(OVERLAY_DIR)) {
          res.writeHead(403).end('forbidden')
          return
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            // 单页兜底：找不到就回 index.html
            fs.readFile(path.join(OVERLAY_DIR, 'index.html'), (e2, d2) => {
              if (e2) {
                res.writeHead(404).end('not found')
                return
              }
              res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] }).end(d2)
            })
            return
          }
          const ext = path.extname(filePath)
          res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' })
          res.end(data)
        })
      })

      const wss = new WebSocketServer({ server })
      // ws 会把底层 server 的 error 再抛一遍到自己身上。没有监听者的话，
      // 端口被占（EADDRINUSE）时会变成未捕获异常，直接把主进程带崩 ——
      // 表现就是「OBS 怎么都不出东西」，而其实服务压根没起来。
      wss.on('error', () => {
        /* 交给 server 的 error 处理，这里只是避免 unhandled error 崩进程 */
      })
      wss.on('connection', (ws) => {
        this.clients.add(ws)
        const cfg = this.configProvider ? this.configProvider() : null
        try {
          ws.send(JSON.stringify({ type: 'hello', payload: { ok: true, overlay: cfg } }))
          // OBS 可能在弹幕跑了一阵之后才连上来，之前广播过的头像它是收不到的，
          // 这里补发全量，否则先出场的人一直是灰头像。
          const known = this.faceProvider ? this.faceProvider() : null
          if (known && known.length) {
            ws.send(JSON.stringify({ type: 'faces', payload: known }))
          }
          const music = this.musicProvider ? this.musicProvider() : null
          if (music) ws.send(JSON.stringify({ type: 'music', payload: music }))
          const lyric = this.lyricProvider ? this.lyricProvider() : null
          // 没有词也要发这一帧 —— 「现在没有词」本身就是个事实，
          // 而且是这样一种事实：不发的话，重连上来的页面会一直挂着断开前那一首的最后一句话。
          if (lyric) ws.send(JSON.stringify({ type: 'lyric', payload: lyric }))
        } catch {
          /* noop */
        }
        this.notifyClients()
        ws.on('close', () => {
          this.clients.delete(ws)
          this.notifyClients()
        })
        ws.on('error', () => {
          this.clients.delete(ws)
          this.notifyClients()
        })
      })

      const onError = (e) => {
        server.removeListener('listening', onListening)
        try {
          wss.close()
        } catch {
          /* noop */
        }
        reject(e)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        this.server = server
        this.wss = wss
        resolve(port)
      }
      server.once('error', onError)
      server.listen(port, '127.0.0.1', onListening)
    })
  }

  notifyClients() {
    try {
      this.onClientsChange?.(this.clients.size, this.port)
    } catch {
      /* noop */
    }
  }

  stop() {
    return new Promise((resolve) => {
      if (this.wss) {
        for (const ws of this.clients) {
          try {
            ws.terminate()
          } catch {
            /* noop */
          }
        }
        this.clients.clear()
        this.wss.close()
        this.wss = null
      }
      if (this.server) {
        this.server.close(() => {
          this.server = null
          resolve()
        })
      } else resolve()
    })
  }

  broadcast(type, payload) {
    if (!this.clients.size) return
    const msg = JSON.stringify({ type, payload })
    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        try {
          ws.send(msg)
        } catch {
          /* noop */
        }
      }
    }
  }

  get clientCount() {
    return this.clients.size
  }
}

module.exports = { OverlayServer }
