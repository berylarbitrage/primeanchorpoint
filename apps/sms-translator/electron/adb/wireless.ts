import { runAdb, shellQuote, type AdbContext } from './adb'

/**
 * Wireless debugging (Android 11+), so the phone does not have to stay plugged
 * in. Two ports are involved and they are NOT the same:
 *
 *  - the *pairing* port, shown only inside the "Pair device with pairing code"
 *    dialog, alongside a six-digit code. Used once.
 *  - the *connect* port, shown on the Wireless debugging screen itself. Used
 *    every time, and it changes when wireless debugging is toggled off and on.
 *
 * Mixing them up is the single most common failure, so they are separate fields
 * in the UI and the errors here say which one is wrong.
 */

export interface WirelessResult {
  ok: boolean
  /** Message to show the user — already phrased for a non-technical reader. */
  message: string
  /** The address actually connected, when adb reported one. */
  address?: string
}

/** `host:port`, trimmed. Rejects anything else rather than guessing. */
export function normaliseAddress(raw: string): string | null {
  const trimmed = raw.trim().replace(/^adb\s+connect\s+/i, '')
  // Host may be IPv4 or a hostname; a bracketed IPv6 literal is also allowed.
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]+):(\d{1,5})$/.exec(trimmed)
  if (!match) return null
  const port = Number(match[2])
  if (port < 1 || port > 65535) return null
  return `${match[1]}:${port}`
}

/**
 * `adb connect` exits 0 even when it failed, so the outcome has to come from
 * the text. Treating exit code as success would report a phantom connection.
 */
export function parseConnectOutput(output: string): WirelessResult {
  const text = output.trim()
  const already = /^already connected to (\S+)/im.exec(text)
  if (already) {
    return { ok: true, message: `已经连上 ${already[1]}。`, address: already[1] }
  }
  const connected = /^connected to (\S+)/im.exec(text)
  if (connected) {
    return { ok: true, message: `已连接 ${connected[1]}。`, address: connected[1] }
  }
  if (/failed to connect|cannot connect|connection refused|No connection could be made/i.test(text)) {
    return {
      ok: false,
      message:
        '连接失败。请确认：手机和电脑在同一个 WiFi；手机上「无线调试」是开着的；' +
        '地址和端口是「无线调试」主界面上显示的那一组（不是配对对话框里的）。',
    }
  }
  return { ok: false, message: text || '连接失败，adb 没有返回任何信息。' }
}

export function parsePairOutput(output: string): WirelessResult {
  const text = output.trim()
  if (/Successfully paired/i.test(text)) {
    return { ok: true, message: '配对成功。接下来填「连接地址」并点连接。' }
  }
  if (/Failed:\s*protocol fault|Failed to pair/i.test(text)) {
    return {
      ok: false,
      message:
        '配对失败。配对码只有几分钟有效，且配对地址必须是「使用配对码配对设备」' +
        '对话框里显示的那一组（端口和主界面的不一样）。请重新打开该对话框再试。',
    }
  }
  return { ok: false, message: text || '配对失败，adb 没有返回任何信息。' }
}

export async function pairWireless(
  ctx: AdbContext,
  address: string,
  code: string,
): Promise<WirelessResult> {
  const target = normaliseAddress(address)
  if (!target) {
    return { ok: false, message: `配对地址格式不对：「${address}」。应该形如 192.168.1.5:37419。` }
  }
  const pin = code.trim()
  if (!/^\d{6}$/.test(pin)) {
    return { ok: false, message: '配对码应该是 6 位数字。' }
  }

  // `adb pair` prompts for the code when it is not supplied, which would hang.
  const result = await runAdb({ ...ctx, serial: null }, ['pair', target, pin], {
    timeoutMs: 30_000,
  })
  return parsePairOutput(result.stdout + '\n' + result.stderr)
}

export async function connectWireless(
  ctx: AdbContext,
  address: string,
): Promise<WirelessResult> {
  const target = normaliseAddress(address)
  if (!target) {
    return { ok: false, message: `连接地址格式不对：「${address}」。应该形如 192.168.1.5:41234。` }
  }
  const result = await runAdb({ ...ctx, serial: null }, ['connect', target], {
    timeoutMs: 30_000,
  })
  return parseConnectOutput(result.stdout + '\n' + result.stderr)
}

export async function disconnectWireless(
  ctx: AdbContext,
  address: string,
): Promise<WirelessResult> {
  const target = normaliseAddress(address)
  if (!target) return { ok: false, message: `地址格式不对：「${address}」。` }
  await runAdb({ ...ctx, serial: null }, ['disconnect', target], { timeoutMs: 15_000 })
  return { ok: true, message: `已断开 ${target}。` }
}

/**
 * Enable wireless debugging on a phone that is currently plugged in, for
 * Android versions without the pairing-code screen. Returns the port to
 * connect on; the caller still needs the phone's IP.
 */
export async function enableTcpip(ctx: AdbContext, port = 5555): Promise<WirelessResult> {
  const result = await runAdb(ctx, ['tcpip', String(port)], { timeoutMs: 30_000 })
  const text = (result.stdout + result.stderr).trim()
  if (/restarting in TCP mode/i.test(text)) {
    return { ok: true, message: `手机已切换到无线模式（端口 ${port}），现在可以拔掉数据线。` }
  }
  return { ok: false, message: text || '切换失败，请确认手机已通过 USB 连上。' }
}

/** Ask the phone for its WLAN address, so the user does not have to look it up. */
export async function readWifiAddress(ctx: AdbContext): Promise<string | null> {
  const result = await runAdb(ctx, ['shell', 'ip', '-f', 'inet', 'addr', 'show', shellQuote('wlan0')], {
    timeoutMs: 15_000,
  })
  if (result.code !== 0) return null
  const match = /inet\s+(\d+\.\d+\.\d+\.\d+)/.exec(result.stdout)
  return match ? match[1] : null
}
