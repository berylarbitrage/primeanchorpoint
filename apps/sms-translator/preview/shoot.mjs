/*
 * Screenshot the app UI against mocked data. See preview/README.md.
 *
 * Serves a copy of dist/ with mock.js injected ahead of the app bundle (a
 * classic script runs before the deferred module), then drives it with
 * Playwright.
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '..')
const dist = join(app, 'dist')
const staging = join(here, '.staging')
const out = join(here, 'out')

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/ not found — run `npm run build` first.')
  process.exit(1)
}

// PREVIEW_PLAYWRIGHT may point at a CommonJS entry, whose named exports are not
// always detected — fall back to the default export.
const pw = await import(process.env.PREVIEW_PLAYWRIGHT ?? 'playwright').catch(() => {
  console.error('Playwright not found. Install it, or set PREVIEW_PLAYWRIGHT to its entry point.')
  process.exit(1)
})
const chromium = pw.chromium ?? pw.default?.chromium
if (!chromium) {
  console.error('The module at PREVIEW_PLAYWRIGHT does not export chromium.')
  process.exit(1)
}

// Stage dist/ + mock.js with the injection applied.
mkdirSync(staging, { recursive: true })
mkdirSync(out, { recursive: true })
const { cpSync } = await import('node:fs')
cpSync(dist, staging, { recursive: true })
cpSync(join(here, 'mock.js'), join(staging, 'mock.js'))
const html = readFileSync(join(dist, 'index.html'), 'utf8').replace(
  '<script type="module"',
  '<script src="./mock.js"></script>\n    <script type="module"',
)
writeFileSync(join(staging, 'index.html'), html)

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }
const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  const file = join(staging, path === '/' ? 'index.html' : path.slice(1))
  if (!existsSync(file)) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({
  ...(process.env.PREVIEW_CHROMIUM ? { executablePath: process.env.PREVIEW_CHROMIUM } : {}),
  args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1320, height: 860 }, deviceScaleFactor: 2 })
const problems = []
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))

await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' })
await page.waitForSelector('.conversation', { timeout: 10_000 })
console.log('conversations rendered:', await page.locator('.conversation').count())

const shots = [
  ['inbox', async () => page.locator('.conversation').filter({ hasText: 'DHL' }).first().click()],
  ['thread', async () => page.locator('.conversation').filter({ hasText: 'Marta' }).first().click()],
  ['mms', async () => page.locator('.conversation').filter({ hasText: '447700900123' }).first().click()],
  ['filter', async () => page.getByRole('button', { name: '可疑及以上' }).click()],
  [
    'note',
    async () => {
      await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' })
      await page.locator('.conversation').filter({ hasText: 'Marta' }).first().click()
      await page.getByPlaceholder(/^发给/).fill('好的，明天见')
      await page.waitForTimeout(200)
    },
  ],
  [
    'translated',
    async () => {
      // A conversation with a language set: the translation must be visible
      // before anything is sent.
      await page.getByRole('button', { name: /^译成 .* 并预览$/ }).click()
      await page.waitForSelector('.preview', { timeout: 10_000 })
    },
  ],
  [
    'blocked',
    async () => {
      await page.getByPlaceholder(/^发给/).fill('我的验证码是 884213，你先用')
      // This conversation has a language set, so the plain-send button is the
      // "send it untranslated" one.
      await page.getByRole('button', { name: '直接发原文' }).click()
      await page.waitForSelector('.blocked', { timeout: 10_000 })
    },
  ],
  [
    'compose',
    async () => {
      await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' })
      await page.getByRole('button', { name: '＋ 新短信' }).click()
      await page.getByPlaceholder('号码，或联系人名字').fill('ma')
      await page.waitForSelector('.suggestion')
    },
  ],
  [
    'error',
    async () => {
      await page.goto(`${base}/index.html?state=error`, { waitUntil: 'networkidle' })
      await page.waitForSelector('.banner.error', { timeout: 10_000 })
    },
  ],
]
for (const [name, act] of shots) {
  await act()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(out, `ui-${name}.png`) })
  console.log('wrote', join('preview/out', `ui-${name}.png`))
}

await browser.close()
server.close()
console.log(problems.length ? 'PAGE ERRORS:\n' + problems.join('\n') : 'no page errors')
process.exit(problems.length ? 1 : 0)
