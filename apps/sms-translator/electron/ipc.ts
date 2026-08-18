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
import { screenDraft, translateDraft } from './translate/claude'
import { WebServer, generatePassword, localUrls } from './web/server'
import { redactForRemote, sanitiseRemoteArgs } from './web/remote'
import {
  fetchNotes,
  fetchRetranslate,
  fetchOutbox,
  pendingUploads,
  pushMessages,
  pushNotes,
  reportOutbox,
  uploadedPatches,
  needsPush,
} from './upload/push'
import type {
  Contact,
  DraftScreening,
  PeerNote,
  DeviceInfo,
  DraftTranslation,
  SendResult,
  Settings,
  SmsMessage,
  SyncStatus,
  UploadStatus,
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

let uploadBusy = false
let uploadError: string | undefined
let lastPushAt: number | undefined
let lastSaved: number | undefined

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

function uploadStatus(): UploadStatus {
  const current = settings.public()
  return {
    enabled: current.uploadEnabled,
    pending: current.uploadEnabled ? store.all().filter(needsPush).length : 0,
    lastPushAt,
    lastSaved,
    error: uploadError,
  }
}

/**
 * Send whatever is outstanding to the website.
 *
 * Runs after every sync and after translations land, so the website copy trails
 * this app by one pass rather than needing its own schedule. One batch per call
 * keeps a first import from turning into a long upload; the next pass takes the
 * rest.
 */
async function pushToWebsite(): Promise<void> {
  const current = settings.public()
  if (!current.uploadEnabled || uploadBusy) return

  const batch = pendingUploads(store.all())
  if (!batch.length) {
    uploadError = undefined
    return
  }

  uploadBusy = true
  try {
    const result = await pushMessages(
      { url: current.uploadUrl, token: current.uploadToken },
      current.deviceSerial ?? device?.serial ?? '',
      batch,
    )
    if (result.ok) {
      uploadError = undefined
      lastPushAt = Date.now()
      lastSaved = result.saved
      // Recorded only after the server accepted them, so a failed push is
      // retried rather than silently dropped.
      store.patchMany(uploadedPatches(batch))
    } else {
      uploadError = result.error
    }
  } finally {
    uploadBusy = false
  }
}

/**
 * Hand one message to the phone. Shared by the UI and by the website outbox —
 * both need the same optimistic record and the same follow-up sync.
 */
async function sendOne(to: string, body: string): Promise<SendResult> {
  const current = settings.public()
  const adbPath = await locator.require()
  const target = await resolveDevice(adbPath, current.deviceSerial)
  if (!target) return { ok: false, note: '手机没连上，发不出去。' }

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
}

/**
 * Re-translate whatever the website asked for.
 *
 * Ids on the website are this app's own message ids, so the mapping is direct:
 * mark them pending and let the queue do the work. The new translation goes up
 * on the next push, which clears the flag server-side.
 */
async function drainRetranslate(): Promise<void> {
  const current = settings.public()
  if (!current.uploadEnabled || !settings.apiKey()) return

  const wanted = await fetchRetranslate({ url: current.uploadUrl, token: current.uploadToken })
  if (!wanted.length) return

  const ids = wanted.map((item) => item.remote_id).filter((id) => Boolean(store.get(id)))
  if (!ids.length) return

  emitMessages(
    store.patchMany(
      ids.map((id) => ({
        id,
        partial: { translationState: 'pending' as const, translationError: undefined },
      })),
    ),
  )
  queue.requeue(ids)
}

/**
 * How often to ask the website whether anything is waiting to be sent.
 *
 * This is the floor on how long a message written on the web page sits before
 * the phone even starts sending it, so it is deliberately short; the request
 * itself is a few hundred bytes.
 */
const OUTBOX_POLL_MS = 5_000
let outboxCheckedAt = 0
let outboxBusy = false

/**
 * Send whatever was written on the website.
 *
 * The website has no phone — it can only queue. This machine is the one holding
 * the phone, so it polls, sends, and reports back. Sends are serial: each one
 * drives the phone's SMS app through the UI, and two at once would fight over
 * the screen.
 */
async function drainOutbox(): Promise<void> {
  const current = settings.public()
  if (!current.uploadEnabled || outboxBusy) return
  if (Date.now() - outboxCheckedAt < OUTBOX_POLL_MS) return
  outboxCheckedAt = Date.now()

  const target = { url: current.uploadUrl, token: current.uploadToken }
  void syncNotes()
  void drainRetranslate()
  const queued = await fetchOutbox(target)
  if (!queued.length) return

  outboxBusy = true
  try {
    for (const item of queued) {
      try {
        // The website has no API key, so the outgoing check can only happen
        // here. A flagged message comes back as a failure with the reason, so
        // whoever wrote it sees why and can rewrite it (or send it from here,
        // where there is an override).
        if (current.screenOutgoing && settings.apiKey()) {
          const verdict = await screenDraft(item.body, {
            apiKey: settings.apiKey(),
            model: current.fastModel || current.model,
          }).catch(() => null)
          if (verdict?.flagged) {
            await reportOutbox(
              target,
              item.id,
              false,
              `发送前检查拦下了：${verdict.reason || '内容可能有问题'}。确认没问题的话，在电脑上重发一次。`,
            )
            continue
          }
        }

        // The website can ask for a language; this side has the API key, so the
        // translation happens here and what goes out is the translated text.
        let body = item.body
        if (item.translate_to && settings.apiKey()) {
          try {
            const translated = await translateDraft(item.body, {
              apiKey: settings.apiKey(),
              model: current.fastModel || current.model,
              targetLanguage: item.translate_to,
            })
            if (translated.text.trim()) body = translated.text
          } catch (err) {
            await reportOutbox(
              target,
              item.id,
              false,
              `翻译成${item.translate_to}时出错：${err instanceof Error ? err.message : String(err)}`,
            )
            continue
          }
        }

        const result = await sendOne(item.to_address, body)
        await reportOutbox(target, item.id, result.ok, result.note ?? '')
      } catch (err) {
        await reportOutbox(target, item.id, false, err instanceof Error ? err.message : String(err))
      }
    }
  } finally {
    outboxBusy = false
  }
}

/**
 * Keep aliases and notes the same on both sides.
 *
 * Whoever edited last wins: the website stamps `updated_at`, this side stamps
 * `peerNotesAt` when the user edits here. Cosmetic data, so a lost race costs a
 * label, not a message.
 */
async function syncNotes(): Promise<void> {
  const current = settings.public()
  if (!current.uploadEnabled) return
  const target = { url: current.uploadUrl, token: current.uploadToken }

  const remote = await fetchNotes(target)
  const remoteByPeer = new Map(remote.map((n) => [n.peer, n]))

  const merged = { ...current.peerNotes }
  let changed = false
  for (const note of remote) {
    const local = merged[note.peer]
    const same = (local?.alias ?? '') === (note.alias ?? '') && (local?.note ?? '') === (note.note ?? '')
    if (same) continue
    const stamp = Date.parse((note.updated_at ?? '').replace(' ', 'T') + 'Z')
    const localStamp = current.peerNotesAt?.[note.peer] ?? 0
    if (Number.isFinite(stamp) && stamp > localStamp) {
      const alias = (note.alias ?? '').trim()
      const text = (note.note ?? '').trim()
      if (alias || text) merged[note.peer] = { ...(alias ? { alias } : {}), ...(text ? { note: text } : {}) }
      else delete merged[note.peer]
      changed = true
    }
  }
  // 对方语言 / 我的语言 are set on the website too; mirror them into the maps
  // the composer and the translation queue read.
  const outgoingLangs = { ...current.outgoingLanguageByPeer }
  const incomingLangs = { ...current.incomingLanguageByPeer }
  const noAuto = new Set(current.noAutoTranslatePeers)
  const noAutoBefore = noAuto.size
  let langsChanged = false
  for (const note of remote) {
    if (note.auto_translate === 0) noAuto.add(note.peer)
    else if (note.auto_translate === 1) noAuto.delete(note.peer)
    const contact = (note.contact_lang ?? '').trim()
    const agent = (note.agent_lang ?? '').trim()
    if (contact && outgoingLangs[note.peer] !== contact) {
      outgoingLangs[note.peer] = contact
      langsChanged = true
    }
    if (agent && incomingLangs[note.peer] !== agent) {
      incomingLangs[note.peer] = agent
      langsChanged = true
    }
  }

  const autoChanged =
    noAuto.size !== noAutoBefore ||
    current.noAutoTranslatePeers.some((peer) => !noAuto.has(peer))

  if (changed || langsChanged || autoChanged) {
    settings.update({
      ...(changed ? { peerNotes: merged } : {}),
      ...(langsChanged
        ? { outgoingLanguageByPeer: outgoingLangs, incomingLanguageByPeer: incomingLangs }
        : {}),
      ...(autoChanged ? { noAutoTranslatePeers: [...noAuto] } : {}),
    })
    window?.webContents.send('sms:settings', settings.public())
  }

  // Anything this side knows that the website does not, or knows differently.
  const outgoing = Object.entries(settings.public().peerNotes)
    .filter(([peer, note]) => {
      const there = remoteByPeer.get(peer)
      return (there?.alias ?? '') !== (note.alias ?? '') || (there?.note ?? '') !== (note.note ?? '')
    })
    .map(([peer, note]) => ({ peer, alias: note.alias ?? '', note: note.note ?? '' }))
  if (outgoing.length) await pushNotes(target, outgoing)
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
    languageFor: (peer) => settings.public().incomingLanguageByPeer[peer] ?? '',
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
      // Translations land after the sync that fetched them, so push again once
      // the queue drains — that pass carries the translated text.
      if (pending === 0) void pushToWebsite()
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
      if (phase === 'idle') {
        lastSyncAt = Date.now()
        void pushToWebsite()
        void drainOutbox()
      }
      emitStatus()
    },
    onNeedTranslation: (ids) => {
      // A conversation with 「收到的消息自动翻译」 off still syncs and still gets
      // pushed — it just does not spend a Claude call unless asked (重新翻译).
      const off = new Set(settings.public().noAutoTranslatePeers)
      queue.enqueue(off.size ? ids.filter((id) => !off.has(store.get(id)?.peer ?? '')) : ids)
    },
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

  handle('sms:send', (to: string, body: string): Promise<SendResult> => sendOne(to, body))

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

  handle('translate:draft', async (text: string, override?: string): Promise<DraftTranslation> => {
    const current = settings.public()
    const target = (override ?? '').trim() || current.outgoingLanguage.trim() || current.targetLanguage
    const result = await translateDraft(text, {
      apiKey: settings.apiKey(),
      model: current.fastModel || current.model,
      targetLanguage: target,
    })
    return { text: result.text, targetLang: target }
  })

  handle('translate:screen', async (text: string): Promise<DraftScreening> => {
    const current = settings.public()
    return screenDraft(text, { apiKey: settings.apiKey(), model: current.fastModel || current.model })
  })

  handle('settings:outgoingLanguage', (peer: string, language: string): Settings => {
    const map = { ...settings.public().outgoingLanguageByPeer }
    // Empty means "follow the global setting" — stored as an absence, not a blank.
    if (language.trim()) map[peer] = language.trim()
    else delete map[peer]
    return settings.update({ outgoingLanguageByPeer: map })
  })

  handle('settings:peerNote', (peer: string, note: PeerNote): Settings => {
    const stamps = { ...(settings.public().peerNotesAt ?? {}), [peer]: Date.now() }
    settings.update({ peerNotesAt: stamps })
    const map = { ...settings.public().peerNotes }
    const alias = (note.alias ?? '').trim()
    const text = (note.note ?? '').trim()
    if (alias || text) map[peer] = { ...(alias ? { alias } : {}), ...(text ? { note: text } : {}) }
    else delete map[peer]
    return settings.update({ peerNotes: map })
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

  handle('upload:status', (): UploadStatus => uploadStatus())

  handle('upload:now', async (): Promise<UploadStatus> => {
    await pushToWebsite()
    outboxCheckedAt = 0 // an explicit "sync now" should not wait out the poll gap
    await drainOutbox()
    return uploadStatus()
  })

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
      // A browser shares the inbox, not the credentials behind it — see web/remote.ts.
      const result = await (fn as (...a: unknown[]) => unknown)(
        ...sanitiseRemoteArgs(channel, args),
      )
      return redactForRemote(channel, result)
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
