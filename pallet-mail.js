'use strict';

// ─── 木板邮件自动转发: Gmail API 客户端 + 规则匹配 + 拼转发邮件 ─────────────────
// 职责: OAuth 授权链接 / code 换 token / 续期、列邮件、取邮件正文和附件、用连接的
// Gmail 账号发出转发邮件; 判断一封邮件命中哪些规则。不碰数据库——token 和规则的
// 持久化由 server.js 负责, 这里保持无状态、fetch 可注入便于单测。
//
// 需要的 Google 权限: gmail.readonly (读邮件) + gmail.send (以这个账号发转发)。
// Google Cloud 里建 OAuth 客户端 (Web application), 回调地址填
// <BASE_URL>/gmail/oauth/callback。公司用 Google Workspace 的话 OAuth 同意屏幕选
// Internal, 不用 Google 审核, refresh token 也不会 7 天过期。

const MailComposer = require('nodemailer/lib/mail-composer');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD_API = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';

function authorizeUrl({ clientId, redirectUri, state, loginHint }) {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent',
    include_granted_scopes: 'true', state,
  });
  if (loginHint) q.set('login_hint', loginHint);
  return AUTH_URL + '?' + q.toString();
}

async function _tokenReq(params, fetchImpl) {
  const r = await (fetchImpl || fetch)(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const e = new Error(j.error_description || j.error || ('HTTP ' + r.status));
    e.code = j.error || '';
    throw e;
  }
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token || '',
    expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    scope: j.scope || '',
  };
}
function exchangeCode({ clientId, clientSecret, redirectUri, code }, fetchImpl) {
  return _tokenReq({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code, grant_type: 'authorization_code' }, fetchImpl);
}
function refreshToken({ clientId, clientSecret, refreshToken: rt }, fetchImpl) {
  return _tokenReq({ client_id: clientId, client_secret: clientSecret, refresh_token: rt, grant_type: 'refresh_token' }, fetchImpl);
}

async function gmail(token, path, opts = {}, fetchImpl) {
  const r = await (fetchImpl || fetch)((opts.upload ? UPLOAD_API : API) + path, {
    method: opts.method || 'GET',
    headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    body: opts.body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((j.error && (j.error.message || j.error.status)) || ('Gmail HTTP ' + r.status));
    e.status = r.status;
    throw e;
  }
  return j;
}
const profile = (token, f) => gmail(token, '/profile', {}, f);
const listLabels = (token, f) => gmail(token, '/labels', {}, f).then(j => j.labels || []);
async function listMessageIds(token, q, max, f) {
  const out = [];
  let pageToken = '';
  do {
    const p = new URLSearchParams({ q, maxResults: String(Math.min(100, max - out.length)) });
    if (pageToken) p.set('pageToken', pageToken);
    const j = await gmail(token, '/messages?' + p.toString(), {}, f);
    (j.messages || []).forEach(m => out.push(m.id));
    pageToken = j.nextPageToken || '';
  } while (pageToken && out.length < max);
  return out;
}
function getMessageMeta(token, id, f) {
  const p = new URLSearchParams({ format: 'metadata' });
  ['From', 'To', 'Cc', 'Subject', 'Date'].forEach(h => p.append('metadataHeaders', h));
  return gmail(token, `/messages/${encodeURIComponent(id)}?` + p.toString(), {}, f);
}
const getMessageFull = (token, id, f) => gmail(token, `/messages/${encodeURIComponent(id)}?format=full`, {}, f);
const getAttachment = (token, msgId, attId, f) => gmail(token, `/messages/${encodeURIComponent(msgId)}/attachments/${encodeURIComponent(attId)}`, {}, f);
// 走上传接口发原始 MIME (最大 35MB), 普通 JSON 接口只收 5MB 左右
function sendRaw(token, rawBuffer, f) {
  return gmail(token, '/messages/send?uploadType=media', {
    method: 'POST', upload: true, headers: { 'Content-Type': 'message/rfc822' }, body: rawBuffer,
  }, f);
}

const b64url = s => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function header(msg, name) {
  const hs = (msg && msg.payload && msg.payload.headers) || [];
  const h = hs.find(x => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value || '') : '';
}
// "GOFO Billing <Billing@GoFo.com>" → "billing@gofo.com"
function emailOf(s) {
  const m = String(s || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(s || '')).trim().toLowerCase();
}
function splitList(s) {
  return String(s || '').split(/[,，;；\n]+/).map(x => x.trim()).filter(Boolean);
}
function isEmail(s) { return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(String(s || '').trim()); }

// 一条规则命中: 发件人在名单里 (完整邮箱, 或 @域名 / 域名) 或 主题 / 摘要里有关键词。
// 返回命中原因, 没命中返回 ''。
function ruleMatch(rule, m) {
  if (!rule || !rule.active) return '';
  const from = emailOf(m.from);
  const dom = from.split('@')[1] || '';
  for (const raw of splitList(rule.senders)) {
    const s = raw.toLowerCase().replace(/^.*<|>.*$/g, '');
    if (s.includes('@') && !s.startsWith('@')) { if (from === s) return '发件人 ' + s; }
    else {
      const d = s.replace(/^@/, '');
      if (d && (dom === d || dom.endsWith('.' + d))) return '发件人域名 ' + d;
    }
  }
  const hay = (String(m.subject || '') + ' \n' + String(m.snippet || '')).toLowerCase();
  for (const k of splitList(rule.keywords)) {
    if (hay.includes(k.toLowerCase())) return '关键词 ' + k;
  }
  return '';
}
// 一封邮件 → 命中的规则 (规则只管它建好之后收到的邮件, 免得新建规则把几天前的旧邮件全转一遍)。
// 都没命中但带了指定的 Gmail 标签 → 用默认收件人。返回 { rules:[{rule,reason}], to:[], byLabel }
function matchMessage(m, rules, { labelId, defaultTo, labelSince } = {}) {
  const hits = [];
  for (const r of rules || []) {
    const since = Date.parse(r.created_at ? String(r.created_at).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(r.created_at) ? '' : 'Z') : '') || 0;
    if (since && m.internalDate && Number(m.internalDate) < since) continue;
    const why = ruleMatch(r, m);
    if (why) hits.push({ rule: r, reason: why });
  }
  const to = [];
  const add = e => { const v = String(e || '').trim(); if (isEmail(v) && !to.some(x => x.toLowerCase() === v.toLowerCase())) to.push(v); };
  hits.forEach(h => splitList(h.rule.forward_to).forEach(add));
  let byLabel = false;
  if (!hits.length && labelId && (m.labelIds || []).includes(labelId)
    && !(labelSince && m.internalDate && Number(m.internalDate) < labelSince)) {
    splitList(defaultTo).forEach(add);
    byLabel = to.length > 0;
  }
  return { rules: hits, to, byLabel };
}

// 从 format=full 的 payload 里取正文 (text / html) 和附件 (含内嵌图片)
function walkParts(payload) {
  const out = { text: '', html: '', attachments: [] };
  const visit = p => {
    if (!p) return;
    const mime = String(p.mimeType || '').toLowerCase();
    const fname = p.filename || '';
    const hdr = n => { const h = (p.headers || []).find(x => String(x.name).toLowerCase() === n); return h ? String(h.value || '') : ''; };
    if (p.parts && p.parts.length) { p.parts.forEach(visit); return; }
    const body = p.body || {};
    if (!fname && mime === 'text/plain' && body.data && !out.text) { out.text = b64url(body.data).toString('utf8'); return; }
    if (!fname && mime === 'text/html' && body.data && !out.html) { out.html = b64url(body.data).toString('utf8'); return; }
    if (body.attachmentId || (fname && body.data)) {
      out.attachments.push({
        filename: fname || 'attachment', mimeType: mime || 'application/octet-stream',
        attachmentId: body.attachmentId || '', data: body.data || '', size: body.size || 0,
        cid: hdr('content-id').replace(/^<|>$/g, ''),
        inline: /^inline/i.test(hdr('content-disposition')),
      });
    }
  };
  visit(payload);
  return out;
}
const escHtml = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 拼一封「转发」邮件 (原邮件头 + 原正文 + 原附件), 返回 RFC822 Buffer
function buildForward({ from, to, note, original, attachments }) {
  const o = original || {};
  const headBlock = [
    '---------- Forwarded message ---------',
    'From: ' + (o.from || ''),
    'Date: ' + (o.date || ''),
    'Subject: ' + (o.subject || ''),
    'To: ' + (o.to || ''),
    o.cc ? 'Cc: ' + o.cc : '',
  ].filter(Boolean);
  const noteTxt = note ? note + '\n\n' : '';
  const text = noteTxt + headBlock.join('\n') + '\n\n' + (o.text || (o.html ? String(o.html).replace(/<[^>]+>/g, ' ') : ''));
  const html = (note ? `<div style="color:#555;font-size:12px">${escHtml(note)}</div><br>` : '')
    + `<div style="color:#555">${headBlock.map(escHtml).join('<br>')}</div><br>`
    + (o.html || `<pre style="white-space:pre-wrap;font-family:inherit">${escHtml(o.text || '')}</pre>`);
  const subj = String(o.subject || '');
  const mail = new MailComposer({
    from, to: (to || []).join(', '),
    subject: /^\s*(fwd?|转发)\s*[:：]/i.test(subj) ? subj : 'Fwd: ' + subj,
    text, html,
    attachments: (attachments || []).map(a => ({
      filename: a.filename, contentType: a.mimeType, content: a.content,
      ...(a.cid ? { cid: a.cid } : {}),
    })),
  });
  return new Promise((resolve, reject) => mail.compile().build((err, buf) => err ? reject(err) : resolve(buf)));
}

// 取原邮件完整内容并转发给 to; 返回 Gmail 发出的那封的 id
async function forwardMessage(token, { msgId, from, to, note }, f) {
  const full = await getMessageFull(token, msgId, f);
  const parts = walkParts(full.payload);
  const atts = [];
  for (const a of parts.attachments) {
    let data = a.data;
    if (!data && a.attachmentId) data = (await getAttachment(token, msgId, a.attachmentId, f)).data || '';
    atts.push({ ...a, content: b64url(data) });
  }
  const raw = await buildForward({
    from, to, note,
    original: {
      from: header(full, 'From'), to: header(full, 'To'), cc: header(full, 'Cc'),
      date: header(full, 'Date'), subject: header(full, 'Subject'), text: parts.text, html: parts.html,
    },
    attachments: atts,
  });
  const sent = await sendRaw(token, raw, f);
  return sent.id || '';
}

module.exports = {
  SCOPES, authorizeUrl, exchangeCode, refreshToken,
  profile, listLabels, listMessageIds, getMessageMeta, getMessageFull, forwardMessage,
  header, emailOf, splitList, isEmail, ruleMatch, matchMessage, walkParts, buildForward,
};
