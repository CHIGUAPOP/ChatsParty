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
    /** 合成缓存：同一套音色 + 同一句话只请求一次，TTL 内复用并刷新时间戳 */
    cache: { enabled: boolean; ttlMs: number; maxMB: number }
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
  window: { width: number; height: number }
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

export interface MusicQueueItem {
  id: number
  name: string
  artists: string
  durationText: string
  picUrl?: string
  requester?: string
  at: number
}

export interface MusicState {
  items: MusicQueueItem[]
  current: MusicQueueItem | null
  queued: number
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
  panels: Record<FloatPanel, { opened: boolean; opacity: number; scale: number }>
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
    set: (panel: FloatPanel, patch: { opacity?: number; scale?: number }) => Promise<{ ok: boolean }>
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
