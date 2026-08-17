import type { SmsBridge } from '../../shared/types'

declare global {
  interface Window {
    sms: SmsBridge
  }
}

export const sms: SmsBridge = window.sms

/**
 * Turn a rejected IPC call into something worth showing a user.
 *
 * Electron wraps main-process errors as
 * `Error invoking remote method 'devices:list': AdbError: <the real message>`.
 * Only the tail is meaningful.
 */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^[A-Za-z]*Error:\s*/, '')
    .trim()
}
