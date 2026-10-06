'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { app, safeStorage } = require('electron')

const FILE_NAME = 'chatsparty.enc'

const DEFAULTS = {
  room: {
    roomId: '',
    realRoomId: 0,
    title: '',
    anchor: '',
    // 本房间主播的 uid。弹幕包里没有「我是主播」的标记，
    // 开了「需要粉丝牌」之后要靠它把主播本人放行（见 main.cjs 的 isPrivileged）
    anchorUid: 0,
    autoConnect: false,
  },
  credentials: {
    SESSDATA: '',
    bili_jct: '',
    DedeUserID: '',
    buvid3: '',
    buvid4: '',
    refreshToken: '',
    savedAt: 0,
  },
  tts: {
    provider: 'mimo',
    protocol: 'chat-completions',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    apiKey: '',
    model: 'mimo-v2.5-tts',
    voice: 'mimo_default',
    format: 'wav',
    speed: 1,
    pitch: '+0Hz',
    stylePrompt: '用自然、轻快、亲切的口吻朗读直播弹幕，语速适中，咬字清晰。',
    enabled: true,
    volume: 0.9,
    maxLength: 60,
    minIntervalMs: 700,
    perUserCooldownMs: 8000,
    mergeDuplicate: true,
    readUsername: true,
    readGift: true,
    readGuard: true,
    readSuperchat: true,
    readEnter: false,
    blockWords: '',
    /**
     * 合成缓存：同一套音色 + 同一句话只向服务请求一次。
     * ttlMs 是「自从最后一次用到它」起算的保留时长 —— 每命中一次就刷新时间戳（滑动过期），
     * 所以常说的话会被一直续期，冷下来的自然过期。默认 7 天，最多占 200 MB。
     */
    cache: { enabled: true, ttlMs: 7 * 24 * 60 * 60 * 1000, maxMB: 200 },
  },
  theme: {
    seed: '#6750A4',
    mode: 'dark',
    contrast: 0,
    // 动效方案：standard = 克制（基线 M3 观感），expressive = M3E 弹簧 + 位移表达
    motion: 'expressive',
  },
  overlay: {
    enabled: true,
    // 用户主动点过「停止」才在下次启动时不自动拉起
    userStopped: false,
    port: 12450,
    maxItems: 40,
    showFace: true,
    showMedal: true,
    showGift: true,
    showSuperchat: true,
    // 点歌面板：关掉就只出弹幕。位置与队列条数也是主播自己定的
    showMusic: true,
    musicPos: 'tl',
    musicQueueCount: 3,
    customCss: '',
    fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
    accent: '#D0BCFF',
  },
  danmaku: {
    sendColor: 16777215,
    sendFontSize: 25,
    sendMode: 1,
    // 弹幕列表是否自动滚到底部。存进配置，切走再回来不该被重置
    autoScroll: true,
  },
  // 已经在库里注册过的音色档案。平台名 + 音色 id（或 MiMo 的音色描述）是它的全部内容
  voiceLibrary: [],
  // { [uid]: profileId } —— 观众自助绑定的结果
  voiceBindings: {},
  // 文本大模型：只用来给「#设计 描述」扩写音色描述，不参与朗读
  llm: {
    provider: 'deepseek',
    baseUrl: '',
    apiKey: '',
    model: 'deepseek-chat',
    enabled: true,
    // 扩写用的提示词模板，含上面那条公式；改坏了可以用界面上的「恢复默认」
    promptTemplate: '',
    temperature: 0.8,
    // 推理模型的思考过程占 max_tokens 预算，给小了正文会空 —— 见 llm.cjs DEFAULT_MAX_TOKENS
    maxTokens: 1200,
    // 关掉模型思考：写音色描述不需要推理，思考只会吃预算、拖慢速度，还会让输出被掐断
    noThink: true,
    timeoutMs: 20000,
  },
  // 各音色平台的独立密钥。MiMo 复用 tts.apiKey，这两家得单独给
  platformKeys: { fish: '', openai: '' },
  // 平台接口地址。留空用默认；被墙 / 要走中转时在这里改成镜像地址
  platformBase: { fish: '', openai: '' },
  // 平台模型。留空 = 用音色档案里记的那个；填了就全局生效（换模型不用重新注册音色）
  platformModel: { fish: '' },
  // 外网请求怎么走：auto = 需要代理的平台走系统代理，其余直连
  proxy: { mode: 'auto' },
  voicePolicy: {
    enabled: true,
    prefix: '#',
    requireMedal: false,
    minMedalLevel: 1,
    allowBind: true,
    allowDesign: true,
    allowSearch: true,
    allowUnbind: true,
    // 弹幕搜索时去哪些平台现查。MiMo / OpenAI 没有开放列表接口，走文档里的原生名单过滤
    searchSources: ['mimo', 'fish', 'edge'],
    searchLimit: 6,
    maxAudienceVoices: 50,
    dailyDesignLimit: 20,
    cooldownMs: 5000,
    replyInChat: true,
    fallbackToDefault: true,
  },
  /**
   * 弹幕指令叫法。改这里就能改观众发什么词触发，不用改代码。
   * 每类给一串叫法，逗号分隔；**第一个是「正名」**，帮助信息里显示的就是它。
   * 与 electron/voices.cjs 的 COMMAND_ALIASES 保持同步（smoke 里有断言盯着）。
   */
  commands: {
    voice: {
      query: ['我的音色', '音色', '当前音色', '查音色', 'voice', 'myvoice'],
      list: ['音色列表', '搜音色', '音色库', '音色搜索', '搜声音', 'list', 'voices', 'search'],
      bind: ['绑定', '用', '换成', '我要', '选', 'bind', 'use'],
      design: ['设计', '定制', '造一个', '创建音色', 'design', 'create'],
      unbind: ['删除音色', '解绑', '取消音色', '恢复默认音色', 'unbind', 'reset'],
      help: ['帮助音色', '音色帮助', '怎么换音色', '音色怎么用', 'help'],
    },
  },
  // 网易云点歌。接口实现见 electron/netease.cjs（自写，不依赖第三方服务）
  music: {
    enabled: true,
    // 观众在弹幕里发「点歌 歌名」触发；改成就改这里（逗号分隔可多个）
    commands: ['点歌', '点首歌'],
    // 有人点歌后自动开播；关掉则只进队列，等主播在音乐页点播放
    autoPlay: true,
    // 128000 / 192000 / 320000
    br: 320000,
    volume: 0.6,
    maxQueue: 20,
    // 同一个人多久才能再点一首，防止一个人刷满歌单
    perUserCooldownMs: 30000,
    maxKeywordLength: 30,
    // 点歌成功时用 TTS 念一句「谁点了什么」
    announce: true,
    // 在直播间弹幕里回执
    replyInChat: true,
    // 填自己的网易云 Cookie 可以解锁会员音质和灰色歌曲。留空用匿名身份，大部分歌也能播
    cookie: '',
  },
  window: { width: 1180, height: 780 },
}

/**
 * 这些配置段是「键 → 值」的字典，键本身由用户增删改（比如 uid → 音色档案）。
 *
 * 必须整体替换，不能深合并 —— 深合并只看补丁里有什么，**删掉的键不会消失**：
 *   base = { 123: 'a', 456: 'b' }，patch = { 123: 'a' }  →  456 还在
 * 于是「解绑」「清理失效绑定」这类操作点了没反应：写是写了，读回来还是老样子。
 *
 * 只有 voiceBindings 需要这套语义。platformKeys / platformBase 这类同样是字典，
 * 但界面上永远是「只改其中一项」地打补丁（patch({platformKeys:{fish:v}})），
 * 而且它们也不需要真的删键 —— 清空写成空串就够了。把它们列进来的话，
 * 改 Fish 的 Key 会把 OpenAI 的 Key 一起抹掉。
 *
 * 数组不受影响（数组本来就整体替换），普通配置段（music / overlay 之类）
 * 保持合并语义，免得只改一项就把同段其他默认值冲掉。
 */
const REPLACE_WHOLE = new Set(['voiceBindings'])

/** 弹幕指令的六类动作。界面上按这个顺序排，解析时也只认这几类 */
const VOICE_COMMAND_KINDS = ['query', 'list', 'bind', 'design', 'unbind', 'help']

/**
 * 把界面传来的指令名收拾干净。
 * 用户可能粘一整串「绑定,换音色，用」进来，也可能某一类留空 ——
 * 这里统一成去空格、去空项、去重复（忽略大小写）的字符串数组。
 * 返回空数组是合法的，意思是「这类指令停用」，解析层会看到并跳过。
 */
function normalizeCommandNames(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[,，、\n]/)
  const out = []
  for (const raw of arr) {
    const s = String(raw ?? '').trim()
    if (!s) continue
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s)
  }
  return out
}

function deepMerge(base, patch, key = '') {
  const out = Array.isArray(base) ? [...base] : { ...base }
  if (!patch || typeof patch !== 'object') return out
  for (const [k, v] of Object.entries(patch)) {
    if (REPLACE_WHOLE.has(k)) {
      // 字典段：以补丁为准，缺的键就是被删掉了
      if (v === null || typeof v !== 'object' || Array.isArray(v)) out[k] = {}
      else out[k] = { ...v }
      continue
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v, k)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  void key
  return out
}

class ConfigStore {
  constructor() {
    this.file = path.join(app.getPath('userData'), FILE_NAME)
    this.data = deepMerge(DEFAULTS, {})
    this.loadError = null
    this.saveError = null
    this.load()
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = fs.readFileSync(this.file)
      const text = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString('utf8')
      this.data = deepMerge(DEFAULTS, JSON.parse(text))
      this.migrate()
      this.loadError = null
    } catch (e) {
      this.loadError = e.message || String(e)
      this.data = deepMerge(DEFAULTS, {})
    }
  }

  /**
   * 老配置的默认值已经不再合适时，在这里就地升级。
   * 只动「正好等于旧默认值」的字段 —— 用户自己改过的值一律不动。
   */
  migrate() {
    const l = this.data?.llm
    if (l && Number(l.maxTokens) === 320) {
      // 320 是给非推理模型定的旧默认。会思考的模型光推理就烧掉 288~320 个 token，
      // 预算全被吃掉 → 正文为空 → 扩写静默失效。统一抬到 1200
      l.maxTokens = DEFAULTS.llm.maxTokens
    }
    // Fish 换过两轮平台，模型 id 也跟着变了：fishaudio-* 是 fishaudio.org 那套，
    // 留着的话每次合成都要先白撞一次 402 才落回免费档。这里直接换成新平台的默认。
    const pm = this.data?.platformModel
    if (pm && /^fishaudio-/i.test(String(pm.fish || ''))) pm.fish = ''
    // 同理，接口地址如果还指着上一家平台，合成一定 401，清掉让它走默认
    const pb = this.data?.platformBase
    if (pb && /fishaudio\.org/i.test(String(pb.fish || ''))) pb.fish = ''
  }

  /**
   * 留一份上一版的快照。
   * 配置里最贵的不是密钥，是用户一个个攒出来的音色库和房间设置 ——
   * 一旦被误写（比如另一个实例拿旧状态整份盖回来），没有备份就只能重来。
   * 只保留最近一份，且 5 分钟内不重复留，避免每次改设置都复制一遍。
   */
  backup() {
    try {
      if (!fs.existsSync(this.file)) return
      const bak = `${this.file}.bak`
      if (fs.existsSync(bak) && Date.now() - fs.statSync(bak).mtimeMs < 5 * 60 * 1000) return
      fs.copyFileSync(this.file, bak)
    } catch {
      /* 备份失败不能影响保存本身 */
    }
  }

  /**
   * 原子写：先写临时文件再 rename。
   * 直接 writeFileSync 的话，进程在写入过程中被杀掉会留下截断的文件，
   * 下次启动 JSON 解析失败 → 整个配置回退默认值（凭据也就跟着没了）。
   */
  save() {
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      const text = JSON.stringify(this.data)
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const buf = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(text)
        : Buffer.from(text, 'utf8')
      this.backup()
      fs.writeFileSync(tmp, buf)
      fs.renameSync(tmp, this.file)
      try {
        fs.chmodSync(this.file, 0o600)
      } catch {
        /* Windows 上无意义，忽略 */
      }
      this.saveError = null
      return true
    } catch (e) {
      this.saveError = e.message || String(e)
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* 临时文件本来就没写成功 */
      }
      console.error('[store] 保存失败', e)
      return false
    }
  }

  get() {
    return this.data
  }

  patch(partial) {
    // 指令名是用户手打的，先按「逗号分隔的一串叫法」收拾干净再落盘，
    // 免得解析时拿「绑定 , 换音色」这种带空格的字符串去比对，永远匹配不上
    // 不就地改调用方传进来的对象 —— sanitize 之类的后置逻辑还要读它
    let next = partial || {}
    if (next.commands && next.commands.voice && typeof next.commands.voice === 'object') {
      const voice = {}
      for (const kind of VOICE_COMMAND_KINDS) {
        if (next.commands.voice[kind] === undefined) continue
        const names = normalizeCommandNames(next.commands.voice[kind])
        // 清空 = 恢复内置叫法。留成空数组等于让这条指令彻底失联，
        // 而主播在界面上把输入框删空，多半只是想重来，不是想关掉它。
        voice[kind] = names.length ? names : [...(DEFAULTS.commands.voice[kind] || [])]
      }
      next = { ...next, commands: { ...next.commands, voice } }
    }
    // 点歌触发词同理：删空了就没人能点歌了，补回默认
    const mc = next.music && next.music.commands
    if (mc !== undefined) {
      const list = normalizeCommandNames(mc)
      const final = list.length ? list : [...DEFAULTS.music.commands]
      if (JSON.stringify(final) !== JSON.stringify(mc)) next = { ...next, music: { ...next.music, commands: final } }
    }
    this.data = deepMerge(this.data, next)
    this.save()
    return this.data
  }

  reset() {
    this.data = deepMerge(DEFAULTS, {})
    this.save()
    return this.data
  }
}

module.exports = { ConfigStore, DEFAULTS, VOICE_COMMAND_KINDS, normalizeCommandNames }
