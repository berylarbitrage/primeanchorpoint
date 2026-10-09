// Bintique Liquidation — frontend
// 一拖弃货 = 一条 lot: 成本 (货款+运费+人工+其他) / 卖给谁 / 卖了多少 / 收了多少
'use strict';

// ---------- i18n ----------
const I18N = {
  zh: {
    login_sub: '弃货管理系统', username: '用户名', password: '密码', sign_in: '登录', sign_out: '退出登录',
    dashboard: '总览', lots: '弃货库存', sales: '销售记录', receivables: '待收款', suppliers: '货源', customers: '买家', users: '用户',
    monthly_pl: '每月 销售额 / 成本 / 毛利', lot_status: '货物状态', top_customers: '买家排行 (销售额)', top_suppliers: '货源排行 (毛利)',
    recent_sales: '最近成交', search: '搜索...', export_csv: '导出 CSV', new_lot: '+ 新增一拖', add_supplier: '+ 新增货源', add_customer: '+ 新增买家', add_user: '+ 新增用户',
    th_lot: '批次号', th_desc: '货物描述', th_customer: '卖给', th_supplier: '货源', th_sale: '成交价', th_cost: '总成本', th_profit: '毛利', th_margin: '毛利率',
    th_sold_date: '成交日期', th_acq_date: '进货日期', th_qty: '数量', th_status: '状态', th_asking: '标价', th_received: '已收', th_balance: '未收', th_payment: '收款', th_category: '品类', th_location: '仓位', th_days: '库龄(天)',
    display_name: '名称', role: '角色', created: '创建时间', contact: '联系人', phone: '电话', email: '邮箱', address: '地址', notes: '备注', name: '名称',
    loads_bought: '进货拖数', loads_sold: '已售拖数', total_spent: '进货总额', total_revenue: '销售总额',
    backup_title: '下载完整备份', backup_desc: '把所有货源、买家和弃货批次导出成 JSON 文件。', download_backup: '下载备份',
    all_time: '全部年份', all_months: '全部月份', all_status: '全部状态', all_suppliers: '全部货源', all_customers: '全部买家',
    st_in_stock: '在库', st_listed: '已挂售', st_sold: '已售', st_cancelled: '作废',
    pay_paid: '已收清', pay_partial: '部分收款', pay_unpaid: '未收款',
    lt_pallet: '板 (Pallet)', lt_truckload: '车 (Truckload)', lt_box: '箱 (Box)', lt_gaylord: 'Gaylord',
    s_inventory: '在库拖数', s_inv_cost: '库存成本', s_sold: '售出拖数', s_revenue: '销售额', s_cogs: '售出成本', s_profit: '毛利', s_margin: '毛利率', s_ar: '待收款', s_avg_profit: '平均每拖毛利',
    sec_basic: '基本信息', sec_cost: '进货 / 成本 (我们的成本)', sec_sale: '销售 (卖给谁 / 卖多少钱)', sec_history: '修改记录',
    f_lot_no: '批次号 (留空自动生成)', f_title: '货物描述', f_category: '品类', f_load_type: '单位', f_qty: '数量', f_location: '仓位',
    f_supplier: '货源', f_acq_date: '进货日期', f_purchase: '货款', f_freight: '运费', f_labor: '人工/装卸', f_other: '其他成本',
    f_status: '状态', f_asking: '标价 (一拖卖多少)', f_customer: '买家', f_sold_date: '成交日期', f_sale_price: '成交价', f_received: '已收金额', f_pay_method: '收款方式',
    total_cost: '总成本', expected_profit: '预计毛利', profit: '毛利', margin: '毛利率', balance: '未收',
    save: '保存', cancel: '取消', delete: '删除', sell: '卖出', receive: '收款', edit: '编辑', none: '— 无 —', new_party: '+ 新建…',
    confirm_delete: '确定删除？此操作不可恢复。', saved: '已保存', deleted: '已删除', no_data: '暂无数据',
    receive_amount: '本次收款金额', new_password: '新密码 (留空不改)', admin: '管理员', staff: '员工', edit_lot: '编辑弃货', new_lot_title: '新增一拖弃货',
  },
  en: {
    login_sub: 'Liquidation Management System', username: 'Username', password: 'Password', sign_in: 'Sign In', sign_out: 'Sign Out',
    dashboard: 'Dashboard', lots: 'Inventory', sales: 'Sales', receivables: 'Receivables', suppliers: 'Suppliers', customers: 'Customers', users: 'Users',
    monthly_pl: 'Monthly Revenue / Cost / Profit', lot_status: 'Load Status', top_customers: 'Top Customers (Revenue)', top_suppliers: 'Top Suppliers (Profit)',
    recent_sales: 'Recent Sales', search: 'Search...', export_csv: 'Export CSV', new_lot: '+ New Load', add_supplier: '+ Add Supplier', add_customer: '+ Add Customer', add_user: '+ Add User',
    th_lot: 'Lot #', th_desc: 'Description', th_customer: 'Sold To', th_supplier: 'Supplier', th_sale: 'Sale Price', th_cost: 'Total Cost', th_profit: 'Profit', th_margin: 'Margin',
    th_sold_date: 'Sold Date', th_acq_date: 'Acquired', th_qty: 'Qty', th_status: 'Status', th_asking: 'Asking', th_received: 'Received', th_balance: 'Balance', th_payment: 'Payment', th_category: 'Category', th_location: 'Location', th_days: 'Days in Stock',
    display_name: 'Name', role: 'Role', created: 'Created', contact: 'Contact', phone: 'Phone', email: 'Email', address: 'Address', notes: 'Notes', name: 'Name',
    loads_bought: 'Loads Bought', loads_sold: 'Loads Sold', total_spent: 'Total Spent', total_revenue: 'Total Revenue',
    backup_title: 'Download a full backup', backup_desc: 'Exports all suppliers, customers and loads as a JSON file.', download_backup: 'Download Backup',
    all_time: 'All Years', all_months: 'All Months', all_status: 'All Status', all_suppliers: 'All Suppliers', all_customers: 'All Customers',
    st_in_stock: 'In Stock', st_listed: 'Listed', st_sold: 'Sold', st_cancelled: 'Cancelled',
    pay_paid: 'Paid', pay_partial: 'Partial', pay_unpaid: 'Unpaid',
    lt_pallet: 'Pallet', lt_truckload: 'Truckload', lt_box: 'Box', lt_gaylord: 'Gaylord',
    s_inventory: 'Loads In Stock', s_inv_cost: 'Inventory Cost', s_sold: 'Loads Sold', s_revenue: 'Revenue', s_cogs: 'Cost of Sold', s_profit: 'Gross Profit', s_margin: 'Margin', s_ar: 'Receivable', s_avg_profit: 'Avg Profit / Load',
    sec_basic: 'Basic Info', sec_cost: 'Purchase / Our Cost', sec_sale: 'Sale (Who bought / How much)', sec_history: 'History',
    f_lot_no: 'Lot # (blank = auto)', f_title: 'Description', f_category: 'Category', f_load_type: 'Unit', f_qty: 'Quantity', f_location: 'Location',
    f_supplier: 'Supplier', f_acq_date: 'Acquired Date', f_purchase: 'Purchase Cost', f_freight: 'Freight', f_labor: 'Labor / Handling', f_other: 'Other Cost',
    f_status: 'Status', f_asking: 'Asking Price (per load)', f_customer: 'Customer', f_sold_date: 'Sold Date', f_sale_price: 'Sale Price', f_received: 'Amount Received', f_pay_method: 'Payment Method',
    total_cost: 'Total Cost', expected_profit: 'Expected Profit', profit: 'Profit', margin: 'Margin', balance: 'Balance',
    save: 'Save', cancel: 'Cancel', delete: 'Delete', sell: 'Sell', receive: 'Receive', edit: 'Edit', none: '— None —', new_party: '+ New…',
    confirm_delete: 'Delete this? This cannot be undone.', saved: 'Saved', deleted: 'Deleted', no_data: 'No data',
    receive_amount: 'Amount received now', new_password: 'New password (blank = keep)', admin: 'Admin', staff: 'Staff', edit_lot: 'Edit Load', new_lot_title: 'New Liquidation Load',
  },
};
let LANG = 'zh';
try { LANG = localStorage.getItem('liq_lang') || 'zh'; } catch (e) {}
const t = k => (I18N[LANG] && I18N[LANG][k]) || I18N.en[k] || k;
function setLang(l) {
  LANG = l; try { localStorage.setItem('liq_lang', l); } catch (e) {}
  applyLang();
  if (currentUser) refreshAll();
}
function applyLang() {
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll('[data-ph]').forEach(el => { el.placeholder = t(el.dataset.ph); });
  document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('on', b.dataset.lang === LANG));
}

// ---------- utils ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (n < 0 ? '-$' : '$') + Math.abs(+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(+n || 0)).toLocaleString('en-US');
const pct = n => isFinite(n) ? (n * 100).toFixed(1) + '%' : '—';
const today = () => new Date().toISOString().slice(0, 10);
const plCls = n => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.innerHTML = `<span>${esc(msg)}</span><span class="toast-close" onclick="this.parentNode.remove()">&times;</span>`;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Not signed in'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

// derived fields per lot
function calc(l) {
  const cost = (+l.purchase_cost || 0) + (+l.freight_cost || 0) + (+l.labor_cost || 0) + (+l.other_cost || 0);
  const sold = l.status === 'sold';
  const sale = +l.sale_price || 0;
  const profit = sold ? sale - cost : null;
  const margin = sold && sale ? profit / sale : NaN;
  const received = +l.amount_received || 0;
  const balance = sold ? sale - received : 0;
  const pay = !sold ? null : balance <= 0.005 ? 'paid' : received > 0 ? 'partial' : 'unpaid';
  const days = l.acquired_date ? Math.floor(((sold && l.sold_date ? new Date(l.sold_date) : new Date()) - new Date(l.acquired_date)) / 864e5) : null;
  return { cost, sale, profit, margin, received, balance, pay, days };
}
const statusBadge = s => `<span class="badge badge-${s}">${esc(t('st_' + s))}</span>`;
const payBadge = p => p ? `<span class="badge badge-${p}">${esc(t('pay_' + p))}</span>` : '';
const chip = (label, val) => `<span class="chip">${esc(label)} <b>${val}</b></span>`;

// ---------- state ----------
let currentUser = null;
let LOTS = [], SUPPLIERS = [], CUSTOMERS = [];
const charts = {};

// ---------- auth ----------
async function doLogin() {
  const username = $('login-user').value.trim(), password = $('login-pass').value;
  const btn = $('login-btn'), err = $('login-err');
  if (!username || !password) { err.textContent = t('username') + ' / ' + t('password') + '?'; return; }
  btn.disabled = true; err.textContent = '';
  try {
    currentUser = await api('/api/login', { method: 'POST', body: { username, password } });
    showApp();
  } catch (e) { err.textContent = e.message; }
  btn.disabled = false;
}
async function doLogout() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  currentUser = null; showLogin();
}
function showLogin() {
  $('app').style.display = 'none';
  $('login-overlay').style.display = 'flex';
  $('login-pass').value = '';
}
function showApp() {
  $('login-overlay').style.display = 'none';
  $('app').style.display = 'flex';
  $('user-display').textContent = currentUser.display_name || currentUser.username;
  $('user-role').textContent = t(currentUser.role);
  document.querySelectorAll('.admin-only').forEach(el => el.style.display = currentUser.role === 'admin' ? '' : 'none');
  const tab = (location.hash || '').slice(1);
  switchTab(document.querySelector(`.sidebar nav a[data-tab="${tab}"]`) ? tab : 'dashboard');
  refreshAll();
}
$('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
$('login-user').addEventListener('keydown', e => { if (e.key === 'Enter') $('login-pass').focus(); });

// ---------- nav ----------
function switchTab(tab) {
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(el => el.classList.toggle('active', el.id === 'tab-' + tab));
  history.replaceState(null, '', '#' + tab);
  if (tab === 'users') loadUsers();
  closeMobileNav();
}
document.querySelectorAll('.sidebar nav a').forEach(a => a.addEventListener('click', e => { e.preventDefault(); switchTab(a.dataset.tab); }));
function toggleMobileNav() { $('sideNav').classList.toggle('open'); $('navOverlay').classList.toggle('show'); }
function closeMobileNav() { $('sideNav').classList.remove('open'); $('navOverlay').classList.remove('show'); }

// ---------- data ----------
async function refreshAll() {
  try {
    [LOTS, SUPPLIERS, CUSTOMERS] = await Promise.all([api('/api/lots'), api('/api/suppliers'), api('/api/customers')]);
  } catch (e) { if (e.message !== 'Not signed in') toast(e.message, 'error'); return; }
  fillFilters();
  renderDashboard(); renderLots(); renderSales(); renderReceivables();
  renderParties('suppliers'); renderParties('customers');
}
function setOptions(sel, opts, keep = true) {
  const el = $(sel), prev = el.value;
  el.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  if (keep && [...el.options].some(o => o.value === prev)) el.value = prev;
}
function fillFilters() {
  const years = [...new Set(LOTS.map(l => (l.sold_date || l.acquired_date || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  setOptions('dash-year', [['', t('all_time')], ...years.map(y => [y, y])]);
  setOptions('dash-month', [['', t('all_months')], ...Array.from({ length: 12 }, (_, i) => [String(i + 1), `${i + 1}月 / ${new Date(2000, i).toLocaleString('en', { month: 'short' })}`])]);
  setOptions('lot-status', [['', t('all_status')], ['open', t('st_in_stock') + ' + ' + t('st_listed')], ...['in_stock', 'listed', 'sold', 'cancelled'].map(s => [s, t('st_' + s)])]);
  setOptions('lot-supplier', [['', t('all_suppliers')], ...SUPPLIERS.map(s => [s.id, s.name])]);
  setOptions('sale-customer', [['', t('all_customers')], ...CUSTOMERS.map(c => [c.id, c.name])]);
  setOptions('ar-customer', [['', t('all_customers')], ...CUSTOMERS.map(c => [c.id, c.name])]);
}

// ---------- dashboard ----------
function inPeriod(d) {
  const y = $('dash-year').value, m = $('dash-month').value;
  if (!d) return !y && !m;
  if (y && d.slice(0, 4) !== y) return false;
  if (m && +d.slice(5, 7) !== +m) return false;
  return true;
}
function renderDashboard() {
  const active = LOTS.filter(l => l.status !== 'cancelled');
  const stock = active.filter(l => l.status === 'in_stock' || l.status === 'listed');
  const sold = active.filter(l => l.status === 'sold' && inPeriod(l.sold_date));
  const sum = (arr, f) => arr.reduce((a, l) => a + f(calc(l)), 0);
  const rev = sum(sold, c => c.sale), cogs = sum(sold, c => c.cost), profit = rev - cogs;
  const ar = sum(active.filter(l => l.status === 'sold'), c => Math.max(0, c.balance));
  const qty = arr => arr.reduce((a, l) => a + (+l.quantity || 0), 0);
  const cards = [
    [t('s_inventory'), qty(stock).toLocaleString(), ''],
    [t('s_inv_cost'), money0(sum(stock, c => c.cost)), 'orange'],
    [t('s_sold'), qty(sold).toLocaleString(), ''],
    [t('s_revenue'), money0(rev), ''],
    [t('s_cogs'), money0(cogs), 'orange'],
    [t('s_profit'), money0(profit), profit >= 0 ? 'green' : 'red'],
    [t('s_margin'), rev ? pct(profit / rev) : '—', profit >= 0 ? 'green' : 'red'],
    [t('s_avg_profit'), sold.length ? money0(profit / sold.length) : '—', ''],
    [t('s_ar'), money0(ar), ar > 0 ? 'red' : 'green'],
  ];
  $('stats-grid').innerHTML = cards.map(([l, v, c]) => `<div class="stat-card"><div class="label">${esc(l)}</div><div class="value ${c}">${v}</div></div>`).join('');

  // monthly (last 12 months that have data, or chosen year)
  const byMonth = {};
  for (const l of active.filter(l => l.status === 'sold' && l.sold_date)) {
    const y = $('dash-year').value; if (y && l.sold_date.slice(0, 4) !== y) continue;
    const k = l.sold_date.slice(0, 7), c = calc(l);
    byMonth[k] = byMonth[k] || { rev: 0, cost: 0 };
    byMonth[k].rev += c.sale; byMonth[k].cost += c.cost;
  }
  const months = Object.keys(byMonth).sort().slice(-12);
  drawChart('chart-monthly', {
    type: 'bar',
    data: { labels: months, datasets: [
      { label: t('s_revenue'), data: months.map(m => byMonth[m].rev), backgroundColor: '#8B6914' },
      { label: t('s_cogs'), data: months.map(m => byMonth[m].cost), backgroundColor: '#e67e22' },
      { label: t('s_profit'), data: months.map(m => byMonth[m].rev - byMonth[m].cost), backgroundColor: '#12B76A' },
    ] },
    options: { maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 10, font: { size: 10 } } } }, scales: { y: { ticks: { callback: v => money0(v), font: { size: 10 } } }, x: { ticks: { font: { size: 10 } } } } },
  });
  const sts = ['in_stock', 'listed', 'sold', 'cancelled'];
  drawChart('chart-status', {
    type: 'doughnut',
    data: { labels: sts.map(s => t('st_' + s)), datasets: [{ data: sts.map(s => LOTS.filter(l => l.status === s).length), backgroundColor: ['#0ea5e9', '#F79009', '#12B76A', '#98a2b3'] }] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } } },
  });
  const top = (key, nameKey, val) => {
    const m = {};
    for (const l of sold) { if (!l[key]) continue; m[l[nameKey]] = (m[l[nameKey]] || 0) + val(calc(l)); }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8);
  };
  const hbar = (id, rows, color) => drawChart(id, {
    type: 'bar', data: { labels: rows.map(r => r[0]), datasets: [{ data: rows.map(r => r[1]), backgroundColor: color }] },
    options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { callback: v => money0(v), font: { size: 10 } } }, y: { ticks: { font: { size: 10 } } } } },
  });
  hbar('chart-customers', top('customer_id', 'customer_name', c => c.sale), '#8B6914');
  hbar('chart-suppliers', top('supplier_id', 'supplier_name', c => c.profit), '#12B76A');

  const recent = sold.slice().sort((a, b) => (b.sold_date || '').localeCompare(a.sold_date || '')).slice(0, 15);
  $('recent-sales').innerHTML = recent.length ? recent.map(l => {
    const c = calc(l);
    return `<tr onclick="openLotModal(${l.id})"><td class="tdn">${esc(l.lot_no)}</td><td>${esc(l.title || '')}</td><td>${esc(l.customer_name || '—')}</td><td class="num">${money(c.sale)}</td><td class="num">${money(c.cost)}</td><td class="num ${plCls(c.profit)}">${money(c.profit)}</td><td>${esc(l.sold_date || '')}</td></tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="7">${t('no_data')}</td></tr>`;
}
function drawChart(id, cfg) {
  if (typeof Chart === 'undefined') return;
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id), cfg);
}

// ---------- sortable tables ----------
const sortState = {};
function thead(id, cols, table, rerender) {
  const s = sortState[table] || {};
  $(id).innerHTML = '<tr>' + cols.map(c => {
    const arrow = s.key === c.key ? (s.dir > 0 ? ' ▲' : ' ▼') : '';
    return c.key ? `<th class="sortable ${c.num ? 'num' : ''}" onclick="sortBy('${table}','${c.key}',${rerender})">${esc(t(c.t) || c.t)}${arrow}</th>` : `<th class="${c.num ? 'num' : ''}">${esc(c.t ? t(c.t) : '')}</th>`;
  }).join('') + '</tr>';
}
function sortBy(table, key, rerender) {
  const s = sortState[table] || {};
  sortState[table] = { key, dir: s.key === key ? -s.dir : 1 };
  rerender();
}
function applySort(table, rows, getters) {
  const s = sortState[table]; if (!s || !getters[s.key]) return rows;
  const g = getters[s.key];
  return rows.slice().sort((a, b) => { const x = g(a), y = g(b); return (x > y ? 1 : x < y ? -1 : 0) * s.dir; });
}
const GET = {
  lot_no: l => l.lot_no || '', title: l => (l.title || '').toLowerCase(), supplier: l => (l.supplier_name || '').toLowerCase(), customer: l => (l.customer_name || '').toLowerCase(),
  acq: l => l.acquired_date || '', sold: l => l.sold_date || '', qty: l => +l.quantity || 0, cost: l => calc(l).cost, asking: l => +l.asking_price || 0,
  sale: l => calc(l).sale, profit: l => calc(l).profit ?? -Infinity, margin: l => { const m = calc(l).margin; return isFinite(m) ? m : -Infinity; },
  received: l => calc(l).received, balance: l => calc(l).balance, status: l => l.status, days: l => calc(l).days ?? -1,
};
function matches(l, q) {
  if (!q) return true;
  q = q.toLowerCase();
  return [l.lot_no, l.title, l.category, l.supplier_name, l.customer_name, l.location, l.notes].some(v => (v || '').toLowerCase().includes(q));
}

// ---------- inventory ----------
function renderLots() {
  const q = $('lot-search').value.trim(), st = $('lot-status').value, sup = $('lot-supplier').value;
  let rows = LOTS.filter(l => matches(l, q) && (!sup || String(l.supplier_id) === sup) &&
    (!st || (st === 'open' ? (l.status === 'in_stock' || l.status === 'listed') : l.status === st)));
  thead('lot-thead', [
    { t: 'th_lot', key: 'lot_no' }, { t: 'th_desc', key: 'title' }, { t: 'th_supplier', key: 'supplier' }, { t: 'th_acq_date', key: 'acq' },
    { t: 'th_qty', key: 'qty', num: 1 }, { t: 'th_cost', key: 'cost', num: 1 }, { t: 'th_asking', key: 'asking', num: 1 },
    { t: 'th_status', key: 'status' }, { t: 'th_customer', key: 'customer' }, { t: 'th_sale', key: 'sale', num: 1 }, { t: 'th_profit', key: 'profit', num: 1 },
    { t: 'th_days', key: 'days', num: 1 }, { t: '' },
  ], 'lots', 'renderLots');
  rows = applySort('lots', rows, GET);
  const open = rows.filter(l => l.status === 'in_stock' || l.status === 'listed');
  $('lot-stats').innerHTML = chip(t('st_in_stock') + '+' + t('st_listed'), open.length) + chip(t('s_inv_cost'), money0(open.reduce((a, l) => a + calc(l).cost, 0))) + chip(t('s_sold'), rows.filter(l => l.status === 'sold').length);
  $('lot-tbody').innerHTML = rows.length ? rows.map(l => {
    const c = calc(l);
    const unit = l.quantity + ' ' + t('lt_' + (l.load_type || 'pallet')).split(' ')[0];
    const act = (l.status === 'in_stock' || l.status === 'listed')
      ? `<button class="btn btn-grn btn-sm" onclick="event.stopPropagation();openLotModal(${l.id},true)">${t('sell')}</button>` : '';
    return `<tr onclick="openLotModal(${l.id})">
      <td class="tdn">${esc(l.lot_no)}</td>
      <td><div class="tdn" style="font-weight:500">${esc(l.title || '')}</div>${l.category ? `<div class="tdct">${esc(l.category)}</div>` : ''}</td>
      <td>${esc(l.supplier_name || '—')}</td><td>${esc(l.acquired_date || '')}</td>
      <td class="num">${esc(unit)}</td><td class="num">${money(c.cost)}</td><td class="num">${l.asking_price ? money(l.asking_price) : '—'}</td>
      <td>${statusBadge(l.status)}</td><td>${esc(l.customer_name || '')}</td>
      <td class="num">${l.status === 'sold' ? money(c.sale) : ''}</td>
      <td class="num ${plCls(c.profit)}">${c.profit !== null ? money(c.profit) : ''}</td>
      <td class="num">${c.days ?? ''}</td><td>${act}</td></tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="13">${t('no_data')}</td></tr>`;
}
function csv(name, header, rows) {
  const q = v => { v = v ?? ''; v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const blob = new Blob(['﻿' + [header, ...rows].map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${name}-${today()}.csv`; a.click();
}
function exportLots() {
  csv('liquidation-loads', ['Lot #', 'Description', 'Category', 'Unit', 'Qty', 'Supplier', 'Acquired', 'Purchase', 'Freight', 'Labor', 'Other', 'Total Cost', 'Asking', 'Status', 'Customer', 'Sold Date', 'Sale Price', 'Profit', 'Received', 'Balance', 'Location', 'Notes'],
    LOTS.map(l => { const c = calc(l); return [l.lot_no, l.title, l.category, l.load_type, l.quantity, l.supplier_name, l.acquired_date, l.purchase_cost, l.freight_cost, l.labor_cost, l.other_cost, c.cost.toFixed(2), l.asking_price, l.status, l.customer_name, l.sold_date, l.status === 'sold' ? c.sale : '', c.profit !== null ? c.profit.toFixed(2) : '', c.received, c.balance.toFixed(2), l.location, l.notes]; }));
}

// ---------- sales ----------
function salesRows() {
  const q = $('sale-search').value.trim(), cu = $('sale-customer').value, f = $('sale-from').value, to = $('sale-to').value;
  return LOTS.filter(l => l.status === 'sold' && matches(l, q) && (!cu || String(l.customer_id) === cu) &&
    (!f || (l.sold_date || '') >= f) && (!to || (l.sold_date || '') <= to));
}
function renderSales() {
  thead('sale-thead', [
    { t: 'th_sold_date', key: 'sold' }, { t: 'th_lot', key: 'lot_no' }, { t: 'th_desc', key: 'title' }, { t: 'th_customer', key: 'customer' }, { t: 'th_supplier', key: 'supplier' },
    { t: 'th_qty', key: 'qty', num: 1 }, { t: 'th_sale', key: 'sale', num: 1 }, { t: 'th_cost', key: 'cost', num: 1 }, { t: 'th_profit', key: 'profit', num: 1 }, { t: 'th_margin', key: 'margin', num: 1 },
    { t: 'th_received', key: 'received', num: 1 }, { t: 'th_payment' },
  ], 'sales', 'renderSales');
  if (!sortState.sales) sortState.sales = { key: 'sold', dir: -1 };
  const rows = applySort('sales', salesRows(), GET);
  let tr = 0, tc = 0, trc = 0, tq = 0;
  $('sale-tbody').innerHTML = rows.length ? rows.map(l => {
    const c = calc(l); tr += c.sale; tc += c.cost; trc += c.received; tq += +l.quantity || 0;
    return `<tr onclick="openLotModal(${l.id})"><td>${esc(l.sold_date || '')}</td><td class="tdn">${esc(l.lot_no)}</td><td>${esc(l.title || '')}</td>
      <td class="tdn" style="font-weight:600">${esc(l.customer_name || '—')}</td><td>${esc(l.supplier_name || '—')}</td><td class="num">${esc(l.quantity)}</td>
      <td class="num">${money(c.sale)}</td><td class="num">${money(c.cost)}</td><td class="num ${plCls(c.profit)}">${money(c.profit)}</td><td class="num">${pct(c.margin)}</td>
      <td class="num">${money(c.received)}</td><td>${payBadge(c.pay)}</td></tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="12">${t('no_data')}</td></tr>`;
  const tp = tr - tc;
  $('sale-tfoot').innerHTML = rows.length ? `<tr><td colspan="5">${rows.length} ${LANG === 'zh' ? '笔' : 'sales'}</td><td class="num">${tq}</td><td class="num">${money(tr)}</td><td class="num">${money(tc)}</td><td class="num ${plCls(tp)}">${money(tp)}</td><td class="num">${tr ? pct(tp / tr) : '—'}</td><td class="num">${money(trc)}</td><td></td></tr>` : '';
  $('sale-stats').innerHTML = chip(t('s_revenue'), money0(tr)) + chip(t('s_profit'), money0(tp)) + chip(t('s_margin'), tr ? pct(tp / tr) : '—');
}
function exportSales() {
  csv('liquidation-sales', ['Sold Date', 'Lot #', 'Description', 'Customer', 'Supplier', 'Qty', 'Sale Price', 'Total Cost', 'Profit', 'Margin', 'Received', 'Balance', 'Payment Method'],
    applySort('sales', salesRows(), GET).map(l => { const c = calc(l); return [l.sold_date, l.lot_no, l.title, l.customer_name, l.supplier_name, l.quantity, c.sale, c.cost.toFixed(2), c.profit.toFixed(2), isFinite(c.margin) ? (c.margin * 100).toFixed(1) + '%' : '', c.received, c.balance.toFixed(2), l.payment_method]; }));
}

// ---------- receivables ----------
function renderReceivables() {
  const cu = $('ar-customer').value;
  const all = LOTS.filter(l => l.status === 'sold' && calc(l).balance > 0.005);
  const rows = all.filter(l => !cu || String(l.customer_id) === cu).sort((a, b) => (a.sold_date || '').localeCompare(b.sold_date || ''));
  const badge = $('ar-badge'); badge.textContent = all.length; badge.style.display = all.length ? '' : 'none';
  thead('ar-thead', [{ t: 'th_sold_date' }, { t: 'th_lot' }, { t: 'th_customer' }, { t: 'th_sale', num: 1 }, { t: 'th_received', num: 1 }, { t: 'th_balance', num: 1 }, { t: 'th_days', num: 1 }, { t: '' }], 'ar', 'renderReceivables');
  const total = rows.reduce((a, l) => a + calc(l).balance, 0);
  $('ar-stats').innerHTML = chip(t('s_ar'), money(total)) + chip('#', rows.length);
  $('ar-tbody').innerHTML = rows.length ? rows.map(l => {
    const c = calc(l), age = l.sold_date ? Math.floor((Date.now() - new Date(l.sold_date)) / 864e5) : '';
    return `<tr onclick="openLotModal(${l.id})"><td>${esc(l.sold_date || '')}</td><td class="tdn">${esc(l.lot_no)}</td><td class="tdn" style="font-weight:600">${esc(l.customer_name || '—')}</td>
      <td class="num">${money(c.sale)}</td><td class="num">${money(c.received)}</td><td class="num neg">${money(c.balance)}</td><td class="num">${age}</td>
      <td><button class="btn btn-grn btn-sm" onclick="event.stopPropagation();openReceive(${l.id})">${t('receive')}</button></td></tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="8">${t('no_data')}</td></tr>`;
}
function openReceive(id) {
  const l = LOTS.find(x => x.id === id), c = calc(l);
  openModal(`${t('receive')} — ${esc(l.lot_no)}`, `
    <div class="modal-row"><div class="modal-field"><span class="modal-label">${t('th_customer')}</span><div>${esc(l.customer_name || '—')}</div></div>
    <div class="modal-field"><span class="modal-label">${t('balance')}</span><div class="neg">${money(c.balance)}</div></div></div>
    <div class="modal-row"><div class="modal-field"><span class="modal-label">${t('receive_amount')}</span><input class="modal-input" id="rcv-amt" type="number" step="0.01" value="${c.balance.toFixed(2)}"/></div>
    <div class="modal-field"><span class="modal-label">${t('f_pay_method')}</span><input class="modal-input" id="rcv-method" list="pay-methods" value="${esc(l.payment_method || '')}"/></div></div>
    ${payMethodsList()}
    <div class="modal-actions"><button class="btn-cancel" onclick="closeModal()">${t('cancel')}</button><button class="btn-save" onclick="saveReceive(${id})">${t('save')}</button></div>`, 460);
}
async function saveReceive(id) {
  try {
    await api(`/api/lots/${id}/payment`, { method: 'POST', body: { amount: $('rcv-amt').value, method: $('rcv-method').value } });
    closeModal(); toast(t('saved')); refreshAll();
  } catch (e) { toast(e.message, 'error'); }
}
const payMethodsList = () => `<datalist id="pay-methods"><option>Cash</option><option>Zelle</option><option>Check</option><option>Wire / ACH</option><option>Venmo</option><option>Credit Card</option></datalist>`;

// ---------- lot modal ----------
function openModal(title, html, width = 720) {
  $('modal-title').innerHTML = title; $('modal-body').innerHTML = html;
  $('modal-box').style.width = width + 'px';
  $('modal').classList.add('open');
}
function closeModal() { $('modal').classList.remove('open'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

const field = (label, inner, full) => `<div class="modal-field${full ? ' full' : ''}"><span class="modal-label">${esc(label)}</span>${inner}</div>`;
const inp = (id, val, type = 'text', extra = '') => `<input class="modal-input" id="${id}" type="${type}" value="${esc(val ?? '')}" ${type === 'number' ? 'step="0.01" min="0"' : ''} ${extra}/>`;
const partySelect = (id, list, val, kind) => `<select class="modal-input" id="${id}" onchange="if(this.value==='__new')quickAddParty('${kind}','${id}')">
  <option value="">${t('none')}</option>${list.map(p => `<option value="${p.id}" ${String(p.id) === String(val) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
  <option value="__new">${t('new_party')}</option></select>`;

async function openLotModal(id, sell) {
  let l = { status: 'in_stock', load_type: 'pallet', quantity: 1, acquired_date: today() };
  if (id) { try { l = await api('/api/lots/' + id); } catch (e) { return toast(e.message, 'error'); } }
  if (sell) { l.status = 'sold'; l.sold_date = l.sold_date || today(); if (!l.sale_price) l.sale_price = l.asking_price || ''; }
  const sel = (fid, opts, v) => `<select class="modal-input" id="${fid}" onchange="lotPreview()">${opts.map(([k, lab]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
  const n = (fid, v) => inp(fid, v === 0 || v ? v : '', 'number', 'oninput="lotPreview()"');
  const hist = (l.history || []).map(h => `<div class="hist"><b>${esc(h.created_at)}</b> · ${esc(h.username || '')} · ${esc(h.action)}${h.detail && h.action !== 'create' ? ' — ' + esc(h.detail).slice(0, 300) : ''}</div>`).join('');
  openModal(id ? `${t('edit_lot')} — ${esc(l.lot_no)}` : t('new_lot_title'), `
    <div class="modal-section">${t('sec_basic')}</div>
    <div class="modal-row">${field(t('f_lot_no'), inp('f-lot_no', l.lot_no))}${field(t('f_category'), inp('f-category', l.category, 'text', 'list="cat-list"'))}</div>
    <datalist id="cat-list">${[...new Set(LOTS.map(x => x.category).filter(Boolean))].map(c => `<option>${esc(c)}</option>`).join('')}</datalist>
    <div class="modal-row">${field(t('f_title'), inp('f-title', l.title, 'text', 'placeholder="e.g. Amazon returns – mixed general merchandise"'), true)}</div>
    <div class="modal-row" style="grid-template-columns:1fr 1fr 1fr">${field(t('f_load_type'), sel('f-load_type', ['pallet', 'truckload', 'box', 'gaylord'].map(k => [k, t('lt_' + k)]), l.load_type))}${field(t('f_qty'), n('f-quantity', l.quantity))}${field(t('f_location'), inp('f-location', l.location))}</div>

    <div class="modal-section">${t('sec_cost')}</div>
    <div class="modal-row">${field(t('f_supplier'), partySelect('f-supplier_id', SUPPLIERS, l.supplier_id, 'suppliers'))}${field(t('f_acq_date'), inp('f-acquired_date', l.acquired_date, 'date'))}</div>
    <div class="modal-row" style="grid-template-columns:repeat(4,1fr)">${field(t('f_purchase'), n('f-purchase_cost', l.purchase_cost))}${field(t('f_freight'), n('f-freight_cost', l.freight_cost))}${field(t('f_labor'), n('f-labor_cost', l.labor_cost))}${field(t('f_other'), n('f-other_cost', l.other_cost))}</div>

    <div class="modal-section">${t('sec_sale')}</div>
    <div class="modal-row" style="grid-template-columns:1fr 1fr 1fr">${field(t('f_status'), sel('f-status', ['in_stock', 'listed', 'sold', 'cancelled'].map(k => [k, t('st_' + k)]), l.status))}${field(t('f_asking'), n('f-asking_price', l.asking_price))}${field(t('f_customer'), partySelect('f-customer_id', CUSTOMERS, l.customer_id, 'customers'))}</div>
    <div class="modal-row" style="grid-template-columns:repeat(4,1fr)" id="sale-fields">${field(t('f_sold_date'), inp('f-sold_date', l.sold_date, 'date'))}${field(t('f_sale_price'), n('f-sale_price', l.sale_price))}${field(t('f_received'), n('f-amount_received', l.amount_received))}${field(t('f_pay_method'), inp('f-payment_method', l.payment_method, 'text', 'list="pay-methods"'))}</div>
    ${payMethodsList()}
    <div class="profit-box" id="lot-preview"></div>
    <div class="modal-row">${field(t('notes'), `<textarea class="modal-input" id="f-notes">${esc(l.notes || '')}</textarea>`, true)}</div>
    ${hist ? `<div class="modal-section">${t('sec_history')}</div><div style="max-height:140px;overflow:auto">${hist}</div>` : ''}
    <div class="modal-actions">
      ${id && currentUser.role === 'admin' ? `<button class="btn-del" onclick="deleteLot(${id})">${t('delete')}</button>` : ''}
      <button class="btn-cancel" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn-save" onclick="saveLot(${id || 'null'})">${t('save')}</button>
    </div>`);
  lotPreview();
}
function lotForm() {
  const ids = ['lot_no', 'title', 'category', 'load_type', 'quantity', 'location', 'supplier_id', 'acquired_date', 'purchase_cost', 'freight_cost', 'labor_cost', 'other_cost',
    'status', 'asking_price', 'customer_id', 'sold_date', 'sale_price', 'amount_received', 'payment_method', 'notes'];
  const o = {}; ids.forEach(k => { const el = $('f-' + k); o[k] = el ? el.value : null; });
  if (o.supplier_id === '__new') o.supplier_id = ''; if (o.customer_id === '__new') o.customer_id = '';
  return o;
}
function lotPreview() {
  const f = lotForm(), c = calc(f), sold = f.status === 'sold';
  $('sale-fields').style.opacity = sold ? 1 : .45;
  const exp = (+f.asking_price || 0) - c.cost;
  $('lot-preview').innerHTML = `
    <div><div class="l">${t('total_cost')}</div><div class="v">${money(c.cost)}</div></div>
    ${sold ? `<div><div class="l">${t('f_sale_price')}</div><div class="v">${money(c.sale)}</div></div>
      <div><div class="l">${t('profit')} / ${t('margin')}</div><div class="v ${plCls(c.profit)}">${money(c.profit)} <span style="font-size:11px">${pct(c.margin)}</span></div></div>
      <div><div class="l">${t('balance')}</div><div class="v ${c.balance > 0.005 ? 'neg' : 'pos'}">${money(c.balance)}</div></div>`
    : `<div><div class="l">${t('f_asking')}</div><div class="v">${money(+f.asking_price || 0)}</div></div>
      <div><div class="l">${t('expected_profit')}</div><div class="v ${plCls(exp)}">${f.asking_price ? money(exp) : '—'}</div></div><div></div>`}`;
}
async function saveLot(id) {
  const body = lotForm();
  if (body.status === 'sold' && !body.customer_id && !confirm(LANG === 'zh' ? '还没选买家，确定保存？' : 'No customer selected — save anyway?')) return;
  try {
    await api(id ? '/api/lots/' + id : '/api/lots', { method: id ? 'PUT' : 'POST', body });
    closeModal(); toast(t('saved')); refreshAll();
  } catch (e) { toast(e.message, 'error'); }
}
async function deleteLot(id) {
  if (!confirm(t('confirm_delete'))) return;
  try { await api('/api/lots/' + id, { method: 'DELETE' }); closeModal(); toast(t('deleted')); refreshAll(); } catch (e) { toast(e.message, 'error'); }
}
async function quickAddParty(kind, selId) {
  const name = prompt(kind === 'suppliers' ? t('add_supplier').replace('+ ', '') : t('add_customer').replace('+ ', ''));
  const sel = $(selId);
  if (!name || !name.trim()) { sel.value = ''; return; }
  try {
    const p = await api('/api/' + kind, { method: 'POST', body: { name } });
    (kind === 'suppliers' ? SUPPLIERS : CUSTOMERS).push(p);
    const opt = new Option(p.name, p.id); sel.insertBefore(opt, sel.lastElementChild); sel.value = p.id;
    fillFilters(); renderParties(kind);
  } catch (e) { toast(e.message, 'error'); sel.value = ''; }
}

// ---------- suppliers / customers ----------
function renderParties(kind) {
  const isSup = kind === 'suppliers';
  const q = $(isSup ? 'sup-search' : 'cust-search').value.trim().toLowerCase();
  const list = isSup ? SUPPLIERS : CUSTOMERS;
  const key = isSup ? 'supplier_id' : 'customer_id';
  const stats = {};
  for (const l of LOTS) {
    if (!l[key] || l.status === 'cancelled') continue;
    const s = stats[l[key]] = stats[l[key]] || { n: 0, sold: 0, spent: 0, rev: 0, profit: 0, bal: 0 };
    const c = calc(l); s.n += +l.quantity || 0; s.spent += c.cost;
    if (l.status === 'sold') { s.sold += +l.quantity || 0; s.rev += c.sale; s.profit += c.profit; s.bal += Math.max(0, c.balance); }
  }
  const rows = list.filter(p => !q || [p.name, p.contact, p.phone, p.email].some(v => (v || '').toLowerCase().includes(q)));
  const cols = isSup
    ? [['name'], ['contact'], ['phone'], ['email'], ['loads_bought', 1], ['total_spent', 1], ['loads_sold', 1], ['s_profit', 1]]
    : [['name'], ['contact'], ['phone'], ['email'], ['loads_sold', 1], ['total_revenue', 1], ['s_profit', 1], ['s_ar', 1]];
  $(kind + '-thead').innerHTML = '<tr>' + cols.map(([k, n]) => `<th class="${n ? 'num' : ''}">${t(k)}</th>`).join('') + '</tr>';
  $(kind + '-tbody').innerHTML = rows.length ? rows.map(p => {
    const s = stats[p.id] || { n: 0, sold: 0, spent: 0, rev: 0, profit: 0, bal: 0 };
    const nums = isSup ? [s.n, money(s.spent), s.sold, `<span class="${plCls(s.profit)}">${money(s.profit)}</span>`]
      : [s.sold, money(s.rev), `<span class="${plCls(s.profit)}">${money(s.profit)}</span>`, s.bal ? `<span class="neg">${money(s.bal)}</span>` : money(0)];
    const initials = esc((p.name || '?').trim().slice(0, 2).toUpperCase());
    return `<tr onclick="openPartyModal('${kind}',${p.id})"><td><div class="tdv"><div class="tda" style="background:${isSup ? '#8B6914' : '#0891b2'}">${initials}</div><div class="tdn">${esc(p.name)}</div></div></td>
      <td>${esc(p.contact || '')}</td><td>${esc(p.phone || '')}</td><td>${esc(p.email || '')}</td>${nums.map(v => `<td class="num">${v}</td>`).join('')}</tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="8">${t('no_data')}</td></tr>`;
}
function openPartyModal(kind, id) {
  const p = id ? (kind === 'suppliers' ? SUPPLIERS : CUSTOMERS).find(x => x.id === id) : {};
  const title = id ? `${t('edit')} — ${esc(p.name)}` : t(kind === 'suppliers' ? 'add_supplier' : 'add_customer').replace('+ ', '');
  openModal(title, `
    <div class="modal-row">${field(t('name') + ' *', inp('p-name', p.name), true)}</div>
    <div class="modal-row">${field(t('contact'), inp('p-contact', p.contact))}${field(t('phone'), inp('p-phone', p.phone))}</div>
    <div class="modal-row">${field(t('email'), inp('p-email', p.email))}${field(t('address'), inp('p-address', p.address))}</div>
    <div class="modal-row">${field(t('notes'), `<textarea class="modal-input" id="p-notes">${esc(p.notes || '')}</textarea>`, true)}</div>
    <div class="modal-actions">
      ${id && currentUser.role === 'admin' ? `<button class="btn-del" onclick="deleteParty('${kind}',${id})">${t('delete')}</button>` : ''}
      <button class="btn-cancel" onclick="closeModal()">${t('cancel')}</button><button class="btn-save" onclick="saveParty('${kind}',${id || 'null'})">${t('save')}</button>
    </div>`, 560);
}
async function saveParty(kind, id) {
  const body = {}; ['name', 'contact', 'phone', 'email', 'address', 'notes'].forEach(k => body[k] = $('p-' + k).value);
  try { await api(`/api/${kind}` + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body }); closeModal(); toast(t('saved')); refreshAll(); }
  catch (e) { toast(e.message, 'error'); }
}
async function deleteParty(kind, id) {
  if (!confirm(t('confirm_delete'))) return;
  try { await api(`/api/${kind}/${id}`, { method: 'DELETE' }); closeModal(); toast(t('deleted')); refreshAll(); } catch (e) { toast(e.message, 'error'); }
}

// ---------- users ----------
let USERS = [];
async function loadUsers() {
  if (!currentUser || currentUser.role !== 'admin') return;
  try { USERS = await api('/api/users'); } catch (e) { return toast(e.message, 'error'); }
  $('users-tbody').innerHTML = USERS.map(u => `<tr onclick="openUserModal(${u.id})"><td class="tdn">${esc(u.username)}</td><td>${esc(u.display_name || '')}</td><td><span class="badge ${u.role === 'admin' ? 'bb' : 'bg'}">${t(u.role)}</span></td><td>${esc(u.created_at)}</td></tr>`).join('');
}
function openUserModal(id) {
  const u = id ? USERS.find(x => x.id === id) : { role: 'staff' };
  openModal(id ? `${t('edit')} — ${esc(u.username)}` : t('add_user').replace('+ ', ''), `
    <div class="modal-row">${field(t('username'), inp('u-username', u.username, 'text', id ? 'disabled' : ''))}${field(t('display_name'), inp('u-display_name', u.display_name))}</div>
    <div class="modal-row">${field(t('role'), `<select class="modal-input" id="u-role"><option value="staff" ${u.role === 'staff' ? 'selected' : ''}>${t('staff')}</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>${t('admin')}</option></select>`)}
      ${field(id ? t('new_password') : t('password'), inp('u-password', '', 'password', 'autocomplete="new-password"'))}</div>
    <div class="modal-actions">
      ${id && id !== currentUser.id ? `<button class="btn-del" onclick="deleteUser(${id})">${t('delete')}</button>` : ''}
      <button class="btn-cancel" onclick="closeModal()">${t('cancel')}</button><button class="btn-save" onclick="saveUser(${id || 'null'})">${t('save')}</button>
    </div>`, 520);
}
async function saveUser(id) {
  const body = { username: $('u-username').value, display_name: $('u-display_name').value, role: $('u-role').value, password: $('u-password').value };
  try { await api('/api/users' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body }); closeModal(); toast(t('saved')); loadUsers(); }
  catch (e) { toast(e.message, 'error'); }
}
async function deleteUser(id) {
  if (!confirm(t('confirm_delete'))) return;
  try { await api('/api/users/' + id, { method: 'DELETE' }); closeModal(); toast(t('deleted')); loadUsers(); } catch (e) { toast(e.message, 'error'); }
}

// ---------- boot ----------
applyLang();
fetch('/api/me').then(r => r.ok ? r.json() : null).then(u => { if (u) { currentUser = u; showApp(); } else showLogin(); }).catch(showLogin);
