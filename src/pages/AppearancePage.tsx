import React from 'react'
import { AppConfig } from '../lib/api'
import { PRESET_SEEDS, tonalRamp } from '../lib/theme'
import { Button, Card, Row, SectionTitle, Switch } from '../components/ui'

interface Props {
  config: AppConfig
  patch: (p: Record<string, unknown>) => Promise<AppConfig>
  notify: (m: string, e?: boolean) => void
}

export default function AppearancePage({ config, patch, notify }: Props) {
  const seed = config.theme?.seed || '#6750A4'
  const mode = config.theme?.mode || 'dark'
  const motion = config.theme?.motion === 'standard' ? 'standard' : 'expressive'
  const [demoSwitch, setDemoSwitch] = React.useState(false)
  const ramp = React.useMemo(() => tonalRamp(seed), [seed])
  // 直接拿 seed 当受控值的话，敲到 3 个字符时还不合法、不提交，React 会把刚敲的字回滚掉，
  // 看起来就是「输入框吞字符」。改成先记在本地，够 6 位或失焦时才提交
  const [hexDraft, setHexDraft] = React.useState(seed)
  const isHex = (v: string) => /^#?[0-9a-fA-F]{6}$/.test(v.trim())

  // 外部改了颜色（点了预设色、恢复了默认）要跟上；
  // 自己正在敲到一半（还不合法）时不能回灌，否则刚敲的字会被吞掉
  React.useEffect(() => {
    if (!isHex(hexDraft) || hexDraft.trim().toUpperCase() !== seed.toUpperCase()) setHexDraft(seed)
  }, [seed])

  const commitHex = (raw: string) => {
    const v = raw.trim()
    if (isHex(v)) patch({ theme: { seed: (v.startsWith('#') ? v : `#${v}`).toUpperCase() } })
    else if (v === '') patch({ theme: { seed: '' } })
  }

  return (
    <div className="section">
      <SectionTitle>主题色</SectionTitle>
      <Card title="种子色" desc="改一个颜色，整套 Material Design 3 配色会实时重新生成。">
        <div className="row">
          <input
            className="color-input"
            type="color"
            value={seed}
            onChange={(e) => patch({ theme: { seed: e.target.value.toUpperCase() } })}
          />
          <div className="field is-floating" style={{ maxWidth: 160 }}>
            <input
              className="field__input mono"
              value={hexDraft}
              spellCheck={false}
              onChange={(e) => {
                const v = e.target.value.trim()
                setHexDraft(v)
                commitHex(v)
              }}
              onBlur={(e) => {
                // 没写完整就失焦，回滚成当前生效的颜色，别留个半截值在框里
                if (!/^#?[0-9a-fA-F]{6}$/.test(e.target.value.trim())) setHexDraft(seed)
              }}
            />
            <label className="field__label">HEX</label>
          </div>
          <Button
            variant="outlined"
            small
            onClick={() => {
              patch({ theme: { seed: '#6750A4' } })
              notify('已恢复默认配色')
            }}
          >
            重置
          </Button>
        </div>

        <div className="divider" />
        <div className="row__label" style={{ marginBottom: 8 }}>
          预设
        </div>
        <div className="swatch-row">
          {PRESET_SEEDS.map((c) => (
            <button
              key={c}
              className={`swatch${c.toLowerCase() === seed.toLowerCase() ? ' is-active' : ''}`}
              style={{ background: c }}
              onClick={() => patch({ theme: { seed: c } })}
              title={c}
            />
          ))}
        </div>

        <div className="divider" />
        <div className="row__label" style={{ marginBottom: 8 }}>
          当前种子色的色阶
        </div>
        <div className="swatch-row">
          {ramp.map((c) => (
            <button
              key={c}
              className="swatch"
              style={{ background: c }}
              onClick={() => patch({ theme: { seed: c.toUpperCase() } })}
              title={c}
            />
          ))}
        </div>
      </Card>

      <SectionTitle>显示</SectionTitle>
      <Card title="深浅色">
        <Row label="深色模式">
          <Switch value={mode === 'dark'} onChange={(v) => patch({ theme: { mode: v ? 'dark' : 'light' } })} />
        </Row>
      </Card>

      <Card title="动效" desc="Standard 是克制的 Material 3 基线；Expressive 换成弹簧曲线，并用抬升、回弹、拉伸来表达状态。">
        <Row label="Expressive 动效">
          <Switch
            value={motion === 'expressive'}
            onChange={(v) => patch({ theme: { motion: v ? 'expressive' : 'standard' } })}
          />
        </Row>
        <div className="divider" />
        <div className="row__hint">当前：{motion === 'expressive' ? 'Expressive（弹簧 + 位移）' : 'Standard（克制）'}</div>
        <div className="divider" />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Button>按住我</Button>
          <Button variant="tonal">悬停看抬升</Button>
          <Button variant="outlined" small onClick={() => notify('弹一下看看')}>
            提示条
          </Button>
        </div>
        <div className="divider" />
        <Row label="开关按下时拉长">
          <Switch value={demoSwitch} onChange={setDemoSwitch} />
        </Row>
      </Card>

      <SectionTitle>预览</SectionTitle>
      <Card title="组件配色预览" desc="按钮、卡片、开关都会跟随上面选的种子色变化。">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Button>Filled</Button>
          <Button variant="tonal">Tonal</Button>
          <Button variant="outlined">Outlined</Button>
          <Button variant="text">Text</Button>
        </div>
        <div className="divider" />
        <div className="grid">
          <div className="card card--outlined" style={{ margin: 0 }}>
            <div className="row__label">Outlined card</div>
            <div className="row__hint">on-surface-variant</div>
          </div>
          <div className="card card--filled" style={{ margin: 0 }}>
            <div className="row__label">Filled card</div>
            <div className="row__hint">surface-container-highest</div>
          </div>
        </div>
      </Card>
    </div>
  )
}
