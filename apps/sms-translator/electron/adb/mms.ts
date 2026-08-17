import { runAdb, runAdbBinary, runAdbChecked, shellQuote, type AdbContext } from './adb'
import { isEmptyResult, isPermissionDenied, parseContentRows, value } from './rows'
import { normalisePeer } from './sms'
import type { Attachment, Direction, SmsMessage } from '../../shared/types'

/**
 * MMS is stored completely differently from SMS:
 *
 *  - `content://mms` holds one row per message but **no text** and **no address**;
 *  - `mms.date` is in **seconds**, not milliseconds (the single easiest thing to
 *    get wrong here — a raw value would land the message in 1970);
 *  - the text body and every attachment live in `content://mms/part` rows,
 *    keyed by `mid`;
 *  - the sender/recipient lives in `content://mms/<id>/addr`, one query per
 *    message.
 */

/** `sub` (subject) last — only the final column may contain arbitrary text. */
const MMS_COLUMNS = ['_id', 'thread_id', 'date', 'msg_box', 'read', 'sub'] as const

/** `text` last, for the same reason. */
const PART_COLUMNS = ['_id', 'mid', 'ct', 'name', 'text'] as const

const ADDR_COLUMNS = ['type', 'address'] as const

/** PDU header values for the `addr.type` column. */
const ADDR_FROM = 137
const ADDR_TO = 151

/** SMIL is the MMS layout descriptor — never anything the user wants to see. */
const IGNORED_TYPES = /^(application\/smil|text\/x-vcalendar|application\/vnd\.wap)/i

export interface MmsRow {
  id: number
  threadId: number
  /** Already converted to epoch milliseconds. */
  date: number
  direction: Direction
  readOnDevice: boolean
  subject: string
}

export interface MmsPart {
  id: number
  mid: number
  contentType: string
  name: string
  text: string
}

/** `msg_box`: 1 = inbox, 2 = sent, 4 = outbox. */
function directionFromBox(box: number): Direction | null {
  if (box === 1) return 'in'
  if (box === 2 || box === 4) return 'out'
  return null // 3 = draft
}

export function parseMmsRows(out: string): MmsRow[] {
  const rows: MmsRow[] = []
  for (const row of parseContentRows(out, MMS_COLUMNS)) {
    const id = Number(row._id)
    const seconds = Number(row.date)
    const direction = directionFromBox(Number(row.msg_box))
    if (!Number.isFinite(id) || !Number.isFinite(seconds) || !direction) continue

    rows.push({
      id,
      threadId: Number(row.thread_id) || 0,
      // Seconds → milliseconds. Everything downstream assumes millis.
      date: seconds * 1000,
      direction,
      readOnDevice: value(row.read) === '1',
      subject: value(row.sub),
    })
  }
  return rows
}

export function parsePartRows(out: string): MmsPart[] {
  const parts: MmsPart[] = []
  for (const row of parseContentRows(out, PART_COLUMNS)) {
    const id = Number(row._id)
    const mid = Number(row.mid)
    if (!Number.isFinite(id) || !Number.isFinite(mid)) continue
    parts.push({
      id,
      mid,
      contentType: value(row.ct).toLowerCase(),
      name: value(row.name),
      text: value(row.text),
    })
  }
  return parts
}

/** Pick the sender for an incoming message, or the recipient for an outgoing one. */
export function pickAddress(out: string, direction: Direction): string {
  const rows = parseContentRows(out, ADDR_COLUMNS)
  const wanted = direction === 'in' ? ADDR_FROM : ADDR_TO
  const match = rows.find((r) => Number(r.type) === wanted && value(r.address))
  if (match) return value(match.address)
  // Some ROMs omit the type, or record only one address. Fall back to any
  // address that is not the placeholder the platform uses for "me".
  const any = rows.find((r) => {
    const address = value(r.address)
    return address && address !== 'insert-address-token'
  })
  return any ? value(any.address) : ''
}

/**
 * Split a message's parts into its text body and the attachments worth keeping.
 * Multiple text parts are joined in id order, which is how the phone renders
 * a multi-slide MMS.
 */
export function splitParts(parts: MmsPart[]): { body: string; attachments: Attachment[] } {
  const ordered = [...parts].sort((a, b) => a.id - b.id)
  const texts: string[] = []
  const attachments: Attachment[] = []

  for (const part of ordered) {
    if (IGNORED_TYPES.test(part.contentType)) continue
    if (part.contentType.startsWith('text/')) {
      if (part.text.trim()) texts.push(part.text)
      continue
    }
    attachments.push({
      partId: part.id,
      contentType: part.contentType || 'application/octet-stream',
      name: part.name || undefined,
    })
  }

  return { body: texts.join('\n'), attachments }
}

export interface QueryMmsOptions {
  sinceMs?: number
  timeoutMs?: number
}

/** List MMS messages newer than `sinceMs`. Text and attachments come separately. */
export async function queryMms(
  ctx: AdbContext,
  opts: QueryMmsOptions = {},
): Promise<MmsRow[]> {
  const args = [
    'shell',
    'content',
    'query',
    '--uri',
    'content://mms',
    '--projection',
    shellQuote(MMS_COLUMNS.join(':')),
    '--sort',
    shellQuote('date ASC'),
  ]
  if (opts.sinceMs != null) {
    // The column is in seconds, so the bound has to be too.
    args.push('--where', shellQuote(`date>${Math.floor(opts.sinceMs / 1000)}`))
  }

  const result = await runAdb(ctx, args, { timeoutMs: opts.timeoutMs ?? 120_000 })
  const out = result.stdout + result.stderr
  // MMS being unavailable is not fatal — SMS still works, so report nothing.
  if (result.code !== 0 || isPermissionDenied(out) || isEmptyResult(out)) return []
  return parseMmsRows(result.stdout)
}

/** Fetch the parts for a set of message ids in one query. */
export async function queryParts(
  ctx: AdbContext,
  mids: number[],
  opts: { timeoutMs?: number } = {},
): Promise<MmsPart[]> {
  if (!mids.length) return []
  const result = await runAdb(
    ctx,
    [
      'shell',
      'content',
      'query',
      '--uri',
      'content://mms/part',
      '--projection',
      shellQuote(PART_COLUMNS.join(':')),
      '--where',
      shellQuote(`mid IN (${mids.join(',')})`),
    ],
    { timeoutMs: opts.timeoutMs ?? 120_000 },
  )
  if (result.code !== 0) return []
  return parsePartRows(result.stdout)
}

/** Look up the address for one message. One adb call, so callers should cache. */
export async function queryMmsAddress(
  ctx: AdbContext,
  mmsId: number,
  direction: Direction,
): Promise<string> {
  const result = await runAdb(
    ctx,
    [
      'shell',
      'content',
      'query',
      '--uri',
      shellQuote(`content://mms/${mmsId}/addr`),
      '--projection',
      shellQuote(ADDR_COLUMNS.join(':')),
    ],
    { timeoutMs: 20_000 },
  )
  if (result.code !== 0) return ''
  return pickAddress(result.stdout, direction)
}

/**
 * Download one attachment's bytes.
 *
 * Uses `exec-out` rather than `shell`: the latter can rewrite line endings,
 * which corrupts image data in a way that only shows up as an unreadable file
 * much later. Reading `part._data` directly is not an option — that path lives
 * under the telephony provider's private storage and shell cannot open it.
 */
export async function readPart(
  ctx: AdbContext,
  partId: number,
  maxBytes: number,
): Promise<Buffer> {
  const result = await runAdbBinary(
    ctx,
    ['exec-out', 'content', 'read', '--uri', shellQuote(`content://mms/part/${partId}`)],
    { timeoutMs: 60_000, maxBytes },
  )
  if (result.code !== 0 || result.stdout.length === 0) {
    const detail = result.stderr.trim() || `exit ${result.code}, empty output`
    throw new Error(`读取附件 ${partId} 失败：${detail}`)
  }
  return result.stdout
}

/** Assemble provider rows into the app's message shape. */
export function buildMessage(
  deviceSerial: string,
  row: MmsRow,
  address: string,
  parts: MmsPart[],
): SmsMessage {
  const { body, attachments } = splitParts(parts)
  return {
    id: `${deviceSerial}:mms:${row.id}`,
    deviceSerial,
    kind: 'mms',
    rawId: row.id,
    threadId: row.threadId,
    address,
    peer: normalisePeer(address),
    date: row.date,
    direction: row.direction,
    subject: row.subject || undefined,
    body,
    attachments: attachments.length ? attachments : undefined,
    readOnDevice: row.readOnDevice,
    readLocal: row.direction === 'out',
    // A picture-only MMS has nothing to translate, but it may still be worth
    // describing, so it does not start as 'skipped'.
    translationState: 'pending',
  }
}

/** Probe whether this ROM lets the shell user read the MMS tables at all. */
export async function mmsAvailable(ctx: AdbContext): Promise<boolean> {
  const out = await runAdbChecked(
    ctx,
    ['shell', 'content', 'query', '--uri', 'content://mms', '--projection', '_id'],
    { timeoutMs: 30_000 },
  ).catch(() => '')
  return out !== '' && !isPermissionDenied(out)
}
