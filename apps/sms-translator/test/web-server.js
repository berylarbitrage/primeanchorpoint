/*
 * Tests for LAN web sharing.
 *
 * This server hands out someone's entire SMS history, and the ability to send
 * from their number, to anything that can reach the port. The parts worth
 * pinning down are therefore the boundaries, not the happy path: no password →
 * nothing; host-only actions stay host-only; a crafted path cannot walk out of
 * the bundle directory.
 *
 * Run with: npm test
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { WebServer, REMOTE_DENIED, generatePassword } = require(
  path.join(__dirname, '..', 'dist-electron', 'electron', 'web', 'server.js'),
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

// A stand-in for the built renderer, plus a secret next to it that must stay
// unreachable.
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-web-test-'))
fs.writeFileSync(
  path.join(dist, 'index.html'),
  '<!doctype html><html><body><script type="module" src="./assets/app.js"></script></body></html>',
)
fs.mkdirSync(path.join(dist, 'assets'))
fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log("app")')
fs.writeFileSync(path.join(dist, '..', 'secret.txt'), 'api key')

const calls = []
const PASSWORD = 'testpassword'
let port = 0

const server = new WebServer({
  distDir: dist,
  invoke: async (channel, args) => {
    calls.push([channel, args])
    if (channel === 'sms:list') return [{ id: 'a1' }]
    if (channel === 'boom') throw new Error('adb 挂了')
    // Same shape as the real dispatcher in ipc.ts.
    throw new Error(`未知的操作：${channel}`)
  },
  password: () => PASSWORD,
  port: () => port,
})

async function request(pathname, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, opts)
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, text, json, headers: res.headers }
}

async function main() {
  // Port 0 lets the OS pick, but the server binds what port() returns, so ask
  // for a high one and retry if it is taken.
  port = 18000 + Math.floor(process.pid % 1000)
  let started = await server.start()
  for (let attempt = 0; !started.ok && attempt < 5; attempt++) {
    port++
    started = await server.start()
  }
  check('the server starts', started.ok, true)

  // --- unauthenticated ---
  const anonymous = await request('/')
  check('the root serves a login page, not the inbox', anonymous.status, 200)
  check('and it is the login page', anonymous.text.includes('访问密码'), true)

  const anonymousApi = await request('/api/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'sms:list', args: [] }),
  })
  check('the API refuses without a session', anonymousApi.status, 401)
  check('and nothing reached the handlers', calls.length, 0)

  const anonymousAsset = await request('/assets/app.js')
  check('even the bundle needs a session', anonymousAsset.status, 200)
  check('serving the login page instead of the file', anonymousAsset.text.includes('访问密码'), true)

  // --- wrong password ---
  const wrong = await request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'nope' }),
  })
  check('a wrong password is rejected', wrong.status, 401)
  check('with no cookie handed out', wrong.headers.get('set-cookie'), null)

  // --- logging in ---
  const login = await request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  check('the right password is accepted', login.status, 200)
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  check('a session cookie is set', cookie.startsWith('sms_token='), true)
  check(
    'the cookie is not readable by page scripts',
    /HttpOnly/i.test(login.headers.get('set-cookie') ?? ''),
    true,
  )

  const auth = { cookie }

  // --- the inbox itself ---
  const index = await request('/', { headers: auth })
  check(
    'the served page installs the web bridge before the app',
    index.text.indexOf('web-bridge.js') < index.text.indexOf('type="module"'),
    true,
  )

  const list = await request('/api/invoke', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'sms:list', args: [] }),
  })
  check('a call reaches the handler', list.json, { result: [{ id: 'a1' }] })

  const denied = await request('/api/invoke', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'adb:browse', args: [] }),
  })
  check('host-only actions are refused', denied.status, 403)
  check(
    'a native file dialog is one of them',
    [...REMOTE_DENIED].includes('adb:browse') && [...REMOTE_DENIED].includes('settings:setApiKey'),
    true,
  )
  check('and it never reached the handler', calls.some(([c]) => c === 'adb:browse'), false)

  const failed = await request('/api/invoke', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'boom', args: [] }),
  })
  check('a handler error comes back as a message', failed.json.error, 'adb 挂了')

  const unknown = await request('/api/invoke', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'nope:nope', args: [] }),
  })
  check('an unknown channel is an error, not a crash', unknown.status, 500)
  check('and says which one', unknown.json.error, '未知的操作：nope:nope')

  // --- path traversal ---
  for (const attempt of ['/../secret.txt', '/..%2fsecret.txt', '/assets/../../secret.txt']) {
    const escaped = await request(attempt, { headers: auth })
    check(`\`${attempt}\` cannot escape the bundle`, escaped.text.includes('api key'), false)
  }

  // --- passwords ---
  const generated = new Set(Array.from({ length: 50 }, () => generatePassword()))
  check('generated passwords are unique', generated.size, 50)
  check('and long enough to be worth something', [...generated].every((p) => p.length >= 10), true)
  check(
    'with no look-alike characters',
    [...generated].every((p) => !/[0o1li]/.test(p)),
    true,
  )

  server.stop()
  check('stopping is reported', server.running(), false)

  fs.rmSync(dist, { recursive: true, force: true })
  fs.rmSync(path.join(dist, '..', 'secret.txt'), { force: true })

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
