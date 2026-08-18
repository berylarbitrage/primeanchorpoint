/*
 * Drive the LAN web page end to end without a phone.
 *
 * Starts the real WebServer over the real dist/ bundle, backed by a stub for
 * the IPC handlers, then logs in with a browser and screenshots the result at
 * desktop and phone widths. This exercises the parts the unit tests cannot:
 * the login round trip, the injected web-bridge, and the responsive layout the
 * shared page is actually viewed at.
 *
 * See preview/README.md.
 */
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '..')
const dist = join(app, 'dist')
const out = join(here, 'out')

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/ not found — run `npm run build` first.')
  process.exit(1)
}

const require = createRequire(import.meta.url)
const { WebServer } = require(join(app, 'dist-electron', 'electron', 'web', 'server.js'))

const now = Date.parse('2026-08-17T20:40:00')
const PASSWORD = 'previewpassword'

function message(over) {
  return {
    deviceSerial: 'R5CX90ABCDE',
    kind: 'sms',
    rawId: 1,
    threadId: 1,
    readOnDevice: true,
    readLocal: true,
    translationState: 'done',
    ...over,
  }
}

const messages = [
  message({
    id: 'a1', address: '+14155550142', peer: '4155550142', contact: 'DHL Express',
    date: now - 90 * 60_000, direction: 'in', readLocal: false,
    body: 'Your parcel could not be delivered. Reschedule at dhl-track.co/r7f2.',
    translation: { text: '您的包裹投递失败。请到 dhl-track.co/r7f2 重新安排投递。', sourceLang: 'English', targetLang: '简体中文', model: 'claude-opus-5', at: now },
    analysis: { category: 'fraud', risk: 5, summary: '假冒快递的钓鱼短信。', at: now },
  }),
  message({
    id: 'b1', address: '+34611223344', peer: '4611223344', contact: 'Marta Ruiz',
    date: now - 30 * 60_000, direction: 'in',
    body: '¿Podemos mover la reunión del martes a las 10?',
    translation: { text: '周二的会能不能改到 10 点？', sourceLang: 'Español', targetLang: '简体中文', model: 'claude-opus-5', at: now },
    analysis: { category: 'personal', risk: 0, summary: '对方想改会议时间。', at: now },
  }),
]

const settings = {
  adbPath: 'adb', deviceSerial: 'R5CX90ABCDE', wirelessAddress: '', pinnedPeers: [],
  wirelessAutoReconnect: true, targetLanguage: '简体中文', outgoingLanguage: '',
  autoTranslate: true, classify: true, model: 'claude-opus-5', pollIntervalMs: 6000,
  autoSync: true, initialImportDays: 90, includeMms: true, maxAttachmentKb: 2048,
  describeImages: true, sendMethod: 'ui', sendTapDelayMs: 1500, batchSize: 20,
  hasApiKey: true, webEnabled: true, webPort: 0, webPassword: PASSWORD,
}

const status = {
  phase: 'idle',
  device: { serial: 'R5CX90ABCDE', state: 'device', model: 'SM_S928B', ready: true },
  lastSyncAt: now,
  pendingTranslations: 0,
}

let port = 18500
const server = new WebServer({
  distDir: dist,
  invoke: async (channel) => {
    if (channel === 'sms:list') return messages
    if (channel === 'settings:get') return settings
    if (channel === 'status:get') return status
    if (channel === 'contacts:list') return [{ name: 'Marta Ruiz', number: '+34611223344' }]
    return null
  },
  password: () => PASSWORD,
  port: () => port,
})

let started = await server.start()
for (let attempt = 0; !started.ok && attempt < 10; attempt++) {
  port++
  started = await server.start()
}
if (!started.ok) {
  console.error('could not start the server:', started.error)
  process.exit(1)
}
const base = `http://127.0.0.1:${port}`
console.log('serving', base)

const pw = await import(process.env.PREVIEW_PLAYWRIGHT ?? 'playwright').catch(() => {
  console.error('Playwright not found. Install it, or set PREVIEW_PLAYWRIGHT to its entry point.')
  process.exit(1)
})
const chromium = pw.chromium ?? pw.default?.chromium

mkdirSync(out, { recursive: true })
const browser = await chromium.launch({
  ...(process.env.PREVIEW_CHROMIUM ? { executablePath: process.env.PREVIEW_CHROMIUM } : {}),
  args: ['--no-sandbox'],
})

const problems = []

for (const [name, viewport] of [
  ['desktop', { width: 1320, height: 860 }],
  ['phone', { width: 390, height: 780 }],
]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 })
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`))

  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  await page.screenshot({ path: join(out, `web-${name}-login.png`) })

  await page.fill('#p', PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForSelector('.conversation', { timeout: 10_000 })
  await page.screenshot({ path: join(out, `web-${name}-inbox.png`) })
  console.log(`wrote preview/out/web-${name}-{login,inbox}.png`)

  // On a phone the list and the thread take turns owning the screen.
  await page.locator('.conversation').first().click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(out, `web-${name}-thread.png`) })
  console.log(`wrote preview/out/web-${name}-thread.png`)

  await page.close()
}

await browser.close()
server.stop()

if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('no page errors')
