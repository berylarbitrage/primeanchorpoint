import path from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { listDevices, resolveDevice } from './adb/adb'
import { AdbLocator } from './adb/locate'
import { sendSms } from './adb/send'
import { normalisePeer } from './adb/sms'
import { SettingsStore } from './settings'
import { MessageStore } from './store'
import { Syncer } from './sync/syncer'
import { TranslationQueue } from './translate/queue'
import { translateDraft } from './translate/claude'
import type {
  DeviceInfo,
  DraftTranslation,
  SendResult,
  Settings,
  SmsMessage,
  SyncStatus,
} from '../shared/types'

let settings: SettingsStore
let store: MessageStore
let syncer: Syncer
let queue: TranslationQueue
let locator: AdbLocator
let window: BrowserWindow | null = null

/** Phase reported by the syncer, kept separate from the translation indicator. */
let syncPhase: 'idle' | 'connecting' | 'syncing' | 'error' = 'idle'
let syncDetail: string | undefined
let lastSyncAt: number | undefined
let device: DeviceInfo | null = null
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
}

function emitRemoved(ids: string[]): void {
  if (!ids.length) return
  window?.webContents.send('sms:removed', ids)
}

function emitStatus(): void {
  window?.webContents.send('sms:status', currentStatus())
}

function handle<T extends unknown[], R>(
  channel: string,
  fn: (...args: T) => Promise<R> | R,
): void {
  ipcMain.handle(channel, async (_event, ...args) => fn(...(args as T)))
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

  handle('devices:list', async (): Promise<DeviceInfo[]> => {
    const adbPath = await locator.require()
    return listDevices(adbPath)
  })

  handle('devices:select', async (serial: string | null): Promise<Settings> => {
    const updated = settings.update({ deviceSerial: serial })
    void syncer.sync('incremental').catch(() => {})
    return updated
  })

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

  syncer.start()
  void syncer.sync('incremental').catch(() => {})
  if (settings.public().autoTranslate && settings.apiKey()) {
    queue.enqueue(store.untranslated().map((m) => m.id))
  }
}

export function disposeIpc(): void {
  syncer?.stop()
  queue?.stop()
  store?.dispose()
  window = null
}

/** Point the event emitters at a freshly created window. */
export function setWindow(win: BrowserWindow): void {
  window = win
}
