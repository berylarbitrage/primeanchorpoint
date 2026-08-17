import { useEffect, useState } from 'react'
import type { DeviceInfo, Settings } from '../../shared/types'
import { errorText, sms } from '../lib/bridge'

interface Props {
  settings: Settings
  onClose: () => void
  onSaved: (settings: Settings) => void
}

export default function SettingsModal({ settings, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<Settings>(settings)
  const [apiKey, setApiKey] = useState('')
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [scanError, setScanError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void scan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function scan(): Promise<void> {
    setScanError(null)
    try {
      setDevices(await sms.listDevices())
      // The app searches common install locations when the configured path
      // does not work, so show the path it actually settled on.
      const current = await sms.getSettings()
      setDraft((prev) => (prev.adbPath === current.adbPath ? prev : { ...prev, adbPath: current.adbPath }))
    } catch (err) {
      setDevices([])
      setScanError(errorText(err))
    }
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      let saved = await sms.setSettings(draft)
      if (apiKey.trim()) saved = await sms.setApiKey(apiKey.trim())
      onSaved(saved)
      onClose()
    } catch (err) {
      setScanError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  function set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>

        <div className="field">
          <label>Anthropic API Key</label>
          <input
            type="password"
            placeholder={settings.hasApiKey ? '已保存（留空则不修改）' : 'sk-ant-...'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <span className="hint">
            保存在本机，Windows 上用系统凭据加密（DPAPI）。短信内容会发送到 Anthropic
            用于翻译。
          </span>
        </div>

        <div className="field-row">
          <div className="field">
            <label>翻译目标语言</label>
            <input
              value={draft.targetLanguage}
              onChange={(e) => set('targetLanguage', e.target.value)}
            />
          </div>
          <div className="field">
            <label>发出短信翻译成</label>
            <input
              placeholder="留空则与上面相同"
              value={draft.outgoingLanguage}
              onChange={(e) => set('outgoingLanguage', e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label>模型</label>
          <select value={draft.model} onChange={(e) => set('model', e.target.value)}>
            <option value="claude-opus-5">claude-opus-5（质量最好）</option>
            <option value="claude-sonnet-5">claude-sonnet-5（更快更便宜）</option>
            <option value="claude-haiku-4-5">claude-haiku-4-5（最便宜）</option>
          </select>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.autoTranslate}
            onChange={(e) => set('autoTranslate', e.target.checked)}
          />
          <span>新短信自动翻译</span>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.classify}
            onChange={(e) => set('classify', e.target.checked)}
          />
          <span>同时做分类与诈骗风险评估（用于筛选）</span>
        </label>

        <hr style={{ border: 0, borderTop: '1px solid var(--border)', width: '100%' }} />

        <div className="field">
          <label>adb 可执行文件路径</label>
          <input value={draft.adbPath} onChange={(e) => set('adbPath', e.target.value)} />
          <span className="hint">
            会自动在常见位置查找（PATH、C:\platform-tools、下载文件夹、Android
            Studio SDK 等）。找不到时再手动填 <code>adb.exe</code> 的完整路径。
          </span>
        </div>

        <div className="field">
          <label>设备</label>
          <div className="device-list">
            {devices.map((device) => (
              <div
                key={device.serial}
                className={`device${draft.deviceSerial === device.serial ? ' selected' : ''}`}
              >
                <span>
                  {device.model ?? device.serial}
                  <span style={{ color: 'var(--text-faint)' }}> · {device.state}</span>
                </span>
                <button
                  type="button"
                  className="btn"
                  disabled={!device.ready}
                  onClick={() => set('deviceSerial', device.serial)}
                >
                  {draft.deviceSerial === device.serial ? '已选择' : '使用'}
                </button>
              </div>
            ))}
            {devices.length === 0 && (
              <span className="hint">
                没有检测到设备。请开启「开发者选项 → USB 调试」，插上数据线后在手机上允许
                调试授权。
              </span>
            )}
            {scanError && <span className="hint" style={{ color: 'var(--danger)' }}>{scanError}</span>}
          </div>
          <div className="row" style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button type="button" className="btn" onClick={() => void scan()}>
              重新扫描
            </button>
            <button type="button" className="btn ghost" onClick={() => set('deviceSerial', null)}>
              自动选择
            </button>
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label>首次导入最近多少天</label>
            <input
              type="number"
              min={1}
              value={draft.initialImportDays}
              onChange={(e) => set('initialImportDays', Number(e.target.value) || 1)}
            />
          </div>
          <div className="field">
            <label>轮询间隔（毫秒）</label>
            <input
              type="number"
              min={2000}
              step={1000}
              value={draft.pollIntervalMs}
              onChange={(e) => set('pollIntervalMs', Number(e.target.value) || 6000)}
            />
          </div>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.autoSync}
            onChange={(e) => set('autoSync', e.target.checked)}
          />
          <span>后台自动同步新短信</span>
        </label>

        <div className="field">
          <label>发送方式</label>
          <select
            value={draft.sendMethod}
            onChange={(e) => set('sendMethod', e.target.value as Settings['sendMethod'])}
          >
            <option value="ui">自动发送 · 识别界面上的发送按钮（推荐，三星适用）</option>
            <option value="keyevent">自动发送 · 模拟方向键+回车（仅原生 AOSP 界面）</option>
            <option value="manual">仅填好草稿，由我在手机上确认发送</option>
          </select>
          <span className="hint">
            Android 没有开放给电脑的直接发短信接口，只能唤起手机短信 App 再替你点发送。
            推荐档会读取手机当前界面、找到发送按钮再点，三星 One UI 能正常工作；找不到
            按钮时会自动退回模拟按键并提示你。<b>第一次发送请盯着手机屏幕确认。</b>
          </span>
        </div>

        {draft.sendMethod !== 'manual' && (
          <div className="field">
            <label>等待短信 App 出现（毫秒）</label>
            <input
              type="number"
              min={300}
              step={100}
              value={draft.sendTapDelayMs}
              onChange={(e) => set('sendTapDelayMs', Number(e.target.value) || 1500)}
            />
            <span className="hint">三星建议 1500–2500；短信 App 启动慢就调大。</span>
          </div>
        )}

        <div className="field">
          <label>每批翻译条数</label>
          <input
            type="number"
            min={1}
            max={50}
            value={draft.batchSize}
            onChange={(e) => set('batchSize', Number(e.target.value) || 20)}
          />
          <span className="hint">条数越多越省钱；如果出现「响应被截断」就调小。</span>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
