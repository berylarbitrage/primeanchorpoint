import { CATEGORIES, type Category } from '../../shared/types'
import {
  categoryLabel,
  filtersActive,
  formatTime,
  type Conversation,
  type Filters,
} from '../lib/derive'

interface Props {
  conversations: Conversation[]
  totalConversations: number
  selectedPeer: string | null
  filters: Filters
  onFiltersChange: (filters: Filters) => void
  onSelect: (peer: string) => void
}

export default function Sidebar({
  conversations,
  totalConversations,
  selectedPeer,
  filters,
  onFiltersChange,
  onSelect,
}: Props) {
  const active = filtersActive(filters)

  function toggleCategory(category: Category): void {
    const next = filters.categories.includes(category)
      ? filters.categories.filter((c) => c !== category)
      : [...filters.categories, category]
    onFiltersChange({ ...filters, categories: next })
  }

  return (
    <aside className="sidebar">
      <div className="filters">
        <input
          type="search"
          placeholder="搜索原文、译文、号码…"
          value={filters.query}
          onChange={(e) => onFiltersChange({ ...filters, query: e.target.value })}
        />

        <div className="chips">
          {CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              className={`chip${filters.categories.includes(category) ? ' on' : ''}`}
              onClick={() => toggleCategory(category)}
            >
              {categoryLabel(category)}
            </button>
          ))}
        </div>

        <div className="chips">
          <button
            type="button"
            className={`chip${filters.unreadOnly ? ' on' : ''}`}
            onClick={() => onFiltersChange({ ...filters, unreadOnly: !filters.unreadOnly })}
          >
            仅未读
          </button>
          <button
            type="button"
            className={`chip risk${filters.minRisk >= 2 ? ' on' : ''}`}
            onClick={() =>
              onFiltersChange({ ...filters, minRisk: filters.minRisk >= 2 ? 0 : 2 })
            }
          >
            可疑及以上
          </button>
          <button
            type="button"
            className={`chip${filters.direction === 'in' ? ' on' : ''}`}
            onClick={() =>
              onFiltersChange({
                ...filters,
                direction: filters.direction === 'in' ? 'all' : 'in',
              })
            }
          >
            仅接收
          </button>
          <button
            type="button"
            className={`chip${filters.untranslatedOnly ? ' on' : ''}`}
            onClick={() =>
              onFiltersChange({ ...filters, untranslatedOnly: !filters.untranslatedOnly })
            }
          >
            未翻译
          </button>
        </div>

        <div className="filter-summary">
          <span>
            {active
              ? `${conversations.length} / ${totalConversations} 个会话匹配`
              : `${totalConversations} 个会话`}
          </span>
          {active && (
            <button
              type="button"
              className="btn ghost"
              onClick={() =>
                onFiltersChange({
                  query: '',
                  categories: [],
                  unreadOnly: false,
                  minRisk: 0,
                  direction: 'all',
                  untranslatedOnly: false,
                })
              }
            >
              清除
            </button>
          )}
        </div>
      </div>

      <div className="conversations">
        {conversations.map((conversation) => {
          const last = conversation.last
          const preview =
            last.translation?.text?.trim() ||
            last.body.trim() ||
            (last.attachments?.length ? '［图片］' : '')
          return (
            <button
              key={conversation.peer}
              type="button"
              className={`conversation${conversation.peer === selectedPeer ? ' active' : ''}`}
              onClick={() => onSelect(conversation.peer)}
            >
              <div className="name">{conversation.title}</div>
              <div className="when">{formatTime(conversation.last.date)}</div>
              <div className="preview">
                {conversation.last.direction === 'out' ? '我: ' : ''}
                {preview}
              </div>
              <div className="meta">
                {conversation.unread > 0 && (
                  <span className="badge unread">{conversation.unread}</span>
                )}
                {conversation.maxRisk >= 4 && <span className="badge danger">高风险</span>}
                {conversation.maxRisk >= 2 && conversation.maxRisk < 4 && (
                  <span className="badge warn">可疑</span>
                )}
                {conversation.categories.slice(0, 2).map((category) => (
                  <span key={category} className="badge">
                    {categoryLabel(category)}
                  </span>
                ))}
                {active && (
                  <span className="badge">
                    {conversation.matchCount} / {conversation.messages.length} 条匹配
                  </span>
                )}
              </div>
            </button>
          )
        })}

        {conversations.length === 0 && (
          <div className="empty">
            <h2>{active ? '没有匹配的短信' : '还没有短信'}</h2>
            <p>
              {active
                ? '换个关键词或清除筛选条件试试。'
                : '连接手机后点击右上角「同步」把短信读进来。'}
            </p>
          </div>
        )}
      </div>
    </aside>
  )
}
