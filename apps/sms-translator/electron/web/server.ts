/*
 * LAN web access.
 *
 * The phone can only be read by a machine running adb, so there is no such
 * thing as a standalone web version. What this does instead: the desktop app
 * that is already talking to the phone also serves the very same renderer
 * bundle over HTTP, so anyone on the same WiFi can open it in a browser.
 *
 * The browser gets `window.sms` from `web-bridge.js` (fetch + SSE) instead of
 * from the Electron preload, so the React app is unaware it is not running in
 * Electron — exactly the trick the preview harness uses.
 *
 * Everything here is deliberately electron-free so it can be tested with plain
 * node (see test/web-server.js).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

export interface WebServerDeps {
  /** Directory holding the built renderer (index.html, assets/, web-bridge.js). */
  distDir: string
  /** Runs an IPC channel by name — the same handlers the desktop UI calls. */
  invoke: (channel: string, args: unknown[]) => Promise<unknown>
  password: () => string
  port: () => number
}

/**
 * Channels a browser client must not reach.
 *
 * These act on the host machine rather than on messages: opening a native file
 * dialog on someone else's desktop, rewriting the adb/wireless connection, or
 * replacing the API key. Everything to do with reading, sending, translating
 * and organising messages is allowed — that is the point of sharing.
 */
export const REMOTE_DENIED = new Set([
  'adb:browse',
  'settings:setApiKey',
  'wireless:pair',
  'wireless:connect',
  'wireless:disconnect',
  'wireless:enableOverUsb',
  'clipboard:write',
  'upload:now',
])

const COOKIE = 'sms_token'
const MAX_BODY_BYTES = 8 * 1024 * 1024
/** Wrong-password attempts allowed per address before it is locked out. */
const MAX_FAILURES = 8
const LOCKOUT_MS = 10 * 60 * 1000

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
}

/** Every address this machine can be reached at, for the "open this" hint. */
export function localUrls(port: number): string[] {
  const urls: string[] = []
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      urls.push(`http://${address.address}:${port}`)
    }
  }
  return urls
}

/** A password short enough to read out loud, long enough not to be guessed. */
export function generatePassword(): string {
  // No look-alike characters: someone will be typing this on a phone.
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz'
  const bytes = crypto.randomBytes(10)
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SMS 译信</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0e1116; color:#e6edf3;
         font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif }
  form { display:grid; gap:12px; width:min(320px, 88vw) }
  h1 { font-size:20px; margin:0 }
  p { margin:0; font-size:13px; color:#8b98a5; line-height:1.6 }
  input, button { font:inherit; padding:10px 12px; border-radius:8px;
                  border:1px solid #2a323d; background:#161b22; color:inherit }
  button { background:#2f81f7; border-color:#2f81f7; color:#07121e; font-weight:600 }
  .err { color:#f85149; font-size:13px; min-height:18px }
</style></head><body>
<form id="f">
  <h1>SMS 译信</h1>
  <p>请输入电脑上「设置 → 网页共享」里显示的访问密码。</p>
  <input id="p" type="password" autocomplete="current-password" placeholder="访问密码" autofocus>
  <button type="submit">进入</button>
  <div class="err" id="e"></div>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (event) => {
  event.preventDefault()
  const error = document.getElementById('e')
  error.textContent = ''
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('p').value }),
  })
  if (res.ok) { location.href = '/'; return }
  const body = await res.json().catch(() => ({}))
  error.textContent = body.error || '密码不对。'
})
</script></body></html>`

export class WebServer {
  private server: http.Server | null = null
  private readonly tokens = new Set<string>()
  private readonly clients = new Set<http.ServerResponse>()
  private failures = new Map<string, { count: number; until: number }>()
  private indexCache: { source: string; html: string } | null = null

  constructor(private readonly deps: WebServerDeps) {}

  running(): boolean {
    return this.server !== null
  }

  /** Resolves with the failure reason rather than throwing: the port is often taken. */
  start(): Promise<{ ok: boolean; error?: string }> {
    if (this.server) return Promise.resolve({ ok: true })
    const port = this.deps.port()

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        void this.route(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
          res.end('server error')
        })
      })

      server.once('error', (err: NodeJS.ErrnoException) => {
        this.server = null
        resolve({
          ok: false,
          error:
            err.code === 'EADDRINUSE'
              ? `端口 ${port} 已被其它程序占用，请在设置里换一个端口。`
              : err.message,
        })
      })

      // 0.0.0.0: the whole point is to be reachable from other devices.
      server.listen(port, '0.0.0.0', () => {
        this.server = server
        resolve({ ok: true })
      })
    })
  }

  stop(): void {
    for (const client of this.clients) client.end()
    this.clients.clear()
    this.tokens.clear()
    this.server?.close()
    this.server = null
  }

  /** Push an event to every connected browser. */
  broadcast(type: 'messages' | 'removed' | 'status', payload: unknown): void {
    if (!this.clients.size) return
    const frame = `data: ${JSON.stringify({ type, payload })}\n\n`
    for (const client of this.clients) {
      try {
        client.write(frame)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  private authorised(req: http.IncomingMessage): boolean {
    const token = parseCookies(req.headers.cookie)[COOKIE]
    return Boolean(token) && this.tokens.has(token)
  }

  private lockedOut(ip: string): boolean {
    const entry = this.failures.get(ip)
    if (!entry) return false
    if (entry.until > Date.now()) return entry.count >= MAX_FAILURES
    this.failures.delete(ip)
    return false
  }

  private noteFailure(ip: string): void {
    const entry = this.failures.get(ip) ?? { count: 0, until: 0 }
    entry.count++
    entry.until = Date.now() + LOCKOUT_MS
    this.failures.set(ip, entry)
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    const ip = req.socket.remoteAddress ?? 'unknown'

    if (pathname === '/api/login' && req.method === 'POST') {
      if (this.lockedOut(ip)) {
        json(res, 429, { error: '密码错误次数太多，请等 10 分钟再试。' })
        return
      }
      const password = this.deps.password()
      let given = ''
      try {
        given = String((JSON.parse(await readBody(req)) as { password?: unknown }).password ?? '')
      } catch {
        given = ''
      }
      if (!password || !timingSafeEqual(given, password)) {
        this.noteFailure(ip)
        json(res, 401, { error: '密码不对。' })
        return
      }
      this.failures.delete(ip)
      const token = crypto.randomBytes(32).toString('hex')
      this.tokens.add(token)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        // Plain HTTP on a LAN, so no Secure flag — it would stop the cookie
        // being stored at all. HttpOnly still keeps it out of page scripts.
        'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Max-Age=2592000; Path=/`,
      })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (!this.authorised(req)) {
      if (pathname.startsWith('/api/')) {
        json(res, 401, { error: '请重新登录。' })
        return
      }
      html(res, 200, LOGIN_PAGE)
      return
    }

    if (pathname === '/api/invoke' && req.method === 'POST') {
      let channel = ''
      let args: unknown[] = []
      try {
        const parsed = JSON.parse(await readBody(req)) as { channel?: string; args?: unknown[] }
        channel = String(parsed.channel ?? '')
        args = Array.isArray(parsed.args) ? parsed.args : []
      } catch {
        json(res, 400, { error: 'bad request' })
        return
      }
      if (REMOTE_DENIED.has(channel)) {
        json(res, 403, { error: '这个操作只能在电脑上的软件里做。' })
        return
      }
      try {
        json(res, 200, { result: (await this.deps.invoke(channel, args)) ?? null })
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        // Proxies that buffer would delay every new message.
        'x-accel-buffering': 'no',
      })
      res.write('retry: 3000\n\n')
      this.clients.add(res)
      req.on('close', () => this.clients.delete(res))
      return
    }

    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }

    if (pathname === '/' || pathname === '/index.html') {
      try {
        html(res, 200, this.indexHtml())
      } catch {
        html(res, 500, '<p>界面文件缺失，请重新安装。</p>')
      }
      return
    }

    this.serveAsset(pathname, res)
  }

  /** dist/index.html with the web bridge injected ahead of the app bundle. */
  private indexHtml(): string {
    const source = fs.readFileSync(path.join(this.deps.distDir, 'index.html'), 'utf8')
    if (this.indexCache?.source === source) return this.indexCache.html
    const html = source.replace(
      /<script type="module"/,
      '<script src="./web-bridge.js"></script>\n    <script type="module"',
    )
    this.indexCache = { source, html }
    return html
  }

  private serveAsset(pathname: string, res: http.ServerResponse): void {
    const requested = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '')
    const file = path.resolve(this.deps.distDir, requested)
    // Never serve outside the bundle, whatever the path claims to be.
    if (file !== path.resolve(this.deps.distDir) && !file.startsWith(path.resolve(this.deps.distDir) + path.sep)) {
      json(res, 403, { error: 'forbidden' })
      return
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      json(res, 404, { error: 'not found' })
      return
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  }
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function html(res: http.ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}
