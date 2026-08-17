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
  /** Re-run `adb connect` when the wireless device drops off the list. */
  wirelessAutoReconnect: boolean
  targetLanguage: string
  /** Language outgoing drafts get translated into. Empty = same as targetLanguage. */
  outgoingLanguage: string
  autoTranslate: boolean
  classify: boolean
  model: string
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
}

export const DEFAULT_SETTINGS: Settings = {
  adbPath: 'adb',
  deviceSerial: null,
  wirelessAddress: '',
  wirelessAutoReconnect: true,
  targetLanguage: '简体中文',
  outgoingLanguage: '',
  autoTranslate: true,
  classify: true,
  model: 'claude-opus-5',
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

  /** Attachment bytes as a data: URL, loaded on demand (never kept in the store). */
  readAttachment(messageId: string, partId: number): Promise<{ dataUrl?: string; error?: string }>

  retranslate(ids: string[]): Promise<void>
  translateDraft(text: string): Promise<DraftTranslation>

  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  setApiKey(key: string): Promise<Settings>

  getStatus(): Promise<SyncStatus>

  onMessages(cb: (messages: SmsMessage[]) => void): () => void
  onRemoved(cb: (ids: string[]) => void): () => void
  onStatus(cb: (status: SyncStatus) => void): () => void
}
