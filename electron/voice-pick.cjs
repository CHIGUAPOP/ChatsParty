'use strict'

/**
 * 「谁在选音色」提示面板的队列。
 *
 * 观众发 `#音色列表 御姐` → 候选摆到直播画面上；随后 `#绑定 2` → 把选中那条标出来。
 * 这里只管「什么时候该显示哪一条」，不管长什么样 —— 所以不 require electron，
 * `scripts/smoke.cjs` 能直接拿去测。
 *
 * 规则（主播定的）：
 *  - 一次只显示一条，默认 8 秒；
 *  - 同时来了多条就**排队依次**显示，不叠加、不互相覆盖；
 *  - 被绑定的那条要**重新计满 8 秒** —— 否则可能刚标上就消失，观众根本没看见；
 *  - 队列有上限。OBS 没开的时候面板推不出去，没人消费，不能让它无限攒着。
 */

const DEFAULT_TTL_MS = 8000
const MAX_QUEUE = 12
/** 面板上最多列几条候选。列太多会顶掉弹幕那一段，而且没人会看第 7 条 */
const MAX_HITS = 6

let seq = 0

function createPickQueue(opts = {}) {
  /** @type {Array<object>} 队首是正在显示的那条 */
  const queue = []
  let ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS

  function setTtl(v) {
    const n = Number(v)
    if (n > 0) ttlMs = n
  }

  /**
   * 丢掉已经过期的，并让新的队首开始计时。
   * 计时是**懒启动**的（shownAt 为 null 时才补上当前时间）—— 排队等着的那几条
   * 不该在还没露过面的时候就把 8 秒耗掉。
   * @returns {boolean} 队列有没有变化（主进程据此决定要不要推一帧）
   */
  function prune(now) {
    let changed = false
    while (queue.length && queue[0].shownAt != null && now - queue[0].shownAt >= ttlMs) {
      queue.shift()
      changed = true
    }
    if (queue.length && queue[0].shownAt == null) {
      queue[0].shownAt = now
      changed = true
    }
    return changed
  }

  /**
   * 有人搜了一批音色。
   * @param {{uid?:string|number, who?:string, keyword?:string, hits?:Array}} item
   */
  function push(item = {}) {
    const entry = {
      id: 'pick-' + ++seq,
      uid: String(item.uid == null ? '' : item.uid),
      who: String(item.who || '').slice(0, 24),
      keyword: String(item.keyword || '').slice(0, 24),
      hits: (Array.isArray(item.hits) ? item.hits : []).slice(0, MAX_HITS).map((h, i) => ({
        n: i + 1,
        name: String(h && h.name ? h.name : '').slice(0, 24),
        source: String((h && h.source) || '').slice(0, 16),
        hint: String((h && h.hint) || '').slice(0, 40),
        registered: Boolean(h && h.registered),
        disabled: Boolean(h && h.disabled),
      })),
      picked: 0,
      failed: '',
      shownAt: null,
    }
    // 同一个人连着搜第二次：把上一条还没结果的换掉。
    // 不换的话他会在自己的旧列表后面排队，而旧列表他已经不要了。
    const dup = queue.findIndex((q) => q.uid && q.uid === entry.uid && !q.picked && !q.failed)
    if (dup >= 0) queue.splice(dup, 1)
    queue.push(entry)
    while (queue.length > MAX_QUEUE) queue.shift()
    return entry
  }

  /**
   * 这个人选完了（或失败了）。从后往前找他最近一条还没结果的。
   * @param {string|number} uid
   * @param {{n?:number, failed?:string}} result n 是候选里的序号（1 起）
   */
  function resolve(uid, result = {}) {
    const key = String(uid == null ? '' : uid)
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i]
      if (q.uid !== key || q.picked || q.failed) continue
      if (result.failed) q.failed = String(result.failed).slice(0, 40)
      else {
        const n = Math.floor(Number(result.n))
        q.picked = Number.isFinite(n) && n >= 1 ? n : 0
      }
      // 标上了就重新计满：不然可能刚标完就到点消失了
      q.shownAt = Date.now()
      return q
    }
    return null
  }

  /** 给叠加层的一帧。panel 为 null = 现在没人在选，把面板藏掉 */
  function snapshot(now = Date.now()) {
    prune(now)
    const head = queue[0]
    if (!head) return { panel: null, waiting: 0 }
    return {
      panel: {
        id: head.id,
        who: head.who,
        keyword: head.keyword,
        hits: head.hits,
        picked: head.picked,
        failed: head.failed,
        // 叠加层按这个跑进度条，跟主进程这边的过期时间对得上
        ttlMs,
      },
      waiting: queue.length - 1,
    }
  }

  return {
    push,
    resolve,
    prune,
    snapshot,
    setTtl,
    size: () => queue.length,
    clear: () => {
      queue.length = 0
    },
  }
}

module.exports = { createPickQueue, DEFAULT_TTL_MS, MAX_QUEUE, MAX_HITS }
