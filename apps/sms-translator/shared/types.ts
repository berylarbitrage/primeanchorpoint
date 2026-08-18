/** Types shared between the Electron main process and the React renderer. */

export type Direction = 'in' | 'out'

export type Category =
  | 'personal'
  | 'verification'
  | 'bank'
  | 'delivery'
  | 'marketing'
  | 'spam'
  | 'fraud'
  | 'service'
  | 'other'

export const CATEGORIES: Category[] = [
  'personal',
  'verification',
  'bank',
  'delivery',
  'service',
  'marketing',
  'spam',
  'fraud',
  'other',
]

export type TranslationState = 'pending' | 'done' | 'error' | 'skipped'

export interface Translation {
  text: string
  sourceLang: string
  targetLang: string
  model: string
  at: number
}

export interface Analysis {
  category: Category
  /** 0 = harmless, 5 = almost certainly a scam. */
  risk: number
  summary: string
  at: number
}

export interface Attachment {
  /** Row id in `content://mms/part` — unique per device. */
  partId: number
  contentType: string
  name?: string
  /** File name under the app's media directory, once downloaded. */
  file?: string
  bytes?: number
  /** Set when the download failed; the message still shows, minus the image. */
  error?: string
  /** Claude's description / OCR of the image, when enabled. */
  description?: string
}

export interface SmsMessage {
  /** `${deviceSerial}:${androidRowId}` — stable across syncs. */
  id: string
  deviceSerial: string
  /** MMS is stored in different tables and can carry attachments. */
  kind: 'sms' | 'mms'
  rawId: number
  threadId: number
  /** Phone number exactly as Android stored it. */
  address: string
  /** Normalised address used for grouping conversations. */
  peer: string
  /** Contact display name, when the contacts provider is readable. */
  contact?: string
  date: number
  direction: Direction
  body: string
  /** MMS subject line, when the sender set one. */
  subject?: string
  attachments?: Attachment[]
  /** Read flag as reported by the phone. */
  readOnDevice: boolean
  /** Read flag maintained by this app (the phone's flag is not writable over adb). */
  readLocal: boolean
  translationState: TranslationState
  translationError?: string
  translation?: Translation
  analysis?: Analysis
  /** Set on messages this app sent, before the phone's SMS database catches up. */
  pending?: boolean
  /**
   * Sent from here, but the phone never wrote it to its SMS database — which
   * happens when the message went out as RCS / chat rather than as SMS. Kept in
   * the thread rather than dropped: it really was sent.
   */
  unconfirmed?: boolean
  /**
   * Translation state at the time this message was last pushed to the website.
   * Undefined = never pushed. Compared against `translationState` so a message
   * pushed before its translation arrived gets pushed again with it.
   */
  uploadedState?: TranslationState
}

/** Per-conversation notes kept by this app (the phone is never written to). */
export interface PeerNote {
  /** Display name to use instead of the number / phone-book name. */
  alias?: string
  /** Free text shown in the conversation header. */
  note?: string
}

/** Verdict on an outgoing draft, from `screenDraft`. */
export interface DraftScreening {
  flagged: boolean
  reason: string
  categories: string[]
}

/** A phone-book entry, used by the "new message" recipient picker. */
export interface Contact {
  name: string
  /** The number exactly as the contacts provider stores it. */
  number: string
}

export interface DeviceInfo {
  serial: string
  state: string
  model?: string
  device?: string
  /** True when `state === 'device'`, i.e. usable. */
  ready: boolean
}

export type SendMethod = 'ui' | 'keyevent' | 'manual'

export interface Settings {
  adbPath: string
  deviceSerial: string | null
  /** `host:port` from the phone's Wireless debugging screen. Empty = USB only. */
  wirelessAddress: string
  /** Conversations kept at the top of the list, newest-first within the group. */
  pinnedPeers: string[]
  /** Re-run `adb connect` when the wireless device drops off the list. */
  wirelessAutoReconnect: boolean
  targetLanguage: string
  /** Language outgoing drafts get translated into. Empty = same as targetLanguage. */
  outgoingLanguage: string
  /** Per-conversation override of that language, remembered per number. */
  outgoingLanguageByPeer: Record<string, string>
  /**
   * Language messages FROM this number get translated into. Empty follows
   * `targetLanguage`. Set here or on the website's phone page.
   */
  incomingLanguageByPeer: Record<string, string>
  /** Numbers whose incoming messages should NOT be auto-translated. */
  noAutoTranslatePeers: string[]
  /** Check outgoing drafts with Claude before sending. */
  screenOutgoing: boolean
  /** Aliases and notes, keyed by normalised number. */
  peerNotes: Record<string, PeerNote>
  /** When each note was last edited here, for the website merge. */
  peerNotesAt: Record<string, number>
  autoTranslate: boolean
  classify: boolean
  model: string
  /**
   * Model for the two things you wait on: translating a draft before sending,
   * and the pre-send check. Both are one short message and both block the send,
   * so they run on the fastest model rather than the most capable one.
   */
  fastModel: string
  pollIntervalMs: number
  autoSync: boolean
  initialImportDays: number
  /** Read MMS as well as SMS, downloading picture attachments. */
  includeMms: boolean
  /** Largest attachment to download, in KB. Bigger ones are skipped. */
  maxAttachmentKb: number
  /** Ask Claude to describe / OCR picture attachments. Costs extra per image. */
  describeImages: boolean
  sendMethod: SendMethod
  sendTapDelayMs: number
  batchSize: number
  /** True when an API key is stored; the key itself is never sent to the renderer. */
  hasApiKey: boolean

  /** Push messages to the company website so they can be read from anywhere. */
  uploadEnabled: boolean
  /** Full push endpoint, e.g. https://example.com/api/device-sms/push */
  uploadUrl: string
  /** Device token issued by the website's 手机短信 page. */
  uploadToken: string

  /** Serve the same inbox to browsers on the local network. */
  webEnabled: boolean
  webPort: number
  /** Password those browsers must enter. Generated on first enable. */
  webPassword: string
}

export const DEFAULT_SETTINGS: Settings = {
  adbPath: 'adb',
  deviceSerial: null,
  wirelessAddress: '',
  pinnedPeers: [],
  wirelessAutoReconnect: true,
  targetLanguage: '简体中文',
  outgoingLanguage: '',
  outgoingLanguageByPeer: {},
  incomingLanguageByPeer: {},
  noAutoTranslatePeers: [],
  screenOutgoing: true,
  peerNotes: {},
  peerNotesAt: {},
  autoTranslate: true,
  classify: true,
  model: 'claude-opus-5',
  fastModel: 'claude-haiku-4-5',
  pollIntervalMs: 6000,
  autoSync: true,
  initialImportDays: 90,
  includeMms: true,
  maxAttachmentKb: 2048,
  describeImages: true,
  sendMethod: 'ui',
  sendTapDelayMs: 1500,
  batchSize: 20,
  hasApiKey: false,
  uploadEnabled: false,
  uploadUrl: '',
  uploadToken: '',
  webEnabled: false,
  webPort: 8848,
  webPassword: '',
}

export interface SyncStatus {
  phase: 'idle' | 'connecting' | 'syncing' | 'translating' | 'error'
  detail?: string
  device?: DeviceInfo | null
  lastSyncAt?: number
  pendingTranslations: number
}

export interface SendResult {
  ok: boolean
  /**
   * Always set on success: says how the message was confirmed (button tapped,
   * fell back to key events, or left for the user to send on the phone).
   */
  note?: string
  message?: SmsMessage
}

export interface WirelessResult {
  ok: boolean
  message: string
  address?: string
}

/** Last known state of the website push, for the settings dialog. */
export interface UploadStatus {
  enabled: boolean
  pending: number
  lastPushAt?: number
  lastSaved?: number
  error?: string
}

export interface WebStatus {
  running: boolean
  port: number
  /** Every address this machine can be opened at, e.g. http://192.168.1.20:8848. */
  urls: string[]
  password: string
  error?: string
}

export interface DraftTranslation {
  text: string
  targetLang: string
}

/** The surface exposed on `window.sms` by the preload script. */
export interface SmsBridge {
  /** `adbPath` overrides the saved setting, for scanning an unsaved edit. */
  listDevices(adbPath?: string): Promise<DeviceInfo[]>
  /** Opens a native file picker for adb; saves and returns it when valid. */
  browseForAdb(): Promise<{ path: string | null; error?: string }>
  selectDevice(serial: string | null): Promise<Settings>

  /** Wireless debugging: pair once, then connect whenever needed. */
  pairWireless(address: string, code: string): Promise<WirelessResult>
  connectWireless(address: string): Promise<WirelessResult>
  disconnectWireless(address: string): Promise<WirelessResult>
  /** Switch a USB-connected phone into wireless mode (pre-Android-11 route). */
  enableWirelessOverUsb(): Promise<WirelessResult & { suggestedAddress?: string }>

  listMessages(): Promise<SmsMessage[]>
  sync(mode: 'full' | 'incremental'): Promise<{ imported: number }>
  send(to: string, body: string): Promise<SendResult>
  markThreadRead(peer: string): Promise<void>
  markThreadUnread(peer: string): Promise<void>
  markAllRead(): Promise<void>

  /**
   * Remove messages from this app only — the phone's own copy is untouched,
   * because the shell user is not the default SMS app and cannot write to the
   * SMS provider. Deleted ids are remembered so a later sync does not bring
   * them back.
   */
  deleteMessages(ids: string[]): Promise<void>
  deleteConversation(peer: string): Promise<void>

  /** Pin/unpin a conversation to the top of the list. */
  setPinned(peer: string, pinned: boolean): Promise<Settings>

  /** Phone book, for addressing a new message by name. Empty when unreadable. */
  listContacts(refresh?: boolean): Promise<Contact[]>
  /** Open the phone's dialler on a number (does not place the call). */
  dial(number: string): Promise<{ ok: boolean; message: string }>
  /** Put text on the Windows clipboard. */
  copyText(text: string): Promise<void>

  /** Attachment bytes as a data: URL, loaded on demand (never kept in the store). */
  readAttachment(messageId: string, partId: number): Promise<{ dataUrl?: string; error?: string }>

  retranslate(ids: string[]): Promise<void>
  /** `targetLanguage` overrides the configured outgoing language for this draft. */
  translateDraft(text: string, targetLanguage?: string): Promise<DraftTranslation>
  /** Check a draft before sending. Throws if no API key is configured. */
  screenDraft(text: string): Promise<DraftScreening>

  /** Remember the language used for one conversation, and its alias / note. */
  setOutgoingLanguage(peer: string, language: string): Promise<Settings>
  setPeerNote(peer: string, note: PeerNote): Promise<Settings>

  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  setApiKey(key: string): Promise<Settings>

  getStatus(): Promise<SyncStatus>

  /** Website push: current state, and a way to send everything outstanding now. */
  getUploadStatus(): Promise<UploadStatus>
  pushNow(): Promise<UploadStatus>

  /** Local-network sharing: current state, and a way to restart it. */
  getWebStatus(): Promise<WebStatus>
  restartWebServer(): Promise<WebStatus>
  regenerateWebPassword(): Promise<WebStatus>

  onMessages(cb: (messages: SmsMessage[]) => void): () => void
  onRemoved(cb: (ids: string[]) => void): () => void
  onStatus(cb: (status: SyncStatus) => void): () => void
  /** Settings changed in the main process (e.g. notes edited on the website). */
  onSettings(cb: (settings: Settings) => void): () => void
}
