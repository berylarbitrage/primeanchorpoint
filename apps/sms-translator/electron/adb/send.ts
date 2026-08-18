import { AdbError, runAdb, runAdbChecked, shellQuote, type AdbContext } from './adb'
import type { SendMethod } from '../../shared/types'

const KEYCODE_DPAD_RIGHT = 22
const KEYCODE_ENTER = 66

/** Where uiautomator writes its dump. /data/local/tmp is always shell-writable. */
const DUMP_PATH = '/data/local/tmp/sms-translator-ui.xml'

export interface SendOptions {
  method: SendMethod
  /** How long to wait for the SMS app to render before looking for the button. */
  tapDelayMs: number
}

export interface SendOutcome {
  /** True when the message was handed to the phone's SMS app. */
  ok: boolean
  /** Human-readable caveat, if any. */
  note?: string
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Localised labels for the send button, matched against `content-desc` and
 * `text`. Samsung, Google Messages, and most OEM apps set one of these.
 */
const SEND_LABELS = [
  'send',
  'send message',
  'send sms',
  '发送',
  '傳送',
  '发送信息',
  '送信',
  '보내기',
  '전송',
  'enviar',
  'envoyer',
  'senden',
  'invia',
  'versturen',
  'wyślij',
  'отправить',
  'gönder',
  'إرسال',
  'שלח',
  'ส่ง',
  'gửi',
  'kirim',
]

interface UiNode {
  resourceId: string
  contentDesc: string
  text: string
  className: string
  clickable: boolean
  enabled: boolean
  center: { x: number; y: number }
}

function parseBounds(bounds: string): { x: number; y: number } | null {
  const match = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds)
  if (!match) return null
  const [, x1, y1, x2, y2] = match.map(Number) as unknown as number[]
  if (x2 <= x1 || y2 <= y1) return null // zero-area node, not tappable
  return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) }
}

function attr(node: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`).exec(node)
  return match ? match[1] : ''
}

function parseNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = []
  for (const raw of xml.match(/<node\b[^>]*\/?>/g) ?? []) {
    const center = parseBounds(attr(raw, 'bounds'))
    if (!center) continue
    nodes.push({
      resourceId: attr(raw, 'resource-id'),
      contentDesc: attr(raw, 'content-desc'),
      text: attr(raw, 'text'),
      className: attr(raw, 'class'),
      clickable: attr(raw, 'clickable') === 'true',
      enabled: attr(raw, 'enabled') !== 'false',
      center,
    })
  }
  return nodes
}

function scoreSendCandidate(node: UiNode): number {
  if (!node.enabled) return 0

  const id = node.resourceId.toLowerCase()
  const desc = node.contentDesc.trim().toLowerCase()
  const text = node.text.trim().toLowerCase()

  // A resource id is the strongest signal and is stable across locales.
  // Samsung uses com.samsung.android.messaging:id/send_button, Google Messages
  // uses .../id/send_message_button_icon.
  const idHit = /(^|[:/_])send([_a-z]*)?(button|btn|icon)?$/.test(id) || /send_?(message|sms|button|btn)/.test(id)

  // Reject the obvious false friends before scoring.
  if (/resend|sender|sent|send_?later|schedule/.test(id)) return 0
  if (/attach|emoji|camera|gallery|sticker|voice|mic/.test(id)) return 0

  const labelHit = SEND_LABELS.includes(desc) || SEND_LABELS.includes(text)

  let score = 0
  if (idHit) score += 10
  if (labelHit) score += 6
  if (node.clickable) score += 3
  if (/Button|ImageView|ImageButton/.test(node.className)) score += 1
  return score
}

/**
 * Locate the send button by dumping the live view hierarchy. This is what makes
 * sending work on OEM skins (Samsung One UI in particular), where the AOSP
 * "focus right, press enter" trick lands on the wrong control.
 */
async function findSendButton(ctx: AdbContext): Promise<UiNode | null> {
  const dump = await runAdb(ctx, ['shell', 'uiautomator', 'dump', DUMP_PATH], {
    timeoutMs: 25_000,
  })
  if (dump.code !== 0) return null

  const xml = await runAdb(ctx, ['shell', 'cat', DUMP_PATH], { timeoutMs: 20_000 })
  // Best-effort cleanup; a leftover file is harmless.
  void runAdb(ctx, ['shell', 'rm', '-f', DUMP_PATH], { timeoutMs: 10_000 }).catch(() => {})

  if (xml.code !== 0 || !xml.stdout.includes('<node')) return null

  let best: UiNode | null = null
  let bestScore = 0
  for (const node of parseNodes(xml.stdout)) {
    const score = scoreSendCandidate(node)
    if (score > bestScore) {
      bestScore = score
      best = node
    }
  }

  // Require more than "it is merely clickable" before tapping anything.
  return bestScore >= 9 ? best : null
}

/**
 * Hand a message to the phone's default SMS app.
 *
 * There is no supported adb command that sends an SMS directly: `service call
 * isms` needs per-Android-version transaction codes and breaks constantly. So
 * this opens the standard SENDTO intent with the body prefilled, then confirms
 * it according to `method`:
 *
 * - `ui`       find the send button in the live view hierarchy and tap it.
 *              Works across OEM skins; the default.
 * - `keyevent` AOSP-style focus-right + enter. Faster, but lands on the wrong
 *              control on many skinned ROMs.
 * - `manual`   stop after prefilling and let the user tap send.
 */
export async function sendSms(
  ctx: AdbContext,
  to: string,
  body: string,
  opts: SendOptions,
): Promise<SendOutcome> {
  if (!to.trim()) throw new AdbError('No recipient given.')
  if (!body.trim()) throw new AdbError('Refusing to send an empty message.')

  // `sms:` URIs treat some punctuation as separators, so keep only what a
  // dialable number may contain.
  const recipient = to.replace(/[^\d+*#;,]/g, '')
  if (!recipient) {
    throw new AdbError(
      `"${to}" is not a dialable number. Replies to alphanumeric senders (bank ` +
        'short codes and the like) have to be sent from the phone.',
    )
  }

  await runAdbChecked(
    ctx,
    [
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.SENDTO',
      '-d',
      shellQuote(`sms:${recipient}`),
      '--es',
      'sms_body',
      shellQuote(body),
      '--ez',
      'exit_on_sent',
      'true',
    ],
    { timeoutMs: 20_000 },
  )

  if (opts.method === 'manual') {
    return {
      ok: true,
      note: '草稿已在手机上打开，请在手机上点发送。',
    }
  }

  await delay(Math.max(300, opts.tapDelayMs))

  if (opts.method === 'ui') {
    const button = await findSendButton(ctx)
    if (button) {
      await runAdbChecked(ctx, [
        'shell',
        'input',
        'tap',
        String(button.center.x),
        String(button.center.y),
      ])
      return {
        ok: true,
        note: '已点击手机上的发送按钮。下次同步会把手机里的这条读回来。',
      }
    }
    // Fall through to the keyevent method rather than silently doing nothing,
    // but say so — the user needs to check the phone this time.
    await runAdbChecked(ctx, ['shell', 'input', 'keyevent', String(KEYCODE_DPAD_RIGHT)])
    await runAdbChecked(ctx, ['shell', 'input', 'keyevent', String(KEYCODE_ENTER)])
    return {
      ok: true,
      note:
        '没能在界面上认出发送按钮，已改用模拟按键。请看一眼手机确认是否真的发出去了；' +
        '如果没有，请在设置里把发送方式改成「仅填好草稿」。',
    }
  }

  await runAdbChecked(ctx, ['shell', 'input', 'keyevent', String(KEYCODE_DPAD_RIGHT)])
  await runAdbChecked(ctx, ['shell', 'input', 'keyevent', String(KEYCODE_ENTER)])
  return {
    ok: true,
    note: '已通过模拟按键发送。下次同步会把手机里的这条读回来。',
  }
}

/** Exported for tests. */
export const __testing = { parseNodes, scoreSendCandidate, parseBounds }

/**
 * Open the phone's dialler on a number.
 *
 * ACTION_DIAL only *shows* the number — placing the call needs CALL_PHONE,
 * which the shell user does not hold, and dialling someone by accident from a
 * desktop app would be worse than one extra tap on the phone.
 */
export async function dialNumber(ctx: AdbContext, number: string): Promise<void> {
  const digits = number.replace(/[^\d+*#;,]/g, '')
  if (!digits) throw new AdbError(`"${number}" 不是可拨的号码。`)
  await runAdbChecked(
    ctx,
    ['shell', 'am', 'start', '-a', 'android.intent.action.DIAL', '-d', shellQuote(`tel:${digits}`)],
    { timeoutMs: 15_000 },
  )
}
