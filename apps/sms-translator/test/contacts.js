/*
 * Tests for the phone-book listing.
 *
 * The contacts provider prints the same unescaped `Row: N k=v, k=v` format as
 * everything else, and names are the worst possible free-text column: "Ruiz,
 * Marta" contains the separator. That is why display_name is queried last.
 *
 * Run with: npm test
 */
const path = require('node:path')
const { parseContactRows } = require(
  path.join(__dirname, '..', 'dist-electron', 'electron', 'adb', 'contacts.js'),
)

let failures = 0
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`ok   ${label}`)
    return
  }
  failures++
  console.log(
    `FAIL ${label}\n  got:      ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
  )
}

const out = [
  'Row: 0 data1=+34611223344, display_name=Marta Ruiz',
  'Row: 1 data1=+8613800138000, display_name=王 小明',
  // Same person, second entry (work number copied into the SIM account).
  'Row: 2 data1=+34 611 22 33 44, display_name=Marta Ruiz (trabajo)',
  'Row: 3 data1=+14155550142, display_name=Ruiz, Marta',
  'Row: 4 data1=NULL, display_name=No Number',
  'Row: 5 data1=+15551230000, display_name=NULL',
].join('\n')

const contacts = parseContactRows(out)
check('a contact without a number is dropped', contacts.length, 4)

const byNumber = Object.fromEntries(contacts.map((c) => [c.number, c.name]))
check('a name containing a comma survives', byNumber['+14155550142'], 'Ruiz, Marta')
check('a nameless number is still offered', byNumber['+15551230000'], '')
check(
  'the same number twice appears once',
  contacts.filter((c) => c.number.replace(/[^\d]/g, '') === '34611223344').length,
  1,
)
check('the first spelling of a duplicate wins', byNumber['+34611223344'], 'Marta Ruiz')
check('non-latin names are kept intact', byNumber['+8613800138000'], '王 小明')

// Sorted by display name so the picker is stable; nameless entries sort by number.
check(
  'sorted for display',
  contacts.map((c) => c.name || c.number),
  ['+15551230000', 'Marta Ruiz', 'Ruiz, Marta', '王 小明'].sort((a, b) => a.localeCompare(b)),
)

check('empty output yields no contacts', parseContactRows('No result found.'), [])

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
