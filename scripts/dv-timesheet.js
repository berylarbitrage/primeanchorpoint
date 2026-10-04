'use strict';

// ─── DV Fulfillment LLC 周时间表 → 可上传的发票 Excel ─────────────────────────
// 用法: node scripts/dv-timesheet.js <hours.json> [输出目录]
//
// hours.json 例子 (见 scripts/dv-timesheet.example.json):
//   {
//     "start": "2026-09-28",          // 本周第一天 (周一), 账期 = start ~ start+6
//     "rate": 18, "markup": 0.25,     // 可选, 覆盖下面 DV_PROFILE 的默认时薪 / Markup
//     "employees": [
//       { "name": "Kyontez Toney", "hours": [8, 8, 0, 0, 0, null, null] }  // 周一~周日, 空 = 没排班
//     ]
//   }
//
// 生成的 .xlsx 第一页「Invoice Upload」是发票生成器已经认识的 payroll 格式
// (Warehouse Location | Employee | Type | Pay Period | Regular Pay Rate | ...),
// 金额全部写成数值 (不是公式), 上传「导入 Excel」即可自动带出员工 / 工时 / 时薪 / Markup。
// 第二页「Daily Hours」是每天工时明细 (和 DV 发来的表一样), 方便核对。
// 一周超过 40 小时的部分算 OT (×1.5)。

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DV_PROFILE = {
  company: 'DV Fulfillment LLC',
  warehouse: 'DV Fulfillment',
  type: 'General Labor',
  rate: null,      // 默认时薪, 未定就在 hours.json 里给 "rate"
  markup: null,    // 默认 Markup (小数, 0.25 = 25%)
  otMultiplier: 1.5,
  otThreshold: 40, // 周工时超过这个数的部分算 OT
};

const r2 = n => Math.round(n * 100) / 100;
const mdy = d => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
const md = d => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
const iso = d => d.toISOString().slice(0, 10);

function build(input) {
  const start = new Date(input.start + 'T00:00:00Z');
  if (Number.isNaN(start.getTime())) throw new Error('start 日期无效: ' + input.start);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setUTCDate(d.getUTCDate() + i); return d; });
  const period = `${mdy(days[0])} - ${mdy(days[6])}`;
  const rate = input.rate != null ? +input.rate : DV_PROFILE.rate;
  const markup = input.markup != null ? +input.markup : DV_PROFILE.markup;
  const otRate = rate != null ? r2(rate * DV_PROFILE.otMultiplier) : null;

  const upload = [[
    'Warehouse Location', 'Employee', 'Type', 'Pay Period', 'Regular Pay Rate', 'OT Pay Rate',
    'Reg Working Hours', 'OT Hours', 'Reg Pay Amount', 'OT Pay Amount', 'Total Pay Amount',
    'Mark Up Rate', 'Total Amount After Mark Up',
  ]];
  const daily = [['Name', ...days.map(md), 'TOTAL']];
  const sum = { reg: 0, ot: 0, regPay: 0, otPay: 0, pay: 0, after: 0 };

  for (const e of input.employees || []) {
    const hrs = days.map((_, i) => { const v = (e.hours || [])[i]; return v == null || v === '' ? null : +v; });
    const total = hrs.reduce((s, v) => s + (v || 0), 0);
    daily.push([e.name, ...hrs.map(v => (v == null ? '' : v)), total]);
    if (!total) continue; // 本周没上班的不进发票
    const ot = Math.max(0, total - DV_PROFILE.otThreshold);
    const reg = total - ot;
    const row = [DV_PROFILE.warehouse, e.name, e.type || DV_PROFILE.type, period, rate ?? '', otRate ?? '', reg, ot];
    if (rate != null) {
      const regPay = r2(reg * rate), otPay = r2(ot * otRate), pay = r2(regPay + otPay);
      const after = markup != null ? r2(pay * (1 + markup)) : '';
      row.push(regPay, otPay, pay, markup ?? '', after);
      Object.assign(sum, { regPay: sum.regPay + regPay, otPay: sum.otPay + otPay, pay: sum.pay + pay, after: sum.after + (after || 0) });
    } else {
      row.push('', '', '', markup ?? '', '');
    }
    sum.reg += reg; sum.ot += ot;
    upload.push(row);
  }
  if (upload.length === 1) throw new Error('本周没有任何工时');
  upload.push(['', 'Total', '', '', '', '', sum.reg, sum.ot,
    rate != null ? r2(sum.regPay) : '', rate != null ? r2(sum.otPay) : '', rate != null ? r2(sum.pay) : '',
    '', markup != null && rate != null ? r2(sum.after) : '']);

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(upload);
  ws1['!cols'] = [20, 22, 14, 24, 10, 10, 10, 9, 12, 12, 12, 10, 14].map(w => ({ wch: w }));
  const ws2 = XLSX.utils.aoa_to_sheet(daily);
  ws2['!cols'] = [22, ...days.map(() => ({ wch: 11 })), { wch: 8 }].map(c => (typeof c === 'number' ? { wch: c } : c));
  XLSX.utils.book_append_sheet(wb, ws1, 'Invoice Upload');
  XLSX.utils.book_append_sheet(wb, ws2, 'Daily Hours');

  // 文件名带 MMDDMMDDYYYY 账期, 发票生成器也能从文件名认出服务周期
  const p2 = d => String(d).padStart(2, '0');
  const tag = `${p2(days[0].getUTCMonth() + 1)}${p2(days[0].getUTCDate())}${p2(days[6].getUTCMonth() + 1)}${p2(days[6].getUTCDate())}${days[6].getUTCFullYear()}`;
  return { wb, fileName: `DV_Fulfillment_Timesheet_${tag}.xlsx`, period: `${iso(days[0])} ~ ${iso(days[6])}`, rate, markup };
}

if (require.main === module) {
  const [inFile, outDir = '.'] = process.argv.slice(2);
  if (!inFile) { console.error('用法: node scripts/dv-timesheet.js <hours.json> [输出目录]'); process.exit(1); }
  const { wb, fileName, period, rate, markup } = build(JSON.parse(fs.readFileSync(inFile, 'utf8')));
  const out = path.join(outDir, fileName);
  XLSX.writeFile(wb, out);
  console.log(`已生成 ${out}  账期 ${period}`);
  if (rate == null) console.log('⚠ 没有时薪: 在 hours.json 加 "rate" (或改 DV_PROFILE.rate), 否则上传后要手动填时薪');
  if (markup == null) console.log('⚠ 没有 Markup: 在 hours.json 加 "markup" (如 0.25), 否则上传后要手动填 Markup');
}

module.exports = { build, DV_PROFILE };
