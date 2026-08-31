'use strict';

// ─── Gusto 合同工付款模板 (Contractor Pay CSV) 生成 ─────────────────────────────
// 输入: ① Gusto 后台导出的空白 contractor pay 模板 CSV（合同工名册: 姓名 / 打码
// SSN / 时薪）② 发票生成器里的员工行（姓名 / 时薪 / 正常与加班工时 / 应付工资）。
// 输出: 同一张模板, 只填 hours / bonus（时薪缺失的名册行改填 fixed_amount）,
// 其余单元格逐字保留, Gusto 才能按行对上自家合同工。
//
// Gusto 按 时薪 × hours 付款, 没有 1.5× 加班的概念。两种折算口径 (opts.mode):
//   'bonus' (默认): hours = 实际工时, 加班溢价和时薪差额放 bonus 列。
//     付款记录里的工时就是真实工时, 总额和工资表一分不差。名册时薪高于工资表
//     实际单价 (bonus 会变负数, Gusto 不收) 的行自动退回 'hours' 口径。
//   'hours': 全折进工时, hours = 应付工资 ÷ 名册时薪, 向上取整到 0.01 小时
//     （宁多不少）。时薪一致时相当于 正常工时 + 1.5×加班工时。
//
// 姓名匹配: 工资表的 "Jose Guerrero" 要对上名册的 last_name=Guerrero,
// first_name=Jose。按分词集合做四档匹配（完全一致 → 包含 → 共享长词 → 近似拼写),
// 同一档命中多行算歧义, 宁可不填也不能付错人。多行工资对到同一名册行（同姓家人
// 或同一人两种时薪）自动合并成一笔, 在 sources 里列明细。

// ── CSV 基础 ──
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  const s = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  // 去掉整行全空的行（模板末尾常带一个空行）
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function stringifyCsv(rows) {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ── 姓名分词 ──
// 小写 + 去重音 + 只留字母数字; 单字母词（middle initial "E"）不参与比较。
function nameTokens(...parts) {
  const out = new Set();
  for (const p of parts) {
    const clean = String(p == null ? '' : p)
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ');
    for (const t of clean.split(/\s+/)) if (t.length > 1) out.add(t);
  }
  return out;
}
const joined = set => [...set].sort().join('');
const isSubset = (a, b) => { for (const t of a) if (!b.has(t)) return false; return a.size > 0; };

// 编辑距离 ≤1 (一个字母打错/多打/漏打, 如 Tecsxco ≈ Tecaxco)。
function editDist1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la === lb) { i++; j++; }
    else if (la > lb) i++;
    else j++;
  }
  return edits + (la - i) + (lb - j) <= 1;
}

// 匹配档位（0 = 不匹配）。entry 是名册行; tokenCount 是每个词出现在几个名册行里。
// 低档位（共享词 / 近似拼写）只认「姓氏且全名册唯一」的词——只共享一个常见名字
// (两个 Jesus、两个 Luis) 绝不能算同一个人。
function matchScore(empT, entry, tokenCount) {
  const rosterT = entry.tokens;
  if (!empT.size || !rosterT.size) return 0;
  if (empT.size === rosterT.size && isSubset(empT, rosterT)) return 100;
  if (joined(empT) === joined(rosterT)) return 100;      // "Finova Operations" ≈ "FINOVAOPERATIONS"
  if (isSubset(empT, rosterT) || isSubset(rosterT, empT)) return 80;
  for (const t of empT) {
    if (t.length >= 4 && entry.lastTokens.has(t) && tokenCount.get(t) === 1) return 60;
  }
  for (const a of empT) {
    if (a.length < 5) continue;
    for (const b of entry.lastTokens) {
      if (b.length >= 5 && tokenCount.get(b) === 1 && editDist1(a, b)) return 50;
    }
  }
  return 0;
}

const r2 = v => Math.round(v * 100) / 100;
// 向上取整到 0.01（留一点浮点余量, 41.9952 → 42.00, 40.93 → 40.93）
const ceil2 = v => Math.ceil(v * 100 - 1e-7) / 100;

// ── 名册解析 ──
const REQUIRED_HEADERS = ['last_name', 'first_name', 'ssn/ein', 'hourly_rate', 'hours'];
function parseRoster(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error('CSV 是空的');
  const headers = rows[0].map(h => String(h).trim().toLowerCase());
  const col = name => headers.indexOf(name);
  for (const h of REQUIRED_HEADERS) {
    if (col(h) < 0) throw new Error(`这不是 Gusto contractor payment 模板：缺少「${h}」列（需要 ${REQUIRED_HEADERS.join(' / ')}）`);
  }
  const cols = {
    last: col('last_name'), first: col('first_name'), business: col('business_name'),
    ssn: col('ssn/ein'), rate: col('hourly_rate'), hours: col('hours'),
    fixed: col('fixed_amount'), bonus: col('bonus'), note: col('note'),
  };
  const entries = rows.slice(1).map((cells, i) => {
    const last = String(cells[cols.last] || '').trim();
    const first = String(cells[cols.first] || '').trim();
    const business = cols.business >= 0 ? String(cells[cols.business] || '').trim() : '';
    const rate = parseFloat(cells[cols.rate]);
    return {
      idx: i, cells,
      label: business || `${last}, ${first}`.replace(/^, |, $/g, ''),
      ssn: String(cells[cols.ssn] || '').trim(),
      rate: Number.isFinite(rate) && rate > 0 ? rate : null,
      tokens: business ? nameTokens(business) : nameTokens(first, last),
      lastTokens: business ? nameTokens(business) : nameTokens(last),
      isBusiness: !!business && !last && !first,
    };
  }).filter(e => e.tokens.size);
  if (!entries.length) throw new Error('模板里没有任何合同工行');
  // 每个词出现在几个名册行里（低档位匹配只认全名册唯一的姓氏词）
  const tokenCount = new Map();
  for (const e of entries) for (const t of e.tokens) tokenCount.set(t, (tokenCount.get(t) || 0) + 1);
  return { headerRow: rows[0], cols, entries, tokenCount };
}

// ── 生成 ──
// employees: [{ name, total, rate, regHours, otHours }]（发票生成器的行, total = 应付工资）
// 返回 { csv, matches, unmatched, ambiguous, warnings, matchedCount, totalPay, untouched }
function buildGustoCsv(templateCsv, employees, opts) {
  opts = opts || {};
  const mode = opts.mode === 'hours' ? 'hours' : 'bonus';
  const roster = parseRoster(templateCsv);
  const warnings = [];
  const byRosterIdx = new Map();   // roster idx → { entry, sources: [{name, owed, rate, fuzzy}] }
  const unmatched = [], ambiguous = [];

  for (const emp of employees || []) {
    const name = String(emp.name || '').trim();
    const owed = r2(Number(emp.total) || 0);
    if (!name || owed <= 0) continue;
    const empT = nameTokens(name);
    let best = 0, hits = [];
    for (const entry of roster.entries) {
      const sc = matchScore(empT, entry, roster.tokenCount);
      if (sc > best) { best = sc; hits = [entry]; }
      else if (sc === best && sc > 0) hits.push(entry);
    }
    if (!best) { unmatched.push({ name, owed }); continue; }
    if (hits.length > 1) {
      ambiguous.push({ name, owed, candidates: hits.map(h => h.label) });
      continue;
    }
    const entry = hits[0];
    if (!byRosterIdx.has(entry.idx)) byRosterIdx.set(entry.idx, { entry, sources: [] });
    byRosterIdx.get(entry.idx).sources.push({
      name, owed,
      rate: Number(emp.rate) || null,
      actualHours: r2((Number(emp.regHours) || 0) + (Number(emp.otHours) || 0)),
      fuzzy: best === 50,
    });
  }

  // 填 hours / fixed_amount, 其余单元格原样保留
  const outRows = [roster.headerRow];
  const matches = [];
  let totalPay = 0;
  for (const entry of roster.entries) {
    const cells = entry.cells.slice();
    while (cells.length < roster.headerRow.length) cells.push('');
    const m = byRosterIdx.get(entry.idx);
    if (m) {
      const owed = r2(m.sources.reduce((s, x) => s + x.owed, 0));
      let hours = null, bonus = null, fixed = null, amount;
      if (entry.rate) {
        // bonus 口径: hours = 实际工时, 差额（加班溢价 + 时薪差）放 bonus。
        // 用不了就退回 hours 口径: 缺实际工时、模板没有 bonus 列、或 bonus 会是负数。
        const actual = r2(m.sources.reduce((s, x) => s + (x.actualHours || 0), 0));
        if (mode === 'bonus' && actual > 0 && roster.cols.bonus >= 0) {
          const base = r2(actual * entry.rate);
          const b = r2(owed - base);
          if (b >= 0) {
            hours = actual;
            amount = r2(base + b);
            cells[roster.cols.hours] = hours.toFixed(2);
            if (b > 0) { bonus = b; cells[roster.cols.bonus] = b.toFixed(2); }
          } else {
            warnings.push(`「${entry.label}」按实际工时 ${actual.toFixed(2)}h × 名册时薪 $${entry.rate} 已超过应付 $${owed.toFixed(2)}（名册时薪偏高），这行改按金额折算工时。`);
          }
        }
        if (hours == null) {
          hours = ceil2(owed / entry.rate);
          amount = r2(hours * entry.rate);
          cells[roster.cols.hours] = hours.toFixed(2);
        }
      } else {
        fixed = owed;
        amount = owed;
        if (roster.cols.fixed >= 0) cells[roster.cols.fixed] = owed.toFixed(2);
        else cells[roster.cols.hours] = ''; // 没有 fixed_amount 列又没时薪 → 只能报警告
      }
      totalPay = r2(totalPay + amount);
      matches.push({
        label: entry.label, ssn: entry.ssn, rate: entry.rate,
        hours, bonus, fixed, amount, diff: r2(amount - owed),
        sources: m.sources,
        merged: m.sources.length > 1,
      });
      if (!entry.rate && roster.cols.fixed < 0) {
        warnings.push(`「${entry.label}」名册里没有时薪，模板又没有 fixed_amount 列，$${owed.toFixed(2)} 没法填，请在 Gusto 手动支付。`);
      }
      if (m.sources.length > 1) {
        warnings.push(`${m.sources.map(s => `${s.name} $${s.owed.toFixed(2)}`).join(' + ')} 已合并付给「${entry.label}」，共 $${owed.toFixed(2)}。`);
      }
      for (const s of m.sources) {
        if (s.fuzzy) warnings.push(`「${s.name}」按近似拼写对到了名册的「${entry.label}」，请核对是否同一人。`);
        if (s.rate && entry.rate && Math.abs(s.rate - entry.rate) > 0.005) {
          warnings.push(`「${s.name}」工资表时薪 $${s.rate} ≠ Gusto 名册时薪 $${entry.rate}（${entry.label}），已按应付金额折算工时。`);
        }
      }
    }
    outRows.push(cells);
  }

  for (const u of unmatched) warnings.push(`「${u.name}」（应付 $${u.owed.toFixed(2)}）在 Gusto 名册里找不到，请在 Gusto 添加后重新生成，或手动支付。`);
  for (const a of ambiguous) warnings.push(`「${a.name}」（应付 $${a.owed.toFixed(2)}）在名册里有多个可能匹配（${a.candidates.join('、')}），没敢自动填，请手动处理。`);

  const ps = String(opts.period_start || '').trim(), pe = String(opts.period_end || '').trim();
  const filename = 'gusto_contractor_pay' + (ps && pe ? `_${ps}_${pe}` : '') + '.csv';
  return {
    csv: stringifyCsv(outRows),
    filename,
    mode,
    matches, unmatched, ambiguous, warnings,
    matchedCount: matches.length,
    untouched: roster.entries.length - matches.length,
    totalPay,
  };
}

module.exports = { buildGustoCsv, parseRoster, parseCsv, stringifyCsv };
