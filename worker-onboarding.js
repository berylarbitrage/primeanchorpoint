'use strict';

// ─── 新员工入职跟踪 (/onboarding) 的纯逻辑 ─────────────────────────────────────
// 「新员工」= 名字第一次出现在正式发票工资表上的人: 有账单才说明要给他付钱。
// 这里只放不碰数据库的部分, 方便单测: 周的划分、Gusto 入职状态 → 检查清单、
// 粘贴的 Gusto 通知邮件标题解析。数据装配和路由在 server.js。

// 付款方式: gusto 要走入职检查清单; 其余只记一笔备注
const PAY_METHODS = ['gusto', 'cash', 'check', 'zelle', 'skip'];

// YYYY-MM-DD → 所在周的周一 (发票工资周期按周一开始)
function weekStart(dateStr) {
  const s = String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d)) return '';
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Gusto 合同工 onboarding_status → 走到了哪一步 (0 还没在 Gusto 建人 … 3 可以付款)。
// 1 = 已建人/发了邀请, 2 = 工人已接受邀请在填资料 (或填完等审核), 3 = 入职完成。
// 不认识的状态值不猜, 只按 onboarded 布尔值判断完成与否。
const GUSTO_STATUS = {
  admin_onboarding_incomplete: { stage: 1, label: '管理员还没填完资料' },
  self_onboarding_not_invited: { stage: 1, label: '还没发邀请' },
  self_onboarding_pending_invite: { stage: 1, label: '邀请待发送' },
  self_onboarding_invited: { stage: 1, label: '已发邀请，工人还没接受' },
  self_onboarding_invited_overdue: { stage: 1, label: '已发邀请，工人逾期未接受' },
  self_onboarding_invited_started: { stage: 2, label: '工人已接受邀请，正在填资料' },
  self_onboarding_started: { stage: 2, label: '工人已接受邀请，正在填资料' },
  self_onboarding_review: { stage: 2, label: '工人填完了，等管理员审核' },
  self_onboarding_awaiting_admin_review: { stage: 2, label: '工人填完了，等管理员审核' },
  self_onboarding_completed_by_contractor: { stage: 2, label: '工人填完了，等管理员审核' },
  admin_onboarding_review: { stage: 2, label: '等管理员审核' },
  onboarding_completed: { stage: 3, label: '入职完成，可以付款' },
};
function gustoStage(raw) {
  raw = raw || {};
  const st = String(raw.onboarding_status || '');
  const known = GUSTO_STATUS[st];
  if (raw.onboarded === true || st === 'onboarding_completed') return { stage: 3, status: st, label: GUSTO_STATUS.onboarding_completed.label };
  if (known) return { stage: known.stage, status: st, label: known.label };
  return { stage: 1, status: st, label: st ? `Gusto 状态: ${st}` : '已在 Gusto 名册' };
}

// ── Gusto 通知邮件标题 ──
// 支持直接从 Gmail 列表复制一整屏: 每行可能带「Gusto 2 收件箱」前缀和「 - Gusto. 正文…  10月21日」尾巴。
const EMAIL_PATTERNS = [
  { kind: 'accepted', re: /^(.+?) accepted your offer at /i },
  { kind: 'ready', re: /^(.+?) from .+? can now be paid/i },
  { kind: 'bank_bad', re: /^(.+?)[’'`]s bank account details (?:are|were) incorrect/i },
  { kind: 'bank_updated', re: /^(.+?)[’'`]s bank account details were updated/i },
];
const EMAIL_KIND_LABEL = {
  accepted: '接受了邀请', ready: '可以付款了 (入职完成)',
  bank_bad: '银行信息有误', bank_updated: '银行信息已更新',
};
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// 邮件列表上的日期只有月日 (「10月21日」/「Oct 21」), 年份按 today 推: 比今天晚的算去年
function _emailDate(line, today) {
  let m = line.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  let mo, dd;
  if (m) { mo = +m[1]; dd = +m[2]; }
  else if ((m = line.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (\d{1,2})\b/i))) { mo = MONTHS[m[1].toLowerCase().slice(0, 3)]; dd = +m[2]; }
  const iso = (line.match(/\b(\d{4}-\d{2}-\d{2})\b/) || [])[1];
  if (iso) return iso;
  if (!mo || !dd) return '';
  const t = String(today || new Date().toISOString()).slice(0, 10);
  let y = +t.slice(0, 4);
  const pad = n => String(n).padStart(2, '0');
  if (`${y}-${pad(mo)}-${pad(dd)}` > t) y--;
  return `${y}-${pad(mo)}-${pad(dd)}`;
}

function parseGustoEmails(text, today) {
  const out = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    // 去掉 Gmail 列表的「发件人 [数量] 收件箱/Inbox」前缀
    const subj = line.replace(/^.*?(?:收件箱|Inbox)\s*/i, '').replace(/^Gusto\s*\d*\s+/i, '').replace(/^(?:Subject|主题)\s*[:：]\s*/i, '');
    for (const p of EMAIL_PATTERNS) {
      const m = subj.match(p.re);
      if (!m) continue;
      const name = m[1].replace(/^["“]|["”]$/g, '').trim();
      if (name && name.length <= 80) out.push({ kind: p.kind, name, date: _emailDate(line, today), subject: subj.split(' - ')[0].slice(0, 200) });
      break;
    }
  }
  return out;
}

// 名字分词: 小写、去重音、只留字母 (和 gusto-pay.js 的口径一致, 这里不依赖它免得循环引用)
function nameWords(n) {
  return String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z]+/).filter(w => w.length >= 2 && !['jr', 'sr', 'ii', 'iii'].includes(w));
}
// 邮件里的名字 ↔ 候选人: 邮件名的每个词都出现在候选人名字里 (邮件常只写名不写姓)。
// candidates: [{key, names: [...]}]; 只有唯一命中才算, 多个命中返回 ambiguous。
function matchEmailName(name, candidates) {
  const w = nameWords(name);
  if (!w.length) return { hits: [] };
  const full = [], partial = [];
  for (const c of candidates) {
    let best = 0;
    for (const n of c.names || []) {
      const cw = new Set(nameWords(n));
      if (!cw.size) continue;
      const inter = w.filter(x => cw.has(x)).length;
      if (inter === w.length && inter === cw.size) best = Math.max(best, 2);
      else if (inter === w.length) best = Math.max(best, 1);
      // 反过来: 发票上写得短 (两个词), 邮件是 Gusto 里的全名
      else if (inter === cw.size && cw.size >= 2) best = Math.max(best, 1);
    }
    if (best === 2) full.push(c.key); else if (best === 1) partial.push(c.key);
  }
  const hits = full.length ? full : partial;
  return { hits: [...new Set(hits)] };
}

// ── Gusto 入职检查清单 ──
// 每一步: auto = 系统看出来做完了 (Gusto API / 邮件 / 付款记录), manual = 有人手动勾了。
// 两者有一个就算完成; bank 一步是「有没有问题」, 有未处理的银行错误邮件就标红。
// 三步, 按顺序: ① 我们这边 (admin / manager) 在 Gusto 加人发邀请, 手动打勾 (Gusto 名册里已经有这个人也算);
// ② 工人接受邀请 (邮件「accepted your offer」/ Gusto API); ③ 工人入职完成 (邮件「can now be paid」/ Gusto API / 已付过款)。
// 后两步也能手动勾 (邮件漏了的时候), 前一步没完成后一步不能勾。银行信息的邮件不在清单里, 单独做成提醒。
const GUSTO_STEPS = [
  { id: 'added', label: '在 Gusto 添加合同工并发邀请', hint: 'Gusto → People → Add contractor，填姓名和邮箱/电话发邀请；做完回来打勾' },
  { id: 'accepted', label: '工人接受邀请', hint: '邮件「… accepted your offer」' },
  { id: 'ready', label: '工人入职完成', hint: '邮件「… can now be paid」' },
];

// ctx: { contractor: {raw}|null, emails: [{kind,date}], manual: {step: {at,by}}, firstPayment: 'YYYY-MM-DD'|'' }
function buildChecklist(ctx) {
  ctx = ctx || {};
  const g = ctx.contractor ? gustoStage(ctx.contractor.raw) : { stage: 0, status: '', label: '' };
  const emails = (ctx.emails || []).slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const lastOf = k => emails.filter(e => e.kind === k).pop();
  const em = { accepted: lastOf('accepted'), ready: lastOf('ready') };
  const paid = String(ctx.firstPayment || '');
  const auto = {
    added: ctx.contractor ? 'Gusto 名册里有这个人' : '',
    accepted: em.accepted ? `邮件 ${em.accepted.date || ''}`.trim() : g.stage >= 2 ? 'Gusto API' : '',
    ready: em.ready ? `邮件 ${em.ready.date || ''}`.trim() : g.stage >= 3 ? 'Gusto API' : paid ? `已付款 ${paid}` : '',
  };
  // 后面的步骤做完了, 前面的自然也做完了 (例如直接收到 can now be paid)
  if (auto.ready && !auto.accepted) auto.accepted = '已入职完成';
  if ((auto.accepted || auto.ready) && !auto.added) auto.added = '工人已收到邀请';
  const manual = ctx.manual || {};
  let prevDone = true;
  const steps = GUSTO_STEPS.map(s => {
    const m = manual[s.id];
    const done = !!(auto[s.id] || m);
    const step = { ...s, auto: auto[s.id] || '', manual: m ? { at: m.at || '', by: m.by || '' } : null, done, locked: !prevDone };
    prevDone = done;
    return step;
  });
  return { steps, gusto: g, done: steps.every(s => s.done), done_count: steps.filter(s => s.done).length };
}

module.exports = {
  PAY_METHODS, GUSTO_STEPS, EMAIL_KIND_LABEL,
  weekStart, addDays, gustoStage, parseGustoEmails, nameWords, matchEmailName, buildChecklist,
};
