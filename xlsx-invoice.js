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

// 全部工作表 (按 tab 顺序) → [{name, rows}]。「每个班次一个分页」的时间表用。
function allSheetPaths(files) {
  const out = [];
  const wb = files.get('xl/workbook.xml');
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    // rels 的属性顺序不固定 (Excel 写 Id 在前, openpyxl 写 Target 在前) →
    // 逐个 <Relationship> 标签独立取 Id / Target
    const relMap = {};
    for (const rtag of (rels.toString('utf8').match(/<Relationship\b[^>]*\/?>/g) || [])) {
      const idM = rtag.match(/\bId="([^"]+)"/);
      const tgtM = rtag.match(/\bTarget="([^"]+)"/);
      if (idM && tgtM) relMap[idM[1]] = tgtM[1];
    }
    const tags = wb.toString('utf8').match(/<sheet\b[^>]*\/?>/g) || [];
    for (const tag of tags) {
      const nameM = tag.match(/\bname="([^"]*)"/);
      const ridM = tag.match(/\br:id="([^"]+)"/);
      if (!ridM || !relMap[ridM[1]]) continue;
      let t = relMap[ridM[1]].replace(/^\//, '');
      if (!t.startsWith('xl/')) t = 'xl/' + t.replace(/^\.\//, '');
      if (files.has(t)) out.push({ name: nameM ? decodeXml(nameM[1]) : 'Sheet', path: t });
    }
  }
  if (!out.length) { const p = firstSheetPath(files); if (p) out.push({ name: 'Sheet1', path: p }); }
  return out;
}
function readXlsxAll(buf) {
  const files = unzip(buf);
  const sharedBuf = files.get('xl/sharedStrings.xml');
  const shared = parseSharedStrings(sharedBuf ? sharedBuf.toString('utf8') : '');
  return allSheetPaths(files).map(s => ({ name: s.name, rows: parseSheet(files.get(s.path).toString('utf8'), shared) }));
}
function readAllSheetsAny(buf) {
  try { return readXlsxAll(buf); } catch (e) {
    let XLSX;
    try { XLSX = require('xlsx'); } catch (_) {
      throw new Error('这看起来是旧版 .xls 文件；请在 Excel / WPS 里「另存为 .xlsx」后再上传（或让管理员安装 xlsx 组件）。');
    }
    const wb = XLSX.read(buf, { type: 'buffer' });
    return (wb.SheetNames || []).map(nm => ({ name: nm, rows: XLSX.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, defval: null }) }));
  }
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

// Elogistek 导出会在双语员工名前加 "Chinese-" 语言标记（如 Chinese-Xishan Zeng）。
// 发票只要干净的名字（语言档位已体现在各行的 Mark-up Rate 里），导入时去掉。
function cleanPersonName(name) {
  return String(name == null ? '' : name).replace(/^chinese[-_\s]+/i, '').trim();
}

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

// rows → structured invoice data for the builder to auto-fill. Auto-detects three
// worksheet shapes: a finished payroll/billing worksheet (rates + markup), a raw
// time-clock attendance report (one row per person per day, hours only), or a
// Tolead-style shift log ("M/D shift" blocks with 序号|STAFF|上下班|时薪|工时).
function buildInvoiceData(rows) {
  const warnings = [];
  if (looksLikeShiftLog(rows)) return buildFromShiftLog(rows, warnings);

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
  const offPeriodRows = []; // 行自己的 Pay Period 与整表主账期不同（补差价/跨周期行）

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const name = cellStr(row, col.name);
    // Skip blank rows and a trailing "Total" summary row.
    if (!name || /^total$/i.test(name)) continue;

    if (!warehouse) warehouse = cellStr(row, col.warehouse);
    const rowPeriod = cellStr(row, col.period);
    if (!periodStart) {
      const p = rowPeriod;
      const pm = p.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*[-–—]+\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (pm) {
        period = p;
        periodStart = toISO(pm[1], pm[2], pm[3].length === 2 ? '20' + pm[3] : pm[3]);
        periodEnd = toISO(pm[4], pm[5], pm[6].length === 2 ? '20' + pm[6] : pm[6]);
      } else if (p && !period) { period = p; }
    } else if (rowPeriod && period && rowPeriod.trim() !== period.trim()) {
      offPeriodRows.push(`${cleanPersonName(name)}（${rowPeriod.trim()}）`);
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
      name: cleanPersonName(name),
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
  if (offPeriodRows.length)
    warnings.push(`${offPeriodRows.length} 行的 Pay Period 与整表主账期不同（补差价/跨周期行）：${offPeriodRows.join('、')}。金额已按 Excel 原样导入，请核对。`);
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
    const name = cleanPersonName(cellStr(row, col.name));
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

// ─── Tolead 式排班流水 ────────────────────────────────────────────────────────
// 结构: 每个班次一块 — 某格写 "7/20 night" 作块头, 跟一行表头
// (序号|STAFF|CHECK IN|break|check out|[工种]|pay|total|Total Pay), 再跟人员行。
// 汇总: 每人每天工时进 days 映射; 同一个人出现不同时薪 (如叉车日) 拆成两行。
function looksLikeShiftLog(rows) {
  let hasBlockDate = false, hasStaffHeader = false;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    for (const c of rows[i] || []) {
      if (/^\d{1,2}\/\d{1,2}(\s|$)/.test(String(c == null ? '' : c).trim())) hasBlockDate = true;
    }
    const cells = (rows[i] || []).map(norm);
    if (cells.some(c => c === 'staff' || c === '姓名') && cells.some(c => c.includes('check'))) hasStaffHeader = true;
    if (hasBlockDate && hasStaffHeader) return true;
  }
  return false;
}

function buildFromShiftLog(rows, warnings) {
  const year = new Date().getFullYear();
  let col = null, curDate = '', curLabel = '';
  const order = [], byKey = new Map(), allDates = [];
  const numOf = v => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
  // 班次明细 (发票可按 shift 分组打印: 组内编号 + 每班小计 + 总计)
  const blocks = [];
  let curBlock = null;

  for (const row0 of rows) {
    const row = row0 || [];
    const cellsN = row.map(norm);
    // 表头行 → 建立列映射 (每块可能重复表头, 重建无妨)
    if (cellsN.some(c => c === 'staff' || c === '姓名')) {
      const idx = p => cellsN.findIndex(c => c && p(c));
      col = {
        name: idx(c => c === 'staff' || c === '姓名'),
        checkin: idx(c => c.replace(/[^a-z一-鿿]/g, '').includes('checkin') || c.includes('上班')),
        brk: idx(c => c.includes('break') || c.includes('休息')),
        checkout: idx(c => c.replace(/[^a-z一-鿿]/g, '').includes('checkout') || c.includes('下班')),
        pay: idx(c => c === 'pay' || c === 'rate' || c.includes('时薪')),
        totalPay: idx(c => (c.includes('total') && c.includes('pay')) || c.includes('总额') || c.includes('总工资')),
      };
      col.hours = cellsN.findIndex((c, i2) => c && i2 !== col.totalPay && (c === 'total' || c === 'hours' || c.includes('工时')));
      // 工种列: 有表头的 (工种/role/position) 优先; 否则取 check out 和 pay 之间
      // 没有表头的那一列 (Forklift 之类写在这)
      col.role = idx(c => c.includes('工种') || c === 'role' || c.includes('position'));
      if (col.role < 0 && col.checkout >= 0 && col.pay > col.checkout + 1) {
        for (let c2 = col.checkout + 1; c2 < col.pay; c2++) if (!cellsN[c2]) { col.role = c2; break; }
      }
      continue;
    }
    // 块头行 → 当前日期 (只有 M/D, 年份按今年)
    const dCell = row.map(v => String(v == null ? '' : v).trim()).find(s => /^\d{1,2}\/\d{1,2}(\s|$)/.test(s));
    if (dCell) {
      const m = dCell.match(/^(\d{1,2})\/(\d{1,2})/);
      curDate = toISO(m[1], m[2], String(year));
      curBlock = null; // 数据行出现时再开块, 避免空块
      var _pendingLabel = dCell.replace(/\s+/g, ' ').trim();
      curLabel = _pendingLabel;
      continue;
    }
    if (!col || !curDate || col.name < 0) continue;
    const name = cleanPersonName(row[col.name]);
    if (!name || /^(total|合计|小计)$/i.test(name)) continue;
    const rate = col.pay >= 0 ? numOf(row[col.pay]) : null;
    // 工时: 优先表里的 total 列; 没有就用上下班时间减休息自己算 (跨午夜自动 +24h)
    let hrs = col.hours >= 0 ? (numOf(row[col.hours]) || 0) : 0;
    if (!hrs && col.checkin >= 0 && col.checkout >= 0) {
      const inH = parseDuration(row[col.checkin]);
      let outH = parseDuration(row[col.checkout]);
      if (inH || outH) {
        if (outH <= inH) outH += 24;
        let b = 0;
        const bs = String(row[col.brk] == null ? '' : row[col.brk]);
        const bm = bs.match(/(\d+)\s*min/i);
        if (bm) b = (+bm[1]) / 60;
        else { const bn = parseFloat(bs); if (Number.isFinite(bn)) b = bn > 5 ? bn / 60 : bn; }
        hrs = Math.max(0, outH - inH - b);
      }
    }
    hrs = Math.round(hrs * 1000) / 1000;
    if (!hrs) continue;
    const role = col.role >= 0 ? String(row[col.role] == null ? '' : row[col.role]).trim() : '';
    const key = name.toLowerCase() + '|' + (rate == null ? '' : rate);
    if (!byKey.has(key)) { byKey.set(key, { name, type: role, rate, total: 0, days: {} }); order.push(key); }
    const rec = byKey.get(key);
    if (role && !rec.type) rec.type = role;
    rec.days[curDate] = Math.round(((rec.days[curDate] || 0) + hrs) * 1000) / 1000;
    rec.total = Math.round((rec.total + hrs) * 1000) / 1000;
    allDates.push(curDate);
    // 班次明细行
    if (!curBlock || curBlock.date !== curDate || curBlock.label !== (typeof curLabel === 'string' ? curLabel : '')) {
      curBlock = { label: typeof curLabel === 'string' ? curLabel : curDate, date: curDate, entries: [], hours: 0, amount: 0 };
      blocks.push(curBlock);
    }
    const amt = Math.round(hrs * (rate || 0) * 100) / 100;
    curBlock.entries.push({ name, role, rate: rate || 0, hours: hrs, amount: amt });
    curBlock.hours = Math.round((curBlock.hours + hrs) * 100) / 100;
    curBlock.amount = Math.round((curBlock.amount + amt) * 100) / 100;
  }

  if (!order.length) throw new Error('没解析到工时行：每个班次块需要一个日期头（如 "7/20 night"）和 STAFF 表头');

  let periodStart = '', periodEnd = '';
  if (allDates.length) { const s = [...allDates].sort(); periodStart = s[0]; periodEnd = s[s.length - 1]; }

  const employees = order.map(k => {
    const r = byKey.get(k);
    return {
      // 排班流水的时薪是每班一口价 (加班不另加成) → otRate = 时薪, 账面和表格一致
      name: r.name, type: r.type || '', regRate: r.rate, otRate: r.rate,
      regHours: null, otHours: null, totalHours: r.total, days: r.days,
      reimbursement: 0, markupRate: null,
      regPay: null, otPay: null, totalPay: null, afterMarkup: null,
    };
  });

  const multiRate = new Set();
  const seenNames = new Map();
  for (const e of employees) {
    const k = e.name.toLowerCase();
    if (seenNames.has(k)) multiRate.add(e.name); else seenNames.set(k, 1);
  }
  warnings.push('识别为「日期+班次」排班流水：已按天汇总每人工时。日期没写年份，按 ' + year + ' 年处理，请核对服务周期。Markup 需手动填写。');
  if (multiRate.size) warnings.push('同一人出现不同时薪（如叉车班），已拆成多行：' + [...multiRate].join('、'));

  return {
    ok: true, format: 'shiftlog', warehouse: '',
    period: periodStart && periodEnd ? periodStart + ' ~ ' + periodEnd : '',
    periodStart, periodEnd, defaultMarkupRate: null, markupMultiplier: null, employees, warnings,
    shift_blocks: blocks,
  };
}

module.exports = function parseInvoiceWorkbook(buf, filename) {
  // 读全部分页: 「每个班次一个 sheet」的时间表, 用 sheet 名 (如 "7.20 night")
  // 生成日期块头再拼成一张大表; 单 sheet 文件行为不变。说明页跳过。
  let sheets = [];
  try { sheets = readAllSheetsAny(buf); } catch (_) { sheets = []; }
  let data = null;
  if (sheets.length) {
    const combined = [];
    for (const sh of sheets) {
      const nm = String(sh.name || '');
      if (/说明|instruction|readme/i.test(nm)) continue;
      const m = nm.match(/(\d{1,2})[\/.\-月]\s*(\d{1,2})/);
      if (m) combined.push([null, nm.replace(/(\d{1,2})[.\-月]\s*(\d{1,2})日?/, (a, x, y) => (+x) + '/' + (+y))]);
      combined.push(...sh.rows);
    }
    if (looksLikeShiftLog(combined)) data = buildFromShiftLog(combined, []);
  }
  if (!data) data = buildInvoiceData(readAnyWorkbook(buf));
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
