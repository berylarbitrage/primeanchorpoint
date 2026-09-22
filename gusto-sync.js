'use strict';

// ─── Gusto API 客户端 (App Integration OAuth2) ─────────────────────────────────
// 职责: OAuth 授权链接 / code 换 token / 续期、拉公司信息、合同工名册、合同工
// 付款记录（谁、哪天、怎么付的、付了多少）。不碰数据库——token 的持久化由调用方
// (server.js) 负责, 这里保持无状态、可注入 fetch 便于单测。
//
// 环境: production → https://api.gusto.com; demo → https://api.gusto-demo.com。
// 用户在 dev.gusto.com 建应用拿 client_id/secret, 先在 demo 联调, 应用过审后切
// production。请求不带 X-Gusto-API-Version 头, 走应用在开发者后台配置的默认版本,
// 免得写死一个应用不支持的版本号。
//
// Gusto 的 refresh token 是一次性的: 每次续期返回新的一对, 旧的立刻作废。所以
// 续期必须串行、拿到新 token 后第一时间落库(server.js 里有锁), 否则并发续期会把
// 唯一有效的 refresh token 用废, 只能让用户重新授权。

const crypto = require('crypto');
const { parseCsv } = require('./gusto-pay');

const HOSTS = { production: 'https://api.gusto.com', demo: 'https://api.gusto-demo.com' };
// GUSTO_API_BASE 环境变量可整体指到别处（本地 mock 联调用）, 生产不用设
function apiHost(environment) {
  return process.env.GUSTO_API_BASE || HOSTS[environment === 'demo' ? 'demo' : 'production'];
}

// 金额字段 Gusto 一律给字符串（"740.00"）; 容错 $ 和千分位。
function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

function authorizeUrl({ environment, clientId, redirectUri, state }) {
  const u = new URL(apiHost(environment) + '/oauth/authorize');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

async function tokenRequest(environment, body, fetchImpl) {
  const f = fetchImpl || fetch;
  const res = await f(apiHost(environment) + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch (e) { /* 保留原文进错误信息 */ }
  if (!res.ok || !j.access_token) {
    const err = new Error(`Gusto OAuth ${res.status}: ${(j.error_description || j.error || text || '').slice(0, 300)}`);
    err.status = res.status;
    err.gusto_error = j.error || '';
    throw err;
  }
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token || '',
    // 提前 2 分钟视为过期, 抵消时钟误差和请求耗时
    expires_at: Date.now() + Math.max(60, (Number(j.expires_in) || 7200) - 120) * 1000,
  };
}

function exchangeCode({ environment, clientId, clientSecret, redirectUri, code, fetchImpl }) {
  return tokenRequest(environment, {
    client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, code, grant_type: 'authorization_code',
  }, fetchImpl);
}

function refreshTokens({ environment, clientId, clientSecret, redirectUri, refreshToken, fetchImpl }) {
  return tokenRequest(environment, {
    client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, refresh_token: refreshToken, grant_type: 'refresh_token',
  }, fetchImpl);
}

async function apiGet(environment, accessToken, path, fetchImpl) {
  const f = fetchImpl || fetch;
  const res = await f(apiHost(environment) + path, {
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' },
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* 下面报错带原文 */ }
  if (!res.ok) {
    const err = new Error(`Gusto API ${res.status} ${path}: ${String(text || '').slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return j;
}

// token 属于哪家公司（授权完成后确定 company_uuid 用）
async function tokenInfo(environment, accessToken, fetchImpl) {
  const j = await apiGet(environment, accessToken, '/v1/token_info', fetchImpl) || {};
  const r = j.resource || {};
  return {
    resource_type: String(r.kind || r.type || ''),
    company_uuid: String(r.uuid || j.company_uuid || ''),
    scope: String(j.scope || ''),
  };
}

async function companyInfo(environment, accessToken, companyUuid, fetchImpl) {
  const j = await apiGet(environment, accessToken, `/v1/companies/${encodeURIComponent(companyUuid)}`, fetchImpl) || {};
  return { uuid: String(j.uuid || companyUuid), name: String(j.trade_name || j.name || j.legal_name || '') };
}

// 合同工名册（分页拉全; is_active=false 的也要——离职的人历史付款还在）
async function listContractors(environment, accessToken, companyUuid, fetchImpl) {
  const out = [];
  for (let page = 1; page <= 25; page++) {
    const j = await apiGet(environment, accessToken,
      `/v1/companies/${encodeURIComponent(companyUuid)}/contractors?page=${page}&per=100`, fetchImpl);
    const arr = Array.isArray(j) ? j : (Array.isArray(j && j.contractors) ? j.contractors : []);
    for (const c of arr) {
      out.push({
        uuid: String(c.uuid || c.id || ''),
        type: String(c.type || ''),
        first_name: String(c.first_name || ''),
        last_name: String(c.last_name || ''),
        business_name: String(c.business_name || ''),
        wage_type: String(c.wage_type || ''),
        hourly_rate: num(c.hourly_rate),
        is_active: c.is_active === false ? 0 : 1,
        raw: c,
      });
    }
    if (arr.length < 100) break;
  }
  return out.filter(c => c.uuid);
}

function contractorDisplayName(c) {
  const business = String(c.business_name || '').trim();
  if (business) return business;
  return `${String(c.last_name || '').trim()}, ${String(c.first_name || '').trim()}`.replace(/^, |, $/g, '');
}

// 一笔付款归一化。分组形状里 contractor_uuid 在外层, 传进来兜底。
function normalizePayment(p, contractorUuid) {
  const wage = num(p.wage);
  const bonus = num(p.bonus);
  const reimb = num(p.reimbursement);
  let total = num(p.wage_total);
  if (total == null) total = r2((wage || 0) + (bonus || 0) + (reimb || 0));
  return {
    uuid: String(p.uuid || p.id || ''),
    contractor_uuid: String(p.contractor_uuid || p.contractor_id || contractorUuid || ''),
    date: String(p.date || p.check_date || '').slice(0, 10),
    payment_method: String(p.payment_method || ''),
    wage_type: String(p.wage_type || ''),
    status: String(p.status || ''),
    hours: num(p.hours),
    hourly_rate: num(p.hourly_rate),
    wage: wage == null ? 0 : wage,
    bonus: bonus == null ? 0 : bonus,
    reimbursement: reimb == null ? 0 : reimb,
    wage_total: total == null ? 0 : total,
    raw: p,
  };
}

// 一段日期范围内的合同工付款, 摊平成一维数组。
// 响应兼容两种形状:
//   ① { contractor_payments: [{contractor_uuid, payments: [...]}] }（分组汇总）
//   ② { contractor_payments: [ {uuid, date, ...} ] } 或直接数组（逐笔平铺）
async function listContractorPayments(environment, accessToken, companyUuid, startDate, endDate, fetchImpl) {
  const j = await apiGet(environment, accessToken,
    `/v1/companies/${encodeURIComponent(companyUuid)}/contractor_payments?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`,
    fetchImpl);
  const groups = Array.isArray(j) ? j : (Array.isArray(j && j.contractor_payments) ? j.contractor_payments : []);
  const out = [];
  for (const g of groups) {
    if (g && Array.isArray(g.payments)) {
      for (const p of g.payments) out.push(normalizePayment(p, g.contractor_uuid || g.contractor_id));
    } else if (g && (g.uuid || g.id) && (g.date || g.check_date)) {
      out.push(normalizePayment(g, g.contractor_uuid || g.contractor_id));
    }
  }
  return out.filter(p => p.uuid);
}

// 日期范围按 90 天分块（Gusto 对超长范围可能拒绝; 分块也让单次响应可控）。
// 输入输出都是 YYYY-MM-DD。
function chunkRanges(startDate, endDate, days) {
  const span = Math.max(1, days || 90);
  const toStr = d => d.toISOString().slice(0, 10);
  let s = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  if (!(s instanceof Date) || isNaN(s) || isNaN(end) || s > end) return [[startDate, endDate]];
  const out = [];
  while (s <= end) {
    const e = new Date(s.getTime() + (span - 1) * 86400000);
    out.push([toStr(s), toStr(e > end ? end : e)]);
    s = new Date(e.getTime() + 86400000);
  }
  return out;
}

// ─── Gusto 付款报告导入（API production 过审前的过渡） ────────────────────────
// Gusto 后台 Reports 导出的合同工付款报告(CSV, Excel 先由调用方转成 CSV)。
// 表头按含义模糊识别, Gusto 改列名/换报告种类也大概率能认; 认不出直接报错并
// 附上实际表头, 让用户把格式发过来适配。产出与 API 同步同构的付款行,
// uuid = 'csv:' + hash(姓名|日期|金额|方式 + 同文件内出现序号):
// 同一份/重叠的报告重复导入幂等更新, 同一天同金额的两笔真付款也不会互相吞。

function _hdrKey(h) {
  return String(h || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function _findCol(headers, candidates) {
  for (const c of candidates) { const i = headers.indexOf(c); if (i >= 0) return i; }
  return -1;
}
// 日期 → YYYY-MM-DD; 认 2026-09-15 / 9/15/2026 / 09-15-2026 / 9/15/26
function _normDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let y = parseInt(m[3], 10);
    if (m[3].length <= 2) y += y < 50 ? 2000 : 1900;
    return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  return '';
}
// 金额: "$1,234.56" / "(50.00)"=负 / 空 → null
function _reportMoney(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[()$,\s]/g, '');
  if (!s || s === '-') return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}

function parsePaymentReportCsv(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('报告是空的（没有数据行）');
  const headers = rows[0].map(_hdrKey);
  const col = {
    name: _findCol(headers, ['contractor', 'contractor name', 'name', 'payee', 'recipient', 'worker', 'employee', 'employee name']),
    first: _findCol(headers, ['first name', 'contractor first name']),
    last: _findCol(headers, ['last name', 'contractor last name']),
    business: _findCol(headers, ['business name']),
    date: _findCol(headers, ['payment date', 'check date', 'pay date', 'date', 'debit date', 'payday']),
    method: _findCol(headers, ['payment method', 'method']),
    status: _findCol(headers, ['status', 'payment status']),
    hours: _findCol(headers, ['hours', 'total hours']),
    wage: _findCol(headers, ['wages', 'wage', 'wage amount', 'regular wages']),
    bonus: _findCol(headers, ['bonus', 'bonuses']),
    reimb: _findCol(headers, ['reimbursement', 'reimbursements', 'expense reimbursement', 'expense reimbursements']),
    total: _findCol(headers, ['total', 'total amount', 'payment total', 'total payment', 'amount', 'wage total', 'total pay', 'total wages']),
  };
  const hasName = col.name >= 0 || col.last >= 0 || col.first >= 0 || col.business >= 0;
  const hasAmount = col.total >= 0 || col.wage >= 0 || col.bonus >= 0 || col.reimb >= 0;
  if (!hasName || !hasAmount) {
    throw new Error(`认不出这份报告的表头（需要收款人姓名列和金额列）。实际表头：${rows[0].map(h => String(h).trim()).filter(Boolean).join(' | ')}`);
  }
  const seen = new Map();
  const out = [], warnings = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    const get = c => (c >= 0 ? String(cells[c] == null ? '' : cells[c]).trim() : '');
    let name = get(col.name);
    if (!name) {
      const business = get(col.business);
      name = business || `${get(col.last)}, ${get(col.first)}`.replace(/^, |, $/g, '');
    }
    name = name.replace(/\s+/g, ' ').trim();
    if (!name || /^(grand )?totals?$/i.test(name)) continue;   // 汇总行不是付款
    const wage = _reportMoney(get(col.wage));
    const bonus = _reportMoney(get(col.bonus));
    const reimb = _reportMoney(get(col.reimb));
    let total = _reportMoney(get(col.total));
    if (total == null) total = Math.round(((wage || 0) + (bonus || 0) + (reimb || 0)) * 100) / 100;
    if (!total) continue;                                       // 没金额的行(分组标题等)跳过; 负数=冲正, 保留
    const date = _normDate(get(col.date));
    if (!date) {
      warnings.push(`第 ${i + 1} 行「${name}」付款日期认不出来（原文：${get(col.date) || '空'}），这行没导入。`);
      continue;
    }
    const method = get(col.method);
    const dupKey = [name.toLowerCase(), date, total.toFixed(2), method.toLowerCase()].join('|');
    const nth = seen.get(dupKey) || 0;
    seen.set(dupKey, nth + 1);
    out.push({
      uuid: 'csv:' + crypto.createHash('sha1').update(dupKey + '#' + nth).digest('hex'),
      contractor_uuid: '',
      contractor_name: name,
      date,
      payment_method: method,
      wage_type: '',
      status: get(col.status),
      hours: _reportMoney(get(col.hours)),
      hourly_rate: null,
      wage: wage == null ? 0 : wage,
      bonus: bonus == null ? 0 : bonus,
      reimbursement: reimb == null ? 0 : reimb,
      wage_total: total,
      raw: Object.fromEntries(rows[0].map((h, c) => [String(h).trim(), String(cells[c] == null ? '' : cells[c])]).filter(([k]) => k)),
    });
  }
  if (!out.length) throw new Error('报告里没有一行可导入的付款（都没有金额或日期）。' + (warnings[0] || ''));
  return { payments: out, warnings };
}

module.exports = {
  apiHost, authorizeUrl, exchangeCode, refreshTokens, apiGet,
  tokenInfo, companyInfo, listContractors, listContractorPayments,
  contractorDisplayName, normalizePayment, chunkRanges, parsePaymentReportCsv,
};
