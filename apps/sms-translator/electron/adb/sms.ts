import { AdbError, runAdbChecked, shellQuote, type AdbContext } from './adb'
import { isEmptyResult, isPermissionDenied, parseContentRows, value } from './rows'
import type { Direction, SendStatus, SmsMessage } from '../../shared/types'

/**
 * Columns we ask the SMS content provider for. `body` MUST stay last — see the
 * note in rows.ts: only the final column may contain arbitrary text.
 */
const COLUMNS = ['_id', 'thread_id', 'address', 'date', 'type', 'status', 'read', 'body'] as const

/** Android's `sms.type` column. 1 = inbox, 2 = sent; 4/5/6 are outbox states. */
function directionFromType(type: number): Direction | null {
  if (type === 1) return 'in'
  if (type === 2 || type === 4 || type === 5 || type === 6) return 'out'
  return null // 3 = draft — not a real message
}

/**
 * Outgoing state from `sms.type` (2 sent, 4 outbox, 5 failed, 6 queued) and
 * `sms.status`, the delivery report: -1 none, 0 complete, 32 pending, 64 failed.
 */
export function sendStatusFromRow(type: number, status: number): SendStatus | undefined {
  if (type === 5) return 'failed'
  if (type === 4 || type === 6) return 'sending'
  if (type !== 2) return undefined
  if (status === 0) return 'delivered'
  if (status >= 64) return 'failed'
  return 'sent'
}

/**
 * Normalise a phone number for conversation grouping.
 *
 * Keeps the last 10 digits, which is the longest suffix that survives every
 * common country code: a US number is 10 national digits with or without the
 * leading `1`, and a mainland Chinese mobile is 11 with or without `86`. Taking
 * 11 instead would split `(555) 010-0000` from `+1 555-010-0000`.
 *
 * Short codes (bank/carrier service numbers) are too short to truncate, and
 * alphanumeric senders have no digits at all — both are kept as-is.
 */
export function normalisePeer(address: string): string {
  const trimmed = address.trim()
  if (!trimmed) return '(unknown)'
  const digits = trimmed.replace(/[^\d]/g, '')
  if (!digits) return trimmed.toUpperCase()
  if (digits.length <= 8) return digits // short code / service number
  return digits.slice(-10)
}

export interface QueryOptions {
  /** Only return messages strictly newer than this epoch-millis value. */
  sinceMs?: number
  /** Only return these provider row ids (used to re-check send status). */
  rawIds?: number[]
  timeoutMs?: number
}

/**
 * Read the phone's SMS database. Requires that the `shell` user can read
 * `content://sms`, which is the case on AOSP and most OEM builds; a few locked
 * down ROMs deny it and surface as a permission error here.
 */
export async function querySms(
  ctx: AdbContext,
  deviceSerial: string,
  opts: QueryOptions = {},
): Promise<SmsMessage[]> {
  const args = [
    'shell',
    'content',
    'query',
    '--uri',
    'content://sms',
    '--projection',
    shellQuote(COLUMNS.join(':')),
    '--sort',
    shellQuote('date ASC'),
  ]
  const where: string[] = []
  if (opts.sinceMs != null) where.push(`date>${Math.floor(opts.sinceMs)}`)
  if (opts.rawIds) {
    const ids = opts.rawIds.filter((id) => Number.isInteger(id) && id > 0)
    if (!ids.length) return []
    where.push(`_id IN (${ids.join(',')})`)
  }
  if (where.length) args.push('--where', shellQuote(where.join(' AND ')))

  const out = await runAdbChecked(ctx, args, { timeoutMs: opts.timeoutMs ?? 120_000 })

  if (isPermissionDenied(out)) {
    throw new AdbError(
      'The phone refused to share content://sms. This ROM blocks shell access to the ' +
        'SMS provider — see the troubleshooting section of the README.',
    )
  }
  if (isEmptyResult(out)) return []

  return parseRows(out, deviceSerial)
}

export function parseRows(out: string, deviceSerial: string): SmsMessage[] {
  const messages: SmsMessage[] = []

  for (const row of parseContentRows(out, COLUMNS)) {
    const type = Number(row.type)
    const direction = directionFromType(type)
    if (!direction) continue
    const sendStatus =
      direction === 'out' ? sendStatusFromRow(type, Number(value(row.status) || -1)) : undefined

    const id = Number(row._id)
    const dateMs = Number(row.date)
    if (!Number.isFinite(id) || !Number.isFinite(dateMs)) continue

    const addr = value(row.address)
    messages.push({
      id: `${deviceSerial}:${id}`,
      deviceSerial,
      kind: 'sms',
      rawId: id,
      threadId: Number(row.thread_id) || 0,
      address: addr,
      peer: normalisePeer(addr),
      date: dateMs,
      direction,
      body: value(row.body),
      readOnDevice: value(row.read) === '1',
      readLocal: direction === 'out',
      translationState: 'pending',
      ...(sendStatus ? { sendStatus } : {}),
    })
  }

  return messages
}
