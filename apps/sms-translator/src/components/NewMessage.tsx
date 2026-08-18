import { useEffect, useMemo, useState } from 'react'
import type { Contact } from '../../shared/types'
import { errorText, sms } from '../lib/bridge'
import Composer from './Composer'

interface Props {
  /** Prefilled body, e.g. when forwarding a message. */
  initialBody?: string
  /** Numbers already in the inbox, offered alongside the phone book. */
  known: { title: string; address: string }[]
  onSend: (to: string, body: string) => Promise<string | null>
  onSent: (to: string) => void
  onCancel: () => void
  canTranslate: boolean
}

/** Digits only, for matching what the user typed against a stored number. */
function digits(value: string): string {
  return value.replace(/[^\d]/g, '')
}

export default function NewMessage({
  initialBody,
  known,
  onSend,
  onSent,
  onCancel,
  canTranslate,
}: Props) {
  const [to, setTo] = useState('')
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [contactsNote, setContactsNote] = useState<string | null>(null)

  // The phone book needs the phone attached, so it is fetched when this view
  // opens rather than at start-up. An unreadable provider is not an error —
  // typing the number still works.
  useEffect(() => {
    let cancelled = false
    setLoadingContacts(true)
    void sms
      .listContacts()
      .then((list) => {
        if (cancelled) return
        setContacts(list)
        if (list.length === 0) {
          setContactsNote('读不到手机通讯录（手机没连上，或系统不允许），直接填号码即可。')
        }
      })
      .catch((err) => {
        if (!cancelled) setContactsNote(errorText(err))
      })
      .finally(() => {
        if (!cancelled) setLoadingContacts(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const query = to.trim().toLowerCase()
  const queryDigits = digits(to)

  const suggestions = useMemo(() => {
    const rows = [
      ...known.map((k) => ({ name: k.title, number: k.address, source: '最近' })),
      ...(contacts ?? []).map((c) => ({ name: c.name, number: c.number, source: '通讯录' })),
    ]

    // One row per number: a contact already in the inbox should not appear twice.
    const seen = new Set<string>()
    const unique = rows.filter((row) => {
      const key = digits(row.number) || row.number
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    if (!query) return unique.slice(0, 8)
    return unique
      .filter(
        (row) =>
          row.name.toLowerCase().includes(query) ||
          (queryDigits !== '' && digits(row.number).includes(queryDigits)),
      )
      .slice(0, 8)
  }, [known, contacts, query, queryDigits])

  const recipient = to.trim()
  const dialable = digits(recipient).length >= 3

  return (
    <section className="thread">
      <header className="thread-header">
        <button type="button" className="btn ghost back" onClick={onCancel} title="返回会话列表">
          ‹ 返回
        </button>
        <div className="who">
          <strong>新短信</strong>
          <span>填号码或搜索联系人</span>
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn ghost" onClick={onCancel}>
          取消
        </button>
      </header>

      <div className="new-message">
        <label className="field-label" htmlFor="new-message-to">
          发给
        </label>
        <input
          id="new-message-to"
          autoFocus
          placeholder="号码，或联系人名字"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />

        {loadingContacts && <span className="hint">正在读取手机通讯录…</span>}
        {contactsNote && <span className="hint">{contactsNote}</span>}

        {suggestions.length > 0 && (
          <div className="suggestions">
            {suggestions.map((row) => (
              <button
                key={`${row.source}:${row.number}`}
                type="button"
                className="suggestion"
                onClick={() => setTo(row.number)}
              >
                <span className="name">{row.name || row.number}</span>
                <span className="number">{row.number}</span>
                <span className="source">{row.source}</span>
              </button>
            ))}
          </div>
        )}

        {/* While a name is being typed the suggestions say enough; the warning
            is only useful once nothing matches. */}
        {recipient !== '' && !dialable && suggestions.length === 0 && (
          <span className="hint" style={{ color: 'var(--warn)' }}>
            「{recipient}」不像号码。银行、快递那种字母开头的号码只能在手机上回复。
          </span>
        )}
      </div>

      <Composer
        to={recipient || '（先填收件人）'}
        initialDraft={initialBody}
        disabled={!dialable}
        onSend={async (_to, body) => {
          const error = await onSend(recipient, body)
          if (!error) onSent(recipient)
          return error
        }}
        canTranslate={canTranslate}
      />
    </section>
  )
}
