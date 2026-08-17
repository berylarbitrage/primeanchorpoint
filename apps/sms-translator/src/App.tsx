import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Settings, SmsMessage, SyncStatus } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'
import { errorText, sms } from './lib/bridge'
import {
  buildConversations,
  filtersActive,
  mergeMessages,
  EMPTY_FILTERS,
  type Filters,
} from './lib/derive'
import Sidebar from './components/Sidebar'
import Thread from './components/Thread'
import SettingsModal from './components/SettingsModal'

export default function App() {
  const [messages, setMessages] = useState<SmsMessage[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [status, setStatus] = useState<SyncStatus>({ phase: 'idle', pendingTranslations: 0 })
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null)
  const [showOriginal, setShowOriginal] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    void (async () => {
      const [initialMessages, initialSettings, initialStatus] = await Promise.all([
        sms.listMessages(),
        sms.getSettings(),
        sms.getStatus(),
      ])
      setMessages(initialMessages)
      setSettings(initialSettings)
      setStatus(initialStatus)
      if (!initialSettings.hasApiKey) setShowSettings(true)
    })()

    const offMessages = sms.onMessages((incoming) =>
      setMessages((current) => mergeMessages(current, incoming)),
    )
    const offRemoved = sms.onRemoved((ids) => {
      const drop = new Set(ids)
      setMessages((current) => current.filter((m) => !drop.has(m.id)))
    })
    const offStatus = sms.onStatus(setStatus)

    return () => {
      offMessages()
      offRemoved()
      offStatus()
    }
  }, [])

  // All conversations, unfiltered — used for the "N / M matched" counter.
  const allConversations = useMemo(
    () => buildConversations(messages, EMPTY_FILTERS),
    [messages],
  )
  const conversations = useMemo(
    () => buildConversations(messages, filters),
    [messages, filters],
  )

  const selected = useMemo(
    () => allConversations.find((c) => c.peer === selectedPeer) ?? null,
    [allConversations, selectedPeer],
  )

  // Filtering out the open conversation would otherwise leave the right pane
  // empty; move to the first match instead. Not marked read — the user did not
  // deliberately open it.
  useEffect(() => {
    if (!filtersActive(filters) || conversations.length === 0) return
    if (selectedPeer && conversations.some((c) => c.peer === selectedPeer)) return
    setSelectedPeer(conversations[0].peer)
  }, [conversations, filters, selectedPeer])

  const selectPeer = useCallback((peer: string) => {
    setSelectedPeer(peer)
    void sms.markThreadRead(peer)
  }, [])

  const handleSend = useCallback(async (to: string, body: string): Promise<string | null> => {
    try {
      const result = await sms.send(to, body)
      return result.ok ? null : (result.note ?? '发送失败。')
    } catch (err) {
      return errorText(err)
    }
  }, [])

  const handleSync = useCallback(async (mode: 'full' | 'incremental') => {
    setSyncing(true)
    try {
      await sms.sync(mode)
    } catch {
      // The failure is reported through the status channel.
    } finally {
      setSyncing(false)
    }
  }, [])

  const dotClass =
    status.phase === 'error'
      ? 'error'
      : status.phase === 'idle'
        ? status.device
          ? 'ok'
          : ''
        : 'busy'

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">SMS 译信</span>

        <div className="status">
          <span className={`dot ${dotClass}`} />
          <span className="detail">{describeStatus(status)}</span>
        </div>

        <div className="spacer" />

        <button
          type="button"
          className="btn"
          disabled={syncing}
          onClick={() => void handleSync('incremental')}
        >
          {syncing ? '同步中…' : '同步'}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={syncing}
          onClick={() => void handleSync('full')}
          title={`重新导入最近 ${settings.initialImportDays} 天的全部短信`}
        >
          重新导入
        </button>
        <button type="button" className="btn ghost" onClick={() => setShowSettings(true)}>
          设置
        </button>
      </header>

      <div className="body">
        <Sidebar
          conversations={conversations}
          totalConversations={allConversations.length}
          selectedPeer={selectedPeer}
          filters={filters}
          onFiltersChange={setFilters}
          onSelect={selectPeer}
        />
        <Thread
          conversation={selected}
          filters={filters}
          showOriginal={showOriginal}
          onToggleOriginal={() => setShowOriginal((v) => !v)}
          onRetranslate={(ids) => void sms.retranslate(ids)}
          onSend={handleSend}
          canTranslate={settings.hasApiKey}
        />
      </div>

      {showSettings && (
        <SettingsModal
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSaved={setSettings}
        />
      )}
    </div>
  )
}

function describeStatus(status: SyncStatus): string {
  switch (status.phase) {
    case 'error':
      return status.detail ?? '出错了'
    case 'connecting':
      return '正在连接手机…'
    case 'syncing':
      return '正在读取短信…'
    case 'translating':
      return `翻译中，剩余 ${status.pendingTranslations} 条`
    default:
      break
  }
  if (!status.device) return '未连接设备'
  const name = status.device.model ?? status.device.serial
  const when = status.lastSyncAt
    ? `，${new Date(status.lastSyncAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })} 已同步`
    : ''
  return `已连接 ${name}${when}`
}
