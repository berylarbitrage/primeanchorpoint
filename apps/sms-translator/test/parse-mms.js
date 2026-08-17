/*
 * Tests for MMS parsing.
 *
 * MMS is stored nothing like SMS, and two details are easy to get wrong in ways
 * that only show up much later:
 *
 *   1. `mms.date` is in SECONDS. Used raw, every picture message lands in 1970.
 *   2. the sender lives in a separate addr table keyed by PDU header type
 *      (137 = from, 151 = to), alongside a placeholder row for "me".
 *
 * Both are covered here, along with part splitting (SMIL layout parts must never
 * reach the user).
 *
 * Run with: npm test
 */
const path = require('node:path')
const {
  parseMmsRows,
  parsePartRows,
  pickAddress,
  splitParts,
  buildMessage,
} = require(path.join(__dirname, '..', 'dist-electron', 'electron', 'adb', 'mms.js'))

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

// --- content://mms ---
const mmsOut = [
  'Row: 0 _id=7, thread_id=12, date=1755400000, msg_box=1, read=0, sub=NULL',
  'Row: 1 _id=8, thread_id=12, date=1755400600, msg_box=2, read=1, sub=Photos, from the trip',
  'Row: 2 _id=9, thread_id=13, date=1755401000, msg_box=3, read=1, sub=a draft',
].join('\n')

const rows = parseMmsRows(mmsOut)
check('drafts (msg_box=3) are dropped', rows.length, 2)
check('seconds are converted to milliseconds', rows[0].date, 1755400000 * 1000)
check('inbox -> in', rows[0].direction, 'in')
check('sent -> out', rows[1].direction, 'out')
check('NULL subject becomes empty', rows[0].subject, '')
check('a subject containing a comma survives', rows[1].subject, 'Photos, from the trip')
check('unread flag', rows[0].readOnDevice, false)

// --- content://mms/part ---
const partOut = [
  'Row: 0 _id=21, mid=7, ct=application/smil, name=smil.xml, text=<smil><body/></smil>',
  'Row: 1 _id=22, mid=7, ct=text/plain, name=NULL, text=看看这个，很奇怪',
  'Row: 2 _id=23, mid=7, ct=image/jpeg, name=IMG_0042.jpg, text=NULL',
  'Row: 3 _id=24, mid=8, ct=image/png, name=shot.png, text=NULL',
].join('\n')

const parts = parsePartRows(partOut)
check('all parts parse', parts.length, 4)
check('content type is lower-cased', parts[2].contentType, 'image/jpeg')

const forSeven = parts.filter((p) => p.mid === 7)
const split = splitParts(forSeven)
check('SMIL layout parts are never surfaced', split.attachments.length, 1)
check('the image is kept', split.attachments[0].contentType, 'image/jpeg')
check('the attachment name is kept', split.attachments[0].name, 'IMG_0042.jpg')
check('text parts become the body', split.body, '看看这个，很奇怪')

// A picture with no text at all is legal and must not invent a body.
const pictureOnly = splitParts(parts.filter((p) => p.mid === 8))
check('a picture-only message has an empty body', pictureOnly.body, '')
check('and still reports its attachment', pictureOnly.attachments.length, 1)

// Multiple text parts join in id order (multi-slide MMS).
check(
  'multiple text parts join in id order',
  splitParts([
    { id: 5, mid: 1, contentType: 'text/plain', name: '', text: 'second' },
    { id: 2, mid: 1, contentType: 'text/plain', name: '', text: 'first' },
  ]).body,
  'first\nsecond',
)

// --- content://mms/<id>/addr ---
const addrOut = [
  'Row: 0 type=137, address=+8613800138000',
  'Row: 1 type=151, address=insert-address-token',
].join('\n')
check('incoming picks the "from" address (type 137)', pickAddress(addrOut, 'in'), '+8613800138000')

const outAddrOut = [
  'Row: 0 type=137, address=insert-address-token',
  'Row: 1 type=151, address=+34611223344',
].join('\n')
check('outgoing picks the "to" address (type 151)', pickAddress(outAddrOut, 'out'), '+34611223344')

check(
  'the "me" placeholder is never chosen as the peer',
  pickAddress('Row: 0 type=151, address=insert-address-token', 'in'),
  '',
)
check(
  'a row with no usable type still yields the address',
  pickAddress('Row: 0 type=0, address=+15551230000', 'in'),
  '+15551230000',
)

// --- assembly ---
const built = buildMessage('R5CX90ABCDE', rows[0], '+8613800138000', forSeven)
check('the id namespace cannot collide with SMS', built.id, 'R5CX90ABCDE:mms:7')
check('kind is recorded', built.kind, 'mms')
check('the peer is normalised like SMS', built.peer, '3800138000')
check('attachments are attached', built.attachments.length, 1)
check('a picture message starts pending, not skipped', built.translationState, 'pending')

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
