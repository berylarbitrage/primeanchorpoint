import { AdbError, runAdbChecked, shellQuote, type AdbContext } from './adb'
import type { Direction, SmsMessage } from '../../shared/types'

/**
 * Columns we ask the SMS content provider for. `body` MUST stay last: the
 * provider prints rows as `key=value, key=value, ...` with no escaping, so the
 * only field allowed to contain arbitrary text is the trailing one.
 */
const COLUMNS = ['_id', 'thread_id', 'address', 'date', 'type', 'read', 'body'] as const

/**
 * Built from COLUMNS: `_id=(.*?), thread_id=(.*?), ... , body=([\s\S]*)`.
 * Anchoring on the literal next column name is what makes this survive commas
 * inside `address` or `body`.
 */
const ROW_RE = new RegExp(
  '^' +
    COLUMNS.map((c, i) =>
      i === COLUMNS.length - 1
        ? `${c}=([\\s\\S]*)$`
        : `${c}=(.*?), (?=${COLUMNS[i + 1]}=)`,
    ).join(''),
)

const ROW_PREFIX = /^Row: \d+ /

/** Android's `sms.type` column. 1 = inbox, 2 = sent; 4/5/6 are outbox states. */
function directionFromType(type: number): Direction | null {
  if (type === 1) return 'in'
  if (type === 2 || type === 4 || type === 5 || type === 6) return 'out'
  return null // 3 = draft — not a real message
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

function parseValue(raw: string): string {
  return raw === 'NULL' ? '' : raw
}

export interface QueryOptions {
  /** Only return messages strictly newer than this epoch-millis value. */
  sinceMs?: number
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
  if (opts.sinceMs != null) {
    args.push('--where', shellQuote(`date>${Math.floor(opts.sinceMs)}`))
  }

  const out = await runAdbChecked(ctx, args, { timeoutMs: opts.timeoutMs ?? 120_000 })

  if (/Permission Denial|SecurityException/i.test(out)) {
    throw new AdbError(
      'The phone refused to share content://sms. This ROM blocks shell access to the ' +
        'SMS provider — see the troubleshooting section of the README.',
    )
  }
  if (/^No result found\.?$/im.test(out.trim())) return []

  return parseRows(out, deviceSerial)
}

export function parseRows(out: string, deviceSerial: string): SmsMessage[] {
  const messages: SmsMessage[] = []

  // A body may contain newlines, so split on the start-of-row marker rather
  // than on line boundaries.
  const chunks = out.split(/\r?\n(?=Row: \d+ )/)

  for (const chunk of chunks) {
    const row = chunk.replace(/\r/g, '').trim()
    if (!ROW_PREFIX.test(row)) continue

    const match = ROW_RE.exec(row.replace(ROW_PREFIX, ''))
    if (!match) continue

    const [, rawId, threadId, address, date, type, read, body] = match
    const direction = directionFromType(Number(type))
    if (!direction) continue

    const id = Number(rawId)
    const dateMs = Number(date)
    if (!Number.isFinite(id) || !Number.isFinite(dateMs)) continue

    const addr = parseValue(address)
    messages.push({
      id: `${deviceSerial}:${id}`,
      deviceSerial,
      rawId: id,
      threadId: Number(threadId) || 0,
      address: addr,
      peer: normalisePeer(addr),
      date: dateMs,
      direction,
      body: parseValue(body),
      readOnDevice: parseValue(read) === '1',
      readLocal: direction === 'out',
      translationState: 'pending',
    })
  }

  return messages
}
