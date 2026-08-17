import { spawn } from 'node:child_process'
import type { DeviceInfo } from '../../shared/types'

export interface AdbContext {
  adbPath: string
  serial: string | null
}

export interface AdbResult {
  code: number
  stdout: string
  stderr: string
}

export class AdbError extends Error {
  constructor(
    message: string,
    readonly result?: AdbResult,
  ) {
    super(message)
    this.name = 'AdbError'
  }
}

/**
 * Quote a value so the *device's* shell sees it verbatim. adb joins its
 * arguments with spaces and hands the result to `sh` on the phone, so anything
 * we pass has to survive a second round of word splitting.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function runAdb(
  ctx: AdbContext,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<AdbResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const full = ctx.serial ? ['-s', ctx.serial, ...args] : args

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(ctx.adbPath, full, { windowsHide: true })
    } catch (err) {
      reject(new AdbError(`Could not start adb at "${ctx.adbPath}": ${String(err)}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new AdbError(`adb ${full.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (stdout += d))
    child.stderr.on('data', (d: string) => (stderr += d))

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new AdbError(`Could not run adb at "${ctx.adbPath}": ${err.message}`))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * Run an adb command and collect stdout as raw bytes.
 *
 * Needed for MMS attachments: `adb shell` can translate line endings, which
 * silently corrupts binary payloads, so those go through `adb exec-out`, and the
 * output must never be decoded as text.
 */
export function runAdbBinary(
  ctx: AdbContext,
  args: string[],
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024
  const full = ctx.serial ? ['-s', ctx.serial, ...args] : args

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(ctx.adbPath, full, { windowsHide: true })
    } catch (err) {
      reject(new AdbError(`Could not start adb at "${ctx.adbPath}": ${String(err)}`))
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => {
        child.kill()
        reject(new AdbError(`adb ${full.join(' ')} timed out after ${timeoutMs}ms`))
      })
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        finish(() => {
          child.kill()
          reject(new AdbError(`adb output exceeded ${maxBytes} bytes`))
        })
        return
      }
      chunks.push(chunk)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => (stderr += d))

    child.on('error', (err) => {
      finish(() => reject(new AdbError(`Could not run adb at "${ctx.adbPath}": ${err.message}`)))
    })
    child.on('close', (code) => {
      finish(() => resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr }))
    })
  })
}

/** Run an adb command and throw unless it exited cleanly. */
export async function runAdbChecked(
  ctx: AdbContext,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const result = await runAdb(ctx, args, opts)
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    throw new AdbError(`adb ${args.join(' ')} failed (exit ${result.code}): ${detail}`, result)
  }
  // Some adb builds print warnings to stdout before the payload; callers that
  // care parse line-by-line, so leave the text intact.
  return result.stdout
}

export async function listDevices(adbPath: string): Promise<DeviceInfo[]> {
  const out = await runAdbChecked({ adbPath, serial: null }, ['devices', '-l'], {
    timeoutMs: 15_000,
  })

  const devices: DeviceInfo[] = []
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('List of devices')) continue
    if (/^[*]/.test(trimmed)) continue // "* daemon started successfully *"

    const [serial, state, ...rest] = trimmed.split(/\s+/)
    if (!serial || !state) continue

    const props: Record<string, string> = {}
    for (const token of rest) {
      const eq = token.indexOf(':')
      if (eq > 0) props[token.slice(0, eq)] = token.slice(eq + 1)
    }

    devices.push({
      serial,
      state,
      model: props.model,
      device: props.device,
      ready: state === 'device',
    })
  }
  return devices
}

/**
 * Resolve which device to talk to. Prefers the configured serial; falls back to
 * the only connected device when there is exactly one.
 */
export async function resolveDevice(
  adbPath: string,
  preferred: string | null,
): Promise<DeviceInfo | null> {
  const devices = await listDevices(adbPath)
  const ready = devices.filter((d) => d.ready)
  if (preferred) {
    const match = ready.find((d) => d.serial === preferred)
    if (match) return match
  }
  return ready.length === 1 ? ready[0] : null
}
