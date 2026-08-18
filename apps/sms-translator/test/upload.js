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
const { needsPush, pendingUploads, serialise, pushMessages, uploadedPatches, PUSH_BATCH } =
  require(path.join(dist, 'upload', 'push.js'))
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

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
