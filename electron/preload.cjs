'use strict'
const { contextBridge, ipcRenderer } = require('electron')

const api = {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    patch: (patch) => ipcRenderer.invoke('config:patch', patch),
    reset: () => ipcRenderer.invoke('config:reset'),
    onNotice: (cb) => on('config:notice', cb),
    onChanged: (cb) => on('config:changed', cb),
  },
  bilibili: {
    qrGenerate: () => ipcRenderer.invoke('bili:qr:generate'),
    qrPoll: () => ipcRenderer.invoke('bili:qr:poll'),
    loginInfo: () => ipcRenderer.invoke('bili:login:info'),
    logout: () => ipcRenderer.invoke('bili:logout'),
    onQrStatus: (cb) => on('bili:qr:status', cb),
    onLogin: (cb) => on('bili:login', cb),
  },
  live: {
    start: (roomId) => ipcRenderer.invoke('live:start', roomId),
    stop: () => ipcRenderer.invoke('live:stop'),
    send: (text) => ipcRenderer.invoke('live:send', text),
    onEvent: (cb) => on('live:event', cb),
    onStatus: (cb) => on('live:status', cb),
    onPopularity: (cb) => on('live:popularity', cb),
    onError: (cb) => on('live:error', cb),
    onFace: (cb) => on('live:face', cb),
  },
  // 在线观众（B站高能榜）。榜单只在房间连上之后才有内容
  viewers: {
    state: () => ipcRenderer.invoke('viewers:state'),
    refresh: () => ipcRenderer.invoke('viewers:refresh'),
    onState: (cb) => on('viewers:state', cb),
  },
  tts: {
    providers: () => ipcRenderer.invoke('tts:providers'),
    voices: (provider, force) => ipcRenderer.invoke('tts:voices', provider, force),
    test: () => ipcRenderer.invoke('tts:test'),
    speak: (text) => ipcRenderer.invoke('tts:speak', text),
    ack: () => ipcRenderer.send('tts:ack'),
    skip: () => ipcRenderer.invoke('tts:skip'),
    clear: () => ipcRenderer.invoke('tts:clear'),
    queue: () => ipcRenderer.invoke('tts:queue'),
    onPlay: (cb) => on('tts:play', cb),
    onState: (cb) => on('tts:state', cb),
    onError: (cb) => on('tts:error', cb),
    onSkip: (cb) => on('tts:skip', cb),
    cacheInfo: () => ipcRenderer.invoke('tts:cache:info'),
    cacheClear: () => ipcRenderer.invoke('tts:cache:clear'),
    cachePrune: () => ipcRenderer.invoke('tts:cache:prune'),
  },
  voices: {
    search: (source, keyword, opts) => ipcRenderer.invoke('voices:search', source, keyword, opts),
    netcheck: (which) => ipcRenderer.invoke('voices:netcheck', which),
    keycheck: (source) => ipcRenderer.invoke('voices:keycheck', source),
    library: () => ipcRenderer.invoke('voices:library'),
    add: (source, voice) => ipcRenderer.invoke('voices:add', source, voice),
    save: (profile) => ipcRenderer.invoke('voices:save', profile),
    remove: (id) => ipcRenderer.invoke('voices:remove', id),
    bind: (uid, profileId) => ipcRenderer.invoke('voices:bind', uid, profileId),
    unbind: (uid) => ipcRenderer.invoke('voices:unbind', uid),
    useAsDefault: (id) => ipcRenderer.invoke('voices:useAsDefault', id),
    test: (payload) => ipcRenderer.invoke('voices:test', payload),
    onChanged: (cb) => on('voices:changed', cb),
  },
  music: {
    search: (keyword, limit) => ipcRenderer.invoke('music:search', keyword, limit),
    url: (id) => ipcRenderer.invoke('music:url', id),
    lyric: (id) => ipcRenderer.invoke('music:lyric', id),
    // 渲染层持有播放器，所以由它告诉主进程「现在唱到哪一行」，主进程再广播给 OBS
    lyricSync: (p) => ipcRenderer.invoke('music:lyricSync', p),
    check: () => ipcRenderer.invoke('music:check'),
    account: () => ipcRenderer.invoke('music:account'),
    login: () => ipcRenderer.invoke('music:login'),
    loginCancel: () => ipcRenderer.invoke('music:loginCancel'),
    onLogin: (cb) => on('music:login', cb),
    state: () => ipcRenderer.invoke('music:state'),
    enqueue: (song, requester) => ipcRenderer.invoke('music:enqueue', song, requester),
    play: () => ipcRenderer.invoke('music:play'),
    next: () => ipcRenderer.invoke('music:next'),
    remove: (index) => ipcRenderer.invoke('music:remove', index),
    clear: () => ipcRenderer.invoke('music:clear'),
    onState: (cb) => on('music:state', cb),
  },
  llm: {
    providers: () => ipcRenderer.invoke('llm:providers'),
    models: () => ipcRenderer.invoke('llm:models'),
    check: () => ipcRenderer.invoke('llm:check'),
    expand: (rough) => ipcRenderer.invoke('llm:expand', rough),
  },
  overlay: {
    start: () => ipcRenderer.invoke('overlay:start'),
    stop: () => ipcRenderer.invoke('overlay:stop'),
    open: (panel) => ipcRenderer.invoke('overlay:open', panel),
    test: () => ipcRenderer.invoke('overlay:test'),
    selfcheck: () => ipcRenderer.invoke('overlay:selfcheck'),
    onStatus: (cb) => on('overlay:status', cb),
  },
  // 桌面浮窗：弹幕 / 当前观众 / 礼物 / 音乐控制台四块，各自弹出为独立小窗。
  // panel 取值：'danmaku' | 'viewers' | 'gifts' | 'music'，和渲染层 ?float= 一致
  float: {
    state: () => ipcRenderer.invoke('float:state'),
    open: (panel) => ipcRenderer.invoke('float:open', panel),
    close: (panel) => ipcRenderer.invoke('float:close', panel),
    /** 浮窗里的设置弹层用：改不透明度 / 字体大小，当场生效 */
    set: (panel, patch) => ipcRenderer.invoke('float:set', panel, patch),
    onState: (cb) => on('float:state', cb),
  },
  // 一键准备开播：扫本机的直播软件、按顺序拉起来、可选连上直播间
  launchpad: {
    scan: (opts) => ipcRenderer.invoke('launchpad:scan', opts),
    run: (payload) => ipcRenderer.invoke('launchpad:run', payload),
    pickExe: () => ipcRenderer.invoke('launchpad:pickExe'),
    onProgress: (cb) => on('launchpad:progress', cb),
  },
  app: {
    exportLog: () => ipcRenderer.invoke('app:exportLog'),
    diagnostics: () => ipcRenderer.invoke('app:diagnostics'),
    info: () => ipcRenderer.invoke('app:info'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  },
}

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('chatsparty', api)
