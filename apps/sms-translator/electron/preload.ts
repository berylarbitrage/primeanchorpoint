import { contextBridge, ipcRenderer } from 'electron'
import type {
  DeviceInfo,
  DraftTranslation,
  SendResult,
  Settings,
  SmsBridge,
  SmsMessage,
  SyncStatus,
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

  listMessages: () => ipcRenderer.invoke('sms:list') as Promise<SmsMessage[]>,
  sync: (mode) => ipcRenderer.invoke('sms:sync', mode) as Promise<{ imported: number }>,
  send: (to, body) => ipcRenderer.invoke('sms:send', to, body) as Promise<SendResult>,
  markThreadRead: (peer) => ipcRenderer.invoke('sms:markThreadRead', peer) as Promise<void>,

  retranslate: (ids) => ipcRenderer.invoke('translate:retry', ids) as Promise<void>,
  translateDraft: (text) =>
    ipcRenderer.invoke('translate:draft', text) as Promise<DraftTranslation>,

  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch) as Promise<Settings>,
  setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', key) as Promise<Settings>,

  getStatus: () => ipcRenderer.invoke('status:get') as Promise<SyncStatus>,

  onMessages: (cb) => subscribe<SmsMessage[]>('sms:messages', cb),
  onRemoved: (cb) => subscribe<string[]>('sms:removed', cb),
  onStatus: (cb) => subscribe<SyncStatus>('sms:status', cb),
}

contextBridge.exposeInMainWorld('sms', bridge)
