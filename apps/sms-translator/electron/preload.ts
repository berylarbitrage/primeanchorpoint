import { contextBridge, ipcRenderer } from 'electron'
import type {
  Contact,
  DraftScreening,
  DeviceInfo,
  DraftTranslation,
  SendResult,
  Settings,
  SmsBridge,
  SmsMessage,
  SyncStatus,
  UploadStatus,
  WebStatus,
  WirelessResult,
} from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

const bridge: SmsBridge = {
  listDevices: (adbPath) =>
    ipcRenderer.invoke('devices:list', adbPath) as Promise<DeviceInfo[]>,
  browseForAdb: () =>
    ipcRenderer.invoke('adb:browse') as Promise<{ path: string | null; error?: string }>,
  selectDevice: (serial) => ipcRenderer.invoke('devices:select', serial) as Promise<Settings>,

  pairWireless: (address, code) =>
    ipcRenderer.invoke('wireless:pair', address, code) as Promise<WirelessResult>,
  connectWireless: (address) =>
    ipcRenderer.invoke('wireless:connect', address) as Promise<WirelessResult>,
  disconnectWireless: (address) =>
    ipcRenderer.invoke('wireless:disconnect', address) as Promise<WirelessResult>,
  enableWirelessOverUsb: () =>
    ipcRenderer.invoke('wireless:enableOverUsb') as Promise<
      WirelessResult & { suggestedAddress?: string }
    >,
  discoverWireless: () =>
    ipcRenderer.invoke('wireless:discover') as Promise<WirelessResult & { address?: string }>,

  listMessages: () => ipcRenderer.invoke('sms:list') as Promise<SmsMessage[]>,
  sync: (mode) => ipcRenderer.invoke('sms:sync', mode) as Promise<{ imported: number }>,
  send: (to, body) => ipcRenderer.invoke('sms:send', to, body) as Promise<SendResult>,
  markThreadRead: (peer) => ipcRenderer.invoke('sms:markThreadRead', peer) as Promise<void>,
  markThreadUnread: (peer) => ipcRenderer.invoke('sms:markThreadUnread', peer) as Promise<void>,
  markAllRead: () => ipcRenderer.invoke('sms:markAllRead') as Promise<void>,

  deleteMessages: (ids) => ipcRenderer.invoke('sms:delete', ids) as Promise<void>,
  deleteConversation: (peer) => ipcRenderer.invoke('sms:deleteThread', peer) as Promise<void>,
  setPinned: (peer, pinned) =>
    ipcRenderer.invoke('sms:setPinned', peer, pinned) as Promise<Settings>,

  listContacts: (refresh) => ipcRenderer.invoke('contacts:list', refresh) as Promise<Contact[]>,
  dial: (number) =>
    ipcRenderer.invoke('phone:dial', number) as Promise<{ ok: boolean; message: string }>,
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text) as Promise<void>,

  readAttachment: (messageId, partId) =>
    ipcRenderer.invoke('mms:readAttachment', messageId, partId) as Promise<{
      dataUrl?: string
      error?: string
    }>,

  retranslate: (ids) => ipcRenderer.invoke('translate:retry', ids) as Promise<void>,
  translateDraft: (text, targetLanguage) =>
    ipcRenderer.invoke('translate:draft', text, targetLanguage) as Promise<DraftTranslation>,
  screenDraft: (text) => ipcRenderer.invoke('translate:screen', text) as Promise<DraftScreening>,

  setOutgoingLanguage: (peer, language) =>
    ipcRenderer.invoke('settings:outgoingLanguage', peer, language) as Promise<Settings>,
  setPeerNote: (peer, note) => ipcRenderer.invoke('settings:peerNote', peer, note) as Promise<Settings>,

  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch) as Promise<Settings>,
  setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', key) as Promise<Settings>,

  getStatus: () => ipcRenderer.invoke('status:get') as Promise<SyncStatus>,

  getUploadStatus: () => ipcRenderer.invoke('upload:status') as Promise<UploadStatus>,
  pushNow: () => ipcRenderer.invoke('upload:now') as Promise<UploadStatus>,

  getWebStatus: () => ipcRenderer.invoke('web:status') as Promise<WebStatus>,
  restartWebServer: () => ipcRenderer.invoke('web:restart') as Promise<WebStatus>,
  regenerateWebPassword: () => ipcRenderer.invoke('web:newPassword') as Promise<WebStatus>,

  onMessages: (cb) => subscribe<SmsMessage[]>('sms:messages', cb),
  onRemoved: (cb) => subscribe<string[]>('sms:removed', cb),
  onStatus: (cb) => subscribe<SyncStatus>('sms:status', cb),
  onSettings: (cb) => subscribe<Settings>('sms:settings', cb),
}

contextBridge.exposeInMainWorld('sms', bridge)
