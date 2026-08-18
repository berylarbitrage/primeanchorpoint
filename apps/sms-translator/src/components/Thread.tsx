import { useEffect, useMemo, useRef } from 'react'
import type { SmsMessage } from '../../shared/types'
import {
  categoryLabel,
  filtersActive,
  formatDayHeading,
  formatTime,
  matches,
  riskLabel,
  type Conversation,
  type Filters,
} from '../lib/derive'
import Composer from './Composer'
import AttachmentView from './AttachmentView'

interface Props {
  conversation: Conversation | null
  /** Narrow screens only: go back to the conversation list. */
  onBack: () => void
  filters: Filters
  showOriginal: boolean
  draft?: string
  onDraftChange: (peer: string, text: string) => void
  onToggleOriginal: () => void
  onRetranslate: (ids: string[]) => void
  onSend: (to: string, body: string) => Promise<string | null>
  onTogglePin: (peer: string, pinned: boolean) => void
  onMarkUnread: (peer: string) => void
  onDeleteConversation: (peer: string) => void
  onDeleteMessage: (id: string) => void
  onForward: (body: string) => void
  onDial: (number: string) => void
  onCopy: (text: string) => void
  canTranslate: boolean
}

function dayKey(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

export default function Thread({
  conversation,
  onBack,
  filters,
  showOriginal,
  draft,
  onDraftChange,
  onToggleOriginal,
  onRetranslate,
  onSend,
  onTogglePin,
  onMarkUnread,
  onDeleteConversation,
  onDeleteMessage,
  onForward,
  onDial,
  onCopy,
  canTranslate,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const active = filtersActive(filters)

  const visible = useMemo(() => {
    if (!conversation) return []
    return active ? conversation.messages.filter((m) => matches(m, filters)) : conversation.messages
  }, [conversation, filters, active])

  const lastId = visible.length ? visible[visible.length - 1].id : null

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conversation?.peer, lastId])

  if (!conversation) {
    return (
      <section className="thread">
        <div className="empty">
          <h2>选择一个会话</h2>
          <p>左侧列出所有会话。搜索和筛选会同时作用于原文和译文。</p>
        </div>
      </section>
    )
  }

  const untranslated = conversation.messages
    .filter(
      (m) =>
        m.translationState !== 'done' &&
        (m.body.trim() !== '' || (m.attachments?.length ?? 0) > 0),
    )
    .map((m) => m.id)

  let previousDay = ''

  return (
    <section className="thread">
      <header className="thread-header">
        <button type="button" className="btn ghost back" onClick={onBack} title="返回会话列表">
          ‹ 返回
        </button>
        <div className="who">
          <strong>{conversation.title}</strong>
          <span>{conversation.address}</span>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn ghost"
          onClick={() => onTogglePin(conversation.peer, !conversation.pinned)}
        >
          {conversation.pinned ? '取消置顶' : '置顶'}
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => onDial(conversation.address)}
          title="在手机上打开拨号界面（不会自动拨出去）"
        >
          拨号
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => onMarkUnread(conversation.peer)}
        >
          标为未读
        </button>
        <button
          type="button"
          className="btn ghost danger"
          onClick={() => onDeleteConversation(conversation.peer)}
          title="从本软件删除这个会话；手机里的短信不受影响"
        >
          删除会话
        </button>
        <button type="button" className="btn ghost" onClick={onToggleOriginal}>
          {showOriginal ? '隐藏原文' : '显示原文'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canTranslate || untranslated.length === 0}
          onClick={() => onRetranslate(untranslated)}
          title={canTranslate ? '' : '请先在设置里填入 Anthropic API key'}
        >
          翻译剩余 {untranslated.length} 条
        </button>
      </header>

      <div className="messages" ref={scroller}>
        {active && (
          <div className="day-heading">
            筛选中：显示 {visible.length} / {conversation.messages.length} 条
          </div>
        )}

        {visible.map((message) => {
          const key = dayKey(message.date)
          const heading = key !== previousDay ? formatDayHeading(message.date) : null
          previousDay = key
          return (
            <MessageBubble
              key={message.id}
              message={message}
              heading={heading}
              showOriginal={showOriginal}
              onRetranslate={() => onRetranslate([message.id])}
              onDelete={() => onDeleteMessage(message.id)}
              onForward={() => onForward(message.translation?.text?.trim() || message.body)}
              onCopy={onCopy}
              canTranslate={canTranslate}
            />
          )
        })}

        {visible.length === 0 && (
          <div className="empty">
            <h2>这个会话里没有匹配的短信</h2>
            <p>清除筛选条件可以看到全部 {conversation.messages.length} 条。</p>
          </div>
        )}
      </div>

      <Composer
        key={conversation.peer}
        to={conversation.address}
        initialDraft={draft}
        onDraftChange={(text) => onDraftChange(conversation.peer, text)}
        onSend={onSend}
        canTranslate={canTranslate}
      />
    </section>
  )
}

interface BubbleProps {
  message: SmsMessage
  heading: string | null
  showOriginal: boolean
  onRetranslate: () => void
  onDelete: () => void
  onForward: () => void
  onCopy: (text: string) => void
  canTranslate: boolean
}

function MessageBubble({
  message,
  heading,
  showOriginal,
  onRetranslate,
  onDelete,
  onForward,
  onCopy,
  canTranslate,
}: BubbleProps) {
  const translated = message.translation?.text?.trim() ?? ''
  const hasTranslation = translated !== '' && translated !== message.body.trim()
  const risk = message.analysis?.risk ?? 0

  return (
    <>
      {heading && <div className="day-heading">{heading}</div>}
      <div className={`msg ${message.direction}`}>
        <div className={`bubble${risk >= 4 ? ' risky' : ''}`}>
          {message.subject && <div className="subject">{message.subject}</div>}

          {message.attachments?.map((attachment) => (
            <AttachmentView
              key={attachment.partId}
              messageId={message.id}
              attachment={attachment}
            />
          ))}

          {hasTranslation ? (
            <>
              {showOriginal && (
                <>
                  <div className="original">{message.body}</div>
                  <div className="divider" />
                </>
              )}
              <div className="translated">{translated}</div>
            </>
          ) : message.body.trim() ? (
            <div className="translated">{message.body}</div>
          ) : null}

          {message.translationState === 'pending' &&
            (message.body.trim() || message.attachments?.length) && (
              <div className="pending-note">
                {message.attachments?.length ? '识别图片中…' : '翻译中…'}
              </div>
            )}
          {message.translationState === 'error' && (
            <div className="error-note">翻译失败：{message.translationError}</div>
          )}
        </div>

        {message.analysis?.summary && (
          <div className="summary">{message.analysis.summary}</div>
        )}

        <div className="footline">
          <span>{formatTime(message.date)}</span>
          {message.pending && <span>发送中…</span>}
          {message.translation?.sourceLang && <span>{message.translation.sourceLang}</span>}
          {message.kind === 'mms' && <span>图片短信</span>}
          {message.analysis && <span>{categoryLabel(message.analysis.category)}</span>}
          {riskLabel(risk) && (
            <span style={{ color: risk >= 4 ? 'var(--danger)' : 'var(--warn)' }}>
              {riskLabel(risk)}
            </span>
          )}
          {canTranslate && (
            <button type="button" className="btn ghost" onClick={onRetranslate}>
              重新翻译
            </button>
          )}
          <button
            type="button"
            className="btn ghost"
            onClick={() => onCopy(message.body)}
            disabled={!message.body.trim()}
          >
            复制原文
          </button>
          {hasTranslation && (
            <button type="button" className="btn ghost" onClick={() => onCopy(translated)}>
              复制译文
            </button>
          )}
          <button
            type="button"
            className="btn ghost"
            onClick={onForward}
            disabled={!message.body.trim() && !translated}
          >
            转发
          </button>
          <button type="button" className="btn ghost danger" onClick={onDelete}>
            删除
          </button>
        </div>
      </div>
    </>
  )
}
