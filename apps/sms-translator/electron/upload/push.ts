/*
 * Push messages to the Prime Anchor website.
 *
 * The phone can only be read by this machine, so the website cannot fetch the
 * inbox — this end has to send it. What lands there is a copy for viewing from
 * anywhere (see public/phone-sms.html); the phone and this app stay the source
 * of truth, and the website copy can be wiped from that page at any time.
 *
 * Uploads are idempotent: the server upserts on (device, message id), and a
 * message is re-sent once its translation arrives, so a row pushed before
 * Claude answered gets its translation filled in on the next pass.
 */
import type { SmsMessage, TranslationState } from '../../shared/types'

export interface PushTarget {
  /** Full endpoint, e.g. https://primeanchorworkforce.com/api/device-sms/push */
  url: string
  token: string
}

export interface PushResult {
  ok: boolean
  /** Messages the server accepted. */
  saved: number
  error?: string
}

/** Messages per request. Bodies are small; the server caps a batch at 500. */
export const PUSH_BATCH = 200

/**
 * A message needs pushing when the website has never seen it, or when its
 * translation state has moved on since the last push (pending → done is the
 * case that matters: the first push carries no translation).
 */
export function needsPush(message: SmsMessage): boolean {
  return message.uploadedState !== message.translationState
}

export function pendingUploads(messages: SmsMessage[], limit = PUSH_BATCH): SmsMessage[] {
  const out: SmsMessage[] = []
  for (const message of messages) {
    if (!needsPush(message)) continue
    out.push(message)
    if (out.length >= limit) break
  }
  return out
}

/** The wire shape. Kept flat and explicit — the server stores exactly these. */
export function serialise(message: SmsMessage): Record<string, unknown> {
  return {
    id: message.id,
    peer: message.peer,
    address: message.address,
    contact: message.contact ?? '',
    direction: message.direction,
    kind: message.kind,
    date: message.date,
    body: message.body,
    translated_body: message.translation?.text ?? '',
    source_lang: message.translation?.sourceLang ?? '',
    risk_score: message.analysis ? message.analysis.risk : null,
    risk_category: message.analysis?.category ?? '',
    risk_summary: message.analysis?.summary ?? '',
    // The image itself stays on this machine; only the fact of it travels.
    has_media: (message.attachments?.length ?? 0) > 0,
  }
}

export async function pushMessages(
  target: PushTarget,
  deviceSerial: string,
  messages: SmsMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<PushResult> {
  if (!messages.length) return { ok: true, saved: 0 }
  if (!target.url.trim() || !target.token.trim()) {
    return { ok: false, saved: 0, error: '还没填网站地址或令牌。' }
  }

  try {
    const res = await fetchImpl(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.token}`,
      },
      body: JSON.stringify({
        device_serial: deviceSerial,
        messages: messages.map(serialise),
      }),
    })
    const text = await res.text()
    if (!res.ok) {
      return {
        ok: false,
        saved: 0,
        error:
          res.status === 401
            ? '网站不认这个令牌。请在网站的「手机短信」页面重新生成一个。'
            : `网站返回 ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`,
      }
    }
    let saved = 0
    try {
      saved = Number((JSON.parse(text) as { saved?: number }).saved ?? 0)
    } catch {
      // A 200 with an unreadable body still means the rows landed; the count is
      // only used for the status line.
      saved = messages.length
    }
    return { ok: true, saved }
  } catch (err) {
    return {
      ok: false,
      saved: 0,
      error: `连不上网站：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** What to record locally once a batch is accepted. */
export function uploadedPatches(
  messages: SmsMessage[],
): { id: string; partial: { uploadedState: TranslationState } }[] {
  return messages.map((m) => ({ id: m.id, partial: { uploadedState: m.translationState } }))
}
