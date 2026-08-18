// Stubs the preload bridge so the real renderer bundle can be screenshotted
// without a phone attached. Data only — no UI code lives here.
(function () {
  const now = Date.parse('2026-08-17T20:40:00')
  const min = 60 * 1000

  function msg(o) {
    return Object.assign(
      {
        deviceSerial: 'R5CX90ABCDE',
        rawId: 0,
        threadId: 1,
        kind: 'sms',
        readOnDevice: true,
        readLocal: true,
        translationState: 'done',
      },
      o,
    )
  }

  const messages = [
    // --- A courier, in English, unread ---
    msg({
      id: 'a1', rawId: 11, threadId: 3, address: '+14155550142', peer: '4155550142',
      contact: 'DHL Express', date: now - 1180 * min, direction: 'in',
      body: 'Your parcel 7742991044 could not be delivered. Reschedule at dhl-track.co/r7f2 or it will be returned in 48h.',
      readLocal: false,
      translation: { text: '您的包裹 7742991044 投递失败。请到 dhl-track.co/r7f2 重新安排投递，否则将在 48 小时后退回。', sourceLang: 'English', targetLang: '简体中文', model: 'claude-opus-5', at: now },
      analysis: { category: 'fraud', risk: 5, summary: '假冒快递的钓鱼短信，链接域名不是 DHL 官方。', at: now },
    }),

    // --- Bank verification code ---
    msg({
      id: 'b1', rawId: 21, threadId: 4, address: 'CHASE', peer: 'CHASE',
      date: now - 96 * min, direction: 'in',
      body: 'Chase: Your verification code is 884213. Never share it. We will never call to ask for it.',
      readLocal: false,
      translation: { text: 'Chase：您的验证码是 884213。请勿泄露。我们绝不会打电话索要验证码。', sourceLang: 'English', targetLang: '简体中文', model: 'claude-opus-5', at: now },
      analysis: { category: 'verification', risk: 0, summary: '银行验证码，正常。', at: now },
    }),

    // --- A real person, Spanish, with a reply from us ---
    msg({
      id: 'c1', rawId: 31, threadId: 5, address: '+34611223344', peer: '4611223344',
      contact: 'Marta Ruiz', date: now - 300 * min, direction: 'in',
      body: '¿Podemos mover la reunión del martes a las 10? Tengo médico por la mañana.',
      translation: { text: '周二的会能不能改到 10 点？我早上要去看医生。', sourceLang: 'Español', targetLang: '简体中文', model: 'claude-opus-5', at: now },
      analysis: { category: 'personal', risk: 0, summary: '对方想把周二的会议改到 10 点。', at: now },
    }),
    msg({
      id: 'c2', rawId: 32, threadId: 5, address: '+34611223344', peer: '4611223344',
      contact: 'Marta Ruiz', date: now - 292 * min, direction: 'out',
      body: 'Sin problema, nos vemos el martes a las 10. Te envío la sala luego.',
      translation: { text: '没问题，周二 10 点见。会议室我稍后发你。', sourceLang: 'Español', targetLang: '简体中文', model: 'claude-opus-5', at: now },
    }),
    msg({
      id: 'c3', rawId: 33, threadId: 5, address: '+34611223344', peer: '4611223344',
      contact: 'Marta Ruiz', date: now - 40 * min, direction: 'in',
      body: 'Perfecto, gracias. Una cosa más: ¿traes el informe de julio impreso?',
      readLocal: false,
      translation: { text: '好的，谢谢。还有一件事：你能把七月的报告打印出来带过来吗？', sourceLang: 'Español', targetLang: '简体中文', model: 'claude-opus-5', at: now },
      analysis: { category: 'personal', risk: 0, summary: '对方请你把七月报告打印出来带上。', at: now },
    }),

    // --- Marketing ---
    msg({
      id: 'd1', rawId: 41, threadId: 6, address: '+18885550199', peer: '8885550199',
      date: now - 620 * min, direction: 'in',
      body: 'FINAL HOURS! 40% off everything + free shipping. Shop now: brnd.io/sale22. Reply STOP to opt out.',
      translation: { text: '最后几小时！全场 4 折 + 包邮。立即购买：brnd.io/sale22。回复 STOP 退订。', sourceLang: 'English', targetLang: '简体中文', model: 'claude-opus-5', at: now },
      analysis: { category: 'marketing', risk: 1, summary: '促销广告，可回复 STOP 退订。', at: now },
    }),

    // --- Still translating, to show the pending state ---
    msg({
      id: 'e1', rawId: 51, threadId: 7, address: '+81901234567', peer: '1901234567',
      contact: '田中 健', date: now - 6 * min, direction: 'in',
      body: '明日の打ち合わせ、資料は私が用意します。よろしくお願いします。',
      readLocal: false, translationState: 'pending',
    }),
  ]

  // A picture message (MMS): scam screenshot with Claude's OCR of the image.
  const FAKE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAACk0lEQVR42u3dR04DARREQY7JglPbYJvknOOYsGeuMAs0av2S6gQtvXU/NM0PEOrBBCBgQMCAgEHAgIABAQMCBgEDAgYEDAIGBAwIGBAwCBgQMPAPAY8en4BQAgYBAwIGBAwCBgQMCBgQMAgYEDAgYBAwIGBAwICAQcCAgAEBAwIGAQMCBgQMJQO+33+BUAIGAQMCBgQMZQJuml8glHdCcC8KCBgQMJQJ+Hb7AUIJGAQM9BTwNxBKwJAc8PX6DYQSMAgYEDAgYCgT8OXyBYQSMAgYEDAgYCgT8Pn8BYRqA74DoQQMAgYEDHQL+HS6A6EEDAIGegq4AUIJGJIDPh4bIJSAQcCAgAEBQ5mAD4cbEErAIGBAwICAoUzA+/0NCNUGfAVCCRgEDAgY6BbwbncFQgkYBAz0FPAFCCVgSA54u70AoQQMAgYEDAgYygS82ZyBUAIGAQMCBgQMZQJer89AqDbgExBKwCBgQMBAt4BXqxMQSsAgYKCngI9AKAFDcsDL5REIJWAQMCBgQMBQJuDF4gCEEjAIGBAwIGAoE/B8fgBCtQHvgVACBgEDAga6BTyb7YFQAgYBAz0FvANCCRiSA55Od0AoAYOAAQEDAoYyAX9+boFQAgYBAwIGBAxlAv742AKh2oA3QCgBg4ABAQPdAn5/3wChBAwCBnoKeA2EEjAkB/z2tgZCCRgEDAgYEDCUCfj1dQWEEjAIGBAwIGAoE/BksgJCtQEvgVACBgEDAga6BTweL4FQAgYBAz0FvABCCRiSAx6NFkAoAYOAAQEDAoYyAb+8zIFQAgYBAwIGBAxlAn5+ngOh2oBnQCgBg4ABAQPdAh4OZ0AoAYOAgZ4CngKhBAzJAQ8GUyCUgEHAgICBTv4ATXyechNC0aEAAAAASUVORK5CYII='
  messages.push(
    msg({
      id: 'f1', rawId: 61, threadId: 8, address: '+447700900123', peer: '7700900123',
      kind: 'mms', date: now - 22 * min, direction: 'in', readLocal: false,
      body: 'See attached invoice, payment is overdue.',
      attachments: [
        {
          partId: 9001, contentType: 'image/png', name: 'invoice.png', file: 'demo.png',
          bytes: 716,
          description: '一张伪造的缴费通知截图，顶部有红色横幅，写着账户已逾期。\n\n图中文字：URGENT — Account suspended. Pay £248.00 within 24 hours at secure-billing-uk.co/pay to avoid legal action. Ref 88213.',
        },
      ],
      translation: { text: '见附件账单，款项已逾期。\n\n（图中文字）紧急——账户已停用。请在 24 小时内到 secure-billing-uk.co/pay 支付 £248.00，否则将采取法律行动。编号 88213。', sourceLang: 'English', targetLang: '简体中文', model: 'claude-opus-5', at: now },
      analysis: { category: 'fraud', risk: 5, summary: '伪造缴费通知截图，制造紧迫感索要付款，域名不是正规机构。', at: now },
    }),
  )

  const settings = {
    adbPath: 'C:\\platform-tools\\adb.exe',
    deviceSerial: '192.168.1.42:41235',
    wirelessAddress: '192.168.1.42:41235',
    wirelessAutoReconnect: true,
    targetLanguage: '简体中文',
    outgoingLanguage: '',
    autoTranslate: true,
    classify: true,
    model: 'claude-opus-5',
    fastModel: 'claude-haiku-4-5',
    pollIntervalMs: 6000,
    autoSync: true,
    initialImportDays: 90,
    includeMms: true,
    maxAttachmentKb: 2048,
    describeImages: true,
    sendMethod: 'ui',
    sendTapDelayMs: 1500,
    batchSize: 20,
    hasApiKey: true,
    pinnedPeers: ['4155550142'],
    outgoingLanguageByPeer: { '4611223344': 'Español' },
    incomingLanguageByPeer: { '4611223344': '简体中文' },
    noAutoTranslatePeers: [],
    screenOutgoing: true,
    peerNotesAt: {},
    peerNotes: { '4611223344': { alias: 'Marta（西班牙同事）', note: '周二 10 点开会，记得带七月报告的打印件。' } },
    webEnabled: true,
    webPort: 8848,
    webPassword: 'k7m2xr9dqp',
  }

  const status = {
    phase: 'idle',
    device: { serial: '192.168.1.42:41235', state: 'device', model: 'SM_S928B', ready: true },
    lastSyncAt: now - 30 * 1000,
    pendingTranslations: 1,
  }

  // `?state=error` renders the failure the user actually hits first, so the
  // long message can be checked for readability.
  if (location.search.includes('state=error')) {
    status.phase = 'error'
    status.device = null
    status.detail =
      '手机已连上，但还没授权。请在手机屏幕上点「允许 USB 调试」，并勾选「一律允许」。'
  }

  const noop = () => () => {}
  window.sms = {
    listDevices: async () => [status.device],
    browseForAdb: async () => ({ path: null }),
    selectDevice: async () => settings,
    pairWireless: async () => ({ ok: true, message: '配对成功。' }),
    connectWireless: async () => ({ ok: true, message: '已连接。' }),
    disconnectWireless: async () => ({ ok: true, message: '已断开。' }),
    enableWirelessOverUsb: async () => ({ ok: true, message: 'ok' }),
    listMessages: async () => messages,
    readAttachment: async () => ({ dataUrl: FAKE_PNG }),
    sync: async () => ({ imported: 0 }),
    send: async () => ({ ok: true }),
    markThreadRead: async () => {},
    markThreadUnread: async () => {},
    markAllRead: async () => {},
    deleteMessages: async () => {},
    deleteConversation: async () => {},
    setPinned: async (peer, pinned) => {
      settings.pinnedPeers = pinned
        ? [...settings.pinnedPeers, peer]
        : settings.pinnedPeers.filter((p) => p !== peer)
      return settings
    },
    listContacts: async () => [
      { name: 'Marta Ruiz', number: '+34611223344' },
      { name: '王 小明', number: '+8613800138000' },
      { name: 'Ruiz, Marta（工作）', number: '+14155550142' },
    ],
    dial: async () => ({ ok: true, message: '已在手机上打开拨号界面。' }),
    copyText: async () => {},
    retranslate: async () => {},
    translateDraft: async (text, lang) => ({ text: '（译文示例）' + text, targetLang: lang || '简体中文' }),
    screenDraft: async (text) =>
      /打钱|验证码是|卡号/.test(text)
        ? { flagged: true, reason: '这条像是在把验证码或钱的事发给别人，先确认一下。', categories: ['fraud'] }
        : { flagged: false, reason: '', categories: [] },
    setOutgoingLanguage: async (peer, language) => {
      settings.outgoingLanguageByPeer = { ...settings.outgoingLanguageByPeer, [peer]: language }
      return settings
    },
    setPeerNote: async (peer, note) => {
      settings.peerNotes = { ...settings.peerNotes, [peer]: note }
      return settings
    },
    getSettings: async () => settings,
    setSettings: async () => settings,
    setApiKey: async () => settings,
    getStatus: async () => status,
    getWebStatus: async () => ({
      running: true,
      port: 8848,
      urls: ['http://192.168.1.20:8848'],
      password: 'k7m2xr9dqp',
    }),
    restartWebServer: async () => window.sms.getWebStatus(),
    regenerateWebPassword: async () => window.sms.getWebStatus(),
    onMessages: noop,
    onRemoved: noop,
    onStatus: noop,
    onSettings: noop,
  }
})()
