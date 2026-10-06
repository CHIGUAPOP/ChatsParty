'use strict'

/**
 * Windows 本地语音（System.Speech / SAPI5）。
 *
 * 完全离线、零请求、零费用，用的是系统「设置 → 时间和语言 → 语音」里已安装的音色。
 * 中文 Windows 一般自带 Microsoft Huihui；装了语言包还会有 Xiaoxiao / Yunxi / Kangkang 等。
 *
 * 通过 powershell -EncodedCommand 调用，避免中文与引号在命令行里被转义坏掉。
 */

const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'

function runPowerShell(script, timeout = 60000) {
  // EncodedCommand 要求 UTF-16LE + base64
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(cleanError(stderr) || err.message))
          return
        }
        resolve(String(stdout))
      }
    )
  })
}

/** 把任意文本安全地塞进 PowerShell 脚本（base64 中转，绕开所有引号/编码问题） */
function embed(text) {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(
    String(text),
    'utf8'
  ).toString('base64')}'))`
}

const PREAMBLE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
`

/** PowerShell 的 stderr 是 CLIXML，直接抛给用户很难看，这里抠出人话 */
function cleanError(stderr) {
  const text = String(stderr || '')
  const errors = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1])
  const raw = errors.length ? errors.join(' ') : text
  return (
    raw
      .replace(/_x000D_/g, '')
      .replace(/_x000A_/g, ' ')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300) || '系统语音调用失败'
  )
}

/** stdout 里可能混入 CLIXML 噪音，只取真正的 JSON 行 */
function extractJson(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('[') || lines[i].startsWith('{')) return lines[i]
  }
  return ''
}

async function listVoices() {
  if (process.platform !== 'win32') return []
  const script = `${PREAMBLE}
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$out = @()
foreach ($v in $synth.GetInstalledVoices()) {
  if ($v.Enabled) {
    $info = $v.VoiceInfo
    $out += [pscustomobject]@{ name = $info.Name; culture = $info.Culture.Name; gender = $info.Gender.ToString() }
  }
}
$synth.Dispose()
ConvertTo-Json -InputObject @($out) -Compress
`
  const raw = extractJson(await runPowerShell(script, 30000))
  if (!raw) return []
  const parsed = JSON.parse(raw)
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  return arr.map((v) => ({
    id: v.name,
    label: `${v.name}${v.culture ? ` · ${v.culture}` : ''}${v.gender ? ` · ${v.gender === 'Female' ? '女' : '男'}` : ''}`,
    culture: v.culture,
    gender: v.gender,
  }))
}

/**
 * @param {object} cfg { voice, rate(-10~10), volume(0~100) }
 * @returns {Promise<{base64:string, mime:string}>}
 */
async function synthesize(cfg, text) {
  if (process.platform !== 'win32') throw new Error('系统语音仅支持 Windows')
  if (!String(text || '').trim()) throw new Error('没有要朗读的文本')

  const tmp = path.join(os.tmpdir(), `chatsparty-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
  const wavLiteral = tmp.replace(/\\/g, '\\\\').replace(/'/g, "''")

  // SAPI 的 Rate 是 -10~10，0 为正常语速；Volume 是 0~100
  const clamp = (n, lo, hi, fallback) => {
    const v = Number(n)
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback
  }
  const rate = clamp(cfg.rate, -10, 10, 0)
  const volume = clamp(cfg.volume, 0, 100, 100)
  const wantVoice = String(cfg.voice || '').trim()

  let script = `${PREAMBLE}
$text = ${embed(text)}
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = ${rate}
$synth.Volume = ${volume}
`
  if (wantVoice) {
    script += `$want = ${embed(wantVoice)}
$match = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Name -eq $want } | Select-Object -First 1
if (-not $match) {
  $match = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Name -like "*$want*" } | Select-Object -First 1
}
if ($match) { $synth.SelectVoice($match.VoiceInfo.Name) }
`
  }
  script += `$synth.SetOutputToWaveFile('${wavLiteral}')
$synth.Speak($text)
$synth.Dispose()
Write-Output 'OK'
`

  try {
    // 首次调用可能撞上 PowerShell 冷启动，失败一次就重试
    try {
      await runPowerShell(script, 90000)
    } catch (e) {
      if (!fs.existsSync(tmp)) await runPowerShell(script, 90000)
      else throw e
    }
    const buf = fs.readFileSync(tmp)
    if (!buf.length) throw new Error('系统语音没有生成音频')
    return { base64: buf.toString('base64'), mime: 'audio/wav' }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

module.exports = { synthesize, listVoices, isSupported: () => process.platform === 'win32' }
