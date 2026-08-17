import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runAdb } from './adb'

/**
 * Finding adb is the very first thing every user hits, and "spawn adb ENOENT"
 * tells them nothing. So rather than requiring PATH to be configured, look in
 * the places Platform Tools actually ends up on a Windows machine.
 */

/** Candidate locations, in the order they should be tried. */
export function defaultCandidates(): string[] {
  const home = os.homedir()
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const tools = path.join('platform-tools', 'adb.exe')

  return [
    // Whatever is on PATH wins — that's the documented setup.
    'adb',

    // Hand-extracted zips. People drop these wherever the download landed.
    path.join('C:\\', tools),
    path.join('C:\\', 'Android', tools),
    path.join(home, 'Downloads', tools),
    path.join(home, 'Downloads', 'platform-tools-latest-windows', tools),
    path.join(home, 'Desktop', tools),
    path.join(home, tools),
    path.join(programFiles, tools),

    // Installed alongside Android Studio.
    path.join(localAppData, 'Android', 'Sdk', tools),
    path.join(home, 'Android', 'Sdk', tools),
    ...(process.env.ANDROID_HOME ? [path.join(process.env.ANDROID_HOME, tools)] : []),
    ...(process.env.ANDROID_SDK_ROOT
      ? [path.join(process.env.ANDROID_SDK_ROOT, tools)]
      : []),

    // Development machines.
    '/usr/bin/adb',
    '/usr/local/bin/adb',
    path.join(home, 'Android', 'Sdk', 'platform-tools', 'adb'),
  ]
}

/** True when the binary at `adbPath` runs and identifies itself as adb. */
export async function verifyAdb(adbPath: string): Promise<boolean> {
  try {
    const result = await runAdb({ adbPath, serial: null }, ['version'], { timeoutMs: 10_000 })
    return result.code === 0 && /Android Debug Bridge/i.test(result.stdout)
  } catch {
    return false
  }
}

/**
 * Return a working adb path, or null if none was found.
 *
 * `configured` is tried first so an explicit setting always wins. Bare names
 * (no separator) are resolved through PATH by the OS, so they are spawned
 * directly; anything that looks like a path is stat'd first to avoid spawning
 * a dozen processes that would all fail.
 */
export async function findAdb(
  configured: string,
  candidates: string[] = defaultCandidates(),
): Promise<string | null> {
  const seen = new Set<string>()
  const ordered = [configured.trim(), ...candidates].filter((c) => {
    if (!c || seen.has(c)) return false
    seen.add(c)
    return true
  })

  for (const candidate of ordered) {
    const looksLikePath = candidate.includes('/') || candidate.includes('\\')
    if (looksLikePath && !fs.existsSync(candidate)) continue
    if (await verifyAdb(candidate)) return candidate
  }
  return null
}

export const ADB_MISSING_MESSAGE =
  '找不到 adb。请到 https://developer.android.com/tools/releases/platform-tools ' +
  '下载 Platform Tools，解压后在下面的「adb 可执行文件路径」里填 adb.exe 的完整路径' +
  '（例如 C:\\platform-tools\\adb.exe），然后点「重新扫描」。'

/**
 * Caches the resolved adb path for the process, and writes it back into
 * settings so the path the app is actually using is visible in the UI.
 */
export class AdbLocator {
  private resolved: string | null = null
  private inFlight: Promise<string | null> | null = null

  constructor(
    private readonly configured: () => string,
    private readonly onResolved: (adbPath: string) => void,
  ) {}

  /** Forget the cached path, e.g. after the user edits the setting. */
  reset(): void {
    this.resolved = null
    this.inFlight = null
  }

  /** Resolve adb, or throw a message the user can act on. */
  async require(): Promise<string> {
    const found = await this.locate()
    if (!found) throw new Error(ADB_MISSING_MESSAGE)
    return found
  }

  async locate(): Promise<string | null> {
    const configured = this.configured().trim()
    if (this.resolved && this.resolved === configured) return this.resolved
    if (this.inFlight) return this.inFlight

    this.inFlight = (async () => {
      const found = await findAdb(configured)
      this.resolved = found
      if (found && found !== configured) this.onResolved(found)
      return found
    })()

    try {
      return await this.inFlight
    } finally {
      this.inFlight = null
    }
  }
}
