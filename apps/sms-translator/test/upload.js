/*
 * Tests for the website push and for what a LAN browser may see.
 *
 * Two things here are easy to get wrong and expensive to get wrong:
 *
 *   1. a message pushed before its translation arrived must be pushed again
 *      once it has one — otherwise the website keeps the untranslated copy for
 *      ever;
 *   2. the browsers we share the inbox with must not be handed the website push
 *      token (or be able to point the push somewhere else).
 *
 * Run with: npm test
 */
const path = require('node:path')
const dist = path.join(__dirname, '..', 'dist-electron', 'electron')
const {
  needsPush, pendingUploads, serialise, pushMessages, uploadedPatches, PUSH_BATCH,
  pendingMediaUploads, pushMedia,
  endpointBase, fetchOutbox, reportOutbox,
} = require(path.join(dist, 'upload', 'push.js'))
const { redactForRemote, sanitiseRemoteArgs } = require(path.join(dist, 'web', 'remote.js'))

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

function message(over = {}) {
  return {
    id: 'dev:1', deviceSerial: 'dev', kind: 'sms', rawId: 1, threadId: 1,
    address: '+14155550142', peer: '4155550142', date: 1_755_400_000_000,
    direction: 'in', body: 'hola', readOnDevice: true, readLocal: true,
    translationState: 'pending', ...over,
  }
}

// --- what gets pushed ---
check('a new message is pushed', needsPush(message()), true)
check(
  'an already-pushed message is not pushed again',
  needsPush(message({ uploadedState: 'pending' })),
  false,
)
check(
  'but it is once its translation arrives',
  needsPush(message({ uploadedState: 'pending', translationState: 'done' })),
  true,
)
check(
  'and not once that translation has been pushed too',
  needsPush(message({ uploadedState: 'done', translationState: 'done' })),
  false,
)

check(
  'a send status change is pushed again',
  needsPush(message({ uploadedState: 'pending', uploadedSendStatus: 'sending', sendStatus: 'sent' })),
  true,
)
check(
  'the send status travels',
  serialise(message({ direction: 'out', sendStatus: 'failed' })).send_status,
  'failed',
)

const many = Array.from({ length: PUSH_BATCH + 40 }, (_, i) => message({ id: `dev:${i}` }))
check('one batch at a time', pendingUploads(many).length, PUSH_BATCH)

// --- the wire shape ---
const wire = serialise(
  message({
    contact: '王 小明',
    translation: { text: '你好', sourceLang: 'Español', targetLang: '简体中文', model: 'm', at: 1 },
    analysis: { category: 'fraud', risk: 5, summary: '钓鱼', at: 1 },
    attachments: [{ partId: 3, contentType: 'image/jpeg' }],
  }),
)
check('the translation travels', [wire.translated_body, wire.source_lang], ['你好', 'Español'])
check('the risk travels', [wire.risk_score, wire.risk_category, wire.risk_summary], [5, 'fraud', '钓鱼'])
check('pictures are flagged, not uploaded', [wire.has_media, 'file' in wire], [true, false])
check('an unscored message sends no score', serialise(message()).risk_score, null)

// --- transport ---
async function main() {
  let seen = null
  const ok = await pushMessages(
    { url: 'https://example.com/api/device-sms/push', token: 'tok' },
    'R5CX90ABCDE',
    [message()],
    async (url, init) => {
      seen = { url, init }
      return { ok: true, status: 200, text: async () => JSON.stringify({ saved: 1 }) }
    },
  )
  check('a successful push reports what landed', ok, { ok: true, saved: 1 })
  check('the token goes in the header', seen.init.headers.authorization, 'Bearer tok')
  check(
    'the device serial is sent with the batch',
    JSON.parse(seen.init.body).device_serial,
    'R5CX90ABCDE',
  )

  const rejected = await pushMessages(
    { url: 'https://example.com/x', token: 'stale' },
    'dev',
    [message()],
    async () => ({ ok: false, status: 401, text: async () => '{"error":"bad token"}' }),
  )
  check('a rejected token is explained, not swallowed', rejected.ok, false)
  check('and says what to do', /令牌/.test(rejected.error), true)

  const offline = await pushMessages(
    { url: 'https://example.com/x', token: 't' },
    'dev',
    [message()],
    async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    },
  )
  check('a network failure is not a crash', offline.ok, false)

  check('nothing to push is not an error', (await pushMessages({ url: '', token: '' }, 'd', [])).ok, true)
  check(
    'but an unconfigured push with work to do is',
    (await pushMessages({ url: '', token: '' }, 'd', [message()])).ok,
    false,
  )

  check(
    'bookkeeping records the state that was pushed',
    uploadedPatches([message({ translationState: 'done' })]),
    [{ id: 'dev:1', partial: { uploadedState: 'done' } }],
  )

  // --- the website outbox (messages written on the web page) ---
  check(
    'the outbox URL is derived from the push URL',
    endpointBase('https://example.com/api/device-sms/push'),
    'https://example.com/api/device-sms',
  )
  check(
    'a trailing slash does not break it',
    endpointBase('https://example.com/api/device-sms/push/'),
    'https://example.com/api/device-sms',
  )

  let outboxUrl = ''
  const queued = await fetchOutbox(
    { url: 'https://example.com/api/device-sms/push', token: 'tok' },
    async (url) => {
      outboxUrl = url
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 7, to_address: '+1555', body: 'hi', peer: '', attempts: 0 }] }) }
    },
  )
  check('queued sends are fetched', queued.length, 1)
  check('from the outbox endpoint', outboxUrl, 'https://example.com/api/device-sms/outbox')

  check(
    'an unreachable website yields nothing rather than throwing',
    await fetchOutbox({ url: 'https://example.com/x/push', token: 't' }, async () => {
      throw new Error('offline')
    }),
    [],
  )
  check(
    'and so does an unconfigured one',
    await fetchOutbox({ url: '', token: '' }, async () => {
      throw new Error('should not be called')
    }),
    [],
  )

  let reported = null
  await reportOutbox(
    { url: 'https://example.com/api/device-sms/push', token: 'tok' },
    7,
    false,
    '手机没连上',
    async (url, init) => {
      reported = { url, body: JSON.parse(init.body) }
      return { ok: true, status: 200, text: async () => '{}' }
    },
  )
  check('a failure is reported back', reported.body, { ok: false, note: '手机没连上' })
  check('to that item', reported.url, 'https://example.com/api/device-sms/outbox/7/result')

  // --- what a LAN browser may see / change ---
  const settings = {
    targetLanguage: '简体中文', adbPath: 'C:/adb.exe', uploadToken: 'secret-token',
    webPassword: 'secret-password', uploadUrl: 'https://example.com/push', deviceSerial: 'R5C',
  }
  const shown = redactForRemote('settings:get', settings)
  check('the push token never reaches a browser', shown.uploadToken, '')
  check('nor does the web password', shown.webPassword, '')
  check('ordinary settings still do', shown.targetLanguage, '简体中文')
  check('and the original is untouched', settings.uploadToken, 'secret-token')
  check('other channels pass through', redactForRemote('sms:list', [{ id: 'a' }]), [{ id: 'a' }])

  const patch = sanitiseRemoteArgs('settings:set', [
    { targetLanguage: 'English', uploadUrl: 'https://evil.example/steal', adbPath: 'C:/x.exe' },
  ])
  check('a browser cannot redirect the push', 'uploadUrl' in patch[0], false)
  check('nor rewire adb', 'adbPath' in patch[0], false)
  check('but can still change its own view', patch[0].targetLanguage, 'English')
  check(
    'other channels keep their arguments',
    sanitiseRemoteArgs('sms:send', ['+1555', 'hi']),
    ['+1555', 'hi'],
  )

  // --- received pictures ---
  const pic = (a) => ({ partId: 7, contentType: 'image/jpeg', file: 'f.jpg', bytes: 1000, ...a })
  check(
    'a downloaded picture on a pushed message is queued',
    pendingMediaUploads([message({ uploadedState: 'done', attachments: [pic()] })]).length,
    1,
  )
  check(
    'not before the message itself is on the website',
    pendingMediaUploads([message({ attachments: [pic()] })]).length,
    0,
  )
  check(
    'nor once uploaded, nor before downloaded, nor HEIC',
    pendingMediaUploads([
      message({
        uploadedState: 'done',
        attachments: [pic({ pushed: true }), pic({ file: undefined }), pic({ contentType: 'image/heic' })],
      }),
    ]).length,
    0,
  )
  let mediaReq = null
  const sent = await pushMedia(
    { url: 'https://example.com/api/device-sms/push', token: 'tok' },
    'dev:mms:5',
    pic(),
    Buffer.from('abc'),
    async (url, init) => {
      mediaReq = { url, body: JSON.parse(init.body) }
      return { ok: true, status: 200, text: async () => '{}' }
    },
  )
  check('a picture upload lands', sent, { done: true })
  check('it goes to media-in', mediaReq.url, 'https://example.com/api/device-sms/media-in')
  check('with the message and part ids', [mediaReq.body.id, mediaReq.body.part_id, mediaReq.body.data], ['dev:mms:5', 7, 'YWJj'])
  const gone = await pushMedia({ url: 'https://example.com/x', token: 't' }, 'x', pic(), Buffer.from('a'),
    async () => ({ ok: false, status: 422, text: async () => 'no' }))
  check('a 422 (no such message) is final, not retried forever', gone.done, true)
  const undeployed = await pushMedia({ url: 'https://example.com/x', token: 't' }, 'x', pic(), Buffer.from('a'),
    async () => ({ ok: false, status: 404, text: async () => 'Cannot POST' }))
  check('a 404 (website not deployed yet) is retried', undeployed.done, false)
  const down = await pushMedia({ url: 'https://example.com/x', token: 't' }, 'x', pic(), Buffer.from('a'),
    async () => ({ ok: false, status: 502, text: async () => '' }))
  check('a 502 is retried', down.done, false)

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
