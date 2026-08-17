import { contextBridge, ipcRenderer } from 'electron'
import type {
  DeviceInfo,
  DraftTranslation,
  SendResult,
  Settings,
  SmsBridge,
  SmsMessage,
  SyncStatus,
} from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

const bridge: SmsBridge = {
  listDevices: () => ipcRenderer.invoke('devices:list') as Promise<DeviceInfo[]>,
  selectDevice: (serial) => ipcRenderer.invoke('devices:select', serial) as Promise<Settings>,

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
