import fs from 'node:fs'
import path from 'node:path'
import type { SmsMessage } from '../shared/types'

interface Meta {
  /** Highest message timestamp seen per device, used as the incremental cursor. */
  cursors: Record<string, number>
  /**
   * Ids the user deleted here. The phone keeps its own copy — the shell user
   * cannot write to the SMS provider — so without this list the very next sync
   * would import them again.
   */
  deleted: string[]
}

/** Tombstone written to the log when a record is removed. */
interface Tombstone {
  id: string
  deleted: true
}

type LogRecord = SmsMessage | Tombstone

function isTombstone(record: LogRecord): record is Tombstone {
  return (record as Tombstone).deleted === true
}

/**
 * Keep locally-derived attachment fields (the downloaded file, its description)
 * while letting the phone stay authoritative about which parts exist.
 */
function mergeAttachments(
  existing: SmsMessage['attachments'],
  incoming: SmsMessage['attachments'],
): SmsMessage['attachments'] {
  if (!incoming) return existing
  if (!existing) return incoming
  const byId = new Map(existing.map((a) => [a.partId, a]))
  return incoming.map((a) => {
    const prev = byId.get(a.partId)
    return prev ? { ...a, file: prev.file, bytes: prev.bytes, description: prev.description, error: prev.error } : a
  })
}

/**
 * Append-only JSONL store with periodic compaction.
 *
 * Deliberately not SQLite: better-sqlite3 is a native module that has to be
 * rebuilt against Electron's ABI for every target, and an SMS inbox is small
 * enough (tens of thousands of short records) that a rewritten log is fine.
 */
export class MessageStore {
  private readonly logPath: string
  private readonly metaPath: string
  private messages = new Map<string, SmsMessage>()
  private meta: Meta = { cursors: {}, deleted: [] }
  private deleted = new Set<string>()
  private linesOnDisk = 0
  private compactTimer: NodeJS.Timeout | null = null

  /** Where MMS attachments are written. Kept out of the log to stay small. */
  readonly mediaDir: string

  constructor(private readonly dir: string) {
    this.logPath = path.join(dir, 'messages.jsonl')
    this.metaPath = path.join(dir, 'meta.json')
    this.mediaDir = path.join(dir, 'media')
  }

  load(): void {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.mkdirSync(this.mediaDir, { recursive: true })

    if (fs.existsSync(this.logPath)) {
      const raw = fs.readFileSync(this.logPath, 'utf8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        this.linesOnDisk++
        try {
          const record = JSON.parse(trimmed) as LogRecord
          if (!record || typeof record.id !== 'string') continue
          if (isTombstone(record)) this.messages.delete(record.id)
          else this.messages.set(record.id, record)
        } catch {
          // A torn final line from an interrupted write — skip it.
        }
      }
    }

    if (fs.existsSync(this.metaPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.metaPath, 'utf8')) as Partial<Meta>
        this.meta = { cursors: parsed.cursors ?? {}, deleted: parsed.deleted ?? [] }
        this.deleted = new Set(this.meta.deleted)
      } catch {
        this.meta = { cursors: {}, deleted: [] }
      }
    }
  }

  all(): SmsMessage[] {
    return [...this.messages.values()].sort((a, b) => a.date - b.date)
  }

  get(id: string): SmsMessage | undefined {
    return this.messages.get(id)
  }

  cursor(deviceSerial: string): number {
    return this.meta.cursors[deviceSerial] ?? 0
  }

  setCursor(deviceSerial: string, value: number): void {
    if (value <= (this.meta.cursors[deviceSerial] ?? 0)) return
    this.meta.cursors[deviceSerial] = value
    this.writeMeta()
  }

  /**
   * Insert new messages, preserving any translation/analysis already attached
   * to a record we have seen before. Returns only the records that changed.
   */
  upsertFromDevice(incoming: SmsMessage[]): SmsMessage[] {
    const changed: SmsMessage[] = []
    for (const message of incoming) {
      if (this.deleted.has(message.id)) continue
      const existing = this.messages.get(message.id)
      if (existing) {
        // The phone is authoritative for the message itself; we keep our own
        // derived fields.
        const merged: SmsMessage = {
          ...message,
          contact: existing.contact ?? message.contact,
          readLocal: existing.readLocal,
          translationState: existing.translationState,
          translationError: existing.translationError,
          translation: existing.translation,
          analysis: existing.analysis,
          // Bookkeeping for the website push — ours, not the phone's.
          uploadedState: existing.uploadedState,
          // Downloaded files and their descriptions are ours, not the phone's.
          attachments: mergeAttachments(existing.attachments, message.attachments),
        }
        if (JSON.stringify(merged) === JSON.stringify(existing)) continue
        this.messages.set(merged.id, merged)
        changed.push(merged)
      } else {
        this.messages.set(message.id, message)
        changed.push(message)
      }
    }
    if (changed.length) this.append(changed)
    return changed
  }

  /** Apply a partial update to one message. Returns the new record, if it exists. */
  patch(id: string, partial: Partial<SmsMessage>): SmsMessage | null {
    const existing = this.messages.get(id)
    if (!existing) return null
    const updated = { ...existing, ...partial }
    this.messages.set(id, updated)
    this.append([updated])
    return updated
  }

  patchMany(updates: { id: string; partial: Partial<SmsMessage> }[]): SmsMessage[] {
    const changed: SmsMessage[] = []
    for (const { id, partial } of updates) {
      const existing = this.messages.get(id)
      if (!existing) continue
      const updated = { ...existing, ...partial }
      this.messages.set(id, updated)
      changed.push(updated)
    }
    if (changed.length) this.append(changed)
    return changed
  }

  /**
   * Write an attachment to the media directory and return its file name.
   *
   * The file name is derived from the device serial and the provider's part id,
   * so re-syncing the same message overwrites rather than accumulating copies.
   */
  writeAttachment(deviceSerial: string, partId: number, ext: string, data: Buffer): string {
    const safeSerial = deviceSerial.replace(/[^A-Za-z0-9._-]/g, '_')
    const name = `${safeSerial}-${partId}${ext}`
    fs.writeFileSync(path.join(this.mediaDir, name), data)
    return name
  }

  attachmentPath(file: string): string {
    // Guard against a crafted record escaping the media directory.
    const resolved = path.resolve(this.mediaDir, file)
    if (resolved !== path.join(this.mediaDir, path.basename(file))) {
      throw new Error(`Refusing to read outside the media directory: ${file}`)
    }
    return resolved
  }

  hasAttachment(file: string): boolean {
    try {
      return fs.existsSync(this.attachmentPath(file))
    } catch {
      return false
    }
  }

  readAttachment(file: string): Buffer {
    return fs.readFileSync(this.attachmentPath(file))
  }

  /**
   * Delete records outright.
   *
   * `permanent` marks them as deleted by the user, so a later sync will not
   * re-import them. Superseded optimistic sends are removed without it: those
   * ids are local placeholders the phone never had.
   */
  remove(ids: string[], permanent = false): string[] {
    const removed: string[] = []
    for (const id of ids) {
      if (this.messages.delete(id)) removed.push(id)
      else if (permanent) removed.push(id)
    }
    if (permanent) {
      let added = false
      for (const id of ids) {
        if (!this.deleted.has(id)) {
          this.deleted.add(id)
          added = true
        }
      }
      if (added) {
        // Bounded so a user who deletes for years cannot grow meta.json without
        // limit. The oldest ids fall off first; those messages are long past
        // the sync window and will not come back anyway.
        this.meta.deleted = [...this.deleted].slice(-20_000)
        this.deleted = new Set(this.meta.deleted)
        this.writeMeta()
      }
    }
    if (removed.length) {
      this.appendRaw(removed.map((id) => ({ id, deleted: true as const })))
    }
    return removed
  }

  /** Optimistic records this app created locally and the phone has not confirmed. */
  pendingLocal(): SmsMessage[] {
    return this.all().filter((m) => m.pending)
  }

  /** Ids of messages that still need a translation pass. */
  untranslated(limit = 500): SmsMessage[] {
    const out: SmsMessage[] = []
    for (const message of this.all()) {
      const hasWork = message.body.trim() !== '' || (message.attachments?.length ?? 0) > 0
      if (message.translationState === 'pending' && hasWork) {
        out.push(message)
        if (out.length >= limit) break
      }
    }
    return out
  }

  private append(records: SmsMessage[]): void {
    this.appendRaw(records)
  }

  private appendRaw(records: LogRecord[]): void {
    const payload = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
    fs.appendFileSync(this.logPath, payload, 'utf8')
    this.linesOnDisk += records.length
    this.scheduleCompaction()
  }

  private writeMeta(): void {
    const tmp = `${this.metaPath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.meta), 'utf8')
    fs.renameSync(tmp, this.metaPath)
  }

  private scheduleCompaction(): void {
    // Rewrite once the log holds roughly twice as many lines as live records.
    if (this.linesOnDisk < 500 || this.linesOnDisk < this.messages.size * 2) return
    if (this.compactTimer) return
    this.compactTimer = setTimeout(() => {
      this.compactTimer = null
      try {
        this.compact()
      } catch {
        // A failed compaction is harmless — the log stays valid, just larger.
      }
    }, 5_000)
  }

  compact(): void {
    const tmp = `${this.logPath}.tmp`
    const payload = this.all()
      .map((r) => JSON.stringify(r))
      .join('\n')
    fs.writeFileSync(tmp, payload ? payload + '\n' : '', 'utf8')
    fs.renameSync(tmp, this.logPath)
    this.linesOnDisk = this.messages.size
  }

  dispose(): void {
    if (this.compactTimer) {
      clearTimeout(this.compactTimer)
      this.compactTimer = null
    }
  }
}
