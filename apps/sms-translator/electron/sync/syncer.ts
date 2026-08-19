import { listDevices, resolveDevice, type AdbContext } from '../adb/adb'
import { connectWireless, disconnectWireless } from '../adb/wireless'
import { ContactResolver } from '../adb/contacts'
import { querySms } from '../adb/sms'
import {
  buildMessage,
  queryMms,
  queryMmsAddress,
  queryParts,
  readPart,
  type MmsPart,
} from '../adb/mms'
import type { MessageStore } from '../store'
import type { Attachment, DeviceInfo, Settings, SmsMessage } from '../../shared/types'

/**
 * Re-read a small window before the cursor on every incremental sync. Phones
 * occasionally write a message with a timestamp slightly behind the previous
 * one (clock adjustments, delayed multipart reassembly), and a strict `>` cursor
 * would skip it forever.
 */
const OVERLAP_MS = 60_000

/** How close in time an optimistic send and the phone's own row must be to match. */
const PENDING_MATCH_MS = 10 * 60_000

/**
 * How long to wait for the phone to write its own copy of a message we sent.
 *
 * Past this the message is not dropped: Samsung sends over RCS whenever the
 * other side supports it, and an RCS message never reaches the SMS provider at
 * all. It is marked unconfirmed instead, so a message that really did go out
 * stays in the thread and says what is uncertain about it.
 */
const PENDING_EXPIRY_MS = 5 * 60_000

/**
 * Cap on attachments downloaded per sync. Each one is a separate adb round-trip,
 * and a first import covering months could otherwise stall the first sync for a
 * long time. Whatever is skipped gets picked up on the following passes.
 */
const MAX_ATTACHMENTS_PER_SYNC = 12

/** Extension to save an attachment under, from its declared content type. */
function extensionFor(contentType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/heic': '.heic',
    'video/mp4': '.mp4',
    'video/3gpp': '.3gp',
    'audio/mpeg': '.mp3',
    'audio/amr': '.amr',
  }
  return map[contentType] ?? '.bin'
}

export interface SyncerDeps {
  store: MessageStore
  settings: () => Settings
  /** Resolves a working adb path, or throws a message the user can act on. */
  adbPath: () => Promise<string>
  apiKeyPresent: () => boolean
  onMessages: (messages: SmsMessage[]) => void
  onDevice: (device: DeviceInfo | null) => void
  onPhase: (phase: 'idle' | 'connecting' | 'syncing' | 'error', detail?: string) => void
  onNeedTranslation: (ids: string[]) => void
  onRemoved: (ids: string[]) => void
}

export class Syncer {
  private timer: NodeJS.Timeout | null = null
  private inFlight = false
  private contacts = new ContactResolver()
  private lastDeviceSerial: string | null = null

  constructor(private readonly deps: SyncerDeps) {}

  start(): void {
    this.stop()
    const interval = Math.max(2000, this.deps.settings().pollIntervalMs)
    this.timer = setInterval(() => {
      if (!this.deps.settings().autoSync) return
      void this.sync('incremental').catch(() => {
        // Errors are already reported through onPhase.
      })
    }, interval)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Restart the poll timer, e.g. after the interval setting changed. */
  restart(): void {
    this.start()
  }

  async sync(mode: 'full' | 'incremental'): Promise<{ imported: number }> {
    if (this.inFlight) return { imported: 0 }
    this.inFlight = true

    try {
      const settings = this.deps.settings()
      this.deps.onPhase('connecting')

      const adbPath = await this.deps.adbPath()
      let device = await resolveDevice(adbPath, settings.deviceSerial)

      // The saved serial is usually the USB one. With the cable out, the same
      // phone is still there — under its wireless address. Without this
      // fallback, unplugging looks like the phone vanished.
      if (!device && settings.wirelessAddress) {
        device = await resolveDevice(adbPath, settings.wirelessAddress)
      }

      // A wireless device drops off whenever the phone sleeps or the WiFi
      // blips. Reconnecting is cheap and silent, so do it before reporting a
      // failure the user would have to act on.
      if (!device && settings.wirelessAddress && settings.wirelessAutoReconnect) {
        this.deps.onPhase('connecting', `正在重新连接 ${settings.wirelessAddress}…`)
        const ctx = { adbPath, serial: null }
        const reconnected = await connectWireless(ctx, settings.wirelessAddress)
        if (reconnected.ok) {
          device =
            (await resolveDevice(adbPath, settings.wirelessAddress)) ??
            (await resolveDevice(adbPath, settings.deviceSerial))
        }
        // adb's classic trap: with a half-dead link `adb connect` says
        // "already connected" while the device sits there offline. Kicking the
        // stale entry and connecting again is what actually revives it.
        if (!device) {
          await disconnectWireless(ctx, settings.wirelessAddress).catch(() => {})
          const retried = await connectWireless(ctx, settings.wirelessAddress)
          if (retried.ok) {
            device = await resolveDevice(adbPath, settings.wirelessAddress)
          }
        }
      }

      this.deps.onDevice(device)

      if (!device) {
        const anyDevice = await listDevices(adbPath).catch(() => [])
        const unauthorized = anyDevice.some((d) => d.state === 'unauthorized')
        this.deps.onPhase(
          'error',
          unauthorized
            ? '手机已连上，但还没授权。请在手机屏幕上点「允许 USB 调试」，并勾选「一律允许」。'
            : settings.wirelessAddress
              ? `连不上 ${settings.wirelessAddress}。请确认手机和电脑在同一个 WiFi、手机的「无线调试」是开着的（关掉再打开会换端口，需要重新填地址）。`
              : '没有检测到手机。请用 USB 线连接并开启「开发者选项 → USB 调试」，或在设置里配置无线连接。三星手机如果这个开关是灰的、写着「已被自动拦截器阻止（Blocked by Auto Blocker）」，先到 设置 → 安全和隐私 → 自动拦截器 里把它关掉。',
        )
        return { imported: 0 }
      }

      if (device.serial !== this.lastDeviceSerial) {
        this.contacts.reset()
        this.lastDeviceSerial = device.serial
      }

      const ctx: AdbContext = { adbPath, serial: device.serial }
      this.deps.onPhase('syncing')

      const cursor = this.deps.store.cursor(device.serial)
      let sinceMs: number
      if (mode === 'full' || cursor === 0) {
        const days = Math.max(1, settings.initialImportDays)
        sinceMs = Date.now() - days * 24 * 60 * 60 * 1000
      } else {
        sinceMs = Math.max(0, cursor - OVERLAP_MS)
      }

      const fetched = await querySms(ctx, device.serial, { sinceMs })
      if (settings.includeMms) {
        fetched.push(...(await this.fetchMms(ctx, device.serial, sinceMs)))
      }
      const changed = this.deps.store.upsertFromDevice(fetched)
      this.prunePending()

      if (settings.includeMms) {
        await this.downloadAttachments(ctx, device.serial, settings)
      }

      // Attach contact names for addresses we have not resolved yet.
      const unresolved = [
        ...new Set(
          changed
            .filter((m) => !m.contact && /\d/.test(m.address))
            .map((m) => m.address),
        ),
      ].slice(0, 25)

      if (unresolved.length) {
        const names = await this.contacts.lookupMany(ctx, unresolved)
        if (names.size) {
          const updates: { id: string; partial: Partial<SmsMessage> }[] = []
          for (const message of this.deps.store.all()) {
            const name = names.get(message.address)
            if (name && message.contact !== name) {
              updates.push({ id: message.id, partial: { contact: name } })
            }
          }
          if (updates.length) this.deps.onMessages(this.deps.store.patchMany(updates))
        }
      }

      const newest = fetched.reduce((max, m) => Math.max(max, m.date), 0)
      if (newest) this.deps.store.setCursor(device.serial, newest)

      if (changed.length) {
        this.deps.onMessages(changed)
        if (settings.autoTranslate && this.deps.apiKeyPresent()) {
          this.deps.onNeedTranslation(
            changed.filter((m) => m.translationState === 'pending').map((m) => m.id),
          )
        }
      }

      this.deps.onPhase('idle')
      return { imported: changed.length }
    } catch (err) {
      this.deps.onPhase('error', err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      this.inFlight = false
    }
  }

  /**
   * Read MMS messages and assemble them from their separate tables.
   *
   * Failures here are swallowed: MMS is a bonus, and a ROM that blocks the MMS
   * tables must not break SMS syncing.
   */
  private async fetchMms(
    ctx: AdbContext,
    deviceSerial: string,
    sinceMs: number,
  ): Promise<SmsMessage[]> {
    try {
      const rows = await queryMms(ctx, { sinceMs })
      if (!rows.length) return []

      const parts = await queryParts(
        ctx,
        rows.map((r) => r.id),
      )
      const byMid = new Map<number, MmsPart[]>()
      for (const part of parts) {
        const list = byMid.get(part.mid)
        if (list) list.push(part)
        else byMid.set(part.mid, [part])
      }

      // Addresses need one adb call each, so reuse the address already known
      // for the thread (MMS and SMS share `threads`) wherever possible.
      const threadAddress = new Map<number, string>()
      for (const existing of this.deps.store.all()) {
        if (existing.threadId && existing.address && !threadAddress.has(existing.threadId)) {
          threadAddress.set(existing.threadId, existing.address)
        }
      }

      const messages: SmsMessage[] = []
      for (const row of rows) {
        let address = threadAddress.get(row.threadId) ?? ''
        if (!address) {
          address = await queryMmsAddress(ctx, row.id, row.direction)
          if (address) threadAddress.set(row.threadId, address)
        }
        messages.push(buildMessage(deviceSerial, row, address, byMid.get(row.id) ?? []))
      }
      return messages
    } catch {
      return []
    }
  }

  /**
   * Fetch the bytes for attachments we do not have yet, a bounded number per
   * sync. A failure is recorded on the attachment so the message still shows
   * and the UI can say why the picture is missing.
   */
  private async downloadAttachments(
    ctx: AdbContext,
    deviceSerial: string,
    settings: Settings,
  ): Promise<void> {
    const maxBytes = Math.max(64, settings.maxAttachmentKb) * 1024
    const pending: { message: SmsMessage; attachment: Attachment }[] = []

    for (const message of this.deps.store.all()) {
      if (message.deviceSerial !== deviceSerial || !message.attachments) continue
      for (const attachment of message.attachments) {
        const have = attachment.file && this.deps.store.hasAttachment(attachment.file)
        if (have || attachment.error) continue
        pending.push({ message, attachment })
      }
    }
    if (!pending.length) return

    const batch = pending.slice(0, MAX_ATTACHMENTS_PER_SYNC)
    const updates: { id: string; partial: Partial<SmsMessage> }[] = []

    for (const { message, attachment } of batch) {
      let next: Attachment
      try {
        const data = await readPart(ctx, attachment.partId, maxBytes)
        const file = this.deps.store.writeAttachment(
          deviceSerial,
          attachment.partId,
          extensionFor(attachment.contentType),
          data,
        )
        next = { ...attachment, file, bytes: data.length, error: undefined }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        next = {
          ...attachment,
          error: /exceeded/.test(detail)
            ? `附件超过 ${settings.maxAttachmentKb} KB 的上限，已跳过。可在设置里调大。`
            : detail,
        }
      }

      const merged = (message.attachments ?? []).map((a) =>
        a.partId === attachment.partId ? next : a,
      )
      // Re-read: an earlier iteration in this same batch may have updated it.
      const current = this.deps.store.get(message.id)
      const base = current?.attachments ?? merged
      updates.push({
        id: message.id,
        partial: {
          attachments: base.map((a) => (a.partId === attachment.partId ? next : a)),
        },
      })
    }

    if (updates.length) this.deps.onMessages(this.deps.store.patchMany(updates))

    if (pending.length > batch.length) {
      this.deps.onPhase(
        'idle',
        `还有 ${pending.length - batch.length} 个附件待下载，会在后续同步中继续。`,
      )
    }
  }

  /**
   * Retire optimistic outgoing records once the phone has written its own row
   * for the same message — matching on peer, body, and a generous time window,
   * because the phone assigns its own timestamp.
   */
  private prunePending(): void {
    const pending = this.deps.store.pendingLocal()
    if (!pending.length) return

    const now = Date.now()
    const real = this.deps.store
      .all()
      .filter((m) => !m.pending && m.direction === 'out')

    const drop: string[] = []
    const stale: { id: string; partial: { pending: boolean; unconfirmed: boolean } }[] = []
    for (const candidate of pending) {
      const matched = real.some(
        (m) =>
          m.peer === candidate.peer &&
          m.body.trim() === candidate.body.trim() &&
          Math.abs(m.date - candidate.date) < PENDING_MATCH_MS,
      )
      // The phone's own copy supersedes ours; anything else that has waited long
      // enough is kept but no longer claims to be in flight.
      if (matched) drop.push(candidate.id)
      else if (now - candidate.date > PENDING_EXPIRY_MS) {
        stale.push({ id: candidate.id, partial: { pending: false, unconfirmed: true } })
      }
    }

    if (drop.length) this.deps.onRemoved(this.deps.store.remove(drop))
    if (stale.length) this.deps.onMessages(this.deps.store.patchMany(stale))
  }
}
