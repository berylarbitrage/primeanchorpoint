import { runAdb, shellQuote, type AdbContext } from './adb'
import { isPermissionDenied, parseContentRows, value } from './rows'
import { normalisePeer } from './sms'
import type { Contact } from '../../shared/types'

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

/**
 * Columns for the phone-book listing. `display_name` MUST stay last — names
 * contain commas ("Ruiz, Marta"), and only the final column may (see rows.ts).
 */
const CONTACT_COLUMNS = ['data1', 'display_name'] as const

/** Rows of `content://com.android.contacts/data` into contacts, deduped. */
export function parseContactRows(output: string): Contact[] {
  const seen = new Set<string>()
  const out: Contact[] = []
  for (const row of parseContentRows(output, CONTACT_COLUMNS)) {
    const number = value(row.data1).trim()
    const name = value(row.display_name).trim()
    if (!number) continue
    // One person often has several entries for the same number (mobile, work,
    // a SIM copy). Key on the digits so the picker shows each number once.
    const key = normalisePeer(number)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, number })
  }
  out.sort((a, b) => (a.name || a.number).localeCompare(b.name || b.number))
  return out
}

/**
 * Read the phone book. Optional, like name lookup: a ROM that denies the shell
 * user READ_CONTACTS just means the user types the number instead.
 */
export async function listPhoneContacts(ctx: AdbContext): Promise<Contact[]> {
  const res = await runAdb(
    ctx,
    [
      'shell',
      'content',
      'query',
      '--uri',
      shellQuote('content://com.android.contacts/data'),
      '--projection',
      shellQuote('data1:display_name'),
      '--where',
      shellQuote(`mimetype='vnd.android.cursor.item/phone_v2'`),
    ],
    { timeoutMs: 30_000 },
  )
  if (res.code !== 0 || isPermissionDenied(res.stdout + res.stderr)) return []
  return parseContactRows(res.stdout)
}
