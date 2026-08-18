import path from 'node:path'
import { app, clipboard, dialog, ipcMain, type BrowserWindow } from 'electron'
import { listDevices, resolveDevice } from './adb/adb'
import { AdbLocator, verifyAdb } from './adb/locate'
import {
  connectWireless,
  disconnectWireless,
  enableTcpip,
  pairWireless,
  readWifiAddress,
} from './adb/wireless'
import { dialNumber, sendSms } from './adb/send'
import { listPhoneContacts } from './adb/contacts'
import { normalisePeer } from './adb/sms'
import { SettingsStore } from './settings'
import { MessageStore } from './store'
import { Syncer } from './sync/syncer'
import { TranslationQueue } from './translate/queue'
import { translateDraft } from './translate/claude'
import { WebServer, generatePassword, localUrls } from './web/server'
import type {
  Contact,
  DeviceInfo,
  DraftTranslation,
  SendResult,
  Settings,
  SmsMessage,
  SyncStatus,
  WebStatus,
  WirelessResult,
} from '../shared/types'

let settings: SettingsStore
let store: MessageStore
let syncer: Syncer
let queue: TranslationQueue
let locator: AdbLocator
let web: WebServer | null = null
let webError: string | undefined
let window: BrowserWindow | null = null

/** Every IPC handler by name, so the web server can call the same code. */
const handlers = new Map<string, (...args: never[]) => unknown>()

/** Phase reported by the syncer, kept separate from the translation indicator. */
let syncPhase: 'idle' | 'connecting' | 'syncing' | 'error' = 'idle'
let syncDetail: string | undefined
let lastSyncAt: number | undefined
let device: DeviceInfo | null = null
/** Phone book, read once per session (see the contacts:list handler). */
let contactBook: Contact[] | null = null
let pendingTranslations = 0

function currentStatus(): SyncStatus {
  return {
    // A busy translation queue is worth showing, but never at the expense of an
    // error the user needs to act on.
    phase:
      syncPhase === 'error' || syncPhase === 'connecting' || syncPhase === 'syncing'
        ? syncPhase
        : pendingTranslations > 0
          ? 'translating'
          : 'idle',
    detail: syncDetail,
    device,
    lastSyncAt,
    pendingTranslations,
  }
}

function emitMessages(messages: SmsMessage[]): void {
  if (!messages.length) return
  window?.webContents.send('sms:messages', messages)
  web?.broadcast('messages', messages)
}

function emitRemoved(ids: string[]): void {
  if (!ids.length) return
  window?.webContents.send('sms:removed', ids)
  web?.broadcast('removed', ids)
}

function emitStatus(): void {
  const status = currentStatus()
  window?.webContents.send('sms:status', status)
  web?.broadcast('status', status)
}

function handle<T extends unknown[], R>(
  channel: string,
  fn: (...args: T) => Promise<R> | R,
): void {
  handlers.set(channel, fn as (...args: never[]) => unknown)
  ipcMain.handle(channel, async (_event, ...args) => fn(...(args as T)))
}

function webStatus(): WebStatus {
  const current = settings.public()
  return {
    running: web?.running() ?? false,
    port: current.webPort,
    urls: web?.running() ? localUrls(current.webPort) : [],
    password: current.webPassword,
    error: webError,
  }
}

/** Apply the current settings to the web server: start, stop, or rebind. */
async function restartWeb(): Promise<void> {
  if (!web) return
  web.stop()
  webError = undefined
  const current = settings.public()
  if (!current.webEnabled) return
  if (!current.webPassword) {
    // Never serve the inbox without a password, even for a moment.
    settings.update({ webPassword: generatePassword() })
  }
  const result = await web.start()
  if (!result.ok) webError = result.error
  emitStatus()
}

export function registerIpc(win: BrowserWindow): void {
  window = win

  const userData = app.getPath('userData')
  settings = new SettingsStore(userData)
  settings.load()

  store = new MessageStore(path.join(userData, 'data'))
  store.load()

  locator = new AdbLocator(
    () => settings.public().adbPath,
    // Persist whatever we found so the UI shows the path actually in use.
    (adbPath) => settings.update({ adbPath }),
  )

  queue = new TranslationQueue({
    store,
    options: () => {
      const current = settings.public()
      return {
        apiKey: settings.apiKey(),
        model: current.model,
        targetLanguage: current.targetLanguage,
        classify: current.classify,
        batchSize: current.batchSize,
        enabled: current.autoTranslate,
        describeImages: current.describeImages,
      }
    },
    readImage: (file) => {
      try {
        return store.hasAttachment(file) ? store.readAttachment(file) : null
      } catch {
        return null
      }
    },
    onChanged: emitMessages,
    onProgress: (pending) => {
      pendingTranslations = pending
      emitStatus()
    },
  })

  syncer = new Syncer({
    store,
    settings: () => settings.public(),
    adbPath: () => locator.require(),
    apiKeyPresent: () => Boolean(settings.apiKey()),
    onMessages: emitMessages,
    onRemoved: emitRemoved,
    onDevice: (found) => {
      if (found?.serial !== device?.serial) contactBook = null
      device = found
      emitStatus()
    },
    onPhase: (phase, detail) => {
      syncPhase = phase
      syncDetail = detail
      if (phase === 'idle') lastSyncAt = Date.now()
      emitStatus()
    },
    onNeedTranslation: (ids) => queue.enqueue(ids),
  })

  handle('devices:list', async (adbPathOverride?: string): Promise<DeviceInfo[]> => {
    // The settings dialog scans with the path in its input box, which may not
    // be saved yet — otherwise "rescan" silently tests the old value.
    const adbPath = await locator.require(adbPathOverride)
    return listDevices(adbPath)
  })

  // Typing a path by hand is the step people get wrong, so let them pick the
  // file. The choice is verified here rather than saved blindly.
  handle('adb:browse', async (): Promise<{ path: string | null; error?: string }> => {
    if (!window) return { path: null }
    const result = await dialog.showOpenDialog(window, {
      title: '选择 adb 可执行文件',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [
              { name: 'adb', extensions: ['exe'] },
              { name: '所有文件', extensions: ['*'] },
            ]
          : [{ name: '所有文件', extensions: ['*'] }],
    })
    const chosen = result.canceled ? undefined : result.filePaths[0]
    if (!chosen) return { path: null }

    if (!(await verifyAdb(chosen))) {
      return {
        path: null,
        error: `选中的文件不是 adb：${chosen}。请选择 platform-tools 文件夹里的 adb.exe。`,
      }
    }

    settings.update({ adbPath: chosen })
    locator.reset()
    return { path: chosen }
  })

  handle('devices:select', async (serial: string | null): Promise<Settings> => {
    const updated = settings.update({ deviceSerial: serial })
    void syncer.sync('incremental').catch(() => {})
    return updated
  })

  handle('wireless:pair', async (address: string, code: string): Promise<WirelessResult> => {
    const adbPath = await locator.require()
    return pairWireless({ adbPath, serial: null }, address, code)
  })

  handle('wireless:connect', async (address: string): Promise<WirelessResult> => {
    const adbPath = await locator.require()
    const result = await connectWireless({ adbPath, serial: null }, address)
    if (result.ok && result.address) {
      // Remember it so the syncer can reconnect on its own after a drop.
      settings.update({ wirelessAddress: result.address, deviceSerial: result.address })
      void syncer.sync('incremental').catch(() => {})
    }
    return result
  })

  handle('wireless:disconnect', async (address: string): Promise<WirelessResult> => {
    const adbPath = await locator.require()
    const result = await disconnectWireless({ adbPath, serial: null }, address)
    settings.update({ wirelessAddress: '', deviceSerial: null })
    return result
  })

  handle(
    'wireless:enableOverUsb',
    async (): Promise<WirelessResult & { suggestedAddress?: string }> => {
      const adbPath = await locator.require()
      const current = settings.public()
      const usb = await resolveDevice(adbPath, current.deviceSerial)
      if (!usb) {
        return { ok: false, message: '请先用 USB 线把手机连上，再点这个按钮。' }
      }
      const ctx = { adbPath, serial: usb.serial }
      const ip = await readWifiAddress(ctx)
      const result = await enableTcpip(ctx)
      return {
        ...result,
        suggestedAddress: ip && result.ok ? `${ip}:5555` : undefined,
      }
    },
  )

  handle('sms:list', (): SmsMessage[] => store.all())

  handle('sms:sync', (mode: 'full' | 'incremental') => syncer.sync(mode))

  handle('sms:send', async (to: string, body: string): Promise<SendResult> => {
    const current = settings.public()
    const adbPath = await locator.require()
    const target = await resolveDevice(adbPath, current.deviceSerial)
    if (!target) return { ok: false, note: 'No Android device connected.' }

    const outcome = await sendSms({ adbPath, serial: target.serial }, to, body, {
      method: current.sendMethod,
      tapDelayMs: current.sendTapDelayMs,
    })

    // Show the message right away. The next sync reads the phone's own copy and
    // retires this placeholder (see Syncer.prunePending).
    const optimistic: SmsMessage = {
      id: `local:${target.serial}:${Date.now()}`,
      deviceSerial: target.serial,
      kind: 'sms',
      rawId: -1,
      threadId: 0,
      address: to,
      peer: normalisePeer(to),
      date: Date.now(),
      direction: 'out',
      body,
      readOnDevice: true,
      readLocal: true,
      translationState: 'skipped',
      pending: true,
    }
    emitMessages(store.upsertFromDevice([optimistic]))

    // Give the phone a moment to write the row, then pick it up.
    setTimeout(() => void syncer.sync('incremental').catch(() => {}), 4_000)

    return { ok: outcome.ok, note: outcome.note, message: optimistic }
  })

  handle('sms:markThreadRead', (peer: string) => {
    const updates = store
      .all()
      .filter((m) => m.peer === peer && !m.readLocal)
      .map((m) => ({ id: m.id, partial: { readLocal: true } }))
    if (updates.length) emitMessages(store.patchMany(updates))
  })

  // Only incoming messages can be unread; marking our own sent ones would make
  // the conversation permanently bold.
  handle('sms:markThreadUnread', (peer: string) => {
    const updates = store
      .all()
      .filter((m) => m.peer === peer && m.direction === 'in' && m.readLocal)
      .map((m) => ({ id: m.id, partial: { readLocal: false } }))
    if (updates.length) emitMessages(store.patchMany(updates))
  })

  handle('sms:markAllRead', () => {
    const updates = store
      .all()
      .filter((m) => !m.readLocal)
      .map((m) => ({ id: m.id, partial: { readLocal: true } }))
    if (updates.length) emitMessages(store.patchMany(updates))
  })

  handle('sms:delete', (ids: string[]) => {
    emitRemoved(store.remove(ids, true))
  })

  handle('sms:deleteThread', (peer: string) => {
    const ids = store
      .all()
      .filter((m) => m.peer === peer)
      .map((m) => m.id)
    emitRemoved(store.remove(ids, true))
    const current = settings.public()
    if (current.pinnedPeers.includes(peer)) {
      settings.update({ pinnedPeers: current.pinnedPeers.filter((p) => p !== peer) })
    }
  })

  handle('sms:setPinned', (peer: string, pinned: boolean): Settings => {
    const current = settings.public().pinnedPeers.filter((p) => p !== peer)
    return settings.update({ pinnedPeers: pinned ? [...current, peer] : current })
  })

  // The phone book changes rarely and the query is slow enough to notice, so it
  // is read once per session unless the user asks for a refresh.
  handle('contacts:list', async (refresh?: boolean): Promise<Contact[]> => {
    if (contactBook && !refresh) return contactBook
    const adbPath = await locator.require()
    const target = await resolveDevice(adbPath, settings.public().deviceSerial)
    if (!target) return contactBook ?? []
    contactBook = await listPhoneContacts({ adbPath, serial: target.serial })
    return contactBook
  })

  handle('phone:dial', async (number: string): Promise<{ ok: boolean; message: string }> => {
    const adbPath = await locator.require()
    const target = await resolveDevice(adbPath, settings.public().deviceSerial)
    if (!target) return { ok: false, message: '手机没连上，没法拨号。' }
    try {
      await dialNumber({ adbPath, serial: target.serial }, number)
      return { ok: true, message: '已在手机上打开拨号界面，请在手机上按拨号键。' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('clipboard:write', (text: string) => {
    clipboard.writeText(text)
  })

  handle(
    'mms:readAttachment',
    async (messageId: string, partId: number): Promise<{ dataUrl?: string; error?: string }> => {
      const message = store.get(messageId)
      const attachment = message?.attachments?.find((a) => a.partId === partId)
      if (!attachment) return { error: '找不到这个附件。' }
      if (attachment.error) return { error: attachment.error }
      if (!attachment.file || !store.hasAttachment(attachment.file)) {
        return { error: '附件还没下载下来，下一次同步会重试。' }
      }
      try {
        const bytes = store.readAttachment(attachment.file)
        return { dataUrl: `data:${attachment.contentType};base64,${bytes.toString('base64')}` }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  handle('translate:retry', (ids: string[]) => {
    queue.requeue(ids)
  })

  handle('translate:draft', async (text: string): Promise<DraftTranslation> => {
    const current = settings.public()
    const target = current.outgoingLanguage.trim() || current.targetLanguage
    const result = await translateDraft(text, {
      apiKey: settings.apiKey(),
      model: current.model,
      targetLanguage: target,
    })
    return { text: result.text, targetLang: target }
  })

  handle('settings:get', (): Settings => settings.public())

  handle('settings:set', (patch: Partial<Settings>): Settings => {
    const before = settings.public()
    const updated = settings.update(patch)
    if (before.adbPath !== updated.adbPath) locator.reset()
    if (before.pollIntervalMs !== updated.pollIntervalMs) syncer.restart()
    if (
      before.webEnabled !== updated.webEnabled ||
      before.webPort !== updated.webPort ||
      before.webPassword !== updated.webPassword
    ) {
      void restartWeb()
    }
    if (updated.autoTranslate && settings.apiKey()) {
      queue.enqueue(store.untranslated().map((m) => m.id))
    }
    return updated
  })

  handle('settings:setApiKey', (key: string): Settings => {
    const updated = settings.setApiKey(key)
    if (updated.hasApiKey && updated.autoTranslate) {
      queue.enqueue(store.untranslated().map((m) => m.id))
    }
    return updated
  })

  handle('status:get', (): SyncStatus => currentStatus())

  handle('web:status', (): WebStatus => webStatus())

  handle('web:restart', async (): Promise<WebStatus> => {
    await restartWeb()
    return webStatus()
  })

  handle('web:newPassword', async (): Promise<WebStatus> => {
    settings.update({ webPassword: generatePassword() })
    // The password is checked per request, but existing browser sessions keep
    // their token — a fresh password should lock them out too.
    await restartWeb()
    return webStatus()
  })

  web = new WebServer({
    // Packaged, main.js sits in dist-electron/electron/, and the renderer in
    // dist/ next to it — the same path loadFile() uses.
    distDir: path.join(__dirname, '..', '..', 'dist'),
    invoke: async (channel, args) => {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`未知的操作：${channel}`)
      return (fn as (...a: unknown[]) => unknown)(...args)
    },
    password: () => settings.public().webPassword,
    port: () => settings.public().webPort,
  })
  if (settings.public().webEnabled) void restartWeb()

  syncer.start()
  void syncer.sync('incremental').catch(() => {})
  if (settings.public().autoTranslate && settings.apiKey()) {
    queue.enqueue(store.untranslated().map((m) => m.id))
  }
}

export function disposeIpc(): void {
  web?.stop()
  web = null
  syncer?.stop()
  queue?.stop()
  store?.dispose()
  window = null
}

/** Point the event emitters at a freshly created window. */
export function setWindow(win: BrowserWindow): void {
  window = win
}
