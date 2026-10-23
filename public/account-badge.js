// 右上角账号卡片: 所有管理页面登录后都显示「谁登录着 · 角色」, 点开看用户名 / 邮箱 / 权限, 可以退出登录。
// 页面只要 <script src="/account-badge.js" defer></script>; 没登录 (接口 401) 就什么都不显示。
(function () {
  if (window.__paAcctBadge || window.self !== window.top) return;   // 嵌在别的页面弹窗里 (iframe) 时不重复显示
  window.__paAcctBadge = true;
  // 各页面自己存的管理后台 token (另外还有 pa_token cookie)
  const KEYS = ['adminToken', 'acct_token', 'mgr_token', 'pa_interviews_token', 'pa_phone_sms_token'];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tokens = () => { const t = []; KEYS.forEach(k => { try { const v = localStorage.getItem(k); if (v && !t.includes(v)) t.push(v); } catch (e) {} }); return t; };
  const realFetch = window.fetch.bind(window);
  // <script src="/account-badge.js" data-float data-right="280">: 整屏不滚动的页面浮在右上角 (data-right 往左挪开页面自己的按钮)
  const SCRIPT = document.currentScript, OPT = (SCRIPT && SCRIPT.dataset) || {};
  let me = null;

  async function whoami() {
    // 先试 cookie, 再试各个 token
    for (const t of [null, ...tokens()]) {
      try {
        const r = await realFetch('/api/admin/me', { credentials: 'same-origin', headers: t ? { Authorization: 'Bearer ' + t } : {} });
        if (r.ok) { const j = await r.json(); if (j && j.username) return j; }
      } catch (e) {}
    }
    return null;
  }

  function css() {
    if (document.getElementById('paAcctCss')) return;
    const st = document.createElement('style'); st.id = 'paAcctCss';
    st.textContent = `
#paAcct{position:relative;z-index:99990;display:flex;justify-content:flex-end;padding:6px 10px 2px;font-family:-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;font-size:13px;line-height:1.3;text-align:left}
#paAcct.pa-float{position:fixed;top:8px;right:10px;padding:0}
#paAcct .pa-wrap{position:relative}
#paAcct .pa-chip{display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.96);border:1px solid #d1d5db;border-radius:999px;padding:4px 10px 4px 5px;cursor:pointer;box-shadow:0 2px 8px rgba(15,23,42,.12);color:#1f2937;max-width:260px}
#paAcct .pa-av{width:24px;height:24px;border-radius:50%;background:#0f4c6b;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;flex:0 0 auto}
#paAcct .pa-nm{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#paAcct .pa-rl{font-size:11px;color:#0369a1;background:#e0f2fe;border-radius:999px;padding:1px 7px;white-space:nowrap;font-weight:700}
#paAcct .pa-card{position:absolute;right:0;top:36px;width:300px;max-width:calc(100vw - 20px);background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 30px rgba(15,23,42,.2);padding:14px 16px;display:none;color:#1f2937}
#paAcct.open .pa-card{display:block}
#paAcct .pa-row{display:flex;gap:8px;margin:3px 0;line-height:1.45}
#paAcct .pa-k{color:#6b7280;flex:0 0 52px}
#paAcct .pa-v{word-break:break-all;font-weight:600}
#paAcct ul{margin:4px 0 0;padding-left:18px;color:#374151;font-size:12.5px;line-height:1.55}
#paAcct .pa-out{margin-top:12px;width:100%;border:1px solid #fecaca;background:#fef2f2;color:#b91c1c;border-radius:8px;padding:7px;font-weight:700;cursor:pointer;font-family:inherit;font-size:13px}
#paAcct .pa-out:hover{background:#fee2e2}
@media print{#paAcct{display:none}}`;
    document.head.appendChild(st);
  }

  function render() {
    let el = document.getElementById('paAcct');
    if (!me) { if (el) el.remove(); return; }
    css();
    if (!el) {
      el = document.createElement('div'); el.id = 'paAcct';
      // 一般页面: 页面最上面一条, 把内容往下推, 不盖住页面自己的按钮;
      // 整屏不滚动的页面 (短信收件箱这类, body 高 100vh + overflow hidden): 浮在右上角
      const bs = getComputedStyle(document.body);
      if (OPT.float !== undefined || bs.overflow === 'hidden' || bs.overflowY === 'hidden' || bs.display === 'flex' || bs.display === 'grid') {
        el.className = 'pa-float'; if (OPT.right) el.style.right = (parseInt(OPT.right, 10) || 10) + 'px';
        document.body.appendChild(el);
      } else document.body.insertBefore(el, document.body.firstChild);
    }
    const name = me.display_name || me.username;
    el.innerHTML = `<div class="pa-wrap"><div class="pa-chip" title="当前登录的账号（点开看详情 / 退出）"><span class="pa-av">${esc(String(name).trim().slice(0, 1).toUpperCase())}</span><span class="pa-nm">${esc(name)}</span><span class="pa-rl">${esc(me.role_label || me.role)}</span></div>
      <div class="pa-card">
        <div style="font-weight:800;font-size:15px;margin-bottom:6px">👤 ${esc(name)}</div>
        <div class="pa-row"><span class="pa-k">用户名</span><span class="pa-v">${esc(me.username)}</span></div>
        <div class="pa-row"><span class="pa-k">邮箱</span><span class="pa-v">${me.email ? esc(me.email) : '<span style="color:#9ca3af;font-weight:400">没填</span>'}</span></div>
        <div class="pa-row"><span class="pa-k">角色</span><span class="pa-v">${esc(me.role_label || me.role)}</span></div>
        <div class="pa-row" style="margin-top:6px"><span class="pa-k">权限</span><span class="pa-v" style="font-weight:400"><ul style="margin:0">${(me.perms || []).map(p => `<li>${esc(p)}</li>`).join('')}</ul></span></div>
        <button class="pa-out" type="button">⎋ 退出登录</button>
      </div></div>`;
    el.querySelector('.pa-chip').onclick = e => { e.stopPropagation(); el.classList.toggle('open'); };
    el.querySelector('.pa-chip').style.display = 'inline-flex';
    el.querySelector('.pa-card').onclick = e => e.stopPropagation();
    el.querySelector('.pa-out').onclick = logout;
  }

  // 页面中间的确认弹窗
  function ask(msg, ok) {
    return new Promise(resolve => {
      const m = document.createElement('div');
      m.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;padding:16px;font-family:inherit';
      m.innerHTML = `<div style="background:#fff;border-radius:12px;max-width:360px;width:100%;padding:18px 20px;box-shadow:0 10px 30px rgba(0,0,0,.25);font-size:14px;color:#1f2937;line-height:1.6">${msg}
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button data-v="0" style="border:1px solid #d1d5db;background:#fff;border-radius:8px;padding:6px 14px;cursor:pointer;font-weight:700">取消</button>
        <button data-v="1" style="border:none;background:#dc2626;color:#fff;border-radius:8px;padding:6px 14px;cursor:pointer;font-weight:700">${ok}</button></div></div>`;
      m.addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b || e.target === m) { m.remove(); resolve(!!b && b.dataset.v === '1'); } });
      document.body.appendChild(m);
    });
  }

  async function logout() {
    if (!(await ask('退出登录？<div style="color:#6b7280;font-size:12.5px;margin-top:4px">这个浏览器里所有管理页面都会一起退出。</div>', '退出登录'))) return;
    const ts = tokens();
    try { await realFetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
    for (const t of ts) { try { await realFetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin', headers: { Authorization: 'Bearer ' + t } }); } catch (e) {} }
    KEYS.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
    document.cookie = 'pa_token=;path=/;max-age=0';
    location.reload();
  }

  async function refresh() { me = await whoami(); render(); }

  // 页面自己登录 / 退出后跟着刷新 (不用整页刷新)
  window.fetch = function (input, init) {
    const p = realFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\/api\/admin\/(login|logout|mfa)/.test(url)) p.then(() => setTimeout(refresh, 600), () => {});
    } catch (e) {}
    return p;
  };
  window.addEventListener('storage', e => { if (KEYS.includes(e.key)) refresh(); });
  document.addEventListener('click', () => { const el = document.getElementById('paAcct'); if (el) el.classList.remove('open'); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh); else refresh();
})();
