'use strict'

/**
 * 播报队列 + 「跳过」状态机。
 *
 * 单独拎出来是因为这里全是边界情况，靠真机点很难复现：
 *  - 正在播放时跳过 → 立刻放行队列，音频交给渲染进程停
 *  - 正在合成时跳过 → 只打标记，合成完丢掉，别再推给渲染进程
 *  - 空闲时手滑点了 → 什么都不该发生（打标记会误伤下一条新弹幕）
 * 抽成纯状态机之后这些都能在 scripts/smoke.cjs 里直接跑。
 */
function createSpeechControl() {
  const queue = []
  let busy = false
  // 播完了由渲染进程回执；跳过时也要手动放行，否则队列永远卡住
  let waitingAck = null
  // 合成期间点的跳过，等合成完再消费
  let skipRequested = false
  let currentText = ''
  let state = 'idle' // idle | loading | playing

  /** 放行等待中的播报，返回「当时确实在播」 */
  const release = () => {
    const r = waitingAck
    waitingAck = null
    if (r) r()
    return Boolean(r)
  }

  return {
    queue,

    get busy() {
      return busy
    },
    get queued() {
      return queue.length
    },
    get state() {
      return state
    },
    get text() {
      return currentText
    },

    setBusy(v) {
      busy = Boolean(v)
    },

    /** 开始处理一条：清掉上一轮可能残留的跳过标记 */
    begin(text) {
      skipRequested = false
      currentText = String(text || '').slice(0, 200)
      state = 'loading'
    },

    markPlaying() {
      state = 'playing'
    },

    /** 合成完了才调用：这期间被点过跳过就丢弃这条 */
    consumeSkip() {
      if (!skipRequested) return false
      skipRequested = false
      state = 'idle'
      currentText = ''
      return true
    },

    /** 等渲染进程播完（或 30 秒兜底），返回 Promise */
    waitPlayback() {
      return new Promise((resolve) => {
        waitingAck = resolve
        setTimeout(() => {
          if (waitingAck === resolve) {
            waitingAck = null
            resolve()
          }
        }, 30000)
      })
    },

    ack() {
      return release()
    },

    /**
     * 点「跳过」。
     * 返回 skipped=true 表示当时确实在播、已放行；
     * pending=true 表示还在合成，标记已打上，马上就会丢掉。
     */
    requestSkip() {
      const wasPlaying = release()
      if (wasPlaying) {
        state = 'idle'
        currentText = ''
        return { skipped: true, pending: false, queued: queue.length }
      }
      // 只有「确实在合成但还没播出来」才值得打标记；
      // 闲着的时候打了标记会一直挂着，把下一条新播报也误丢掉
      if (busy) skipRequested = true
      return { skipped: false, pending: busy, queued: queue.length }
    },

    /** 清空待播队列，当前这条也一起跳过 */
    clearQueue() {
      const n = queue.length
      queue.length = 0
      const wasPlaying = release()
      if (!wasPlaying && busy) skipRequested = true
      state = 'idle'
      currentText = ''
      return { cleared: n, skipped: wasPlaying }
    },

    finish() {
      state = 'idle'
      currentText = ''
    },

    /** 给渲染进程的状态快照：切页面之后也能知道现在在念什么 */
    snapshot() {
      return {
        queued: queue.length,
        busy,
        playing: Boolean(waitingAck),
        state,
        text: currentText,
      }
    },
  }
}

module.exports = { createSpeechControl }
