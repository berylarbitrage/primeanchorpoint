import { runAdb, shellQuote, type AdbContext } from './adb'

/**
 * Best-effort contact name lookup through the contacts provider. Many ROMs deny
 * the shell user READ_CONTACTS, so every failure here is swallowed — a missing
 * name is cosmetic, not an error worth surfacing.
 */
export class ContactResolver {
  /** address -> display name ('' means "looked up, no name"). */
  private cache = new Map<string, string>()
  private disabled = false

  reset(): void {
    this.cache.clear()
    this.disabled = false
  }

  async lookup(ctx: AdbContext, address: string): Promise<string> {
    if (this.disabled || !address) return ''

    const cached = this.cache.get(address)
    if (cached !== undefined) return cached

    const uri = `content://com.android.contacts/phone_lookup/${encodeURIComponent(address)}`
    let name = ''
    try {
      const res = await runAdb(
        ctx,
        ['shell', 'content', 'query', '--uri', shellQuote(uri), '--projection', 'display_name'],
        { timeoutMs: 10_000 },
      )
      if (res.code !== 0 || /Permission Denial|SecurityException/i.test(res.stdout + res.stderr)) {
        // The provider is not readable at all — stop asking for this session.
        this.disabled = true
        return ''
      }
      const match = /display_name=([^\r\n]*)/.exec(res.stdout)
      if (match && match[1] !== 'NULL') name = match[1].trim()
    } catch {
      this.disabled = true
      return ''
    }

    this.cache.set(address, name)
    return name
  }

  /** Resolve names for a set of addresses, sequentially to avoid adb contention. */
  async lookupMany(ctx: AdbContext, addresses: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const address of addresses) {
      if (this.disabled) break
      const name = await this.lookup(ctx, address)
      if (name) out.set(address, name)
    }
    return out
  }
}
