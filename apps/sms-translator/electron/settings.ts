import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'

interface StoredSettings extends Omit<Settings, 'hasApiKey'> {
  /** OS-encrypted (DPAPI on Windows) when available, base64 either way. */
  apiKey?: string
  apiKeyEncrypted?: boolean
}

export class SettingsStore {
  private readonly file: string
  private data: StoredSettings

  constructor(dir: string) {
    this.file = path.join(dir, 'settings.json')
    const { hasApiKey: _ignored, ...rest } = DEFAULT_SETTINGS
    this.data = { ...rest }
  }

  load(): void {
    if (!fs.existsSync(this.file)) return
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoredSettings>
      this.data = { ...this.data, ...parsed }
    } catch {
      // Corrupt settings file — fall back to defaults rather than refusing to start.
    }
  }

  /** The renderer-visible view: everything except the key material. */
  public(): Settings {
    const { apiKey, apiKeyEncrypted: _enc, ...rest } = this.data
    return { ...rest, hasApiKey: Boolean(apiKey) }
  }

  update(patch: Partial<Settings>): Settings {
    const { hasApiKey: _ignored, ...rest } = patch
    this.data = { ...this.data, ...rest }
    this.persist()
    return this.public()
  }

  setApiKey(key: string): Settings {
    const trimmed = key.trim()
    if (!trimmed) {
      delete this.data.apiKey
      delete this.data.apiKeyEncrypted
    } else if (safeStorage.isEncryptionAvailable()) {
      this.data.apiKey = safeStorage.encryptString(trimmed).toString('base64')
      this.data.apiKeyEncrypted = true
    } else {
      // No OS keychain (rare on Windows, common in bare CI containers).
      this.data.apiKey = Buffer.from(trimmed, 'utf8').toString('base64')
      this.data.apiKeyEncrypted = false
    }
    this.persist()
    return this.public()
  }

  apiKey(): string {
    const stored = this.data.apiKey
    if (!stored) return ''
    const buf = Buffer.from(stored, 'base64')
    if (this.data.apiKeyEncrypted) {
      try {
        return safeStorage.decryptString(buf)
      } catch {
        return ''
      }
    }
    return buf.toString('utf8')
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }
}
