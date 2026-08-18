import type { Category, PeerNote, SmsMessage } from '../../shared/types'

export interface Filters {
  query: string
  categories: Category[]
  unreadOnly: boolean
  /** 0 disables the risk filter. */
  minRisk: number
  direction: 'all' | 'in' | 'out'
  untranslatedOnly: boolean
}

export const EMPTY_FILTERS: Filters = {
  query: '',
  categories: [],
  unreadOnly: false,
  minRisk: 0,
  direction: 'all',
  untranslatedOnly: false,
}

export function filtersActive(f: Filters): boolean {
  return (
    f.query.trim() !== '' ||
    f.categories.length > 0 ||
    f.unreadOnly ||
    f.minRisk > 0 ||
    f.direction !== 'all' ||
    f.untranslatedOnly
  )
}

export function matches(message: SmsMessage, f: Filters): boolean {
  if (f.direction !== 'all' && message.direction !== f.direction) return false
  if (f.unreadOnly && (message.readLocal || message.direction === 'out')) return false
  if (f.untranslatedOnly && message.translationState === 'done') return false
  if (f.minRisk > 0 && (message.analysis?.risk ?? 0) < f.minRisk) return false
  if (f.categories.length && !f.categories.includes(message.analysis?.category ?? 'other')) {
    return false
  }

  const query = f.query.trim().toLowerCase()
  if (query) {
    const haystack = [
      message.body,
      message.translation?.text ?? '',
      message.analysis?.summary ?? '',
      message.address,
      message.contact ?? '',
    ]
      .join('\n')
      .toLowerCase()
    if (!haystack.includes(query)) return false
  }

  return true
}

export interface Conversation {
  peer: string
  title: string
  /** The address to reply to — the most recent one seen for this peer. */
  address: string
  messages: SmsMessage[]
  last: SmsMessage
  unread: number
  maxRisk: number
  categories: Category[]
  /** How many messages pass the active filters. */
  matchCount: number
  pinned: boolean
  /** Alias and free-text note kept by this app, if any. */
  note?: PeerNote
}

export function buildConversations(
  messages: SmsMessage[],
  filters: Filters,
  pinnedPeers: string[] = [],
  peerNotes: Record<string, PeerNote> = {},
): Conversation[] {
  const pinned = new Set(pinnedPeers)
  const groups = new Map<string, SmsMessage[]>()
  for (const message of messages) {
    const list = groups.get(message.peer)
    if (list) list.push(message)
    else groups.set(message.peer, [message])
  }

  const active = filtersActive(filters)
  const conversations: Conversation[] = []

  for (const [peer, list] of groups) {
    list.sort((a, b) => a.date - b.date)
    const last = list[list.length - 1]
    const matchCount = active ? list.filter((m) => matches(m, filters)).length : list.length
    if (active && matchCount === 0) continue

    const categories = new Set<Category>()
    let maxRisk = 0
    let unread = 0
    let contact: string | undefined
    for (const message of list) {
      if (message.analysis) {
        categories.add(message.analysis.category)
        maxRisk = Math.max(maxRisk, message.analysis.risk)
      }
      if (message.direction === 'in' && !message.readLocal) unread++
      if (message.contact) contact = message.contact
    }

    const note = peerNotes[peer]
    conversations.push({
      peer,
      // An alias set here wins: it is the name the user chose for this number.
      title: note?.alias || contact || last.address || peer,
      address: last.address || peer,
      messages: list,
      last,
      unread,
      maxRisk,
      categories: [...categories],
      matchCount,
      pinned: pinned.has(peer),
      note,
    })
  }

  // Pinned conversations stay on top; everything else is newest-first.
  conversations.sort((a, b) =>
    a.pinned === b.pinned ? b.last.date - a.last.date : a.pinned ? -1 : 1,
  )
  return conversations
}

const CATEGORY_LABELS: Record<Category, string> = {
  personal: '个人',
  verification: '验证码',
  bank: '银行',
  delivery: '物流',
  service: '服务通知',
  marketing: '营销',
  spam: '垃圾短信',
  fraud: '疑似诈骗',
  other: '其他',
}

export function categoryLabel(category: Category): string {
  return CATEGORY_LABELS[category] ?? category
}

export function riskLabel(risk: number): string {
  if (risk >= 4) return '高风险'
  if (risk >= 2) return '可疑'
  return ''
}

export function formatTime(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return time

  const sameYear = date.getFullYear() === now.getFullYear()
  const day = date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return `${day} ${time}`
}

export function formatDayHeading(ts: number): string {
  return new Date(ts).toLocaleDateString([], {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
}

/** Merge an incoming batch of records into an existing list, newest state wins. */
export function mergeMessages(
  current: SmsMessage[],
  incoming: SmsMessage[],
): SmsMessage[] {
  if (!incoming.length) return current
  const byId = new Map(current.map((m) => [m.id, m]))
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort((a, b) => a.date - b.date)
}
