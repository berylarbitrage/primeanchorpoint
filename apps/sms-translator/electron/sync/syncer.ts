import { resolveDevice, type AdbContext } from '../adb/adb'
import { ContactResolver } from '../adb/contacts'
import { querySms } from '../adb/sms'
import type { MessageStore } from '../store'
import type { DeviceInfo, Settings, SmsMessage } from '../../shared/types'

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
 * An optimistic send the phone never wrote to its SMS database within this
 * window did not go out. The phone's database is the source of truth, so the
 * placeholder is retired rather than left as a phantom message.
 */
const PENDING_EXPIRY_MS = 30 * 60_000

export interface SyncerDeps {
  store: MessageStore
  settings: () => Settings
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

      const device = await resolveDevice(settings.adbPath, settings.deviceSerial)
      this.deps.onDevice(device)

      if (!device) {
        this.deps.onPhase(
          'error',
          'No Android device with USB debugging is connected. Run "adb devices" to check.',
        )
        return { imported: 0 }
      }

      if (device.serial !== this.lastDeviceSerial) {
        this.contacts.reset()
        this.lastDeviceSerial = device.serial
      }

      const ctx: AdbContext = { adbPath: settings.adbPath, serial: device.serial }
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
      const changed = this.deps.store.upsertFromDevice(fetched)
      this.prunePending()

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
    for (const candidate of pending) {
      const matched = real.some(
        (m) =>
          m.peer === candidate.peer &&
          m.body.trim() === candidate.body.trim() &&
          Math.abs(m.date - candidate.date) < PENDING_MATCH_MS,
      )
      if (matched || now - candidate.date > PENDING_EXPIRY_MS) drop.push(candidate.id)
    }

    if (drop.length) this.deps.onRemoved(this.deps.store.remove(drop))
  }
}
