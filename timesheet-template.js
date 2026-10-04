'use strict';

// ─── 客户时间表模板 (可下载填写, 再上传进发票生成器) ───────────────────────────
// 两种模板, 都在第一页「Timesheet」, A1 写 "PA TIMESHEET" 作为识别标记:
//   WEEKLY — 一人一行, 一周 7 天每天一列 (和 DV Fulfillment 发来的表一样)
//            Name | Rate | OT Rate | 9/28/2026 … 10/4/2026 | TOTAL
//   DAILY  — 按日期, 一人一天一行
//            Date | Name | Rate | OT Rate | Time In | Time Out | Break (min) | Hours | Note
// 表头上方是键值行: Company / Week Start (或 Period Start / Period End) / Markup。
// 下载时按该客户最近一张发票预填员工名单、时薪、Markup; 上传时 parseTimesheetTemplate()
// 把每人每天的工时读成 days 映射, 正常/加班按每周 (周一~周日) 超 40 小时拆分。

const MARK = 'PA TIMESHEET';
const KINDS = ['weekly', 'daily'];

const r2 = n => Math.round(n * 100) / 100;
const r3 = n => Math.round(n * 1000) / 1000;
const EPOCH = Date.UTC(1899, 11, 30);
const isoToSerial = s => { const [y, m, d] = s.split('-').map(Number); return (Date.UTC(y, m - 1, d) - EPOCH) / 86400000; };
const serialToIso = n => new Date(EPOCH + Math.round(n) * 86400000).toISOString().slice(0, 10);
const addDays = (s, n) => serialToIso(isoToSerial(s) + n);
const pad2 = n => String(n).padStart(2, '0');
const isIso = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// 本周一 (按美国中部时间无所谓, 只需要日期)
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
}

// 单元格 → YYYY-MM-DD: Excel 日期序号, 或 "9/28/2026" / "2026-09-28" 文本
function cellDate(v, fallbackYear) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return v > 20000 && v < 80000 ? serialToIso(v) : '';
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : fallbackYear;
    if (y) return `${y}-${pad2(m[1])}-${pad2(m[2])}`;
  }
  return '';
}

// 工时格: 普通数字 = 小时; "8:30" = 8.5 小时
function cellHours(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  const m = s.match(/^(\d+):(\d{2})$/);
  if (m) return +m[1] + +m[2] / 60;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// 钟点格: Excel 时间 (一天的小数) 或 "7:00 AM" / "19:30" 文本 → 当天第几小时
function cellClock(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v >= 0 && v < 1 ? v * 24 : (v < 24 ? v : null);
  const m = String(v).trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])?\.?m?\.?$/i);
  if (!m) return null;
  let h = +m[1] % (m[3] ? 12 : 24);
  if (m[3] && /p/i.test(m[3])) h += 12;
  return h + (m[2] ? +m[2] / 60 : 0);
}

const num = v => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
const str = v => (v == null ? '' : String(v).trim());
const low = v => str(v).toLowerCase();

// ─── 生成模板 ────────────────────────────────────────────────────────────────
// opts: { company, kind: 'weekly'|'daily', start: 'YYYY-MM-DD', end?, markup (倍数, 如 1.25),
//         employees: [{ name, rate, otRate }] }
function buildTimesheetTemplate(opts) {
  const XLSX = require('xlsx');
  const kind = KINDS.includes(opts.kind) ? opts.kind : 'weekly';
  const company = str(opts.company);
  const start = kind === 'weekly' ? mondayOf(opts.start) : opts.start;
  let end = kind === 'weekly' ? addDays(start, 6) : (isIso(opts.end) && opts.end >= start ? opts.end : addDays(start, 6));
  if (isoToSerial(end) - isoToSerial(start) > 30) end = addDays(start, 30);
  const nDays = isoToSerial(end) - isoToSerial(start) + 1;
  const emps = (opts.employees || []).filter(e => str(e.name));
  const markup = num(opts.markup) > 0 ? num(opts.markup) : '';
  const rateCell = v => (num(v) > 0 ? num(v) : '');
  const dateCell = (iso, f) => (f ? { t: 'n', v: isoToSerial(iso), f, z: 'm/d/yyyy' } : { t: 'n', v: isoToSerial(iso), z: 'm/d/yyyy' });

  const aoa = [[MARK, kind.toUpperCase()], ['Company', company]];
  let cols;
  if (kind === 'weekly') {
    aoa.push(['Week Start', dateCell(start)], ['Markup', markup],
      ['每格填当天工时 (小时, 如 8 或 7.5); 没上班留空。改 Week Start 日期列会跟着变。Rate 留空 = 上传后在发票页填。'], []);
    const hdrRow = aoa.length + 1; // 1-based Excel row of the header
    aoa.push(['Name', 'Rate', 'OT Rate', ...Array.from({ length: 7 }, (_, i) => dateCell(addDays(start, i), `$B$3+${i}`)), 'TOTAL']);
    const rows = [...emps.map(e => [e.name, rateCell(e.rate), rateCell(e.otRate)]), ...Array.from({ length: 15 }, () => [''])];
    rows.forEach((r, i) => {
      const x = hdrRow + 1 + i;
      aoa.push([r[0], r[1] ?? '', r[2] ?? '', '', '', '', '', '', '', '', { t: 'n', v: 0, f: `SUM(D${x}:J${x})` }]);
    });
    cols = [24, 8, 8, 11, 11, 11, 11, 11, 11, 11, 8];
  } else {
    aoa.push(['Period Start', dateCell(start)], ['Period End', dateCell(end)], ['Markup', markup],
      ['一人一天一行: 填 Hours (小时), 或填 Time In / Time Out (+ Break 分钟) 自动算。没上班的行留空即可, 可自行加行。'], []);
    aoa.push(['Date', 'Name', 'Rate', 'OT Rate', 'Time In', 'Time Out', 'Break (min)', 'Hours', 'Note']);
    for (let i = 0; i < nDays; i++) {
      const d = addDays(start, i);
      for (const e of emps) aoa.push([dateCell(d), e.name, rateCell(e.rate), rateCell(e.otRate)]);
    }
    for (let i = 0; i < 20; i++) aoa.push(['']);
    cols = [11, 24, 8, 8, 9, 9, 10, 8, 20];
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = cols.map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Timesheet');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const [sy, sm, sd] = start.split('-'), [ey, em, ed] = end.split('-');
  const safe = company.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');
  // 文件名带 MMDDMMDDYYYY 账期 (发票生成器的文件名账期规则也认)
  const fileName = `${safe ? safe + '_' : ''}Timesheet_${kind === 'weekly' ? 'Weekly' : 'Daily'}_${sm}${sd}${em}${ed}${ey}.xlsx`;
  return { buffer: buf, fileName, start, end, kind };
}

// ─── 读回填好的模板 ──────────────────────────────────────────────────────────
function isTimesheetTemplate(rows) {
  return (rows || []).slice(0, 3).some(r => low((r || [])[0]) === MARK.toLowerCase());
}

function parseTimesheetTemplate(rows) {
  const warnings = [];
  let markIdx = rows.findIndex(r => low((r || [])[0]) === MARK.toLowerCase());
  let kind = low((rows[markIdx] || [])[1]) === 'daily' ? 'daily' : 'weekly';
  const meta = {};
  let hdrIdx = -1;
  for (let i = markIdx + 1; i < Math.min(rows.length, markIdx + 20); i++) {
    const r = rows[i] || [];
    const k = low(r[0]);
    if ((k === 'name' && kind === 'weekly') || (k === 'date' && kind === 'daily')) { hdrIdx = i; break; }
    if (k) meta[k] = r[1];
  }
  if (hdrIdx < 0) throw new Error('时间表模板找不到表头行（' + (kind === 'weekly' ? 'Name' : 'Date') + '）');
  const company = str(meta.company);
  const mult = num(meta.markup) > 0 ? num(meta.markup) : null;
  const markupMultiplier = mult == null ? null : (mult < 1 ? r3(1 + mult) : mult); // 填成 0.25 也认
  const hdr = (rows[hdrIdx] || []).map(low);
  const colOf = (...names) => hdr.findIndex(h => names.includes(h));

  const order = [], byName = new Map();
  const person = (name) => {
    const key = name.toLowerCase().replace(/\s+/g, ' ');
    if (!byName.has(key)) { byName.set(key, { name: name.replace(/\s+/g, ' '), rate: null, otRate: null, days: {} }); order.push(key); }
    return byName.get(key);
  };
  const addHours = (p, iso, h) => { p.days[iso] = r3((p.days[iso] || 0) + h); };
  const takeRates = (p, rate, otRate) => {
    if (p.rate == null && num(rate) > 0) p.rate = num(rate);
    else if (num(rate) > 0 && p.rate !== num(rate)) warnings.push(`${p.name} 填了不同的时薪（${p.rate} / ${num(rate)}），已按第一个 ${p.rate} 计。`);
    if (p.otRate == null && num(otRate) > 0) p.otRate = num(otRate);
  };
  let periodStart = '', periodEnd = '';

  if (kind === 'weekly') {
    const weekStart = cellDate(meta['week start']);
    const cName = colOf('name'), cRate = colOf('rate'), cOt = colOf('ot rate');
    const dayCols = [];
    hdr.forEach((h, c) => {
      if (c === cName || c === cRate || c === cOt || h === 'total') return;
      const raw = (rows[hdrIdx] || [])[c];
      const iso = cellDate(raw, weekStart ? weekStart.slice(0, 4) : '');
      if (iso) dayCols.push({ c, iso });
    });
    // 日期列读不出来 (公式没缓存值) → 按 Week Start 往后排 7 列
    if (!dayCols.length && weekStart) for (let i = 0; i < 7; i++) dayCols.push({ c: cOt + 1 + i, iso: addDays(weekStart, i) });
    if (!dayCols.length) throw new Error('时间表模板读不出日期列，请检查 Week Start');
    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const name = str(r[cName]);
      if (!name || /^total$/i.test(name)) continue;
      const p = person(name);
      takeRates(p, r[cRate], cOt >= 0 ? r[cOt] : null);
      for (const { c, iso } of dayCols) { const h = cellHours(r[c]); if (h) addHours(p, iso, h); }
    }
    const isos = dayCols.map(d => d.iso).sort();
    periodStart = isos[0]; periodEnd = isos[isos.length - 1];
  } else {
    const c = {
      date: colOf('date'), name: colOf('name'), rate: colOf('rate'), ot: colOf('ot rate'),
      tin: colOf('time in'), tout: colOf('time out'), brk: colOf('break (min)', 'break'), hours: colOf('hours'),
    };
    const ps = cellDate(meta['period start']), pe = cellDate(meta['period end']);
    const year = (ps || pe || '').slice(0, 4) || String(new Date().getFullYear());
    let lastDate = '';
    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const name = str(r[c.name]);
      if (!name) continue;
      const iso = cellDate(r[c.date], year) || lastDate; // 同一天连写多人时日期可只写第一行
      if (iso) lastDate = iso;
      let h = cellHours(r[c.hours]);
      if (h == null) {
        const a = cellClock(r[c.tin]), b = cellClock(r[c.tout]);
        if (a != null && b != null) h = (b >= a ? b - a : b + 24 - a) - (num(r[c.brk]) || 0) / 60;
      }
      const p = person(name);
      takeRates(p, r[c.rate], c.ot >= 0 ? r[c.ot] : null);
      if (!h || h <= 0) continue;
      if (!iso) { warnings.push(`${name} 有一行 ${r2(h)} 小时没写日期，已跳过。`); continue; }
      addHours(p, iso, r2(h));
    }
    const isos = order.flatMap(k => Object.keys(byName.get(k).days)).sort();
    periodStart = ps || isos[0] || ''; periodEnd = pe || isos[isos.length - 1] || '';
    const outside = isos.filter(d => (ps && d < ps) || (pe && d > pe));
    if (outside.length) warnings.push(`有 ${outside.length} 天的工时在 Period Start ~ End 之外（${[...new Set(outside)].join('、')}），请核对服务周期。`);
  }

  // 正常/加班: 每周 (周一~周日) 超 40 小时算加班
  const employees = [];
  for (const k of order) {
    const p = byName.get(k);
    const weeks = {};
    for (const [d, h] of Object.entries(p.days)) { const w = mondayOf(d); weeks[w] = (weeks[w] || 0) + h; }
    let reg = 0, ot = 0;
    for (const h of Object.values(weeks)) { reg += Math.min(h, 40); ot += Math.max(h - 40, 0); }
    const total = r3(reg + ot);
    if (total <= 0) continue; // 预填了名字但这期没上班
    employees.push({
      name: p.name, type: '', regRate: p.rate, otRate: p.otRate,
      regHours: r3(reg), otHours: r3(ot), totalHours: total, days: p.days,
      reimbursement: 0, markupRate: markupMultiplier ? r3(markupMultiplier - 1) : 0,
      regPay: null, otPay: null, totalPay: null, afterMarkup: null,
    });
  }
  if (!employees.length) throw new Error('时间表里没有填任何工时');
  if (employees.some(e => !(e.regRate > 0))) warnings.push('有员工没填时薪（Rate），请在发票页补上：' + employees.filter(e => !(e.regRate > 0)).map(e => e.name).join('、'));
  if (!markupMultiplier) warnings.push('时间表没填 Markup，请在发票页填写。');

  return {
    ok: true, format: 'timesheet-' + kind, warehouse: '', companyHint: company || undefined,
    period: periodStart && periodEnd ? `${periodStart} ~ ${periodEnd}` : '',
    periodStart, periodEnd, defaultMarkupRate: markupMultiplier ? r3(markupMultiplier - 1) : null,
    markupMultiplier, employees, warnings,
  };
}

module.exports = { buildTimesheetTemplate, isTimesheetTemplate, parseTimesheetTemplate, mondayOf };
