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

// Normalize a header cell for fuzzy matching.
function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[\s_]+/g, ' ').trim(); }

// MM/DD/YYYY → YYYY-MM-DD
function toISO(m, d, y) {
  return `${y}-${String(+m).padStart(2, '0')}-${String(+d).padStart(2, '0')}`;
}

// rows → structured invoice data for the builder to auto-fill.
function buildInvoiceData(rows) {
  const warnings = [];
  // Find the header row: the row containing "employee" and a rate/hours header.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = (rows[i] || []).map(norm);
    if (cells.some(c => c.includes('employee')) &&
        cells.some(c => c.includes('pay') || c.includes('rate') || c.includes('hour'))) {
      headerIdx = i; break;
    }
  }
  if (headerIdx < 0) throw new Error('找不到表头行（需要含 "Employee" 列）');
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
  const col = {
    warehouse: find('warehouse'),
    name: find('employee'),
    type: find(h => h.includes('type')),
    period: find('pay period'),
    regRate: find('regular', 'rate'),
    otRate: find('ot', 'rate'),
    regHours: find(h => h.includes('reg') && h.includes('hour')),
    otHours: find(h => h.includes('ot') && h.includes('hour')),
    regPay: find('reg', 'pay', 'amount'),
    otPay: find('ot', 'pay', 'amount'),
    totalPay: find('total pay'),
    markup: find('mark', 'rate'),
    reimb: find('reimburs'),
    afterMarkup: find('after mark'),
  };
  if (col.name < 0) throw new Error('找不到 "Employee" 列');

  const cellNum = (row, c) => { if (c < 0) return null; const v = row[c]; const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
  const cellStr = (row, c) => { if (c < 0) return ''; const v = row[c]; return v == null ? '' : String(v).trim(); };

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
    const otHours = cellNum(row, col.otHours) || 0;
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

  return { ok: true, warehouse, period, periodStart, periodEnd, defaultMarkupRate: topMarkup, markupMultiplier, employees, warnings };
}

module.exports = function parseInvoiceWorkbook(buf) {
  return buildInvoiceData(readXlsx(buf));
};
module.exports.readXlsx = readXlsx;
