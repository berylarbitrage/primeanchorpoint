const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const fontPath = path.join(__dirname, '../fonts/NotoSansSC-Regular.ttf');
const outputPath = path.join(__dirname, '../sop-job-management.pdf');

const doc = new PDFDocument({
  size: 'A4',
  margins: { top: 56, bottom: 56, left: 56, right: 56 },
  bufferPages: true,
});
doc.pipe(fs.createWriteStream(outputPath));
doc.registerFont('CN', fontPath);

const PW = doc.page.width;
const PH = doc.page.height;
const ML = 56, MR = 56, MT = 56, MB = 56;
const CW = PW - ML - MR; // content width = 483

// ── colour palette ──────────────────────────────────────────────────────────
const C = {
  amber:  '#b45309', amberDk: '#92400e', amberLt: '#fef3c7',
  blue:   '#1d4ed8', blueLt:  '#eff6ff',
  red:    '#dc2626', redLt:   '#fef2f2',
  green:  '#065f46', greenLt: '#f0fdf4',
  purple: '#5B21B6', purpleLt:'#f5f3ff',
  gray:   '#9BA3B0', grayDk:  '#374151', grayLt:  '#f3f4f6',
  text:   '#1a1a1a', sub:     '#6b7280',
};

// ── low-level helpers ────────────────────────────────────────────────────────
function cx() { return doc.x; }
function cy() { return doc.y; }
function setCY(y) { doc.y = y; }
function ensureSpace(needed) {
  if (doc.y + needed > PH - MB) doc.addPage();
}

function hline(y, color = C.amberLt, lw = 0.8) {
  doc.moveTo(ML, y).lineTo(ML + CW, y).lineWidth(lw).strokeColor(color).stroke();
}

// ── page header/footer (added at end via bufferPages) ───────────────────────
function drawRunningHeader() {
  doc.font('CN').fontSize(7.5).fillColor(C.gray)
    .text('Prime Anchor Workforce — 内部操作手册 (SOP)', ML, 22, { width: CW, align: 'left' });
}

// ── Section title bar ────────────────────────────────────────────────────────
function sectionBar(label, secNum, color = C.amberDk) {
  ensureSpace(36);
  const y = doc.y + 6;
  doc.rect(ML, y, CW, 26).fillColor(color).fill();
  doc.font('CN').fontSize(11).fillColor('#fff')
    .text(`${secNum}  ${label}`, ML + 10, y + 7, { width: CW - 10 });
  doc.y = y + 36;
}

// ── Callout / note box ───────────────────────────────────────────────────────
function callout(text, bg = C.amberLt, fg = C.amberDk) {
  ensureSpace(34);
  const y = doc.y + 2;
  const linesApprox = Math.ceil(text.length / 70);
  const h = Math.max(30, linesApprox * 13 + 14);
  doc.rect(ML, y, CW, h).fillColor(bg).fill();
  doc.rect(ML, y, 3, h).fillColor(fg).fill();
  doc.font('CN').fontSize(8.5).fillColor(fg)
    .text(text, ML + 10, y + 8, { width: CW - 14 });
  doc.y = y + h + 6;
}

// ── Numbered step ────────────────────────────────────────────────────────────
function step(num, title, bullets = []) {
  ensureSpace(40 + bullets.length * 14);
  const y = doc.y + 4;
  const circR = 9;
  doc.circle(ML + circR, y + circR, circR).fillColor(C.amber).fill();
  doc.font('CN').fontSize(9).fillColor('#fff')
    .text(String(num), ML, y + 4, { width: circR * 2, align: 'center' });
  doc.font('CN').fontSize(10).fillColor(C.text)
    .text(title, ML + circR * 2 + 6, y + 2, { width: CW - circR * 2 - 6 });
  if (bullets.length) {
    for (const b of bullets) {
      ensureSpace(16);
      doc.font('CN').fontSize(8.5).fillColor(C.sub)
        .text('• ' + b, ML + circR * 2 + 10, doc.y + 1, { width: CW - circR * 2 - 14 });
    }
  }
  doc.y += 6;
}

// ── Two-column field list ────────────────────────────────────────────────────
function fieldTable(rows) {
  for (const [label, desc] of rows) {
    ensureSpace(16);
    const y = doc.y + 1;
    doc.font('CN').fontSize(8.5).fillColor(C.amber)
      .text(label, ML + 4, y, { width: 138, lineBreak: false });
    doc.font('CN').fontSize(8.5).fillColor(C.grayDk)
      .text(desc, ML + 148, y, { width: CW - 152 });
    hline(doc.y + 1, '#e5e7eb', 0.4);
    doc.y += 3;
  }
}

// ── Simple table ─────────────────────────────────────────────────────────────
function simpleTable(headers, rows, colWidths) {
  ensureSpace(24 + rows.length * 20);
  let y = doc.y + 4;
  const totalW = colWidths.reduce((a, b) => a + b, 0);
  // header
  doc.rect(ML, y, totalW, 20).fillColor(C.amberLt).fill();
  let x = ML + 6;
  for (let i = 0; i < headers.length; i++) {
    doc.font('CN').fontSize(8).fillColor(C.amberDk)
      .text(headers[i], x, y + 5, { width: colWidths[i] - 8, lineBreak: false });
    x += colWidths[i];
  }
  y += 20;
  for (let r = 0; r < rows.length; r++) {
    const rowH = 20;
    doc.rect(ML, y, totalW, rowH).fillColor(r % 2 === 0 ? '#fff' : '#fafafa').fill();
    x = ML + 6;
    for (let i = 0; i < rows[r].length; i++) {
      doc.font('CN').fontSize(8).fillColor(C.grayDk)
        .text(rows[r][i], x, y + 5, { width: colWidths[i] - 8, lineBreak: false });
      x += colWidths[i];
    }
    y += rowH;
  }
  doc.rect(ML, doc.y + 4, totalW, y - doc.y - 4).strokeColor('#e2e5ea').lineWidth(0.5).stroke();
  doc.y = y + 6;
}

// ════════════════════════════════════════════════════════════════════════════
// PAGE 1 — Cover
// ════════════════════════════════════════════════════════════════════════════
// amber top bar
doc.rect(0, 0, PW, 8).fillColor(C.amber).fill();

// logo text
doc.font('CN').fontSize(18).fillColor(C.amberDk)
  .text('Prime Anchor Workforce', ML, 70, { align: 'center', width: CW });
doc.font('CN').fontSize(9).fillColor(C.amber)
  .text('Internal Standard Operating Procedure', ML, 96, { align: 'center', width: CW });

// main title box
doc.rect(ML, 118, CW, 88).fillColor(C.amberLt).fill();
doc.rect(ML, 118, 4, 88).fillColor(C.amber).fill();
doc.font('CN').fontSize(22).fillColor(C.amberDk)
  .text('职位管理操作手册', ML, 138, { align: 'center', width: CW });
doc.font('CN').fontSize(10.5).fillColor(C.amber)
  .text('创建职位 · 设置隐藏 · 关联可入职员工', ML, 172, { align: 'center', width: CW });

// meta grid
doc.y = 228;
const meta = [
  ['文档编号', 'PAW-SOP-003'],
  ['版本',     'v2.0'],
  ['适用系统', 'Prime Anchor Workforce 管理后台'],
  ['适用角色', '管理员 (Admin) / 操作员 (Staff)'],
  ['生效日期', new Date().toLocaleDateString('zh-CN')],
];
for (const [k, v] of meta) {
  const y = doc.y;
  doc.font('CN').fontSize(8.5).fillColor(C.amber)
    .text(k + '：', ML + 8, y, { width: 80, lineBreak: false });
  doc.font('CN').fontSize(8.5).fillColor(C.text)
    .text(v, ML + 92, y, { width: CW - 100 });
}

// divider
doc.y += 10;
hline(doc.y, C.amberLt, 1);
doc.y += 12;

// TOC
doc.font('CN').fontSize(10).fillColor(C.amberDk).text('目  录', ML, doc.y);
doc.y += 10;
const toc = [
  ['第一节', '创建职位（Create a Job Posting）',               '2'],
  ['第二节', '设置职位为隐藏（Set to Private / Hidden）',       '3'],
  ['第三节', '查找可入职员工并关联职位',                        '4'],
  ['第四节', '从员工列表直接安排职位',                          '5'],
  ['附　录', '常见问题（FAQ）',                                  '5'],
];
for (const [sec, title, pg] of toc) {
  const y = doc.y + 1;
  doc.font('CN').fontSize(9).fillColor(C.amber)
    .text(sec, ML + 4, y, { width: 52, lineBreak: false });
  doc.font('CN').fontSize(9).fillColor(C.text)
    .text(title, ML + 60, y, { width: CW - 100, lineBreak: false });
  doc.font('CN').fontSize(9).fillColor(C.gray)
    .text(`第 ${pg} 页`, ML, y, { width: CW, align: 'right' });
}

// bottom bar
doc.rect(0, PH - 8, PW, 8).fillColor(C.amberLt).fill();

// ════════════════════════════════════════════════════════════════════════════
// PAGE 2 — Section 1: Create Job
// ════════════════════════════════════════════════════════════════════════════
doc.addPage();
doc.y = MT;

sectionBar('创建职位  Create a Job Posting', '第一节', C.blue);
callout('前提：必须以管理员（Admin）或操作员（Staff）账号登录管理后台。', C.blueLt, C.blue);

step(1, '进入职位管理', [
  '在左侧导航栏展开"招聘管理"分组，点击"职位管理"进入职位列表。',
]);
step(2, '点击"+ 新增职位"按钮', [
  '页面右上角橙色按钮，点击后弹出职位创建表单。',
]);
step(3, '填写职位表单', ['以下为主要填写项：']);

fieldTable([
  ['合作公司 *',     '搜索框输入公司名称，从下拉列表中选择'],
  ['工种类别',       '从下拉列表选择（也可选"其他"自定义）'],
  ['职位类型',       '全职 / 兼职 / 临时工 / 临时转正'],
  ['工作地点',       '填写街道、城市、州、邮编，点击"验证地址"确认'],
  ['雇佣性质',       'W2 / Contract / 1099 / W2+Contract'],
  ['薪资',           '固定或区间方式；填写金额并选择单位（/hr /day…）'],
  ['语言',           '勾选语言后填写对应标题及职位介绍（中/英/西班牙文）'],
  ['班次 *',         '勾选班次（早/中/晚/夜/弹性），系统会展开时间填写栏'],
  ['福利待遇',       '点击标签多选（医疗保险、401k、带薪休假等）'],
  ['招聘人数',       '填写招募人数；勾选"急聘"则在招聘板上显示标记'],
]);

step(4, '保存职位', [
  '点击表单底部橙色"保存"按钮。',
  '系统自动生成唯一职位编号（Job ID），默认状态为"在招（Open）"且公开可见。',
]);

callout('提示：若不希望该职位出现在公开招聘板，请参阅第二节"设置隐藏"。', C.amberLt, C.amberDk);

// ════════════════════════════════════════════════════════════════════════════
// PAGE 3 — Section 2: Set Hidden
// ════════════════════════════════════════════════════════════════════════════
doc.addPage();
doc.y = MT;

sectionBar('设置职位为隐藏  Set to Private / Hidden', '第二节', C.red);
callout(
  '"隐藏"将职位从公开招聘板移除，后台管理与员工关联操作不受影响。' +
  '适用于内部专属职位、已满岗暂未关闭的职位或测试职位。',
  C.redLt, C.red
);

step(1, '在职位列表找到目标职位', ['可用搜索框按名称、公司或地点筛选。']);
step(2, '点击操作列中的"🚫 隐藏"按钮', [
  '按钮为灰色样式，点击后立即生效，无需额外确认。',
  '系统后台将该职位的 visible 字段设为 0。',
]);
step(3, '确认隐藏状态', [
  '状态列新增红色"隐藏"标签。',
  '"🚫 隐藏"按钮变为绿色"👁 显示"按钮。',
]);
step(4, '恢复公开（取消隐藏）', [
  '点击绿色"👁 显示"按钮即可一键恢复，逻辑与隐藏完全对称。',
]);

doc.y += 4;
simpleTable(
  ['按钮显示', '当前可见状态', '求职者能否在招聘板看到'],
  [
    ['🚫 隐藏（灰色）', '公开（Visible = 1）', '✅ 可见'],
    ['👁 显示（绿色）', '隐藏（Visible = 0）', '❌ 不可见'],
  ],
  [160, 160, CW - 320]
);

callout('所有隐藏 / 显示操作均记录在该职位的操作历史中，可通过"历史"按钮随时查询。', C.greenLt, C.green);

// ════════════════════════════════════════════════════════════════════════════
// PAGE 4 — Section 3: Find onboarded workers and link to job
// ════════════════════════════════════════════════════════════════════════════
doc.addPage();
doc.y = MT;

sectionBar('查找可入职员工并关联职位', '第三节', C.purple);
callout(
  '"可入职（✅ 可入职）"状态：员工已在工人账户中完成全部入职任务（W9/合同/I-9 等），' +
  '系统自动将其标记为 onboarded = 1。此类员工可直接派工或关联职位。',
  C.purpleLt, C.purple
);

step(1, '进入"工人账户"页面', [
  '左侧导航 → 招聘管理 → 工人账户（Worker Accounts）。',
]);
step(2, '识别"可入职"工人', [
  '状态列显示紫色"✅ 可入职"标签的工人即已完成入职流程，随时可派工。',
  '状态为"✅ 正常"表示账户已激活但入职任务尚未全部完成。',
  '状态为"⏳ 待验证"表示账户尚未通过手机验证，无法派工。',
]);
step(3, '（首次使用）转为员工档案', [
  '若该工人尚未绑定员工档案（姓名下方显示"未绑定员工"），需先点击入职进度弹窗中的"🔄 转员工"按钮。',
  '系统会自动创建员工记录，并将工人账户与员工档案绑定。',
  '绑定后员工姓名列会显示员工编号（如 EMP-001）。',
]);
step(4, '点击"📤 派工"按钮关联职位', [
  '工人账户列表 → 找到目标工人 → 点击操作列中的"📤 派工"按钮。',
  '在弹出的"派工"面板中选择目标职位、填写班次日期，保存后即完成关联。',
  '"📤 派工"按钮仅在该工人已绑定员工档案时才显示。',
]);
step(5, '或通过入职弹窗操作', [
  '点击"✅ 可入职"按钮打开入职进度弹窗，弹窗底部有"派工"快捷操作区，',
  '可在同一界面完成查看入职状态与安排工作的操作。',
]);

callout(
  '工人状态速查：待验证 → 手动激活或重发验证 | 正常（未完成入职）→ 推动完成任务 | 可入职 → 可派工/关联职位 | 暂停 → 需恢复后方可派工',
  C.amberLt, C.amberDk
);

// ════════════════════════════════════════════════════════════════════════════
// PAGE 5 — Section 4: Assign job from employee list + FAQ
// ════════════════════════════════════════════════════════════════════════════
doc.addPage();
doc.y = MT;

sectionBar('从员工列表直接安排职位', '第四节', C.green);
callout('此方法适用于员工档案已存在的情况，直接在员工管理页面创建工作记录（含薪资和绩效数据）。', C.greenLt, C.green);

step(1, '进入"员工管理"页面', ['左侧导航 → 员工管理，进入员工列表。']);
step(2, '找到目标员工并点击"📋 安排职位"', [
  '每行操作区有橙色"📋 安排职位"按钮，点击弹出"工作记录"对话框。',
  '也可点击行末"..."菜单 → 安排职位。',
]);
step(3, '填写工作记录', ['在弹窗中依次填写：']);

fieldTable([
  ['选择职位 *',    '从下拉列表中选择，选中后自动显示公司名称和工作地点'],
  ['开始日期',      '员工在该职位的实际工作开始日期'],
  ['结束日期',      '实际或预计结束日期（可暂时留空）'],
  ['员工薪资',      '员工时薪、总工时、总薪酬（用于薪资核算）'],
  ['客户计费',      '向客户收取的时薪和总金额（用于利润核算）'],
  ['绩效评分',      '效率 / 质量 / 出勤 / 安全 / 团队合作 / 技能，各 1-5 星'],
  ['备注',          '工作表现、优缺点等补充说明（可选）'],
]);

step(4, '保存关联', [
  '点击弹窗底部"确认"按钮，系统保存工作记录。',
  '员工列表中该员工的"职位"列将同步更新为最新活跃职位名称。',
  '再次打开弹窗时，顶部蓝色标签会列出该员工所有历史工作记录，点击可编辑。',
]);

doc.y += 8;
sectionBar('常见问题  FAQ', '附　录', C.gray);

const faqs = [
  ['Q  隐藏职位后，已提交的申请会消失吗？',
   'A  不会。隐藏仅影响公开招聘板的展示，后台申请记录完整保留，管理员可继续处理。'],
  ['Q  "可入职"和"可派工"有什么区别？',
   'A  "可入职（onboarded）"代表入职材料已全部完成；"可派工（dispatch_ready）"是管理员额外确认的班次派遣就绪标志，需在入职弹窗中手动开启。'],
  ['Q  为什么"📤 派工"按钮不显示？',
   'A  该工人尚未绑定员工档案。请先点击"🔄 转员工"完成绑定，派工按钮即出现。'],
  ['Q  一名员工能关联多个职位吗？',
   'A  可以。工作记录不限数量，历史和并行记录均支持，系统以最新活跃记录为主显示职位名称。'],
  ['Q  职位能删除吗？',
   'A  仅"关闭原因=测试（test）"的职位才能删除。正式职位建议改为关闭状态以保留历史记录。'],
];

for (const [q, a] of faqs) {
  ensureSpace(44);
  const y = doc.y + 2;
  doc.rect(ML, y, CW, 40).fillColor('#fafafa').fill();
  doc.font('CN').fontSize(8.5).fillColor(C.purple).text(q, ML + 8, y + 6, { width: CW - 14 });
  doc.font('CN').fontSize(8.5).fillColor(C.grayDk).text(a, ML + 8, doc.y + 2, { width: CW - 14 });
  doc.y += 6;
  hline(doc.y, '#e5e7eb', 0.4);
  doc.y += 3;
}

// ── Footer line ──────────────────────────────────────────────────────────────
ensureSpace(24);
doc.y += 8;
hline(doc.y, C.amberLt, 0.8);
doc.y += 5;
doc.font('CN').fontSize(7.5).fillColor(C.gray)
  .text('本文档由 Prime Anchor Workforce 系统自动生成，如有疑问请联系系统管理员。', ML, doc.y, { align: 'center', width: CW });

// ── Running headers & page numbers ──────────────────────────────────────────
const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i++) {
  doc.switchToPage(range.start + i);
  if (i > 0) drawRunningHeader();
  doc.font('CN').fontSize(7.5).fillColor(C.gray)
    .text(`第 ${i + 1} 页 / 共 ${range.count} 页`, ML, PH - 38, { align: 'center', width: CW });
}

doc.end();
console.log('PDF 已生成：', outputPath);
