'use strict'

/**
 * 「队列堆积时加速朗读」的状态机。
 *
 * 单独拎出来的理由和 speech-control 一样：这里全是时间相关的边界，靠真机很难复现 ——
 * 要等 30 秒、要看队列长度、还要卡在「刚好读完」的那一刻。抽成纯状态机之后
 * scripts/smoke.cjs 可以注入假定时器，把整套时序一次跑完。
 *
 * 三条规则：
 *  1. 待念条数（含正在念的这条）达到 threshold → 进加速；
 *  2. 一旦进了加速，**不会**因为队列变短就立刻退出 —— 只在「队列读空 + holdMs 内
 *     没有新需求」时才退出。否则一快一慢来回抖，听着比慢还难受；
 *  3. 读空后 holdMs 内又来了新需求 → 重新计时，仍然是加速。
 */

/** 把配置整理成可用形状。手改坏的配置文件不该让播报变成 3 倍速 */
function normalizeCatchUp(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const rate = Number(c.rate)
  const hold = Number(c.holdSec)
  return {
    enabled: c.enabled !== false,
    // 下限 2：堆 1 条就加速没有意义，那是正常播报
    threshold: Math.max(2, Math.round(Number(c.threshold) || 5)),
    rate: Math.min(3, Math.max(1, Number.isFinite(rate) && rate > 0 ? rate : 1.5)),
    holdMs: Math.max(0, Number.isFinite(hold) && hold >= 0 ? hold : 30) * 1000,
  }
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.setTimeout]  注入假定时器（smoke 用）
 * @param {Function} [opts.clearTimeout]
 */
function createCatchUp(opts = {}) {
  const setTimer = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimeout || ((t) => clearTimeout(t))

  let active = false
  let timer = null

  const cancelHold = () => {
    if (timer) {
      clearTimer(timer)
      timer = null
    }
  }

  return {
    get active() {
      return active
    },

    /** 有新的东西要念：静默期从头算（别在刚加速完一句就把人打回原速） */
    noteDemand() {
      cancelHold()
    },

    /**
     * 这条该用多快的速度播。
     * @param {number} pending 队列里还没念的条数（不含正在念的这条）
     * @param {object} cfg normalizeCatchUp 的结果
     */
    rateFor(pending, cfg) {
      if (!cfg.enabled) {
        cancelHold()
        active = false
        return 1
      }
      // 队里已经堆了几条在等，本身就是该加速的信号，不用等把它也取出来才发现
      if (Number(pending) + 1 >= cfg.threshold) active = true
      return active ? cfg.rate : 1
    },

    /**
     * 一条处理完了（含被丢弃的）。队列空了才开始数静默期。
     * 注意 active 在这里**只增不减** —— 退出只走定时器，见开头第 2 条规则。
     */
    afterSpeech(pending, cfg) {
      if (!cfg.enabled || !active) return
      if (Number(pending) > 0) return
      cancelHold()
      timer = setTimer(() => {
        timer = null
        active = false
      }, cfg.holdMs)
    },

    reset() {
      cancelHold()
      active = false
    },

    /** 测试用：现在有没有挂着的静默计时 */
    hasHold() {
      return Boolean(timer)
    },
  }
}

module.exports = { createCatchUp, normalizeCatchUp }
