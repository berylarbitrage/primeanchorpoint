/*
 * `window.sms` for browsers on the LAN.
 *
 * The desktop app gets this object from the Electron preload over IPC. When the
 * same bundle is served over HTTP (see electron/web/server.ts), this classic
 * script runs first and installs an identical surface backed by fetch + SSE, so
 * the React app never learns which one it is talking to.
 *
 * Kept as plain JS in public/ on purpose: it must not go through the bundler,
 * because it has to be in place before the app module executes.
 */
;(function () {
  async function invoke(channel, ...args) {
    const res = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, args }),
    })
    if (res.status === 401) {
      // The session expired; the login page is what the server serves at /.
      location.reload()
      throw new Error('请重新登录。')
    }
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `请求失败（${res.status}）`)
    return body.result
  }

  // One event stream feeds every subscriber, reconnecting on its own.
  const listeners = { messages: new Set(), removed: new Set(), status: new Set() }
  const source = new EventSource('/api/events')
  source.onmessage = (event) => {
    let frame
    try {
      frame = JSON.parse(event.data)
    } catch {
      return
    }
    for (const cb of listeners[frame.type] ?? []) {
      try {
        cb(frame.payload)
      } catch {
        /* a broken listener must not stop the others */
      }
    }
  }

  function subscribe(type, cb) {
    listeners[type].add(cb)
    return () => listeners[type].delete(cb)
  }

  /*
   * `navigator.clipboard` needs a secure context, and a LAN page is plain HTTP.
   * The old execCommand path still works there, and copying is worth keeping.
   */
  function copyText(text) {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    try {
      document.execCommand('copy')
    } finally {
      document.body.removeChild(area)
    }
    return Promise.resolve()
  }

  window.sms = {
    listDevices: (adbPath) => invoke('devices:list', adbPath),
    browseForAdb: async () => ({
      path: null,
      error: '浏览文件只能在电脑上的软件里做。',
    }),
    selectDevice: (serial) => invoke('devices:select', serial),

    pairWireless: async () => ({ ok: false, message: '无线配对请在电脑上的软件里做。' }),
    connectWireless: async () => ({ ok: false, message: '无线连接请在电脑上的软件里做。' }),
    disconnectWireless: async () => ({ ok: false, message: '请在电脑上的软件里断开。' }),
    enableWirelessOverUsb: async () => ({ ok: false, message: '请在电脑上的软件里操作。' }),

    listMessages: () => invoke('sms:list'),
    sync: (mode) => invoke('sms:sync', mode),
    send: (to, body) => invoke('sms:send', to, body),
    markThreadRead: (peer) => invoke('sms:markThreadRead', peer),
    markThreadUnread: (peer) => invoke('sms:markThreadUnread', peer),
    markAllRead: () => invoke('sms:markAllRead'),
    deleteMessages: (ids) => invoke('sms:delete', ids),
    deleteConversation: (peer) => invoke('sms:deleteThread', peer),
    setPinned: (peer, pinned) => invoke('sms:setPinned', peer, pinned),

    listContacts: (refresh) => invoke('contacts:list', refresh),
    dial: (number) => invoke('phone:dial', number),
    copyText,

    readAttachment: (messageId, partId) => invoke('mms:readAttachment', messageId, partId),

    retranslate: (ids) => invoke('translate:retry', ids),
    translateDraft: (text) => invoke('translate:draft', text),

    getSettings: () => invoke('settings:get'),
    setSettings: (patch) => invoke('settings:set', patch),
    setApiKey: async () => {
      throw new Error('API key 只能在电脑上的软件里填。')
    },

    getStatus: () => invoke('status:get'),

    onMessages: (cb) => subscribe('messages', cb),
    onRemoved: (cb) => subscribe('removed', cb),
    onStatus: (cb) => subscribe('status', cb),
  }
})()
