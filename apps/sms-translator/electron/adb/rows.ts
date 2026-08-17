/**
 * Parser for `adb shell content query` output.
 *
 * The provider prints rows as `Row: N key=value, key=value, ...` with **no
 * escaping of any kind**, so a value may contain commas, newlines, and text
 * that looks like another column. Two rules make this tractable:
 *
 *  1. anchor each field on the literal name of the *next* column, so only the
 *     final column can swallow arbitrary text;
 *  2. always put the one free-text column (a message body, a subject) last in
 *     the projection.
 *
 * Callers are responsible for rule 2 — see COLUMNS in sms.ts and mms.ts.
 */

const ROW_PREFIX = /^Row: \d+ /

export type Row<C extends readonly string[]> = Record<C[number], string>

/** Build the field-splitting regex for a projection. */
function rowRegex(columns: readonly string[]): RegExp {
  return new RegExp(
    '^' +
      columns
        .map((c, i) =>
          i === columns.length - 1
            ? `${c}=([\\s\\S]*)$`
            : `${c}=(.*?), (?=${columns[i + 1]}=)`,
        )
        .join(''),
  )
}

/** `NULL` is how the provider spells "no value"; callers want an empty string. */
export function value(raw: string | undefined): string {
  return raw === undefined || raw === 'NULL' ? '' : raw
}

export function parseContentRows<C extends readonly string[]>(
  output: string,
  columns: C,
): Row<C>[] {
  const re = rowRegex(columns)
  const rows: Row<C>[] = []

  // A value may contain newlines, so split on the start-of-row marker rather
  // than on line boundaries.
  for (const chunk of output.split(/\r?\n(?=Row: \d+ )/)) {
    const line = chunk.replace(/\r/g, '').trim()
    if (!ROW_PREFIX.test(line)) continue

    const match = re.exec(line.replace(ROW_PREFIX, ''))
    if (!match) continue

    const row = {} as Row<C>
    columns.forEach((name, i) => {
      row[name as C[number]] = match[i + 1] ?? ''
    })
    rows.push(row)
  }

  return rows
}

/** True when the output says the provider refused us. */
export function isPermissionDenied(output: string): boolean {
  return /Permission Denial|SecurityException/i.test(output)
}

/** True when the query ran fine but matched nothing. */
export function isEmptyResult(output: string): boolean {
  return /^No result found\.?$/im.test(output.trim())
}
