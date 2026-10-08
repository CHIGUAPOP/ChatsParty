'use strict'

/**
 * 桌面浮窗 —— 一共四个：弹幕 / 当前观众 / 礼物·付费留言 / 音乐控制台。
 *
 * 每个浮窗就是主窗口里对应区域的一份「弹出版」：主窗口里点区域右上角的圆点
 * 「弹出为浮窗」，那块区域就收进浮窗里（主窗口里不再显示）；浮窗里点 × 收回，
 * 内容回到主窗口。开着的时候互不重复显示，关掉必然物归原主。
 *
 * 浮窗加载的是**应用渲染层本尊**（?float=<panel> 只渲染那一个区域），
 * 不是 OBS 叠加层 —— 所以样式跟弹幕功能区一模一样（同一套 M3 设计令牌），
 * 弹幕浮窗还能直接发弹幕（它有同样的 preload，走同一批 IPC）。
 *
 * ⚠️ 窗口一律**不透明**（PANEL_BG 底板，页面里没有标题栏 —— 顶条整条可拖，
 * 右上角只有设置按钮和 ×；透明度旋钮由渲染层写在内容区 CSS 上，顶条始终不透明）。
 * 为什么不用纯透明：透明窗要 Chromium 走 GPU 合成路径，而本程序为了兼容
 * 无 GPU / 受限环境，启动时就 `disableHardwareAcceleration()` +
 * `disable-gpu-compositing`（见 main.cjs 顶部）。两者一撞，透明窗在屏幕上
 * **一像素都画不出来** —— 实测采样到的是桌面色。
 */

/** 数值夹在合理区间里：太透会变成一片看不见的膜，太大太小都没法用 */
function num(v, def, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, n))
}

/** 有底板模式的窗口底色（跟界面的 surface 同族，看着是一家的） */
const PANEL_BG = '#14121a'

/** 四个浮窗。名字同时是 ?float= 的参数值，两侧必须逐字一致 */
const FLOAT_PANELS = ['danmaku', 'viewers', 'gifts', 'music']

/** 各浮窗的默认尺寸。弹幕竖着刷流要高一些；音乐横一点好放进度条 */
const PANEL_DEFAULT_SIZE = {
  danmaku: [380, 620],
  viewers: [330, 560],
  gifts: [370, 520],
  music: [360, 460],
}

/**
 * 位置专用：null 就是「没记住过」，**不能**当成 0。
 * Number(null) === 0，直接 Number 会让浮窗每次都开在屏幕左上角。
 */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 一个面板的配置夹在合理区间里 */
function clampPanel(panel, cfg) {
  const f = cfg || {}
  const b = f.bounds || {}
  const [dw, dh] = PANEL_DEFAULT_SIZE[panel] || [380, 520]
  const sfNum = Number(b.sf)
  return {
    opened: Boolean(f.opened),
    // 0.2 以下基本看不见了；1 就是完全不透明
    opacity: num(f.opacity, 0.95, 0.2, 1),
    // 「字体大小」的实现：窗口自身 zoom，连带布局一起缩
    scale: num(f.scale, 100, 50, 200),
    bounds: {
      width: Math.round(num(b.width, dw, 200, 4000)),
      height: Math.round(num(b.height, dh, 160, 4000)),
      x: numOrNull(b.x),
      y: numOrNull(b.y),
      // 记这笔宽高时所在屏幕的缩放（跨缩放屏恢复时要按物理大小折算）。
      // 没有就是老配置，恢复时不做换算
      sf: Number.isFinite(sfNum) && sfNum > 0 ? sfNum : null,
    },
  }
}

/**
 * 记下来的位置还在不在某块屏幕上。
 * 拔掉外接显示器之后，那个坐标会落在屏幕外 —— 还照着开的话浮窗就「不见了」。
 */
function isOnScreen(x, y, screen) {
  if (!screen || x === null || y === null) return false
  let displays = []
  try {
    displays = screen.getAllDisplays()
  } catch {
    return false
  }
  return displays.some((d) => {
    const a = d.bounds || {}
    const w = Number(a.width) || 0
    const h = Number(a.height) || 0
    return x >= a.x - 8 && x <= a.x + w && y >= a.y - 8 && y <= a.y + h
  })
}

/**
 * 四个浮窗的管家。
 *
 * @param {object} o
 * @param {string} o.preload            preload 脚本路径（浮窗和主窗口共用同一份）
 * @param {() => object} [o.icon]       窗口图标（没有就不设）
 * @param {(m: string, e?: object) => void} [o.log]  日志。浮窗出了问题只能靠日志判案
 * @param {() => object} o.getConfig    读当前配置（要 float 那一段）
 * @param {(p: object) => void} o.patchConfig 写回配置（记位置 / 改开关，deep merge）
 * @param {(w: import('electron').BrowserWindow, panel: string) => void} o.load
 *                                       把对应面板的页面装进窗口（dev 走 dev server、
 *                                       打包走 dist-renderer，主进程比这里清楚）
 * @param {(s: object) => void} [o.onState]  状态变了推给所有窗口
 */
class FloatWindows {
  constructor(o) {
    this.o = o || {}
    /** panel 名 → BrowserWindow。没开的面板没有键 */
    this.wins = {}
    /** panel 名 → 记位置用的防抖定时器 */
    this.rememberTimers = {}
    /** panel 名 → 浮窗内调旋钮的落盘防抖定时器 */
    this.setTimers = {}
    /** panel 名 → sync 串行队列（面板之间互不干扰，各排各的） */
    this.queues = {}
  }

  say(msg, extra) {
    try {
      this.o.log?.(`[float] ${msg}`, extra)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  isOpen(panel) {
    const w = this.wins[panel]
    return Boolean(w && !w.isDestroyed())
  }

  /** 全量状态。界面据此渲染每个区域的圆点与占位 */
  state() {
    const cfg = this.o.getConfig() || {}
    const panels = {}
    for (const p of FLOAT_PANELS) {
      const c = clampPanel(p, (cfg.panels || {})[p])
      panels[p] = {
        opened: this.isOpen(p),
        opacity: c.opacity,
        scale: c.scale,
      }
    }
    return { panels, alwaysOnTop: cfg.alwaysOnTop !== false }
  }

  /** 每个浮窗的标题栏文字。窗口是无边框的，标题看不见，但 Alt+Tab 和无障碍读的是它 */
  label(panel) {
    return {
      danmaku: '弹幕浮窗',
      viewers: '当前观众浮窗',
      gifts: '礼物浮窗',
      music: '音乐控制台浮窗',
    }[panel] || panel
  }

  async open(panel) {
    if (this.isOpen(panel)) {
      this.wins[panel].focus()
      return true
    }
    const { BrowserWindow, screen } = require('electron')
    const cfg = this.o.getConfig() || {}
    const c = clampPanel(panel, (cfg.panels || {})[panel])
    const alwaysOnTop = cfg.alwaysOnTop !== false
    const b = c.bounds

    // 跨缩放屏折算：记下的宽高是「那块屏的缩放」下的 DIP 值。拖到一块缩放不同
    // 的屏幕上时 Windows 会重排窗口并触发 resize，被记住的就是折过一遍的数 ——
    // 不换算的话，关掉再开就会比关闭前大（用户实测）。按物理大小折回目标屏：
    //   物理像素 = 记下的 DIP × 记下的缩放；新 DIP = 物理像素 ÷ 目标屏缩放
    let width = b.width
    let height = b.height
    let target = null
    try {
      target = isOnScreen(b.x, b.y, screen)
        ? screen.getDisplayMatching({ x: b.x, y: b.y, width: b.width, height: b.height })
        : screen.getPrimaryDisplay()
    } catch {
      target = null
    }
    const tsf = Number(target && target.scaleFactor)
    if (b.sf && Number.isFinite(tsf) && tsf > 0) {
      width = Math.round((b.width * b.sf) / tsf)
      height = Math.round((b.height * b.sf) / tsf)
    }

    const opts = {
      width,
      height,
      minWidth: 220,
      minHeight: 180,
      title: `ChatsParty · ${this.label(panel)}`,
      // 无边框：它本来就该像贴在画面上的一层，不该有系统那条边框
      frame: false,
      // 不透明深色底板。透明窗在本程序里一像素都画不出来（见文件顶部注释）
      backgroundColor: PANEL_BG,
      // 浮窗不该去任务栏里占一个格子
      skipTaskbar: true,
      resizable: true,
      ...(this.o.icon ? this.o.icon() : {}),
      webPreferences: {
        preload: this.o.preload,
        contextIsolation: true,
        nodeIntegration: false,
        // 不聚焦时也要继续跑动画、继续收弹幕，否则切走就定格
        backgroundThrottling: false,
      },
    }
    if (isOnScreen(b.x, b.y, screen)) {
      opts.x = b.x
      opts.y = b.y
    } else {
      // 没记住过（或记的那个位置已经不在任何屏幕上了）就摆到屏幕中间，
      // 别让它落在角落里 —— 无边框窗口一旦跑到看不见的地方就找不回来了
      opts.center = true
    }

    const w = new BrowserWindow({ ...opts, show: false })
    this.wins[panel] = w
    this.say(`打开${this.label(panel)}`)

    this.applyTo(w, c, alwaysOnTop)
    // ⚠️ 这两个监听必须在 load 之前挂：loadURL/loadFile 返回时页面已经加载完，
    // did-finish-load 和 page-title-updated 都已经发过了 —— 挂晚了就永远等不到
    //（表现就是缩放失效、窗口标题被页面顶掉）。
    // 缩放是 webContents 上的，加载完再压一次才牢 —— 换页会被重置回 1
    w.webContents.on('did-finish-load', () => {
      try {
        w.webContents.setZoomFactor(c.scale / 100)
      } catch {
        /* 缩放失败不影响显示 */
      }
    })
    // 页面自己的 <title> 会盖掉窗口标题 —— 拦下来
    w.webContents.on('page-title-updated', (ev) => {
      ev.preventDefault()
      w.setTitle(`ChatsParty · ${this.label(panel)}`)
    })
    try {
      await this.o.load(w, panel)
    } catch (e) {
      this.say(`加载页面失败：${e?.message || e}`)
      w.destroy()
      delete this.wins[panel]
      throw e
    }

    // 记住了位置的才要校准：跨缩放屏的「首落」会被双重换算 —— 实测在 150% 的
    // 副屏上请求 400×600，落地变成 603×902（Electron 创建时按目标屏换算一次，
    // Windows 的 DPICHANGED 又重排一次）。窗口落定之后再 setBounds 一遍就是
    // 1:1 精确落位 —— 所以量一量、不对就再摆一遍，摆准了才亮出来。
    // 不校准的后果：每次关掉重开都可能大一号，remember 把大的记回去，越滚越大。
    if (opts.x !== undefined) {
      await this.settleBounds(w, { x: opts.x, y: opts.y, width, height })
    }
    w.show()

    // 拖到哪儿、拉成多大都记下来，下次在同一处开。
    // move/resize 每帧都来，全量加密写盘会把拖动拖成幻灯片 —— 攒 400ms
    const rememberSoon = () => this.scheduleRemember(panel)
    w.on('move', rememberSoon)
    w.on('moved', rememberSoon)
    w.on('resize', rememberSoon)
    w.on('resized', rememberSoon)
    w.on('closed', () => {
      /**
       * 只有「当前这个窗口」被关掉才算数。
       * 重建浮窗时旧窗口的 closed 会晚一步到：那时 this.wins[panel] 已经是
       * 刚建好的新窗口了。不做身份校验的话，旧窗口的这一刻会把新窗口的引用
       * 清掉、还会把开关写成 false —— 而屏幕上窗口明明还在。
       */
      if (this.wins[panel] !== w) return
      delete this.wins[panel]
      this.say(`${this.label(panel)}被关掉了（× 或窗框），内容回到弹幕姬`)
      this.o.patchConfig({ panels: { [panel]: { opened: false } } })
      this.push()
    })

    this.push()
    const [x, y] = w.getPosition()
    const [ww, hh] = w.getSize()
    this.say(`${this.label(panel)}已打开 ${ww}×${hh} @ ${x},${y}（不透明度 ${c.opacity}·缩放 ${c.scale}%·置顶 ${alwaysOnTop}）`)
    return true
  }

  /**
   * 落位校准：量到的尺寸和要摆的不一致就再 setBounds 一遍，最多五轮。
   * DPICHANGED 的重排是异步的，所以每一轮之间要留出间隔让它落地。
   * 单屏（缩放一致）时第一轮就过，一次 setBounds 都不用发。
   */
  async settleBounds(w, rect) {
    for (let i = 0; i < 5; i++) {
      let cw = 0
      let ch = 0
      try {
        ;[cw, ch] = w.getSize()
      } catch {
        return
      }
      if (Math.abs(cw - rect.width) <= 2 && Math.abs(ch - rect.height) <= 2) return
      try {
        w.setBounds(rect)
      } catch {
        return
      }
      await new Promise((r) => setTimeout(r, 120))
    }
    this.say('落位校准五轮还没摆准，就这样了')
  }

  /** 把旋钮落到窗口上 */
  applyTo(w, c, alwaysOnTop) {    if (!w || w.isDestroyed()) return
    /**
     * 透明度**必须走窗口级 setOpacity**（DWM 层，本机禁了 GPU 合成也有效）。
     * 试过让渲染层把 opacity 写在内容区 CSS 上 —— 窗口底板是不透明的深色，
     * 内容淡下去只是「深底上更暗」，永远透不到窗后的桌面，用户看着就是「没生效」。
     * 代价是整扇窗（含文字）一起淡 —— DWM 是逐像素乘 alpha，没法让文字例外
     * （每像素透明要 transparent 窗口，本机画不出来，见文件顶注释）。
     *
     * 所以拖一条**可读性曲线**抬低端：滑块 100% → 实际 100%（完全一致），
     * 50% → 68%，20% → 41% —— 拉得再低文字也不会淡成影子。
     * 配合渲染层 is-dim（低不透明度时文字加阴影、次要文字提亮）双保险。
     */
    try {
      w.setOpacity(Math.pow(c.opacity, 0.55))
    } catch {
      /* noop */
    }
    if (alwaysOnTop !== undefined) {
      try {
        // screen-saver 这一档才能真正压在全屏游戏上面，普通档会被盖住
        w.setAlwaysOnTop(alwaysOnTop, 'screen-saver')
      } catch {
        /* noop */
      }
    }
    try {
      w.webContents.setZoomFactor(c.scale / 100)
    } catch {
      /* noop */
    }
  }

  close(panel) {
    // 收之前把两笔没落盘的都补上：旋钮刚拖完、位置刚拖完就关窗的话
    if (this.setTimers[panel]) {
      clearTimeout(this.setTimers[panel])
      this.setTimers[panel] = null
      const cur = (this.o.getConfig() || {}).panels || {}
      const c = clampPanel(panel, cur[panel])
      this.o.patchConfig({ panels: { [panel]: { opacity: c.opacity, scale: c.scale } } })
    }
    // 收之前先把「顺手记一笔」补上：用户拖完立刻关窗的话，那一笔还没落盘
    if (this.rememberTimers[panel]) {
      clearTimeout(this.rememberTimers[panel])
      this.rememberTimers[panel] = null
      this.remember(panel)
    }
    const w = this.wins[panel]
    if (!this.isOpen(panel)) return
    // 先把引用摘掉再关：closed 回调靠 this.wins[panel] === w 判断「是不是我们关的」，
    // 摘掉之后它就不会把开关拨回关（那是对「用户点浮窗里的 ×」才做的处理）
    delete this.wins[panel]
    try {
      w.close()
    } catch {
      /* noop */
    }
    this.say(`${this.label(panel)}已收起，内容回到弹幕姬`)
    this.push()
  }

  closeAll() {
    for (const p of FLOAT_PANELS) this.close(p)
  }

  /** 浮窗里的设置弹层改了透明度 / 字体大小：上窗立刻生效，落盘攒 400ms */
  set(panel, patch) {
    const cur = (this.o.getConfig() || {}).panels || {}
    const merged = {
      ...(cur[panel] || {}),
      ...(patch || {}),
    }
    const c = clampPanel(panel, merged)
    if (this.isOpen(panel)) this.applyTo(this.wins[panel], c)
    // 拖滑块时每帧都到这里，全量加密写盘会把拖动拖成幻灯片 —— 攒一下
    if (this.setTimers[panel]) clearTimeout(this.setTimers[panel])
    this.setTimers[panel] = setTimeout(() => {
      this.setTimers[panel] = null
      this.o.patchConfig({ panels: { [panel]: { opacity: c.opacity, scale: c.scale } } })
      this.push()
    }, 400)
    return c
  }

  /** 配置改了（config:patch 里带着 float）：逐个面板对齐 */
  syncAll() {
    for (const p of FLOAT_PANELS) this.sync(p)
  }

  /**
   * 单个面板对齐配置。串行化：config:patch 可能被连续触发，
   * 而开关切换是「关一个 / 开一个」的多步动作，并发跑会互相踩。
   */
  sync(panel) {
    const next = (this.queues[panel] || Promise.resolve()).then(
      () => this.applySync(panel),
      () => this.applySync(panel),
    )
    this.queues[panel] = next.catch(() => {})
    return next
  }

  async applySync(panel) {
    const cfg = this.o.getConfig() || {}
    const want = (cfg.panels || {})[panel]?.opened === true
    if (want && !this.isOpen(panel)) {
      try {
        await this.open(panel)
      } catch (e) {
        this.say(`打开${this.label(panel)}失败：${e?.message || e}`)
      }
      return
    }
    if (!want && this.isOpen(panel)) {
      this.close(panel)
      return
    }
    if (want) {
      const c = clampPanel(panel, (cfg.panels || {})[panel])
      this.applyTo(this.wins[panel], c, cfg.alwaysOnTop !== false)
      this.push()
    }
  }

  /** 上次开着的浮窗都带回来（启动时调） */
  async restore() {
    const cfg = this.o.getConfig() || {}
    const panels = cfg.panels || {}
    for (const p of FLOAT_PANELS) {
      if (panels[p]?.opened === true) {
        try {
          await this.open(p)
        } catch (e) {
          this.say(`恢复${this.label(p)}失败：${e?.message || e}`)
        }
      }
    }
  }

  /** 攒一下再落盘：拖动中每帧写一次配置，拖动会变成幻灯片 */
  scheduleRemember(panel) {
    if (this.rememberTimers[panel]) clearTimeout(this.rememberTimers[panel])
    this.rememberTimers[panel] = setTimeout(() => {
      this.rememberTimers[panel] = null
      this.remember(panel)
    }, 400)
  }

  remember(panel) {
    const w = this.wins[panel]
    if (!w || w.isDestroyed()) return
    let x = null
    let y = null
    let width = null
    let height = null
    let sf = null
    try {
      const p = w.getPosition()
      const s = w.getSize()
      x = p[0]
      y = p[1]
      width = s[0]
      height = s[1]
      // 记下这笔宽高是哪块屏幕的缩放下的 —— 跨缩放屏拖过之后，下次恢复要折算
      const { screen } = require('electron')
      const d = screen.getDisplayMatching({ x, y, width, height })
      const n = Number(d && d.scaleFactor)
      if (Number.isFinite(n) && n > 0) sf = n
    } catch {
      return
    }
    this.o.patchConfig({ panels: { [panel]: { bounds: { x, y, width, height, sf } } } })
  }

  push() {
    try {
      this.o.onState?.(this.state())
    } catch {
      /* noop */
    }
  }
}

module.exports = { FloatWindows, FLOAT_PANELS, PANEL_DEFAULT_SIZE, clampPanel, isOnScreen, PANEL_BG }
