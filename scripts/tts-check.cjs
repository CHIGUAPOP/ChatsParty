'use strict'
/**
 * TTS 自检：走真实的适配层（electron/tts.cjs），逐个提供方合成同一句话，
 * 报告耗时、音频体积，并把音频落盘到 tmp-tts/ 方便直接试听。
 *
 *   node scripts/tts-check.cjs          # 测 Edge + 系统语音
 *   node scripts/tts-check.cjs edge     # 只测某一个：edge / system / mimo / openai
 */
const fs = require('node:fs')
const path = require('node:path')
const { synthesize, listVoices, PROVIDERS } = require('../electron/tts.cjs')

const TEXT = '欢迎来到直播间，这是一条语音合成测试。'
const outDir = path.join(__dirname, '..', 'tmp-tts')

function save(name, base64) {
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, name)
  fs.writeFileSync(file, Buffer.from(base64, 'base64'))
  return file
}

const CASES = [
  { provider: 'edge', cfg: { voice: 'zh-CN-XiaoxiaoNeural', speed: 1 } },
  { provider: 'edge', cfg: { voice: 'zh-CN-YunxiNeural', speed: 1.15 } },
  { provider: 'system', cfg: { speed: 1 } },
]

async function main() {
  const only = process.argv[2] || ''
  for (const c of CASES) {
    if (only && c.provider !== only) continue
    const p = PROVIDERS[c.provider]
    console.log(`--- ${p.name} ---`)
    let cfg = { provider: c.provider, protocol: p.protocol, format: p.formats[0], ...c.cfg }

    if (!cfg.voice) {
      const voices = await listVoices(c.provider).catch(() => [])
      if (!voices?.length) {
        console.log('  ✗ 本机没有可用音色，跳过')
        continue
      }
      console.log(`  音色 ${voices.length} 个，例如：${voices.slice(0, 3).map((v) => v.label).join(' | ')}`)
      cfg.voice = voices[0].id
    } else if (c.provider === 'edge') {
      const voices = await listVoices('edge')
      const zh = voices.filter((v) => /^zh/i.test(v.locale || '')).length
      console.log(`  在线音色 ${voices.length} 个，中文 ${zh} 个`)
    }

    const t = Date.now()
    try {
      const r = await synthesize(cfg, TEXT, '轻快一点')
      const ext = r.mime.includes('wav') ? 'wav' : 'mp3'
      const file = save(`${c.provider}-${String(cfg.voice).replace(/[^\w-]/g, '_')}.${ext}`, r.base64)
      console.log(
        `  ✓ ${cfg.voice}  ${Date.now() - t} ms  ${((r.base64.length * 0.75) / 1024).toFixed(1)} KB  ${r.mime}\n    → ${file}`
      )
    } catch (e) {
      console.log(`  ✗ ${cfg.voice}  ${Date.now() - t} ms  ${e.message}`)
    }
  }
}

main()
