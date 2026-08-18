import { useEffect, useState } from 'react'
import type { DraftScreening } from '../../shared/types'
import { errorText, sms } from '../lib/bridge'

/** Offered in the send-language picker. Anything else can be typed in settings. */
const LANGUAGES = [
  '简体中文',
  'English',
  'Español',
  '繁體中文',
  'Tiếng Việt',
  '한국어',
  '日本語',
  'Português',
  'Français',
  'Русский',
  'العربية',
]

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
  /** Language this conversation is written in; '' follows the global setting. */
  language?: string
  onLanguageChange?: (language: string) => void
  /** Run the outgoing check before sending. */
  screen?: boolean
}

export default function Composer({
  to,
  onSend,
  canTranslate,
  initialDraft,
  onDraftChange,
  disabled = false,
  language = '',
  onLanguageChange,
  screen = false,
}: Props) {
  const [draft, setDraft] = useState(initialDraft ?? '')
  const [preview, setPreview] = useState<{ text: string; lang: string } | null>(null)
  const [busy, setBusy] = useState<'none' | 'translating' | 'checking' | 'sending'>('none')
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  // Set when the check flagged the text; sending again goes through anyway.
  const [blocked, setBlocked] = useState<{ body: string; verdict: DraftScreening } | null>(null)

  // A preview belongs to the draft it was made from; drop it when the draft or
  // the recipient changes.
  useEffect(() => {
    setPreview(null)
  }, [to])

  function edit(text: string): void {
    setDraft(text)
    setPreview(null)
    setBlocked(null)
    onDraftChange?.(text)
  }

  async function translate(): Promise<boolean> {
    if (!draft.trim()) return false
    setBusy('translating')
    setNote(null)
    try {
      const result = await sms.translateDraft(draft, language)
      setPreview({ text: result.text, lang: result.targetLang })
      return true
    } catch (err) {
      setNote({ text: errorText(err), error: true })
      return false
    } finally {
      setBusy('none')
    }
  }

  async function send(body: string, force = false): Promise<void> {
    if (!body.trim() || disabled) return

    // The check runs on what is actually going out — the translation, when one
    // is being sent, not the draft it came from.
    if (screen && canTranslate && !force) {
      setBusy('checking')
      try {
        const verdict = await sms.screenDraft(body)
        if (verdict.flagged) {
          setBlocked({ body, verdict })
          setBusy('none')
          return
        }
      } catch (err) {
        // A failed check must not block a legitimate message; say so and carry on.
        setNote({ text: `发送前检查没跑成功（${errorText(err)}），已直接发送。`, error: false })
      }
    }

    setBusy('sending')
    setNote(null)
    setBlocked(null)
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

  const languageLabel = language || '（跟设置一致）'
  // A language was chosen for this conversation: the draft is meant to go out
  // translated, so translating comes first and the result is shown before send.
  const translating = language.trim() !== '' && canTranslate

  return (
    <div className="composer">
      <textarea
        value={draft}
        placeholder={
          translating
            ? `发给 ${to}（写中文即可，Ctrl+Enter 先翻成${language}）`
            : `发给 ${to}（Ctrl+Enter 直接发送原文）`
        }
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            // Same rule as the buttons: with a language chosen, show the
            // translation first rather than firing the original off.
            if (translating && !preview) void translate()
            else void send(preview?.text ?? draft)
          }
        }}
      />

      {preview && (
        <div className="preview">
          <span className="label">
            Claude 译文（{preview.lang}）— 点「发送译文」发出去的就是这段
          </span>
          {preview.text}
        </div>
      )}

      {blocked && (
        <div className="blocked">
          <div>
            <b>这条先别发：</b>
            {blocked.verdict.reason || '内容可能有问题。'}
          </div>
          <div className="row">
            <button
              type="button"
              className="btn ghost danger"
              onClick={() => void send(blocked.body, true)}
            >
              我确认，仍然发送
            </button>
            <button type="button" className="btn ghost" onClick={() => setBlocked(null)}>
              我再改改
            </button>
          </div>
        </div>
      )}

      <div className="row">
        <select
          value={language}
          title="发送前把草稿翻译成这个语言"
          onChange={(e) => onLanguageChange?.(e.target.value)}
          disabled={!onLanguageChange}
        >
          <option value="">译成…（跟设置一致）</option>
          {LANGUAGES.map((item) => (
            <option key={item} value={item}>
              译成 {item}
            </option>
          ))}
        </select>

        {/* With a language chosen, translating is the point — so it is the main
            button, and the translation is shown before anything is sent. */}
        {translating && !preview && (
          <button
            type="button"
            className="btn primary"
            disabled={!canTranslate || !draft.trim() || busy !== 'none'}
            onClick={() => void translate()}
            title={canTranslate ? `翻译成 ${languageLabel}` : '请先在设置里填入 Anthropic API key'}
          >
            {busy === 'translating' ? '翻译中…' : `译成 ${languageLabel} 并预览`}
          </button>
        )}

        {!translating && (
          <button
            type="button"
            className="btn"
            disabled={!canTranslate || !draft.trim() || busy !== 'none'}
            onClick={() => void translate()}
            title={canTranslate ? '翻译草稿' : '请先在设置里填入 Anthropic API key'}
          >
            {busy === 'translating' ? '翻译中…' : '翻译草稿'}
          </button>
        )}

        {preview && (
          <>
            <button
              type="button"
              className="btn primary"
              disabled={busy !== 'none' || disabled}
              onClick={() => void send(preview.text)}
            >
              {busy === 'sending'
                ? '发送中…'
                : busy === 'checking'
                  ? '检查中…'
                  : `发送译文（${preview.lang}）`}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy !== 'none'}
              onClick={() => void translate()}
            >
              重新翻译
            </button>
          </>
        )}

        <button
          type="button"
          className={preview || translating ? 'btn ghost' : 'btn primary'}
          disabled={!draft.trim() || busy !== 'none' || disabled}
          onClick={() => void send(draft)}
          title={translating ? '不翻译，把你写的原样发出去' : ''}
        >
          {busy === 'sending' && !preview
            ? '发送中…'
            : translating
              ? '直接发原文'
              : '发送原文'}
        </button>
      </div>

      {note && <div className={`note${note.error ? ' error' : ''}`}>{note.text}</div>}
    </div>
  )
}
