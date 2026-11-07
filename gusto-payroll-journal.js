'use strict';

// ─── Gusto「Payroll Journal」报告解析 (美国 W-2 员工工资单) ─────────────────────
// Gusto 后台 Reports → Payroll Journal 导出的 CSV:
//   抬头几行 (公司名 / 地址) → "Payroll Journal Summary by Employee" 全年汇总表 (跳过)
//   → "Employee Earnings" 后面按每次发薪一段:
//       "Regular" / "Off-Cycle" / "Tax reconciliation" … (发薪类型)
//       "Pay period"," 06/29/2026 - 07/12/2026"   (Tax reconciliation 没有这一行)
//       "Pay day"," 07/21/2026"
//       表头行 (Last Name, First Name, …, Gross Earnings, …, Net Pay, …)
//       每个员工一行
//       "Payroll Totals" 行 (该段结束)
// 输出每个「员工 × 一次发薪」一条, 金额都按报告原样 (不重算)。纯函数, 不碰数据库。

const { parseCsv } = require('./gusto-pay');

const _key = h => String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
const _num = v => {
  let s = String(v == null ? '' : v).trim().replace(/[$,\s]/g, '');
  if (!s) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round((neg ? -n : n) * 100) / 100;
};
// "07/21/2026" → "2026-07-21"
const _iso = v => {
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
};

// 这几个「(Amount)」列以外的金额列都算其他收入项 (PTO / Holiday / Commission …), 记到底薪那块
const _SKIP_AMOUNT_COLS = new Set(['regular (amount)', 'overtime (amount)']);

function parsePayrollJournalCsv(csvText) {
  const rows = parseCsv(String(csvText || '').replace(/^﻿/, ''));
  if (!rows.some(r => _key(r[0]) === 'last name' && r.map(_key).includes('gross earnings') && r.map(_key).includes('net pay'))) {
    throw new Error('这不是 Gusto 的 Payroll Journal 工资单报告（找不到 Last Name / Gross Earnings / Net Pay 表头）。请在 Gusto → Reports → Payroll Journal 导出 CSV。');
  }
  const out = [];
  let runType = '', period = '', payDay = '', hdr = null, hdrRaw = [];
  for (const r of rows) {
    const c0 = String(r[0] || '').trim(), k0 = _key(c0);
    const rest = r.slice(1).some(x => String(x || '').trim());
    if (k0 === 'pay period') { period = String(r[1] || '').trim(); continue; }
    if (k0 === 'pay day') { payDay = String(r[1] || '').trim(); continue; }
    if (k0 === 'last name') { hdr = r.map(_key); hdrRaw = r.map(x => String(x || '').trim()); continue; }
    if (k0 === 'payroll totals' || k0 === 'totals') { hdr = null; runType = ''; period = ''; payDay = ''; continue; }
    // 只有第一格有字的行: 段落标题 (Regular / Off-Cycle / Tax reconciliation / Employee Earnings …)
    if (c0 && !rest) { if (!hdr) runType = c0; continue; }
    // 没有发薪日的表 (最上面的全年汇总) 不要
    if (!hdr || !payDay || !c0) continue;
    const g = name => { const i = hdr.indexOf(name); return i >= 0 ? r[i] : ''; };
    const last = c0, first = String(g('first name') || '').trim();
    const pd = _iso(payDay);
    const pm = period.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
    const others = [];
    hdr.forEach((h, i) => {
      const m = h.match(/^(.+) \(amount\)$/);
      if (!m || _SKIP_AMOUNT_COLS.has(h)) return;
      const amt = _num(r[i]);
      if (!amt) return;
      const hrs = _num(r[hdr.indexOf(`${m[1]} (hours)`)]);
      others.push({ label: hdrRaw[i].replace(/\s*\(Amount\)\s*$/i, ''), amount: amt, hours: hrs });
    });
    const rec = {
      last_name: last, first_name: first,
      name: [first, last].filter(Boolean).join(' '),
      run_type: runType || 'Regular',
      pay_day: pd, pay_day_raw: payDay,
      period_raw: period, period_start: pm ? _iso(pm[1]) : '', period_end: pm ? _iso(pm[2]) : '',
      regular_hours: _num(g('regular (hours)')), regular_amount: _num(g('regular (amount)')), regular_rate: _num(g('regular (rate)')),
      ot_hours: _num(g('overtime (hours)')), ot_amount: _num(g('overtime (amount)')), ot_rate: _num(g('overtime (rate)')),
      bonus: _num(g('bonus')),
      other_earnings: others,
      gross: _num(g('gross earnings')),
      k401_employee: _num(g('vestwell pretax 401k (employee deduction)')),
      k401_company: _num(g('vestwell pretax 401k (company contribution)')),
      employee_taxes: _num(g('employee taxes')),
      fed_tax: _num(g('federal income tax (employee)')),
      ss_employee: _num(g('social security (employee)')),
      medicare_employee: _num(g('medicare (employee)')) + _num(g('additional medicare (employee)')),
      state_tax: _num(g('il state income tax (employee)')),
      employer_taxes: _num(g('employer taxes')),
      reimbursement: Math.round((_num(g('reimbursements')) + _num(g('one time reimbursement'))) * 100) / 100,
      net_pay: _num(g('net pay')),
      check_amount: _num(g('check amount')),
      employer_cost: _num(g('employer cost')),
      employee_type: String(g('employee type') || '').trim(),
      payment: String(g('payment') || '').trim(),
    };
    // 其他州的州税列 (XX State Income Tax) 也算进州税
    hdr.forEach((h, i) => { if (/ state income tax \(employee\)$/.test(h) && h !== 'il state income tax (employee)') rec.state_tax += _num(r[i]); });
    rec.state_tax = Math.round(rec.state_tax * 100) / 100;
    // 0 工资 (这次没发) / 税务调整 (只有几分钱雇主税) 不算一笔工资
    rec.skip = !(rec.gross > 0 || rec.reimbursement > 0);
    out.push(rec);
  }
  return out;
}

// 名字比较: 不分大小写 / 重音 / 姓名顺序 ("Siqi Fang" = "Fang Siqi")
function nameKey(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, ' ').trim().split(' ').filter(Boolean).sort().join(' ');
}

module.exports = { parsePayrollJournalCsv, nameKey };
