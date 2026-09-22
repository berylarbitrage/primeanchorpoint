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

module.exports = {
  apiHost, authorizeUrl, exchangeCode, refreshTokens, apiGet,
  tokenInfo, companyInfo, listContractors, listContractorPayments,
  contractorDisplayName, normalizePayment, chunkRanges,
};
