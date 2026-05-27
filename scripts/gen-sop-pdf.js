const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const fontPath = path.join(__dirname, '../fonts/NotoSansSC-Regular.ttf');
const outputPath = path.join(__dirname, '../sop-job-management.pdf');

const doc = new PDFDocument({
  size: 'A4',
  margins: { top: 60, bottom: 60, left: 60, right: 60 },
  bufferPages: true,
  info: {
    Title: 'SOP — 职位创建、设为隐藏及关联员工操作手册',
    Author: 'Prime Anchor Workforce',
  }
});

doc.pipe(fs.createWriteStream(outputPath));
doc.registerFont('CN', fontPath);

// ─── Helpers ────────────────────────────────────────────────────────────────
const W = doc.page.width - 120; // usable width

function header() {
  doc.font('CN').fontSize(9).fillColor('#b45309')
    .text('Prime Anchor Workforce — 内部操作手册 (SOP)', 60, 20, { align: 'left', width: W });
  doc.fontSize(9).fillColor('#b45309')
    .text(`生成日期：${new Date().toLocaleDateString('zh-CN')}`, 60, 20, { align: 'right', width: W });
}

function sectionTitle(text, color = '#92400e') {
  doc.moveDown(0.6);
  doc.font('CN').fontSize(14).fillColor(color).text(text);
  // underline
  const y = doc.y;
  doc.moveTo(60, y).lineTo(60 + W, y).lineWidth(1).strokeColor(color).stroke();
  doc.moveDown(0.4);
}

function stepBox(num, title, lines, color = '#b45309') {
  const boxX = 60, boxY = doc.y;
  const circleR = 12;

  // number circle
  doc.circle(boxX + circleR, boxY + circleR, circleR).fillColor(color).fill();
  doc.font('CN').fontSize(11).fillColor('#fff')
    .text(String(num), boxX, boxY + 6, { width: circleR * 2, align: 'center' });

  // title
  doc.font('CN').fontSize(11).fillColor('#1a1a1a')
    .text(title, boxX + circleR * 2 + 8, boxY + 4, { width: W - circleR * 2 - 8 });

  // content lines
  doc.font('CN').fontSize(9.5).fillColor('#444');
  for (const line of lines) {
    doc.text(line, boxX + circleR * 2 + 8, doc.y + 3, { width: W - circleR * 2 - 8 });
  }
  doc.moveDown(0.6);
}

function note(text, bgColor = '#fef3c7', textColor = '#92400e') {
  const noteX = 60, noteY = doc.y;
  const noteH = 36;
  doc.roundedRect(noteX, noteY, W, noteH, 6).fillColor(bgColor).fill();
  doc.font('CN').fontSize(9).fillColor(textColor)
    .text(text, noteX + 12, noteY + 10, { width: W - 24 });
  doc.y = noteY + noteH + 6;
  doc.moveDown(0.3);
}

function fieldRow(label, desc) {
  doc.font('CN').fontSize(9.5).fillColor('#b45309').text(`• ${label}`, 80, doc.y, { continued: true, width: 160 });
  doc.fillColor('#444').text(`  ${desc}`, { width: W - 80 });
}

function pageBreakIfNeeded(neededPx = 120) {
  if (doc.y + neededPx > doc.page.height - 60) doc.addPage();
}

// ════════════════════════════════════════════════════════════════════════════
// PAGE 1 — Cover
// ════════════════════════════════════════════════════════════════════════════
header();

// Logo area (text-based)
doc.font('CN').fontSize(22).fillColor('#92400e')
  .text('Prime Anchor Workforce', 60, 90, { align: 'center', width: W });
doc.font('CN').fontSize(11).fillColor('#b45309')
  .text('内部操作手册 (Standard Operating Procedure)', 60, 120, { align: 'center', width: W });

// Divider
doc.moveTo(60, 148).lineTo(60 + W, 148).lineWidth(2).strokeColor('#f59e0b').stroke();

// Title block
doc.roundedRect(60, 165, W, 100, 10).fillColor('#fffbeb').fill();
doc.font('CN').fontSize(20).fillColor('#92400e')
  .text('职位管理操作手册', 60, 185, { align: 'center', width: W });
doc.font('CN').fontSize(11).fillColor('#b45309')
  .text('创建职位 · 设为隐藏 · 关联员工', 60, 215, { align: 'center', width: W });

// Meta info box
doc.y = 290;
const metaData = [
  ['文档编号', 'PAW-SOP-003'],
  ['版本',     'v1.0'],
  ['适用系统', 'Prime Anchor Workforce 管理后台 (admin.html)'],
  ['适用角色', '管理员 (Admin) / 操作员 (Staff)'],
  ['生成日期', new Date().toLocaleDateString('zh-CN')],
];
for (const [k, v] of metaData) {
  doc.font('CN').fontSize(9.5).fillColor('#92400e').text(`${k}：`, 80, doc.y, { continued: true, width: 100 });
  doc.fillColor('#1a1a1a').text(v, { width: W - 100 });
}

// TOC
doc.y = 460;
sectionTitle('目录 Table of Contents', '#92400e');
const toc = [
  ['第一节', '创建职位（Create a Job Posting）',           '2'],
  ['第二节', '设置职位为隐藏/私密（Set Private）',          '3'],
  ['第三节', '将职位关联至员工（Link Job to Employee）',    '4'],
  ['附录',   '常见问题与注意事项',                          '5'],
];
for (const [num, title, pg] of toc) {
  doc.font('CN').fontSize(10).fillColor('#b45309').text(`${num}  ${title}`, 80, doc.y, { continued: true, width: W - 60 });
  doc.fillColor('#9BA3B0').text(`第 ${pg} 页`, { align: 'right' });
}

// ════════════════════════════════════════════════════════════════════════════
// PAGE 2 — Section 1: Create Job
// ════════════════════════════════════════════════════════════════════════════
doc.addPage();
header();

doc.font('CN').fontSize(9).fillColor('#9BA3B0').text('第一节', 60, 60);
sectionTitle('创建职位 Create a Job Posting', '#1d4ed8');

note('前提条件：必须以管理员（Admin）或操作员（Staff）账号登录管理后台。', '#eff6ff', '#1d4ed8');

stepBox(1, '进入职位管理页面', [
  '登录管理后台后，在左侧导航栏找到"招聘管理"分组，',
  '点击下方"职位管理"进入职位列表页面。',
]);

stepBox(2, '点击"新增职位"按钮', [
  '页面右上角有橙色"+ 新增职位"按钮，点击后弹出职位创建表单。',
]);

stepBox(3, '填写职位基本信息', [
  '以下字段为必填或强烈建议填写：',
]);

// Field table
const fields = [
  ['合作公司 *',    '在搜索框输入公司名称，从下拉列表中选择对应合作公司'],
  ['工种类别',      '从下拉列表选择（如：仓库分拣员、打包员等）；选"其他"可自定义'],
  ['职位类型',      '全职 / 兼职 / 临时工 / 临时转正'],
  ['工作地点',      '填写街道地址、城市、州、邮编；点击"验证地址"按钮确认地址有效'],
  ['雇佣性质',      'W2 / Contract / 1099 / W2+Contract'],
  ['薪资',          '选择固定或范围方式，填入金额并选择单位（/hr, /day 等）'],
  ['语言',          '勾选职位描述语言（英文/中文/西班牙文），并填写对应标题和介绍'],
  ['班次',          '勾选适用班次（早班/中班/晚班/夜班/弹性），系统会展开时间填写栏'],
  ['福利待遇',      '点击对应标签选择（可多选）'],
  ['招聘人数',      '填写需要招募的人数'],
  ['急聘',          '勾选后在招聘板上会显示"急聘"标记'],
];
for (const [label, desc] of fields) {
  fieldRow(label, desc);
}

doc.moveDown(0.5);
stepBox(4, '保存职位', [
  '填写完毕后，点击底部橙色"保存"按钮。',
  '系统会自动生成唯一职位编号（Job ID）并保存至数据库。',
  '保存成功后职位默认状态为"在招（Open）"，同时默认对外公开可见。',
]);

note('⚠ 注意：若要在网站招聘板上对求职者隐藏该职位，请参阅第二节"设置为隐藏"。', '#fef9c3', '#92400e');

// ════════════════════════════════════════════════════════════════════════════
// PAGE 3 — Section 2: Set Private
// ════════════════════════════════════════════════════════════════════════════
doc.addPage();
header();

doc.font('CN').fontSize(9).fillColor('#9BA3B0').text('第二节', 60, 60);
sectionTitle('设置职位为隐藏（Private / Hidden）', '#dc2626');

note(
  '说明："隐藏"功能将职位从公开招聘板上移除，但不影响后台管理和员工关联操作。' +
  '适用于内部专属职位、已满岗但暂未关闭的职位，或测试用职位。',
  '#fef2f2', '#dc2626'
);

stepBox(1, '找到目标职位', [
  '在"职位管理"页面，找到需要隐藏的职位所在行。',
  '可使用搜索框按名称、公司或地点进行筛选。',
]);

stepBox(2, '点击"🚫 隐藏"按钮', [
  '每个职位行的操作列中有一个灰色的"🚫 隐藏"按钮。',
  '点击后系统会立即将该职位的可见状态切换为隐藏（visible = 0）。',
  '无需额外确认弹窗，操作即时生效。',
]);

stepBox(3, '确认隐藏状态', [
  '隐藏后，该职位行的状态列会新增一个红色"隐藏"标签。',
  '原"🚫 隐藏"按钮会变为绿色的"👁 显示"按钮。',
]);

stepBox(4, '恢复公开（取消隐藏）', [
  '若需要重新公开该职位，点击绿色"👁 显示"按钮即可恢复。',
  '操作方式与隐藏完全相同，为一键切换。',
]);

// Status chart
doc.moveDown(0.3);
pageBreakIfNeeded(140);
doc.font('CN').fontSize(10).fillColor('#1a1a1a').text('隐藏状态说明对照表：', 60, doc.y);
doc.moveDown(0.3);

const tableX = 60, colW = [120, 120, 200];
const headers2 = ['按钮显示', '当前状态', '求职者是否可见'];
const rows2 = [
  ['🚫 隐藏（灰色）', '公开（Visible）', '✅ 可见（显示在招聘板）'],
  ['👁 显示（绿色）', '隐藏（Hidden）',  '❌ 不可见（已从招聘板移除）'],
];
let ty = doc.y;
// header row bg
doc.rect(tableX, ty, W, 22).fillColor('#fef3c7').fill();
let cx = tableX + 8;
for (let i = 0; i < headers2.length; i++) {
  doc.font('CN').fontSize(9).fillColor('#92400e').text(headers2[i], cx, ty + 6, { width: colW[i] });
  cx += colW[i];
}
ty += 22;
for (const row of rows2) {
  doc.rect(tableX, ty, W, 22).fillColor(ty % 44 === 22 ? '#fffbeb' : '#fff').fill();
  cx = tableX + 8;
  for (let i = 0; i < row.length; i++) {
    doc.font('CN').fontSize(9).fillColor('#444').text(row[i], cx, ty + 6, { width: colW[i] });
    cx += colW[i];
  }
  ty += 22;
}
doc.rect(tableX, doc.y, W, ty - doc.y + 2).strokeColor('#e2e5ea').lineWidth(0.5).stroke();
doc.y = ty + 10;

note('此操作会记录在职位的操作历史（History）中，可通过"历史"按钮查询。', '#f0fdf4', '#065f46');

// ════════════════════════════════════════════════════════════════════════════
// PAGE 4 — Section 3: Link Employee
// ════════════════════════════════════════════════════════════════════════════
doc.addPage();
header();

doc.font('CN').fontSize(9).fillColor('#9BA3B0').text('第三节', 60, 60);
sectionTitle('将职位关联至员工 Link Job to Employee', '#065f46');

note('此操作记录员工在某一职位上的工作情况，包含起止日期、薪资数据和绩效评分，用于HR档案管理。', '#f0fdf4', '#065f46');

stepBox(1, '进入员工管理页面', [
  '在左侧导航栏点击"员工管理"，进入员工列表。',
]);

stepBox(2, '找到目标员工', [
  '可通过搜索框输入员工姓名或员工编号快速定位。',
]);

stepBox(3, '打开员工操作菜单', [
  '点击员工行右侧的操作按钮（或右键点击员工行），',
  '在弹出的菜单中选择"📋 安排职位"选项。',
]);

stepBox(4, '在弹窗中配置工作记录', [
  '弹出"工作记录"对话框后，按以下顺序填写：',
]);

const linkFields = [
  ['选择职位',      '从下拉列表中搜索并选择目标职位，选中后会显示公司名称和地点'],
  ['开始日期',      '填写员工在该职位的工作开始日期'],
  ['结束日期',      '填写实际或预计结束日期（可留空）'],
  ['员工薪资信息',  '填写员工时薪、总工时、总薪酬（用于薪资核算）'],
  ['客户计费信息',  '填写向客户收取的时薪和总金额（用于利润核算）'],
  ['绩效评分',      '对效率、质量、出勤、安全、团队合作、技能六项进行评分（1-5星）'],
  ['备注',          '可填写员工工作表现、优缺点等补充说明'],
];
for (const [label, desc] of linkFields) {
  fieldRow(label, desc);
}

doc.moveDown(0.5);
stepBox(5, '保存关联记录', [
  '填写完毕后点击"确认"按钮，系统将工作记录保存至数据库。',
  '员工档案中的"当前职位"栏位会同步更新显示该职位名称。',
]);

stepBox(6, '查看或编辑已有记录', [
  '再次打开"安排职位"弹窗时，顶部会列出该员工已有的工作记录（蓝色标签）。',
  '点击对应标签即可载入历史数据进行修改。',
]);

note('⚠ 一名员工可以关联多个职位记录（历史或并行），系统不限制数量。', '#fffbeb', '#b45309');

// ════════════════════════════════════════════════════════════════════════════
// PAGE 5 — Appendix
// ════════════════════════════════════════════════════════════════════════════
doc.addPage();
header();

doc.font('CN').fontSize(9).fillColor('#9BA3B0').text('附录', 60, 60);
sectionTitle('常见问题与注意事项 FAQ & Notes', '#5B21B6');

const faqs = [
  {
    q: '隐藏职位后，之前已提交申请的求职者会受影响吗？',
    a: '不会。隐藏操作仅影响职位在公开招聘板的可见性，已存在的申请记录不会被删除，管理员仍可在后台正常处理。',
  },
  {
    q: '新建职位后为什么招聘板上没有显示？',
    a: '请检查：(1) 职位状态是否为"在招（Open）"；(2) 职位可见状态是否为公开（非隐藏）；(3) 联系技术支持确认招聘板数据已同步。',
  },
  {
    q: '"关联职位"和"派工（Assignment）"有什么区别？',
    a: '"关联职位（员工工作记录）"用于HR档案，记录该员工历史工作的职位、薪酬和绩效。"派工"是为员工创建具体班次/排班计划，通过派工管理模块操作。',
  },
  {
    q: '能否删除职位？',
    a: '系统仅允许删除关闭原因为"测试（test）"的职位。正式职位建议通过关闭（Close）操作下架，而非删除，以保留历史记录。',
  },
  {
    q: '操作历史可以查看吗？',
    a: '可以。在职位列表点击对应职位的"历史"按钮，可查看该职位的所有创建、编辑、开放、关闭、隐藏、显示等操作记录，包括操作人和时间。',
  },
];

for (const faq of faqs) {
  pageBreakIfNeeded(80);
  doc.font('CN').fontSize(10).fillColor('#5B21B6').text(`Q: ${faq.q}`, 60, doc.y, { width: W });
  doc.moveDown(0.2);
  doc.font('CN').fontSize(9.5).fillColor('#374151').text(`A: ${faq.a}`, 72, doc.y, { width: W - 12 });
  doc.moveDown(0.7);
}

// Closing line
pageBreakIfNeeded(60);
doc.moveTo(60, doc.y).lineTo(60 + W, doc.y).lineWidth(1).strokeColor('#fde68a').stroke();
doc.moveDown(0.5);
doc.font('CN').fontSize(8.5).fillColor('#9BA3B0')
  .text('本文档由 Prime Anchor Workforce 系统自动生成，如有疑问请联系系统管理员。', 60, doc.y, { align: 'center', width: W });

// ─── Page numbers ────────────────────────────────────────────────────────────
const totalPages = doc.bufferedPageRange().count;
for (let i = 0; i < totalPages; i++) {
  doc.switchToPage(i);
  doc.font('CN').fontSize(8).fillColor('#9BA3B0')
    .text(`第 ${i + 1} 页 / 共 ${totalPages} 页`, 60, doc.page.height - 40, { align: 'center', width: W });
}

doc.end();
console.log('PDF 已生成：', outputPath);
