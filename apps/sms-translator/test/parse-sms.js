/*
 * Tests for the SMS content-provider parser.
 *
 * `content query` has no escaping whatsoever — it prints `key=value, key=value`
 * and a message body can legally contain commas, newlines, and text that looks
 * like another column. That makes this parser the most failure-prone piece of
 * the app, so it gets covered directly.
 *
 * Run with: npm test  (builds dist-electron first)
 */
const path = require('node:path')
const { parseRows, normalisePeer } = require(
  path.join(__dirname, '..', 'dist-electron', 'electron', 'adb', 'sms.js'),
)

const sample = [
  'Row: 0 _id=41, thread_id=3, address=+8613800138000, date=1755400000000, type=1, status=-1, read=0, body=您好，验证码 483920，5 分钟内有效',
  'Row: 1 _id=42, thread_id=3, address=+8613800138000, date=1755400600000, type=2, status=-1, read=1, body=收到了，谢谢',
  'Row: 2 _id=43, thread_id=9, address=NULL, date=1755401000000, type=1, status=-1, read=1, body=NULL',
  'Row: 3 _id=44, thread_id=4, address=ALIPAY, date=1755402000000, type=1, status=-1, read=0, body=First line, second=not a column',
  'more body text on its own line',
  'and another line',
  'Row: 4 _id=45, thread_id=4, address=(555) 010-0000, date=1755403000000, type=3, status=-1, read=1, body=a draft, should be dropped',
  'Row: 5 _id=46, thread_id=4, address=(555) 010-0000, date=1755404000000, type=5, status=-1, read=1, body=failed one',
  'Row: 6 _id=47, thread_id=4, address=(555) 010-0000, date=1755405000000, type=4, status=-1, read=1, body=still going',
  'Row: 7 _id=48, thread_id=4, address=(555) 010-0000, date=1755406000000, type=2, status=0, read=1, body=delivered one',
  'Row: 8 _id=49, thread_id=4, address=(555) 010-0000, date=1755407000000, type=2, status=NULL, read=1, body=no report',
].join('\n')

const rows = parseRows(sample, 'ABC123')

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

check('drops the draft (type=3)', rows.length, 8)
check('id is namespaced by device', rows[0].id, 'ABC123:41')
check('inbox -> in', rows[0].direction, 'in')
check('sent -> out', rows[1].direction, 'out')
check('unread flag', rows[0].readOnDevice, false)
check('body containing a comma', rows[0].body, '您好，验证码 483920，5 分钟内有效')
check('NULL address becomes empty', rows[2].address, '')
check('NULL body becomes empty', rows[2].body, '')
check(
  'multi-line body with a "key=" lookalike survives intact',
  rows[3].body,
  'First line, second=not a column\nmore body text on its own line\nand another line',
)
check('alphanumeric sender kept as its own peer', rows[3].peer, 'ALIPAY')
check(
  'country code ignored when grouping',
  normalisePeer('+8613800138000'),
  normalisePeer('13800138000'),
)
check(
  'formatting ignored when grouping',
  normalisePeer('(555) 010-0000'),
  normalisePeer('+1 555-010-0000'),
)
check(
  'different numbers stay in different conversations',
  normalisePeer('+8613800138000') === normalisePeer('+8613900139000'),
  false,
)
check('incoming has no send status', rows[0].sendStatus, undefined)
check('sent, no delivery report', rows[1].sendStatus, 'sent')
check('type=5 -> failed', rows[4].sendStatus, 'failed')
check('type=4 -> sending', rows[5].sendStatus, 'sending')
check('status=0 -> delivered', rows[6].sendStatus, 'delivered')
check('NULL status -> sent', rows[7].sendStatus, 'sent')
check('short codes are kept verbatim', normalisePeer('10086'), '10086')

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
