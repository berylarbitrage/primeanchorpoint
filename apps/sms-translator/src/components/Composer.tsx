import { useEffect, useState } from 'react'
import { errorText, sms } from '../lib/bridge'

interface Props {
  to: string
  /** Resolves to an error message, or null on success. */
  onSend: (to: string, body: string) => Promise<string | null>
  canTranslate: boolean
  /** Restored draft for this conversation, or a body being forwarded. */
  initialDraft?: string
  /** Called on every edit so the parent can keep the draft across switches. */
  onDraftChange?: (text: string) => void
  /** No recipient yet — the box is visible but nothing can be sent. */
  disabled?: boolean
}

export default function Composer({
  to,
  onSend,
  canTranslate,
  initialDraft,
  onDraftChange,
  disabled = false,
}: Props) {
  const [draft, setDraft] = useState(initialDraft ?? '')
  const [preview, setPreview] = useState<{ text: string; lang: string } | null>(null)
  const [busy, setBusy] = useState<'none' | 'translating' | 'sending'>('none')
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)

  // A preview belongs to the draft it was made from; drop it when the draft or
  // the recipient changes.
  useEffect(() => {
    setPreview(null)
  }, [to])

  async function translate(): Promise<void> {
    if (!draft.trim()) return
    setBusy('translating')
    setNote(null)
    try {
      const result = await sms.translateDraft(draft)
      setPreview({ text: result.text, lang: result.targetLang })
    } catch (err) {
      setNote({ text: errorText(err), error: true })
    } finally {
      setBusy('none')
    }
  }

  function edit(text: string): void {
    setDraft(text)
    setPreview(null)
    onDraftChange?.(text)
  }

  async function send(body: string): Promise<void> {
    if (!body.trim() || disabled) return
    setBusy('sending')
    setNote(null)
    const error = await onSend(to, body)
    setBusy('none')
    if (error) {
      setNote({ text: error, error: true })
      return
    }
    setDraft('')
    setPreview(null)
    onDraftChange?.('')
  }

  return (
    <div className="composer">
      <textarea
        value={draft}
        placeholder={`发给 ${to}（Ctrl+Enter 直接发送原文）`}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void send(draft)
          }
        }}
      />

      {preview && (
        <div className="preview">
          <span className="label">译文（{preview.lang}）— 发送的将是这段文字</span>
          {preview.text}
        </div>
      )}

      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={!canTranslate || !draft.trim() || busy !== 'none'}
          onClick={() => void translate()}
          title={canTranslate ? '' : '请先在设置里填入 Anthropic API key'}
        >
          {busy === 'translating' ? '翻译中…' : '翻译草稿'}
        </button>

        {preview && (
          <button
            type="button"
            className="btn primary"
            disabled={busy !== 'none' || disabled}
            onClick={() => void send(preview.text)}
          >
            发送译文
          </button>
        )}

        <button
          type="button"
          className={preview ? 'btn' : 'btn primary'}
          disabled={!draft.trim() || busy !== 'none' || disabled}
          onClick={() => void send(draft)}
        >
          {busy === 'sending' ? '发送中…' : '发送原文'}
        </button>
      </div>

      {note && <div className={`note${note.error ? ' error' : ''}`}>{note.text}</div>}
    </div>
  )
}
