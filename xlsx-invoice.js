'use strict';

// ─── Dependency-free .xlsx → invoice reader ──────────────────────────────────
// An .xlsx file is a ZIP archive of XML parts. We read the ZIP central directory,
// inflate the parts we need with Node's built-in zlib, and pull the payroll rows
// out of the first worksheet. No third-party library required.
//
// Exposes parseInvoiceWorkbook(buffer) → structured data the invoice builder can
// auto-fill. Tuned for the weekly payroll worksheet exported with these columns:
//   Warehouse Location | Employee | Type | Pay Period | Regular Pay Rate |
//   OT Pay Rate | Reg Working Hours | OT Hours | Reg Pay Amount | OT Pay Amount |
//   Total Pay Amount | Mark Up Rate | Reimbursement | Total Amount After Mark Up
// Columns are matched by header text (not position), so minor reordering is fine.

const zlib = require('zlib');

// Read the ZIP central directory → Map<filename, Buffer(uncompressed)>.
function unzip(buf) {
  // Locate End Of Central Directory (EOCD): signature 0x06054b50, scanned from end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 .xlsx 文件（缺少 ZIP 目录）');
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // start of central directory
  const files = new Map();
  for (let n = 0; n < cdCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // Jump to the local header to find where the actual data starts.
    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      let out;
      if (method === 0) out = Buffer.from(raw);              // stored
      else if (method === 8) out = zlib.inflateRawSync(raw); // deflate
      else throw new Error('不支持的压缩方式: ' + method);
      files.set(name, out);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// Decode common XML entities found in cell text.
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// sharedStrings.xml → array of strings (each <si> may hold multiple <t> runs).
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const reSi = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = reSi.exec(xml))) {
    const runs = m[1].match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [];
    out.push(runs.map(r => decodeXml(r.replace(/<t\b[^>]*>/, '').replace(/<\/t>/, ''))).join(''));
  }
  return out;
}

// "AB12" → zero-based column index for "AB".
function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || ['A'])[0];
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

// Worksheet XML → array of rows, each an array of cell values (string|number|null).
function parseSheet(xml, shared) {
  const rows = [];
  const reRow = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rm;
  while ((rm = reRow.exec(xml))) {
    const inner = rm[1] || '';
    const cells = [];
    const reCell = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = reCell.exec(inner))) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const refM = attrs.match(/\br="([A-Z]+\d+)"/);
      const idx = refM ? colIndex(refM[1]) : cells.length;
      const tM = attrs.match(/\bt="([^"]+)"/);
      const type = tM ? tM[1] : 'n';
      let val = null;
      if (type === 'inlineStr') {
        const t = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
        val = t ? decodeXml(t[1]) : '';
      } else {
        const vM = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/); // formula cells expose the cached <v>
        const raw = vM ? vM[1] : null;
        if (raw === null) val = null;
        else if (type === 's') val = shared[parseInt(raw, 10)] != null ? shared[parseInt(raw, 10)] : '';
        else if (type === 'str' || type === 'b') val = decodeXml(raw);
        else { const num = parseFloat(raw); val = Number.isNaN(num) ? decodeXml(raw) : num; }
      }
      cells[idx] = val;
    }
    rows.push(cells);
  }
  return rows;
}

// Resolve the FIRST worksheet's part path via workbook.xml + its rels.
function firstSheetPath(files) {
  const wb = files.get('xl/workbook.xml');
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const sheetM = wb.toString('utf8').match(/<sheet\b[^>]*\br:id="([^"]+)"/);
    if (sheetM) {
      const rid = sheetM[1];
      const relM = rels.toString('utf8').match(new RegExp('<Relationship\\b[^>]*\\bId="' + rid + '"[^>]*\\bTarget="([^"]+)"'));
      if (relM) {
        let t = relM[1].replace(/^\//, '');
        if (!t.startsWith('xl/')) t = 'xl/' + t.replace(/^\.\//, '');
        if (files.has(t)) return t;
      }
    }
  }
  // Fallback: lowest-numbered worksheet file.
  const sheets = [...files.keys()].filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => (parseInt(a.match(/(\d+)/)[1]) - parseInt(b.match(/(\d+)/)[1])));
  return sheets[0] || null;
}

function readXlsx(buf) {
  const files = unzip(buf);
  const sharedBuf = files.get('xl/sharedStrings.xml');
  const shared = parseSharedStrings(sharedBuf ? sharedBuf.toString('utf8') : '');
  const sheetPath = firstSheetPath(files);
  if (!sheetPath) throw new Error('找不到工作表');
  return parseSheet(files.get(sheetPath).toString('utf8'), shared);
}

// Read either a modern .xlsx (dependency-free, above) or a legacy .xls (OLE2/BIFF)
// into rows[][]. .xls needs SheetJS, which is only require()d on that fallback path so
// the light .xlsx reader keeps working even if the optional package isn't installed.
function readAnyWorkbook(buf) {
  try {
    return readXlsx(buf); // fast path for .xlsx
  } catch (e) {
    let XLSX;
    try { XLSX = require('xlsx'); } catch (_) {
      throw new Error('这看起来是旧版 .xls 文件；请在 Excel / WPS 里「另存为 .xlsx」后再上传（或让管理员安装 xlsx 组件）。');
    }
    const wb = XLSX.read(buf, { type: 'buffer' });
    if (!wb.SheetNames || !wb.SheetNames.length) throw new Error('找不到工作表');
    // Prefer the sheet that carries the payroll/attendance rows (has an
    // Employee / Username / Person header); else the first sheet.
    let pick = wb.SheetNames[0];
    for (const nm of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, defval: null });
      const hit = rows.slice(0, 10).some(r => (r || []).some(c => /employee|username|person\s*name/i.test(String(c == null ? '' : c))));
      if (hit) { pick = nm; break; }
    }
    return XLSX.utils.sheet_to_json(wb.Sheets[pick], { header: 1, raw: true, defval: null });
  }
}

// Weekly exports embed the service period in the file name as MMDDMMDDYYYY
// (e.g. "…071307192026…" = 07/13/2026 – 07/19/2026). Best-effort only.
function _periodFromFilename(name) {
  const m = String(name || '').match(/(?:^|\D)(\d{2})(\d{2})(\d{2})(\d{2})(\d{4})(?:\D|$)/);
  if (!m) return null;
  const [, m1, d1, m2, d2, y] = m;
  if (+m1 < 1 || +m1 > 12 || +m2 < 1 || +m2 > 12 || +d1 < 1 || +d1 > 31 || +d2 < 1 || +d2 > 31) return null;
  return { start: toISO(m1, d1, y), end: toISO(m2, d2, y) };
}

// Normalize a header cell for fuzzy matching.
function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[\s_]+/g, ' ').trim(); }

// MM/DD/YYYY → YYYY-MM-DD
function toISO(m, d, y) {
  return `${y}-${String(+m).padStart(2, '0')}-${String(+d).padStart(2, '0')}`;
}

// Parse "HH:MM:SS" / "H:MM", an Excel time fraction (e.g. 0.3646 of a 24h day),
// or a plain hours number into hours.
function parseDuration(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') {
    let h = v * 24;        // Excel stores clock durations as a fraction of a day
    if (h > 24.5) h = v;   // already in hours (defensive for non-Excel-time files)
    return h;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (m) return (+m[1]) + (+m[2]) / 60 + (m[3] ? (+m[3]) / 3600 : 0);
  const num = parseFloat(s);
  if (Number.isFinite(num)) { let h = num * 24; if (h > 24.5) h = num; return h; }
  return 0;
}

// rows → structured invoice data for the builder to auto-fill. Auto-detects two
// worksheet shapes: a finished payroll/billing worksheet (rates + markup), or a
// raw time-clock attendance report (one row per person per day, hours only).
function buildInvoiceData(rows) {
  const warnings = [];

  // Locate the header row — accept either the payroll layout (Employee + rate/pay)
  // or the attendance layout (Person Name + Clock / 工作时长).
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = (rows[i] || []).map(norm);
    const hasEmp = cells.some(c => c.includes('employee'));
    const hasPerson = cells.some(c => c.includes('person'));
    const hasRateish = cells.some(c => c.includes('pay') || c.includes('rate') || c.includes('hour'));
    const hasClock = cells.some(c => c.includes('clock') || c.includes('工作时长') || c.includes('工时'));
    if ((hasEmp && hasRateish) || (hasPerson && hasClock)) { headerIdx = i; break; }
  }
  if (headerIdx < 0) throw new Error('找不到表头行（需要含 "Employee" 或 "Person Name" 列）');
  const headers = (rows[headerIdx] || []).map(norm);

  // Map a logical field → column index by matching header keywords.
  const find = (...preds) => {
    for (let c = 0; c < headers.length; c++) {
      const h = headers[c];
      if (!h) continue;
      if (preds.every(p => (typeof p === 'string' ? h.includes(p) : p(h)))) return c;
    }
    return -1;
  };
  const cellNum = (row, c) => { if (c < 0) return null; const v = row[c]; const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
  const cellStr = (row, c) => { if (c < 0) return ''; const v = row[c]; return v == null ? '' : String(v).trim(); };

  const isAttendance = headers.some(h => h.includes('person'))
    && headers.some(h => h.includes('clock') || h.includes('工作时长') || h.includes('工时'));

  return isAttendance
    ? buildFromAttendance({ rows, headerIdx, find, cellStr, warnings })
    : buildFromPayroll({ rows, headerIdx, headers, find, cellNum, cellStr, warnings });
}

// Finished payroll/billing worksheet → invoice line items (rates + markup baked in).
function buildFromPayroll({ rows, headerIdx, headers, find, cellNum, cellStr, warnings }) {
  // Column keywords cover both the original worksheet and Elogistek-style exports
  // (Username / Regular HR / 1.5 OT + 2.0 OT / Hourly Rate / Salary / Invoiced Salary
  //  / Department / Working Group). Matched by header text, so order doesn't matter.
  const or = (...idxs) => { for (const i of idxs) if (i >= 0) return i; return -1; };
  const col = {
    warehouse: or(find('warehouse'), find(h => h === 'department')),
    // The person's NAME — prefer Username / Employee Name; never an "Employee ID" column.
    name: or(find('username'), find(h => h.includes('employee') && !h.includes('id') && !h.includes('#')), find('person')),
    type: or(find(h => h.includes('type')), find(h => h.includes('working group'))),
    period: find('pay period'),
    regRate: or(find('regular', 'rate'), find('hourly', 'rate'), find(h => h.includes('pay') && h.includes('rate') && !h.includes('ot'))),
    otRate: find('ot', 'rate'),
    regHours: find(h => h.includes('reg') && (h.includes('hour') || h.includes('hr'))),
    regPay: find('reg', 'pay', 'amount'),
    otPay: find('ot', 'pay', 'amount'),
    totalPay: or(find('total pay'), find(h => h === 'salary')),
    markup: find('mark', 'rate'),
    reimb: find('reimburs'),
    afterMarkup: or(find('after mark'), find(h => h.includes('invoiced'))),
  };
  // OT hours may live in one column ("OT Hours") or several ("1.5 OT" + "2.0 OT").
  // Collect every OT column that holds HOURS (exclude rate / pay / amount columns).
  const otHourCols = [];
  (headers || []).forEach((h, c) => {
    if (h && h.includes('ot') && !h.includes('rate') && !h.includes('pay') && !h.includes('amount') && !h.includes('total') && !h.includes('note')) otHourCols.push(c);
  });
  if (col.name < 0) throw new Error('找不到员工姓名列（Employee / Username / Person Name）');
  let sawDoubleOt = false;

  let warehouse = '', period = '', periodStart = '', periodEnd = '';
  const employees = [];
  const markupCounts = {};

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const name = cellStr(row, col.name);
    // Skip blank rows and a trailing "Total" summary row.
    if (!name || /^total$/i.test(name)) continue;

    if (!warehouse) warehouse = cellStr(row, col.warehouse);
    if (!periodStart) {
      const p = cellStr(row, col.period);
      const pm = p.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*[-–—]+\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (pm) {
        period = p;
        periodStart = toISO(pm[1], pm[2], pm[3].length === 2 ? '20' + pm[3] : pm[3]);
        periodEnd = toISO(pm[4], pm[5], pm[6].length === 2 ? '20' + pm[6] : pm[6]);
      } else if (p && !period) { period = p; }
    }

    const regRate = cellNum(row, col.regRate) || 0;
    const otRate = cellNum(row, col.otRate);
    const regHours = cellNum(row, col.regHours) || 0;
    let otHours = 0;
    for (const c of otHourCols) {
      const v = cellNum(row, c) || 0;
      otHours += v;
      if (v > 0 && /2(\.0)?\s*(x|ot|×|倍)|double|双/.test(headers[c] || '')) sawDoubleOt = true;
    }
    otHours = Math.round(otHours * 1000) / 1000;
    const reimb = cellNum(row, col.reimb) || 0;
    let markupFrac = cellNum(row, col.markup);
    if (markupFrac == null) markupFrac = 0;
    const key = markupFrac.toFixed(4);
    markupCounts[key] = (markupCounts[key] || 0) + 1;

    employees.push({
      name,
      type: cellStr(row, col.type),
      regRate,
      otRate: otRate == null ? null : otRate,
      regHours,
      otHours,
      totalHours: Math.round((regHours + otHours) * 1000) / 1000,
      days: null,
      reimbursement: reimb,
      markupRate: markupFrac,
      regPay: cellNum(row, col.regPay),
      otPay: cellNum(row, col.otPay),
      totalPay: cellNum(row, col.totalPay),
      afterMarkup: cellNum(row, col.afterMarkup),
    });
  }

  if (!employees.length) throw new Error('表格中没有员工数据行');

  // Most common markup fraction → the invoice's default markup multiplier.
  let topMarkup = 0, topN = -1;
  for (const k of Object.keys(markupCounts)) {
    if (markupCounts[k] > topN) { topN = markupCounts[k]; topMarkup = parseFloat(k); }
  }
  const markupMultiplier = Math.round((1 + topMarkup) * 10000) / 10000;

  if (!periodStart) warnings.push('未能从「Pay Period」列解析出服务周期日期，请手动填写开始/结束日期。');
  if (employees.some(e => e.reimbursement && e.reimbursement !== 0))
    warnings.push('表格含「Reimbursement」报销金额，发票生成器暂不支持报销项，已忽略；如需请手动添加一行。');
  if (otHourCols.length > 1) warnings.push('加班分「1.5×」「2.0×」多列，已合并为「加班工时」，默认按 1.5× 计' + (sawDoubleOt ? '；本表含 2.0× 加班，请把相关员工加班时薪手动改为双倍。' : '。'));

  return { ok: true, format: 'payroll', warehouse, period, periodStart, periodEnd, defaultMarkupRate: topMarkup, markupMultiplier, employees, warnings };
}

// Raw time-clock attendance report (one row per person per day) → per-person totals.
// Aggregates each person's daily worked hours into a days map; rates/markup aren't
// in this file, so they're left blank for the user to fill before saving.
function buildFromAttendance({ rows, headerIdx, find, cellStr, warnings }) {
  const col = {
    name: find(h => h.includes('person')),
    date: find(h => h === '日期' || h.includes('日期') || h.includes('date')),
    clockTime: find(h => h.includes('clock time')),
    worked: find(h => h.includes('工作时长') || h.includes('总工时')),
  };
  if (col.name < 0) throw new Error('找不到 "Person Name" 列');
  // Prefer the explicit 总工作时长 (net worked) column; fall back to gross Clock Time.
  const hoursCol = col.worked >= 0 ? col.worked : col.clockTime;
  if (hoursCol < 0) throw new Error('找不到工时列（Clock Time / 总工作时长）');

  const order = [];          // preserve first-seen person order
  const byName = new Map();   // key → { name, total, days: {iso: hours} }
  const allDates = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const name = cellStr(row, col.name);
    if (!name || /^total$/i.test(name)) continue;
    const dRaw = cellStr(row, col.date);
    const dm = dRaw.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    const iso = dm ? toISO(dm[1], dm[2], dm[3].length === 2 ? '20' + dm[3] : dm[3]) : '';
    const hrs = Math.round(parseDuration(row[hoursCol]) * 1000) / 1000;
    const key = name.toLowerCase();
    if (!byName.has(key)) { byName.set(key, { name, total: 0, days: {} }); order.push(key); }
    const rec = byName.get(key);
    if (iso) { rec.days[iso] = Math.round(((rec.days[iso] || 0) + hrs) * 1000) / 1000; allDates.push(iso); }
    rec.total = Math.round((rec.total + hrs) * 1000) / 1000;
  }

  if (!order.length) throw new Error('考勤表中没有打卡数据行');

  let periodStart = '', periodEnd = '';
  if (allDates.length) { const s = [...allDates].sort(); periodStart = s[0]; periodEnd = s[s.length - 1]; }

  const employees = order.map(key => {
    const rec = byName.get(key);
    return {
      name: rec.name, type: '', regRate: null, otRate: null,
      regHours: null, otHours: null, totalHours: rec.total, days: rec.days,
      reimbursement: 0, markupRate: null,
      regPay: null, otPay: null, totalPay: null, afterMarkup: null,
    };
  });

  const usedNet = col.worked >= 0;
  warnings.push('这是考勤工时报表（只含工时），已按' + (usedNet ? '「总工作时长」' : '「Clock Time」') + '列汇总每人工时；时薪与 Markup 需要手动填写后再保存。');

  return {
    ok: true, format: 'attendance', warehouse: '',
    period: (periodStart && periodEnd) ? `${periodStart} ~ ${periodEnd}` : '',
    periodStart, periodEnd, defaultMarkupRate: null, markupMultiplier: null, employees, warnings,
  };
}

module.exports = function parseInvoiceWorkbook(buf, filename) {
  const data = buildInvoiceData(readAnyWorkbook(buf));
  // If the sheet carried no service period, fall back to the one embedded in the
  // file name (weekly exports do this) and drop the "no period" warning.
  if (data && data.ok && !data.periodStart && filename) {
    const p = _periodFromFilename(filename);
    if (p) {
      data.periodStart = p.start; data.periodEnd = p.end;
      if (!data.period) data.period = p.start + ' ~ ' + p.end;
      data.warnings = (data.warnings || []).filter(w => !/服务周期/.test(w));
    }
  }
  return data;
};
module.exports.readXlsx = readXlsx;
module.exports.readAnyWorkbook = readAnyWorkbook;
