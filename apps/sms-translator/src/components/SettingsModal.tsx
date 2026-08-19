import { useEffect, useState } from 'react'
import type { DeviceInfo, Settings, UploadStatus, WebStatus } from '../../shared/types'
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
  const [webStatus, setWebStatus] = useState<WebStatus | null>(null)
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null)

  useEffect(() => {
    void scan()
    void sms.getWebStatus().then(setWebStatus).catch(() => {})
    void sms.getUploadStatus().then(setUploadStatus).catch(() => {})
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
      if (result.ok) {
        setDevices(await sms.listDevices(draft.adbPath).catch(() => []))
        // Connecting switches the saved device to the wireless address. The
        // draft in this dialog still holds the old USB serial — and clicking
        // 保存 would write it back, which is exactly the "worked until I
        // unplugged the cable" failure. Pull the fresh values into the draft.
        const saved = await sms.getSettings().catch(() => null)
        if (saved) {
          setDraft((prev) => ({
            ...prev,
            deviceSerial: saved.deviceSerial,
            wirelessAddress: saved.wirelessAddress,
          }))
        }
      }
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
          <label>模型（收到的短信：翻译 + 风险判断）</label>
          <select value={draft.model} onChange={(e) => set('model', e.target.value)}>
            <option value="claude-opus-5">claude-opus-5（判断最准，但最慢，忙的时候还会排队）</option>
            <option value="claude-sonnet-5">claude-sonnet-5（快很多，判断也够用）</option>
            <option value="claude-haiku-4-5">claude-haiku-4-5（最快最便宜）</option>
          </select>
          <span className="hint">
            嫌慢就换 Sonnet 或 Haiku。Opus 在高峰期经常返回「忙不过来」，软件会自动
            重试几次，但等待就是这么来的。
          </span>
        </div>

        <div className="field">
          <label>模型（发送前：翻译草稿 + 安全检查）</label>
          <select value={draft.fastModel} onChange={(e) => set('fastModel', e.target.value)}>
            <option value="claude-haiku-4-5">claude-haiku-4-5（最快，推荐）</option>
            <option value="claude-sonnet-5">claude-sonnet-5</option>
            <option value="claude-opus-5">claude-opus-5（最慢，一般没必要）</option>
          </select>
          <span className="hint">
            这两件事你是站在那儿等结果的，所以默认用最快的模型。短信就一两句话，
            Haiku 完全够翻。
          </span>
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
            手机和电脑要在<b>同一个 WiFi</b>。下面两条路选一条，<b>第一条省事得多</b>。
          </span>

          {/* The tcpip route needs one cable, and that is the whole setup — no
              codes to read off a phone screen. It works on current Android too,
              so it is offered first rather than as a legacy fallback. */}
          <div
            style={{
              display: 'grid',
              gap: 6,
              marginTop: 8,
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid var(--border)',
              background: 'var(--bg-raised)',
            }}
          >
            <span className="hint">
              <b>办法一 · 插一次线就好（推荐）</b>：用 USB 线把手机连上电脑（手机上允许调试），
              然后点下面这个按钮。连上之后就可以<b>把线拔了</b>。
            </span>
            <div>
              <button
                type="button"
                className="btn primary"
                disabled={wirelessBusy}
                onClick={() =>
                  void runWireless(async () => {
                    const result = await sms.enableWirelessOverUsb()
                    if (!result.suggestedAddress) return result
                    set('wirelessAddress', result.suggestedAddress)
                    // Switching the phone to TCP mode is only half of it; connect
                    // straight away so one click really is the whole setup.
                    const connected = await sms.connectWireless(result.suggestedAddress)
                    return connected.ok
                      ? { ok: true, message: `已连上 ${result.suggestedAddress}，现在可以拔线了。` }
                      : connected
                  })
                }
              >
                {wirelessBusy ? '处理中…' : '切换到无线（先插一次 USB）'}
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 6, marginTop: 12 }}>
            <span className="hint">
              <b>办法二 · 完全不插线</b>（安卓 11 以上）。手机上：设置 → 开发者选项 →
              <b>无线调试</b> —— 注意要<b>点这一行的文字进去</b>，不是只把右边的开关拨开；
              进去之后才有「使用配对码配对设备」。
            </span>
            <span className="hint">
              <b>第 1 步 · 配对</b>（只需做一次）：点「使用配对码配对设备」，
              把弹出框里的 <b>IP 地址和端口</b> 与 <b>6 位配对码</b> 填到这里。
              这个框<b>不能关</b>，关了配对码就失效了。
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
              <b>第 2 步 · 连接</b>：配对成功后一般会<b>自动连上</b>，不用自己填。
              没自动连上就点「自动查找」，还不行再手填「无线调试」<b>主界面</b>上那一组
              —— <b>和配对对话框里的端口不是同一个</b>，这是最容易填错的地方。
            </span>
            <div>
              <button
                type="button"
                className="btn"
                disabled={wirelessBusy}
                onClick={() =>
                  void runWireless(async () => {
                    const result = await sms.discoverWireless()
                    if (result.address) set('wirelessAddress', result.address)
                    return result
                  })
                }
                title="手机开着无线调试时会在局域网里广播地址，这里直接去找"
              >
                {wirelessBusy ? '查找中…' : '自动查找并连接'}
              </button>
            </div>
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
          <label>发送前检查</label>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.screenOutgoing}
              onChange={(e) => set('screenOutgoing', e.target.checked)}
            />
            发送前让 AI 看一眼草稿
          </label>
          <span className="hint">
            辱骂威胁、把验证码或卡号发给别人、答应打钱、明显的诈骗话术会被拦下来并说明
            原因；确认没问题可以点「我确认，仍然发送」照发。语气重但正常的对话不会拦。
            每条多花一次很便宜的调用，没填 API key 时自动跳过。
          </span>
        </div>

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
          <label>同步到公司网站（出门在外也能看）</label>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.uploadEnabled}
              onChange={(e) => set('uploadEnabled', e.target.checked)}
            />
            把手机短信推送到网站
          </label>
          <span className="hint">
            每次同步之后，这台电脑会把读到的短信（含译文和风险分）推到公司网站的
            「手机短信」页面，登录管理员账号就能随时查看，不需要这台电脑一直开着。
            <b>你的私人短信会存在服务器上</b>，网站那一页上可以随时一键清空。
            图片本身不上传，只标注「有图片」。
          </span>

          {draft.uploadEnabled && (
            <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              <input
                placeholder="推送网址，如 https://primeanchorworkforce.com/api/device-sms/push"
                value={draft.uploadUrl}
                onChange={(e) => set('uploadUrl', e.target.value.trim())}
              />
              <input
                placeholder="设备令牌（在网站「手机短信」页面点「生成新令牌」）"
                value={draft.uploadToken}
                onChange={(e) => set('uploadToken', e.target.value.trim())}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void (async () => {
                      try {
                        onSaved(await sms.setSettings(draft))
                        setUploadStatus(await sms.pushNow())
                      } catch (err) {
                        setScanError(errorText(err))
                      }
                    })()
                  }
                >
                  保存并立即推送
                </button>
                <span className="hint">
                  {uploadStatus?.error
                    ? uploadStatus.error
                    : uploadStatus?.lastPushAt
                      ? `上次推送 ${new Date(uploadStatus.lastPushAt).toLocaleTimeString()}，${uploadStatus.lastSaved ?? 0} 条；还有 ${uploadStatus.pending} 条待推`
                      : `还有 ${uploadStatus?.pending ?? 0} 条待推送`}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="field">
          <label>网页共享（同一个 WiFi 下别人也能看）</label>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.webEnabled}
              onChange={(e) => set('webEnabled', e.target.checked)}
            />
            开启网页访问
          </label>
          <span className="hint">
            开启后，<b>这台电脑</b>会在局域网里提供一个网页，别人用手机或平板的浏览器
            打开就能看短信、看译文、搜索筛选，也能发短信。手机必须一直连着这台电脑，
            电脑关机或软件退出就打不开了。第一次开启时 Windows 防火墙会弹窗，请点
            「允许访问」。
          </span>

          {draft.webEnabled && (
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="hint" style={{ minWidth: '4em' }}>端口</span>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  style={{ width: 120 }}
                  value={draft.webPort}
                  onChange={(e) => set('webPort', Number(e.target.value) || 8848)}
                />
                <span className="hint">被占用就换一个，比如 8849。</span>
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="hint" style={{ minWidth: '4em' }}>访问密码</span>
                <code className="password">{webStatus?.password || '（保存后生成）'}</code>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() =>
                    void sms
                      .regenerateWebPassword()
                      .then((status) => {
                        setWebStatus(status)
                        setDraft((prev) => ({ ...prev, webPassword: status.password }))
                      })
                      .catch(() => {})
                  }
                >
                  换一个
                </button>
              </div>
              <span className="hint">
                谁拿到这个密码，谁就能读你所有短信、也能用你的号码发短信——只发给你
                信得过的人。换密码会把已经登录的浏览器全部踢下线。
              </span>

              <div>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void (async () => {
                      // Applied without closing the dialog, so the address and
                      // password can be read (and typed into a phone) right here.
                      try {
                        onSaved(await sms.setSettings(draft))
                        const status = await sms.restartWebServer()
                        setWebStatus(status)
                        setDraft((prev) => ({ ...prev, webPassword: status.password }))
                      } catch (err) {
                        setScanError(errorText(err))
                      }
                    })()
                  }
                >
                  应用并显示网址
                </button>
              </div>

              {webStatus?.error && (
                <span className="hint" style={{ color: 'var(--danger)' }}>{webStatus.error}</span>
              )}

              {webStatus?.running && webStatus.urls.length > 0 && (
                <div className="hint">
                  <div>在手机浏览器里打开（要连同一个 WiFi）：</div>
                  {webStatus.urls.map((url) => (
                    <div key={url}>
                      <code className="password">{url}</code>
                    </div>
                  ))}
                </div>
              )}
              {!webStatus?.running && !webStatus?.error && (
                <span className="hint">保存后网页服务才会启动，网址会显示在这里。</span>
              )}
            </div>
          )}
        </div>

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
