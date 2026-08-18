/*
 * Tests for deletion in the message store.
 *
 * Deleting is the one inbox action that cannot be pushed to the phone: the
 * shell user is not the default SMS app, so the phone keeps its copy. Without
 * remembering what was deleted, the very next sync re-imports it and the
 * message the user just deleted comes straight back.
 *
 * Run with: npm test
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { MessageStore } = require(
  path.join(__dirname, '..', 'dist-electron', 'electron', 'store.js'),
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

function message(id, extra = {}) {
  return {
    id,
    deviceSerial: 'R5CX90ABCDE',
    kind: 'sms',
    rawId: Number(id.split(':').pop()),
    threadId: 1,
    address: '+14155550142',
    peer: '4155550142',
    date: 1_755_400_000_000,
    direction: 'in',
    body: 'hello',
    readOnDevice: false,
    readLocal: false,
    translationState: 'pending',
    ...extra,
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-store-test-'))
const store = new MessageStore(dir)
store.load()

store.upsertFromDevice([message('dev:1'), message('dev:2')])
check('both messages are stored', store.all().length, 2)

// --- deleting for real ---
check('delete reports what it removed', store.remove(['dev:1'], true), ['dev:1'])
check('and the message is gone', store.all().length, 1)
store.upsertFromDevice([message('dev:1'), message('dev:2')])
check('a later sync does not resurrect it', store.all().map((m) => m.id), ['dev:2'])

// --- the optimistic-send case ---
// Retiring a local placeholder must NOT block that id forever; nothing else
// would ever carry it, but the intent is different and worth pinning down.
store.upsertFromDevice([message('local:9')])
store.remove(['local:9'])
check('a non-permanent removal leaves no tombstone', store.all().length, 1)
store.upsertFromDevice([message('local:9')])
check('so the record can come back', store.all().length, 2)

// --- across a restart ---
const reopened = new MessageStore(dir)
reopened.load()
check(
  'the deletion survives a restart',
  reopened.all().map((m) => m.id).sort(),
  ['dev:2', 'local:9'],
)
reopened.upsertFromDevice([message('dev:1')])
check('including against a fresh import', reopened.all().length, 2)

fs.rmSync(dir, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
