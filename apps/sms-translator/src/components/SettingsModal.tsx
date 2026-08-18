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
  const [pairAddress, setPairAddress] = useState('')
  const [pairCode, setPairCode] = useState('')
  const [wirelessBusy, setWirelessBusy] = useState(false)
  const [wirelessNote, setWirelessNote] = useState<{ text: string; ok: boolean } | null>(null)

  useEffect(() => {
    void scan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function browse(): Promise<void> {
    setScanError(null)
    try {
      const result = await sms.browseForAdb()
      if (result.error) {
        setScanError(result.error)
        return
      }
      if (!result.path) return // cancelled
      setDraft((prev) => ({ ...prev, adbPath: result.path as string }))
      setDevices(await sms.listDevices(result.path))
    } catch (err) {
      setScanError(errorText(err))
    }
  }

  async function scan(): Promise<void> {
    setScanError(null)
    try {
      setDevices(await sms.listDevices(draft.adbPath))
      // The app searches common install locations when the configured path
      // does not work, so show the path it actually settled on.
      const current = await sms.getSettings()
      setDraft((prev) => (prev.adbPath === current.adbPath ? prev : { ...prev, adbPath: current.adbPath }))
    } catch (err) {
      setDevices([])
      setScanError(errorText(err))
    }
  }

  async function runWireless(
    action: () => Promise<{ ok: boolean; message: string }>,
  ): Promise<void> {
    setWirelessBusy(true)
    setWirelessNote(null)
    try {
      const result = await action()
      setWirelessNote({ text: result.message, ok: result.ok })
      if (result.ok) setDevices(await sms.listDevices(draft.adbPath).catch(() => []))
    } catch (err) {
      setWirelessNote({ text: errorText(err), ok: false })
    } finally {
      setWirelessBusy(false)
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
            checked={draft.includeMms}
            onChange={(e) => set('includeMms', e.target.checked)}
          />
          <span>
            同时同步图片短信（MMS）
            <span className="hint" style={{ display: 'block' }}>
              图片会下载到本机显示。只读不发——电脑端发送仍然是纯文字。
            </span>
          </span>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.describeImages}
            onChange={(e) => set('describeImages', e.target.checked)}
          />
          <span>
            让 Claude 读图（描述内容 + 识别图中文字）
            <span className="hint" style={{ display: 'block' }}>
              截图式的诈骗短信全靠这个才能筛出来。每张图一次请求，比纯文字贵不少；
              不需要就关掉。
            </span>
          </span>
        </label>

        <div className="field">
          <label>单个附件大小上限（KB）</label>
          <input
            type="number"
            min={64}
            step={256}
            value={draft.maxAttachmentKb}
            onChange={(e) => set('maxAttachmentKb', Number(e.target.value) || 2048)}
          />
          <span className="hint">超过就跳过不下载，并在那条短信上标注原因。</span>
        </div>

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
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ flex: 1, minWidth: 0 }}
              value={draft.adbPath}
              onChange={(e) => set('adbPath', e.target.value)}
            />
            <button type="button" className="btn" onClick={() => void browse()}>
              浏览…
            </button>
          </div>
          <span className="hint">
            一般不用管——会自动在常见位置查找（PATH、<code>C:\platform-tools</code>、
            下载文件夹、桌面、Android Studio 的 SDK 目录）。找不到时点「浏览…」
            选中 platform-tools 文件夹里的 <code>adb.exe</code> 即可，不用手打。
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
                调试授权。三星手机若开关是灰的、写着「已被自动拦截器阻止（Blocked by Auto
                Blocker）」，先到 设置 → 安全和隐私 → <b>自动拦截器</b> 里关掉它，USB 调试
                和无线调试才能打开。
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

        <div className="field">
          <label>无线连接（不用一直插着数据线）</label>
          <span className="hint">
            手机上打开：设置 → 开发者选项 → <b>无线调试</b>（打开它），要求手机和电脑
            在<b>同一个 WiFi</b>。首次需要配对一次。
          </span>

          <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
            <span className="hint">
              <b>第 1 步 · 配对</b>（只需做一次）：点手机上的「使用配对码配对设备」，
              把弹出框里的 <b>IP 地址和端口</b> 与 <b>6 位配对码</b> 填到这里。
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ flex: 2, minWidth: 0 }}
                placeholder="配对地址，如 192.168.1.5:37419"
                value={pairAddress}
                onChange={(e) => setPairAddress(e.target.value)}
              />
              <input
                style={{ flex: 1, minWidth: 0 }}
                placeholder="配对码"
                value={pairCode}
                onChange={(e) => setPairCode(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                disabled={wirelessBusy || !pairAddress.trim() || !pairCode.trim()}
                onClick={() => void runWireless(() => sms.pairWireless(pairAddress, pairCode))}
              >
                配对
              </button>
            </div>

            <span className="hint" style={{ marginTop: 6 }}>
              <b>第 2 步 · 连接</b>：填「无线调试」<b>主界面</b>上显示的那一组地址和端口
              —— <b>和配对对话框里的端口不是同一个</b>，这是最容易填错的地方。
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ flex: 1, minWidth: 0 }}
                placeholder="连接地址，如 192.168.1.5:41234"
                value={draft.wirelessAddress}
                onChange={(e) => set('wirelessAddress', e.target.value)}
              />
              <button
                type="button"
                className="btn primary"
                disabled={wirelessBusy || !draft.wirelessAddress.trim()}
                onClick={() =>
                  void runWireless(() => sms.connectWireless(draft.wirelessAddress))
                }
              >
                {wirelessBusy ? '处理中…' : '连接'}
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={wirelessBusy || !draft.wirelessAddress.trim()}
                onClick={() =>
                  void runWireless(() => sms.disconnectWireless(draft.wirelessAddress))
                }
              >
                断开
              </button>
            </div>

            <label className="check" style={{ marginTop: 4 }}>
              <input
                type="checkbox"
                checked={draft.wirelessAutoReconnect}
                onChange={(e) => set('wirelessAutoReconnect', e.target.checked)}
              />
              <span>断线后自动重连（手机息屏或 WiFi 抖动都会掉线，建议开着）</span>
            </label>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
              <button
                type="button"
                className="btn ghost"
                disabled={wirelessBusy}
                onClick={() =>
                  void runWireless(async () => {
                    const result = await sms.enableWirelessOverUsb()
                    if (result.suggestedAddress) {
                      set('wirelessAddress', result.suggestedAddress)
                    }
                    return result
                  })
                }
              >
                安卓 10 及更早：先插线，点这里切到无线
              </button>
            </div>

            {wirelessNote && (
              <span
                className="hint"
                style={{ color: wirelessNote.ok ? 'var(--ok)' : 'var(--danger)' }}
              >
                {wirelessNote.text}
              </span>
            )}
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
