# ChatsParty

B 站直播间弹幕姬 · 弹幕语音播报 · 多平台 TTS · MD3 动态配色 · OBS 叠加层 · 网易云点歌。

把直播间弹幕变成声音：观众发一条弹幕，程序用你选定的音色念出来；观众还能用弹幕指令
搜索 / 绑定 / 设计自己的专属音色，也能点歌、上屏。

> 注：本项目由 Hy4 preview 与 DeepSeek V4.1 Flash 开发。

---

## 功能

- **弹幕语音播报** —— 弹幕实时转语音，队列化播放，可过滤、可限流、可跳过。
- **多平台 TTS**
  - Edge 朗读（免费、免密钥）
  - 系统语音（本地离线）
  - 小米 MiMo
  - OpenAI（`audio/speech`）
  - Fish Audio（fish.audio 在线音色库）
  - 自定义（任意 OpenAI 兼容接口）
- **在线音色库** —— 搜索 / 注册 / 绑定音色；观众用弹幕指令即可换音色、造音色。
- **弹幕指令** —— 前缀与指令叫法全部可在界面改；支持粉丝牌门槛、房管 / 主播豁免、冷却。
- **LLM 辅助写音色描述** —— DeepSeek / OpenAI / Moonshot / 智谱 / 硅基流动 / 通义 等 OpenAI 兼容服务。
- **网易云点歌** —— 弹幕点歌入队，扫码登录后可播会员歌曲。
- **OBS 叠加层** —— 本地 HTTP 服务（默认 `127.0.0.1:12450`），浏览器源直接加；含弹幕流与「正在播放 / 待播列表」面板，样式可在界面里预览。
- **Material Design 3 主题** —— 跟随封面取色的动态配色，深浅色模式。
- **配置安全** —— 所有密钥与 Cookie 使用 Electron `safeStorage` 加密后存本地，**不写入仓库**。

## 环境要求

- **Node.js ≥ 18**（推荐 20 / 22）
- Windows（主要支持平台；OTA 脚本为 `.bat`）
- 一个 B 站直播间（自己开播或任意房间即可连）

## 快速开始

```bash
# 方式一：一键脚本（推荐，双击即可）
start.bat              # 标准模式：自动装依赖 → 构建界面 → 启动

# 方式二：手动
npm install
npm run build:renderer   # 构建渲染层到 dist-renderer/
npm run launch           # 启动（等价于标准模式）
```

首次冷启动 `scripts/launch.cjs` 会自动检测缺失依赖并 `npm install`（走国内镜像），随后构建渲染层再拉 Electron。

## 开发模式（热更新）

```bash
start-dev.bat
# 或
npm run dev
```

会同时起 Vite 开发服务器（`127.0.0.1:5180`）与 Electron，改前端代码即时生效。

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run launch` | 标准启动（必要时自动构建） |
| `npm run dev` | 开发模式（热更新） |
| `npm run build:renderer` | 只构建渲染层 |
| `npm test` | 冒烟测试（含渲染层类型检查） |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run e2e:danmaku` | 弹幕指令端到端测试（真起 Electron 主进程） |
| `npm run build` | 构建渲染层 + 打包安装包（electron-builder） |

## 目录结构

```
electron/            主进程
  main.cjs           入口：窗口、IPC、弹幕分发、指令处理
  store.cjs          配置持久化（safeStorage 加密 + 原子写 + 迁移）
  voices.cjs         音色库：搜索 / 注册 / 绑定 / 指令解析 / 权限
  tts.cjs            各平台 TTS 合成
  tts-edge.cjs       Edge 朗读
  tts-sapi.cjs       系统语音
  netease.cjs        网易云：搜索 / 取链 / 歌词 / 点歌指令
  llm.cjs            LLM 供应商与提示词
  overlay.cjs        本地叠加层 HTTP / WebSocket 服务
  preload.cjs        渲染层桥（contextBridge）
  bilibili/          直播间连接、弹幕解析、扫码登录
  lib/               HTTP / 签名 / 网络等基础库
src/                 React 渲染层（页面与组件）
overlay/index.html   OBS 叠加层页面（手写 DOM，独立于 React）
scripts/             启动 / 冒烟 / 端到端脚本
build/               打包资源：应用图标 build/icon.png（源图）与 build/icon.ico（Windows 多尺寸）
```

## OBS 叠加层

1. 界面里打开叠加层开关，记下端口（默认 `12450`）。
2. OBS → 来源 → 浏览器 → URL 填 `http://127.0.0.1:12450/overlay`。
3. 宽高按需设置，背景透明即可。

弹幕页与叠加层页都有实时预览，所见即所得。

## 弹幕指令（默认叫法，可在界面修改）

| 指令 | 说明 |
| --- | --- |
| `#我的音色` | 查看自己当前绑定的音色 |
| `#音色列表 <关键词>` | 搜索在线音色库 |
| `#绑定 <名字>` | 绑定某个音色 |
| `#设计 <描述>` | 用一句话描述，让 LLM 生成专属音色（取决于平台支持） |
| `#删除音色` | 恢复默认音色 |
| `#帮助音色` | 查看全部指令 |

前缀默认 `#`，点歌触发词默认 `点歌`（如 `点歌 晴天`）。以上全部可以改成你直播间顺口的叫法。

## 关于密钥与隐私

- 所有密钥（TTS / LLM / 平台 Key）与 Cookie（B 站登录、网易云 `MUSIC_U`）**只保存在本机**，
  路径为 Electron 的 `userData/chatsparty.enc`，使用系统 `safeStorage` 加密。
- 仓库中**不包含任何个人密钥**，也请勿把本机生成的配置文件提交上来。
- 若你 fork 本仓库用于分发，请自查是否误带了 `userData`、日志或构建产物。

## 打包

```bash
npm run build      # vite build + electron-builder（输出到 release/）
```

## 声明

- 本项目仅供学习交流与个人直播辅助使用，请遵守 B 站 / 网易云 / 各 TTS 服务商的用户协议。
- 通过非官方接口获取的内容（如网易云歌曲直链）仅供个人回放，请勿用于任何商业或传播用途。
- 使用本程序产生的一切后果由使用者自行承担。

## License

[MIT](./LICENSE)
