import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import FloatShell from './float/FloatShell'
import type { FloatPanel } from './lib/api'
import './styles.css'

/**
 * 桌面浮窗和主窗口共用同一份渲染层入口：
 * 带 ?float=<panel> 打开的就是浮窗，只渲染对应那一个区域；
 * 没带的走完整应用。面板名和 electron/float.cjs 的 FLOAT_PANELS 逐字一致。
 */
const FLOAT_PANELS: FloatPanel[] = ['danmaku', 'viewers', 'gifts', 'music']
const raw = new URLSearchParams(window.location.search).get('float')
const floatPanel = FLOAT_PANELS.find((p) => p === raw)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {floatPanel ? <FloatShell panel={floatPanel} /> : <App />}
  </React.StrictMode>,
)
