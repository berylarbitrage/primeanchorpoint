/*
 * What a browser on the LAN may see and change.
 *
 * The web page runs the same renderer as the desktop app, so it calls the same
 * IPC channels — including `settings:get`, which carries secrets (the website
 * push token, the web password itself) and host wiring (the adb path, the
 * chosen device). Sharing the inbox with the family is not the same as handing
 * out the credentials behind it, and a remote client must not be able to point
 * the website push somewhere else.
 *
 * Kept electron-free so it can be tested directly (test/web-server.js).
 */
import type { Settings } from '../../shared/types'

/** Never sent to a browser. */
const SECRET_SETTINGS = ['uploadToken', 'webPassword'] as const

/** Never accepted from a browser: host wiring and where messages get pushed. */
const HOST_ONLY_SETTINGS = [
  'adbPath',
  'deviceSerial',
  'wirelessAddress',
  'wirelessAutoReconnect',
  'uploadEnabled',
  'uploadUrl',
  'uploadToken',
  'webEnabled',
  'webPort',
  'webPassword',
] as const

/** Strip secrets from a settings object on its way to a browser. */
export function redactForRemote(channel: string, result: unknown): unknown {
  if (channel !== 'settings:get' && channel !== 'settings:set') return result
  if (!result || typeof result !== 'object') return result
  const copy = { ...(result as Settings) } as Record<string, unknown>
  for (const key of SECRET_SETTINGS) {
    // Emptied rather than deleted: the renderer expects the field to exist.
    if (key in copy) copy[key] = ''
  }
  return copy
}

/** Drop host-only keys from a settings patch a browser sent. */
export function sanitiseRemoteArgs(channel: string, args: unknown[]): unknown[] {
  if (channel !== 'settings:set') return args
  const patch = args[0]
  if (!patch || typeof patch !== 'object') return args
  const copy = { ...(patch as Record<string, unknown>) }
  for (const key of HOST_ONLY_SETTINGS) delete copy[key]
  return [copy, ...args.slice(1)]
}

export const __testing = { SECRET_SETTINGS, HOST_ONLY_SETTINGS }
