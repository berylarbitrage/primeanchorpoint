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
import NewMessage from './components/NewMessage'
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
  // Which error text the user has dismissed. Keyed by the text itself so a
  // different error re-opens the banner instead of staying hidden.
  const [dismissedError, setDismissedError] = useState<string | null>(null)
  // Unsent text, per conversation, so switching threads does not lose it.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // Non-null while writing to a number that has no conversation yet.
  const [compose, setCompose] = useState<{ body?: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)

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
    () => buildConversations(messages, EMPTY_FILTERS, settings.pinnedPeers, settings.peerNotes),
    [messages, settings.pinnedPeers, settings.peerNotes],
  )
  const conversations = useMemo(
    () => buildConversations(messages, filters, settings.pinnedPeers, settings.peerNotes),
    [messages, filters, settings.pinnedPeers, settings.peerNotes],
  )

  const unreadTotal = useMemo(
    () => allConversations.reduce((sum, c) => sum + c.unread, 0),
    [allConversations],
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
    setCompose(null)
    setSelectedPeer(peer)
    void sms.markThreadRead(peer)
  }, [])

  // A short-lived line under the topbar for things that need acknowledging but
  // not acting on ("copied", "the dialler is open on your phone").
  const flash = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast((current) => (current === text ? null : current)), 4000)
  }, [])

  const togglePin = useCallback(async (peer: string, pinned: boolean) => {
    setSettings(await sms.setPinned(peer, pinned))
  }, [])

  const setPeerNote = useCallback(async (peer: string, alias: string, note: string) => {
    setSettings(await sms.setPeerNote(peer, { alias, note }))
  }, [])

  const setOutgoingLanguage = useCallback(async (peer: string, language: string) => {
    setSettings(await sms.setOutgoingLanguage(peer, language))
  }, [])

  const markUnread = useCallback((peer: string) => {
    void sms.markThreadUnread(peer)
  }, [])

  const deleteConversation = useCallback(
    (peer: string) => {
      const conversation = allConversations.find((c) => c.peer === peer)
      const count = conversation?.messages.length ?? 0
      const ok = window.confirm(
        `从本软件删除「${conversation?.title ?? peer}」的 ${count} 条短信？\n\n` +
          '手机里的短信不会被删除（电脑端没有这个权限），但删掉后同步不会再把它们拉回来。',
      )
      if (!ok) return
      void sms.deleteConversation(peer)
      if (selectedPeer === peer) setSelectedPeer(null)
    },
    [allConversations, selectedPeer],
  )

  const deleteMessage = useCallback((id: string) => {
    void sms.deleteMessages([id])
  }, [])

  const copyText = useCallback(
    (text: string) => {
      if (!text.trim()) return
      void sms.copyText(text)
      flash('已复制到剪贴板。')
    },
    [flash],
  )

  const dial = useCallback(
    async (number: string) => {
      const result = await sms.dial(number)
      flash(result.message)
    },
    [flash],
  )

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

  // Once the error clears, forget the dismissal — if the same failure comes
  // back on the next sync the user should see it again.
  useEffect(() => {
    if (status.phase !== 'error') setDismissedError(null)
  }, [status.phase])

  // The topbar can only show a clipped one-liner, and these messages are the
  // ones that tell the user what to actually do (authorise the phone, turn on
  // wireless debugging). They get a full-width banner instead.
  const errorBanner =
    status.phase === 'error' && status.detail && status.detail !== dismissedError
      ? status.detail
      : null

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
          <span className="detail" title={describeStatus(status)}>
            {describeStatus(status)}
          </span>
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

      {errorBanner && (
        <div className="banner error" role="alert">
          <span className="text">{errorBanner}</span>
          <button type="button" className="btn ghost" onClick={() => setShowSettings(true)}>
            打开设置
          </button>
          <button
            type="button"
            className="btn ghost"
            title="关闭"
            onClick={() => setDismissedError(errorBanner)}
          >
            ×
          </button>
        </div>
      )}

      {toast && <div className="banner">{toast}</div>}

      {/* On a phone the two panes cannot share the screen: `show-thread` hands
          it to whichever one the user is actually looking at. */}
      <div className={`body${compose || selectedPeer ? ' show-thread' : ''}`}>
        <Sidebar
          conversations={conversations}
          totalConversations={allConversations.length}
          selectedPeer={compose ? null : selectedPeer}
          filters={filters}
          unreadTotal={unreadTotal}
          onFiltersChange={setFilters}
          onSelect={selectPeer}
          onCompose={() => setCompose({})}
          onTogglePin={(peer, pinned) => void togglePin(peer, pinned)}
          onMarkUnread={markUnread}
          onDelete={deleteConversation}
          onMarkAllRead={() => void sms.markAllRead()}
        />
        {compose ? (
          <NewMessage
            initialBody={compose.body}
            known={allConversations.map((c) => ({ title: c.title, address: c.address }))}
            onSend={handleSend}
            onSent={(to) => {
              setCompose(null)
              // The optimistic record lands under the normalised peer, which is
              // what the conversation list is keyed by.
              setSelectedPeer(normalisePeerLike(to))
            }}
            onCancel={() => setCompose(null)}
            canTranslate={settings.hasApiKey}
          />
        ) : (
          <Thread
            onBack={() => setSelectedPeer(null)}
            conversation={selected}
            filters={filters}
            showOriginal={showOriginal}
            draft={selected ? drafts[selected.peer] : undefined}
            onDraftChange={(peer, text) => setDrafts((current) => ({ ...current, [peer]: text }))}
            onToggleOriginal={() => setShowOriginal((v) => !v)}
            onRetranslate={(ids) => void sms.retranslate(ids)}
            onSend={handleSend}
            onTogglePin={(peer, pinned) => void togglePin(peer, pinned)}
            onMarkUnread={markUnread}
            onDeleteConversation={deleteConversation}
            onDeleteMessage={deleteMessage}
            onForward={(body) => setCompose({ body })}
            onDial={(number) => void dial(number)}
            onCopy={copyText}
            onSaveNote={(peer, alias, note) => void setPeerNote(peer, alias, note)}
            language={selected ? (settings.outgoingLanguageByPeer[selected.peer] ?? '') : ''}
            onLanguageChange={(peer, language) => void setOutgoingLanguage(peer, language)}
            screenOutgoing={settings.screenOutgoing}
            canTranslate={settings.hasApiKey}
          />
        )}
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

/**
 * Mirror of the main process's `normalisePeer` (last 10 digits), so a message
 * just sent to a new number selects the conversation it will land in.
 */
function normalisePeerLike(address: string): string {
  const trimmed = address.trim()
  if (!trimmed) return '(unknown)'
  const digits = trimmed.replace(/[^\d]/g, '')
  if (!digits) return trimmed.toUpperCase()
  if (digits.length <= 8) return digits
  return digits.slice(-10)
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
