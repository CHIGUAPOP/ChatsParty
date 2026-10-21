/** 一张表情图片。w/h 是 B 站给的原始尺寸（0 表示没给），渲染时只用高度 */
export interface EmoticonItem {
  url: string
  w?: number
  h?: number
}

/** 表情图册：归一后的表情名 → 图片。名字已剥掉方括号，同一份里也留了小写键 */
export type EmoticonBook = Record<string, EmoticonItem>

export interface LiveEvent {
  id?: string
  type: 'danmaku' | 'gift' | 'guard' | 'superchat' | 'enter' | 'live' | 'offline' | 'other'
  uid?: number
  username?: string
  face?: string
  content?: string
  medal?: { name: string; level: number; anchorName: string; color: number } | null
  level?: number
  isAdmin?: boolean
  color?: number
  giftName?: string
  num?: number
  price?: number
  emots?: Record<string, { url: string; width?: number; height?: number }> | null
  emojiUrl?: string
  timestamp?: number
}

export interface AppConfig {
  room: { roomId: string; realRoomId: number; title: string; anchor: string; anchorUid: number; autoConnect: boolean }
  credentials: {
    SESSDATA: string
    bili_jct: string
    DedeUserID: string
    buvid3: string
    buvid4: string
    refreshToken: string
    savedAt: number
  }
  tts: {
    provider: string
    protocol: string
    baseUrl: string
    apiKey: string
    model: string
    voice: string
    format: string
    speed: number
    pitch: string
    /** 全局默认音色也可以是设计 / 克隆出来的，这时靠下面三样驱动，不看 voice */
    mimoMode?: 'preset' | 'design' | 'clone'
    designPrompt?: string
    cloneFile?: string
    stylePrompt: string
    enabled: boolean
    volume: number
    maxLength: number
    minIntervalMs: number
    perUserCooldownMs: number
    mergeDuplicate: boolean
    readUsername: boolean
    /** B站默认昵称（bili_3706983133743519 这类）不念数字，改念 defaultUserName */
    renameDefaultUser: boolean
    defaultUserName: string
    readGift: boolean
    readGuard: boolean
    readSuperchat: boolean
    readEnter: boolean
    blockWords: string
    /**
     * 观众只发一个标点时（「？」「！」）换成对应语气的语气词再念 —— 孤立符号 TTS 念出来是静音。
     * tones 是主播自己写的那张表（每行「符号 词1 词2 …」，随机抽一个），留空用 builtinTones。
     */
    interjection?: {
      enabled?: boolean
      tones?: string
      /** 内置表（只读）。界面在 tones 为空时按它显示，「恢复内置默认」就是清空 tones */
      builtinTones?: string
      ellipsis?: boolean
    }
    /** 合成缓存：同一套音色 + 同一句话只请求一次，TTL 内复用并刷新时间戳 */
    cache: { enabled: boolean; ttlMs: number; maxMB: number }
    /**
     * 合成失败（超时 / 断网 / 额度用完 / 平台 5xx）时自动换免费嗓子把这句念完 ——
     * 别让直播间因为一个平台抽风就整段静音。Key 填错（401/403）不回退。
     */
    fallback?: {
      enabled?: boolean
      /** edge（免费·免密钥）或 system（本地·离线） */
      provider?: 'edge' | 'system'
      voice?: string
      /** 触发后多久之内不再去撞原平台（ms） */
      cooldownMs?: number
    }
  }
  theme: { seed: string; mode: 'light' | 'dark'; contrast: number; motion?: 'standard' | 'expressive' }
  overlay: {
    enabled: boolean
    userStopped?: boolean
    port: number
    maxItems: number
    showFace: boolean
    showMedal: boolean
    showGift: boolean
    showSuperchat: boolean
    showMusic?: boolean
    musicPos?: string
    musicQueueCount?: number
    danmakuPos?: string
    /**
     * 气泡塞不下时，最老那条往哪边滑出去并淡出。
     * natural = 朝离角落最远的那一侧（贴底往上、贴顶往下），或强制 up / down。
     */
    danmakuOverflow?: 'natural' | 'up' | 'down'
    customCss: string
    /** 界面整体大小百分比（50–200），乘在所有尺寸上 */
    scale?: number
    /** 字体大小百分比（50–200），在整体缩放之上再乘一次字号 */
    fontSize?: number
    showLyric?: boolean
    /** 歌词位置：tc / bc 上下居中，或 tl / tr / bl / br 四个角 */
    lyricPos?: string
    /** 同屏显示的歌词行数（含当前正在唱的那句） */
    lyricLines?: number
    /** 自动避让：画面一窄就把弹幕/点歌/歌词分到互不相交的几段里（默认开） */
    autoLayout?: boolean
    /** 音色选择面板：观众搜音色时把候选摆到直播画面上 */
    showVoicePick?: boolean
    /** 面板位置：tl / tr / bl / br 四个角（默认 tr） */
    voicePickPos?: string
    /** 面板上最多列几条候选（1–6） */
    voicePickHits?: number
    /** 每条候选在画面上存活多久（ms）。同时来了多条就按这个时长排队依次放 */
    voicePickTtlMs?: number
    /** 在线观众（高能榜）面板：常驻在画面上的一小块观众榜 */
    showViewers?: boolean
    /** 观众面板位置：tl / tr / bl / br 四个角 */
    viewersPos?: string
    /** 面板上最多列几个人（1–20） */
    viewersCount?: number
    fontFamily: string
    accent: string
  }
  /**
   * 桌面浮窗：弹幕功能区的每一块都能单独弹出成无边框小窗。
   * 弹出后那块区域在主窗口里就不再显示，收回时物归原主 —— 两边永远只有一份。
   */
  float?: {
    /** 全体浮窗共用的置顶 */
    alwaysOnTop: boolean
    /** 每个面板一份配置 */
    panels: Partial<
      Record<FloatPanel, { opened?: boolean; opacity?: number; scale?: number; bounds?: FloatBounds; showFaces?: boolean }>
    >
  }
  /** 一键准备开播：按顺序拉起本机的直播软件 */
  launchpad?: {
    /** 要拉起的程序 id，顺序就是启动顺序 */
    order: string[]
    /** Steam 库里的程序走 steam://rungameid/<appid>（关掉则直启 exe） */
    useSteam: boolean
    /** 两个程序之间隔多久 */
    gapMs: number
    /** 拉起来之后自动连上直播间 */
    autoConnect: boolean
    /** 已经在跑的就跳过，不再拉一遍 */
    skipRunning: boolean
    /** 扫描不到的手补项 */
    custom?: { id?: string; name?: string; exe: string; hint?: string }[]
  }
  danmaku: {
    sendColor: number
    sendFontSize: number
    sendMode: number
    autoScroll?: boolean
  }
  /**
   * 在线观众（B站高能榜）。
   * 只有「在线且有过互动」的人会上榜，所以它不等于观看人数 ——
   * 界面上必须说清楚，别让主播把榜上人数当成观众总数。
   */
  viewers?: {
    enabled: boolean
    /** 刷新间隔（ms）。风控下限 10 秒，改小会被主进程钳回去 */
    intervalMs: number
  }
  voiceLibrary: VoiceProfile[]
  voiceBindings: Record<string, string>
  /** 弹幕指令的叫法。每类一列，第一个是正名；留空数组 = 用内置叫法 */
  commands?: { voice?: Record<string, string[]> }
  platformKeys: { fish: string; openai: string }
  platformBase: { fish: string; openai: string }
  platformModel: { fish: string }
  llm: {
    provider: string
    baseUrl: string
    apiKey: string
    model: string
    enabled: boolean
    promptTemplate: string
    temperature: number
    maxTokens: number
    noThink: boolean
    timeoutMs: number
  }
  proxy: { mode: 'auto' | 'system' | 'direct' }
  voicePolicy: {
    enabled: boolean
    prefix: string
    requireMedal: boolean
    minMedalLevel: number
    allowBind: boolean
    allowDesign: boolean
    allowSearch: boolean
    allowUnbind: boolean
    searchSources: string[]
    searchLimit: number
    maxAudienceVoices: number
    dailyDesignLimit: number
    cooldownMs: number
    replyInChat: boolean
    fallbackToDefault: boolean
  }
  music: {
    enabled: boolean
    commands: string[]
    autoPlay: boolean
    br: number
    volume: number
    maxQueue: number
    perUserCooldownMs: number
    maxKeywordLength: number
    announce: boolean
    replyInChat: boolean
    cookie: string
  }
  /** B 站视频的声音（画面在官方内嵌播放器里，跨域碰不到它的音量） */
  video: {
    /** 自己那一路音频的音量 0~1 */
    volume: number
    muted: boolean
    /**
     * B 站视频**请求的**清晰度（qn 码，见 MusicPage 的 QUALITY_OPTIONS）。
     * 实际拿到的可能更低 —— 服务端会夹，真值看 MusicState.streamQuality。
     */
    quality?: number
  }
  window: { width: number; height: number }
  /** 关掉主界面时缩到系统托盘，后台继续收弹幕；真退出走托盘图标的右键菜单 */
  general?: { closeToTray?: boolean }
}

export interface MusicSong {
  id: number
  name: string
  alias?: string
  artists: string
  album: string
  picUrl?: string
  duration: number
  durationText: string
  playable: boolean
  maxBr: number
  fee: number
}

/** 网易云登录态。没填 Cookie 或 Cookie 失效时 loggedIn=false */
export interface MusicAccount {
  loggedIn: boolean
  nickname: string
  vip: boolean
  vipType: number
  channel: 'weapi' | 'linux'
}

/**
 * 队列里的一条。它**不一定是歌** —— B 站视频（BV 号）走的是同一条队列，
 * 用 kind 区分：歌交给网易云取音频，视频交给内嵌的 B 站官方播放器。
 */
export interface MusicQueueItem {
  /** 'song' 是老数据（没有这个字段）的默认值 */
  kind?: 'song' | 'video'
  id: number
  name: string
  artists: string
  durationText: string
  picUrl?: string
  requester?: string
  at: number
  /** 仅视频：BV 号 / cid / 总秒数（播放器按它计时推进下一首） */
  bvid?: string
  cid?: number
  duration?: number
}

/** B 站视频信息（点歌页粘 BV 号后查出来的那条） */
export interface VideoInfo {
  bvid: string
  aid: number
  cid: number
  title: string
  up: string
  pic: string
  duration: number
  durationText: string
  page: number
}

export interface MusicState {
  items: MusicQueueItem[]
  current: MusicQueueItem | null
  queued: number
  /**
   * 最后一条播放心跳（拥有播放权的窗口每 400ms 推一次，主进程存底）。
   * 新开的窗口（典型：刚弹出的音乐浮窗）挂载时靠它把镜像进度补上，
   * 否则接管播放权那一刻会被当成「换了条目」从头播。
   */
  tick?: { key: string; pos: number; dur: number; playing: boolean } | null
  /** 当前视频的整条流地址（歌没有）。浮窗与叠加层靠它播画面 */
  stream?: string | null
  /**
   * 这条流**实际拿到**的清晰度（B 站 qn 码）。
   * 选了 1080P 也可能被夹回 720P，所以显示的是它，不是设置里选的那档。
   */
  streamQuality?: number
}

export interface MusicAudio {
  id: number
  url: string
  br: number
  size: number
  type: string
  level: string
  expiresIn: number
  /** 实际拿到的音质比设置里选的低 */
  downgraded?: boolean
}

/** 高能榜上的一个人 */
export interface ViewerItem {
  uid: number
  name: string
  face: string
  /** 本场贡献值。榜单就是按它排的；不在榜上的人恒为 0 */
  score: number
  /** 0 = 没有大航海，1 总督 / 2 提督 / 3 舰长 */
  guardLevel: number
  guard: string
  /** 荣誉等级（财富等级），0 表示没有 */
  wealthLevel: number
  medal: { name: string; level: number } | null
  /**
   * 是否在高能榜上。
   *
   * false = 只是「人在房间里」，还没有过互动，所以没有贡献值、也没有排名。
   * 网页端「房间观众」里排名栏显示「-」的那批人就是这些。
   */
  onRank: boolean
}

/**
 * 在线观众快照。主进程轮询之后推过来，界面与 OBS 叠加层读的是同一份。
 *
 * items 是**两份名单合起来**的：高能榜（在线且有互动）+ 在线用户（人在房间里就算）。
 * 但仍然不等于观看人数 —— 挂着一直不动的纯潜水观众两边都不出现。
 *
 * 叠加层读的是同一份，加字段要三处一起改（这里 / main.cjs 的初始值 / overlay 的默认 cfg）。
 */
export interface ViewersState {
  ok: boolean
  roomId: number
  anchorUid: number
  /** 当前在线人数（B站给的近似值，不是「人气值」） */
  onlineNum: number
  items: ViewerItem[]
  updatedAt: number
  error: string
  /**
   * 「在线用户」那一路单独的失败原因。
   *
   * 它要登录态，高能榜不要 —— 没登录时榜还是好的，只是看不到「只看不说」的人。
   * 分开一个字段是为了不把整张榜判死，同时又能把这件事说出来。
   */
  onlineError: string
  fetching: boolean
}

/** 浮窗面板名。和 electron/float.cjs 的 FLOAT_PANELS、?float= 参数逐字一致 */
export type FloatPanel = 'danmaku' | 'viewers' | 'gifts' | 'music'

/** 浮窗记下来的位置与大小。x / y 为 null = 还没记住过；sf = 记这笔时所在屏幕的缩放 */
export interface FloatBounds {
  x: number | null
  y: number | null
  width: number
  height: number
  sf?: number | null
}

/** 桌面浮窗的实时状态。每个面板开了没有、两个旋钮现在是什么值 */
export interface FloatState {
  panels: Record<FloatPanel, { opened: boolean; opacity: number; scale: number; muted?: boolean }>
  alwaysOnTop: boolean
}

export interface VoiceSearchHit {
  id: string
  name: string
  hint?: string
  source: string
}

export interface VoiceProfile {
  id: string
  owner: 'builtin' | 'host' | 'audience'
  ownerUid?: number
  ownerName?: string
  enabled?: boolean
  name: string
  platform: string
  provider: string
  protocol: string
  baseUrl?: string
  model?: string
  voice: string
  voiceHint?: string
  format?: string
  speed?: number
  stylePrompt?: string
  mimoMode?: 'preset' | 'design' | 'clone'
  designPrompt?: string
  cloneFile?: string
  createdAt?: number
}

export interface LlmProvider {
  id: string
  label: string
  baseUrl: string
  defaultModel: string
  keyUrl: string
  note: string
}

export interface LoginInfo {
  isLogin: boolean
  mid?: number
  uname?: string
  face?: string
  level?: number
  // 本机存过凭据，但 B站已经判它失效 —— 需要重新扫码，而不是默默变成匿名
  expired?: boolean
}

interface Bridge {
  config: {
    get: () => Promise<AppConfig>
    patch: (patch: Record<string, unknown>) => Promise<AppConfig>
    reset: () => Promise<AppConfig>
    onNotice: (cb: (p: { messages: string[] }) => void) => () => void
    onChanged: (cb: (c: AppConfig) => void) => () => void
  }
  bilibili: {
    qrGenerate: () => Promise<{ qrcodeKey: string; url: string; dataUrl: string }>
    qrPoll: () => Promise<{ ok: boolean }>
    loginInfo: () => Promise<LoginInfo>
    logout: () => Promise<{ ok: boolean }>
    onQrStatus: (cb: (p: { status: string; message: string }) => void) => () => void
    onLogin: (cb: (info: LoginInfo) => void) => () => void
  }
  live: {
    start: (roomId: string) => Promise<{ ok: boolean; realRoomId?: number; title?: string; message?: string }>
    stop: () => Promise<{ ok: boolean }>
    send: (text: string) => Promise<{ ok: boolean; message?: string }>
    onEvent: (cb: (e: LiveEvent) => void) => () => void
    onStatus: (cb: (s: { status: string; message?: string; roomId?: number }) => void) => () => void
    onPopularity: (cb: (p: { popularity: number }) => void) => () => void
    onError: (cb: (e: { message: string }) => void) => () => void
    onFace: (cb: (p: { src: string; data: string }) => void) => () => void
  }
  /** 在线观众（B站高能榜）。房间没连上时返回一份空状态，不是报错 */
  viewers: {
    state: () => Promise<ViewersState>
    refresh: () => Promise<ViewersState>
    onState: (cb: (s: ViewersState) => void) => () => void
  }
  /**
   * 表情图册（名字 → 图片）。弹幕包自带的 `emots` 只覆盖一部分且键格式不统一，
   * 主进程会把直播面板 + 评论面板合并成一张全量表推过来。
   */
  emoticons: {
    get: () => Promise<EmoticonBook>
    onChanged: (cb: (book: EmoticonBook) => void) => () => void
  }
  tts: {
    providers: () => Promise<Record<string, any>>
    voices: (provider: string, force?: boolean) => Promise<{ ok: boolean; voices?: any[]; message?: string }>
    test: () => Promise<{ base64: string; mime: string; latency: number }>
    speak: (text: string) => Promise<{ ok: boolean }>
    ack: () => void
    skip: () => Promise<{ skipped: boolean; pending: boolean; queued: number }>
    clear: () => Promise<{ cleared: number }>
    queue: () => Promise<{ queued: number; busy: boolean; playing: boolean; state: string; text: string }>
    onPlay: (cb: (p: { base64: string; mime: string; text: string; meta: unknown; volume: number }) => void) => () => void
    onState: (cb: (s: { state: string; text: string }) => void) => () => void
    onError: (cb: (e: { message: string; text: string }) => void) => () => void
    /** 不是失败，是「换了个嗓子在念」这类需要主播知道一声的提示 */
    onNotice: (cb: (n: { message: string; reason?: string; provider?: string }) => void) => () => void
    onSkip: (cb: () => void) => () => void
    cacheInfo: () => Promise<TtsCacheInfo>
    cacheClear: () => Promise<{ ok: boolean; cleared: number; bytes: number }>
    cachePrune: () => Promise<{ ok: boolean; removed: number; bytes: number }>
  }
  voices: {
    search: (
      source: string,
      keyword?: string,
      opts?: { limit?: number; force?: boolean }
    ) => Promise<{ ok: boolean; voices?: VoiceSearchHit[]; errors?: string[] }>
    netcheck: (which?: string) => Promise<{
      mode: string
      results: {
        id: string
        label: string
        base: string
        dns: string
        ip: string
        tcp: string
        http: number | null
        ok: boolean
        message: string
      }[]
    }>
    library: () => Promise<{ library: VoiceProfile[]; bindings: Record<string, string> }>
    keycheck: (source: string) => Promise<{
      ok: boolean
      source: string
      label: string
      key: { len: number; fp: string; empty: boolean }
      status: number
      message: string
      // Fish 专用：真合成实测的结果
      workingModel?: string
      readOnly?: number | null
      tried?: { model: string; status: number; message: string }[]
    }>
    add: (source: string, voice: { id: string; name?: string; hint?: string }) => Promise<VoiceProfile>
    save: (profile: Partial<VoiceProfile> & { id: string }) => Promise<VoiceProfile | null>
    remove: (id: string) => Promise<{ ok: boolean }>
    bind: (uid: number | string, profileId: string | null) => Promise<{ ok: boolean }>
    unbind: (uid: number | string) => Promise<{ ok: boolean }>
    /** 把库里的音色设成全局默认（所有人共用的那条嗓子） */
    useAsDefault: (id: string) => Promise<{ ok: boolean; tts: AppConfig['tts'] }>
    test: (payload: { profileId?: string; source?: string; voice?: any }) => Promise<{ latency: number }>
    onChanged: (cb: (p: { library: VoiceProfile[]; bindings: Record<string, string> }) => void) => () => void
  }
  music: {
    search: (keyword: string, limit?: number) => Promise<MusicSong[]>
    url: (id: number) => Promise<MusicAudio>
    lyric: (id: number) => Promise<{ lrc: { time: number; text: string }[]; raw: string }>
    /** 上报歌词进度（不按帧，只在换歌 / 换行 / 播放状态变化时调） */
    lyricSync: (p: {
      songId: number
      lines?: { time: number; text: string }[]
      index: number
      playing: boolean
    }) => Promise<void>
    check: () => Promise<{
      ok: boolean
      song: MusicSong
      audio: MusicAudio
      account: MusicAccount
      channel: string
      latency: number
    }>
    account: () => Promise<MusicAccount>
    /** 开一个窗口让用户登录网易云官网，登录成功会自动保存 Cookie */
    login: () => Promise<{ ok: boolean; opened?: boolean; message?: string }>
    loginCancel: () => Promise<void>
    onLogin: (cb: (r: { ok: boolean; cookie?: string; nickname?: string; vip?: boolean; cancelled?: boolean; message?: string }) => void) => () => void
    state: () => Promise<MusicState>
    enqueue: (song: MusicSong, requester?: string) => Promise<{ ok: boolean; position?: number; reason?: string }>
    /** 查一条 B 站视频（BV 号或链接） */
    videoInfo: (text: string) => Promise<VideoInfo>
    /** B 站视频入同一条队列 */
    enqueueVideo: (v: VideoInfo, requester?: string) => Promise<{ ok: boolean; position?: number; reason?: string }>
    /**
     * B 站视频的**整条播放地址**（platform=html5，音视频混流的 mp4）。
     * 原生 <video> 直接播它 —— 画面和声音从同一个元素出。
     */
    videoAudio: (v: { bvid?: string; cid?: number }) => Promise<{ url: string; quality?: number }>
    /**
     * 跨窗口播放权（见 music-engine 顶部说明）：同一时刻只有一个窗口真正出声。
     * 拥有者把当前进度当心跳推出去，其余窗口照着镜像；非拥有者的
     * 播放/暂停/拖进度转发给拥有者去执行。
     */
    tickPush: (p: { key?: string; pos: number; dur: number; playing: boolean }) => void
    onTick: (cb: (p: { pos: number; dur: number; playing: boolean }) => void) => () => void
    remote: (cmd: { type: 'toggle' } | { type: 'seek'; sec: number }) => void
    onRemote: (cb: (cmd: { type: 'toggle' } | { type: 'seek'; sec: number }) => void) => () => void
    /** 视频清晰度被改了：主进程喊一声，渲染层丢掉本地缓存的流并按新清晰度重取（进度接回原处） */
    onReload: (cb: () => void) => () => void
    play: () => Promise<MusicState>
    next: () => Promise<MusicState>
    remove: (index: number) => Promise<MusicState>
    clear: () => Promise<MusicState>
    onState: (cb: (s: MusicState) => void) => () => void
  },
  llm: {
    providers: () => Promise<{
      providers: LlmProvider[]
      formula: string
      template: string
    }>
    models: () => Promise<{
      ok: boolean
      provider: string
      label: string
      base: string
      models: string[]
      status?: number
      message: string
    }>
    check: () => Promise<{
      ok: boolean
      provider: string
      models: string[]
      status?: number
      message: string
    }>
    expand: (rough: string) => Promise<{
      ok: boolean
      used: boolean
      text: string
      raw?: string
      model?: string
      message?: string
    }>
  }
  overlay: {
    start: () => Promise<{ ok: boolean; port?: number; message?: string }>
    stop: () => Promise<{ ok: boolean }>
    /** 不带参数 = 打开「全部」那个地址；带面板名 = 只开那一块（/overlay/lyric 这种） */
    open: (panel?: string) => Promise<{ ok: boolean }>
    test: () => Promise<{ ok: boolean; clients: number }>
    selfcheck: () => Promise<{
      ok: boolean
      url: string
      running: boolean
      port: number
      clients: number
      http?: number
      message: string
    }>
    onStatus: (cb: (s: { enabled: boolean; port: number; url?: string; clients: number; error?: string }) => void) => () => void
  }
  /** 桌面浮窗：弹幕/观众/礼物/音乐四块，各自弹出为独立小窗（M3 风格） */
  float: {
    state: () => Promise<FloatState>
    open: (panel: FloatPanel) => Promise<{ ok: boolean; message?: string }>
    close: (panel: FloatPanel) => Promise<{ ok: boolean }>
    /** 浮窗里的设置弹层用：改不透明度 / 字体大小，当场生效 */
    set: (
      panel: FloatPanel,
      patch: { opacity?: number; scale?: number; muted?: boolean },
    ) => Promise<{ ok: boolean }>
    /** 开关、拖拽、关窗都会推一帧，界面据此把圆点/占位摆到正确的位置 */
    onState: (cb: (s: FloatState) => void) => () => void
  }
  app: {
    exportLog: () => Promise<{ ok: boolean; path?: string }>
    diagnostics: () => Promise<Diagnostics>
    info: () => Promise<AppInfo>
    openExternal: (url: string) => Promise<{ ok: boolean; message?: string }>
  }
  launchpad: {
    /** 现扫本机的直播相关程序（只读，不启动任何东西） */
    scan: (opts?: { force?: boolean }) => Promise<LaunchpadScan>
    /** 一键拉起，并按配置连上直播间 */
    run: (payload?: {
      order?: string[]
      useSteam?: boolean
      skipRunning?: boolean
      gapMs?: number
      connect?: boolean
      roomId?: string
      rescan?: boolean
    }) => Promise<LaunchpadRunResult>
    /** 手补一个扫描不到的程序 */
    pickExe: () => Promise<{ ok: boolean; exe?: string; name?: string }>
    onProgress: (cb: (p: LaunchpadProgress) => void) => () => void
  }
}

/** 「一键准备开播」扫到的一个程序 */
export interface LaunchpadApp {
  id: string
  name: string
  hint: string
  /** capture=推流/录制，avatar=虚拟形象，tracking=面捕，audio=音频设备，custom=手补 */
  kind: string
  origin: 'steam' | 'external' | 'custom'
  appid: string
  exe: string
  /** 有 appid 但没扫到 exe：装是装了，得手动指定 */
  exeMissing?: boolean
  /** 直启时要带的参数（比如 VTS 官方的 -nosteam） */
  nosteamArg?: string
  installdir?: string
  library?: string
  version?: string
  role?: string
  /**
   * 它要求管理员权限（manifest 里写着 requireAdministrator，直播姬就是这样）。
   * 启动时必须由系统弹一次 UAC，用户点「是」才起得来 —— 没有别的办法。
   */
  elevate?: boolean
  /** 现在是不是已经在跑。null = 查不到（当作未知，不影响启动） */
  running?: boolean | null
}

export interface LaunchpadScan {
  ok: boolean
  message?: string
  steamRoot?: string
  steamExe?: string
  libraries?: string[]
  errors?: string[]
  apps?: LaunchpadApp[]
}

export interface LaunchpadStep {
  id: string
  name: string
  status: 'pending' | 'running' | 'started' | 'skipped' | 'failed'
  message: string
  mode?: string
}

export interface LaunchpadProgress {
  steps: LaunchpadStep[]
  index: number
  connecting?: boolean
}

export interface LaunchpadRunResult {
  ok: boolean
  message?: string
  steps: LaunchpadStep[]
  connect?: { ok: boolean; realRoomId?: number; title?: string; message?: string } | null
}

/** 「关于」页展示的版本与运行时信息。version 由主进程的 app.getVersion() 给 */
export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
}

/** TTS 合成缓存的统计与当前策略 */
export interface TtsCacheInfo {
  enabled: boolean
  ttlMs: number
  maxBytes: number
  /** 累计省下的合成次数 */
  hits: number
  /** 累计写入条目次数 */
  putCount: number
  entries: number
  bytes: number
  oldestSavedAt: number
  newestSavedAt: number
  dir: string
}

export interface Diagnostics {
  hasCredentials: boolean
  savedAt: number
  uid: string
  loadError: string
  saveError: string
  logPath: string
  backupPath?: string
  voiceCount?: number
  bindingCount?: number
}

export const api: Bridge = (window as any).chatsparty
