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
    test: (payload) => ipcRenderer.invoke('voices:test', payload),
    onChanged: (cb) => on('voices:changed', cb),
  },
  music: {
    search: (keyword, limit) => ipcRenderer.invoke('music:search', keyword, limit),
    url: (id) => ipcRenderer.invoke('music:url', id),
    lyric: (id) => ipcRenderer.invoke('music:lyric', id),
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
    open: () => ipcRenderer.invoke('overlay:open'),
    test: () => ipcRenderer.invoke('overlay:test'),
    selfcheck: () => ipcRenderer.invoke('overlay:selfcheck'),
    onStatus: (cb) => on('overlay:status', cb),
  },
  app: {
    exportLog: () => ipcRenderer.invoke('app:exportLog'),
    diagnostics: () => ipcRenderer.invoke('app:diagnostics'),
  },
}

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('chatsparty', api)
