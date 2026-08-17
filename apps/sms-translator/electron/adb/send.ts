import { AdbError, runAdbChecked, shellQuote, type AdbContext } from './adb'
import type { SendMethod } from '../../shared/types'

const KEYCODE_DPAD_RIGHT = 22
const KEYCODE_ENTER = 66

export interface SendOptions {
  method: SendMethod
  /** How long to wait for the SMS app to render before the automatic tap. */
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
 * Hand a message to the phone's default SMS app.
 *
 * There is no supported adb command that sends an SMS directly: `service call
 * isms` needs per-Android-version transaction codes and breaks constantly, so
 * this opens the standard SENDTO intent with the body prefilled instead.
 *
 * - `intent` mode then presses D-pad-right + Enter, which lands on the send
 *   button in every stock SMS app we know of. It is a UI automation, so it can
 *   miss on heavily skinned ROMs — always verify on the phone the first time.
 * - `manual` mode stops after prefilling and lets you tap send yourself.
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
      note: 'Draft opened on the phone — tap send there to deliver it.',
    }
  }

  await delay(Math.max(300, opts.tapDelayMs))
  await runAdbChecked(ctx, ['shell', 'input', 'keyevent', String(KEYCODE_DPAD_RIGHT)])
  await runAdbChecked(ctx, ['shell', 'input', 'keyevent', String(KEYCODE_ENTER)])

  return {
    ok: true,
    note:
      'Sent through the phone’s SMS app. It will appear below once the next ' +
      'sync reads it back from the phone.',
  }
}
