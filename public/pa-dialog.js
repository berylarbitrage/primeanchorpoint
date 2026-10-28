// 站内样式弹窗（替代原生 alert / confirm / prompt），与后台 admin.html 同一风格：
// 图标 + 彩色标题 + 说明。各页面 <script src="/pa-dialog.js"></script> 引入即可。
//   showAlert(msg)                 → Promise<void>（不阻塞，后面的代码照常往下走）
//   await showConfirm(msg, opts)   → true / false（opts.html:true 时 msg 按 HTML 插入，调用方负责转义）
//   await showPrompt(msg, value)   → 字符串（可为 ''）/ 取消返回 null
// 按钮文字跟页面语言走：window.PA_DLG_LANG → 页面的 currentLang → <html lang>；
// 中英双语的提示（如 "提交失败 / Submission failed"，或中文下一行跟英文）按钮也用双语。
(function () {
  const COLORS = {
    blue:  { bg: '#DBEAFE', stroke: '#2563EB', title: '#1E40AF' },
    green: { bg: '#D1FAE5', stroke: '#059669', title: '#065F46' },
    red:   { bg: '#FEE2E2', stroke: '#DC2626', title: '#B91C1C' },
    amber: { bg: '#FEF3C7', stroke: '#D97706', title: '#92400E' }
  };
  const ICONS = {
    info:  '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    check: '<circle cx="12" cy="12" r="10"/><polyline points="8 12.5 11 15.5 16 9.5"/>',
    warn:  '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'
  };
  const L = {
    zh: { ok: '确认', got: '知道了', cancel: '取消', confirm: '请确认', input: '请输入', red: '出错了', green: '完成', amber: '请注意', blue: '提示' },
    en: { ok: 'Confirm', got: 'OK', cancel: 'Cancel', confirm: 'Please confirm', input: 'Please enter', red: 'Something went wrong', green: 'Done', amber: 'Please note', blue: 'Notice' },
    es: { ok: 'Confirmar', got: 'Entendido', cancel: 'Cancelar', confirm: 'Confirme', input: 'Ingrese', red: 'Algo salió mal', green: 'Listo', amber: 'Atención', blue: 'Aviso' }
  };

  function pageLang() {
    let l = window.PA_DLG_LANG;
    if (!l) { try { if (typeof currentLang === 'string') l = currentLang; } catch (e) {} } // eslint-disable-line no-undef
    l = String(l || document.documentElement.lang || 'zh').toLowerCase().slice(0, 2);
    return L[l] ? l : 'en';
  }
  // 中文 + 英文句子（「 / Please…」或另起一行）的双语提示 → 双语按钮
  function labels(msg) {
    const lang = pageLang();
    if (lang === 'zh' && /[一-鿿]/.test(msg) && /(^|\n|\/)\s*[A-Za-z]+(\s+[A-Za-z',.?!-]+){2,}/.test(msg)) {
      const o = {}; for (const k in L.zh) o[k] = L.zh[k] + ' / ' + L.en[k]; return o;
    }
    return L[lang];
  }

  let styled = false;
  function injectStyle() {
    if (styled) return; styled = true;
    const st = document.createElement('style');
    st.textContent =
      '.pa-dlg-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:100001;font-family:"DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}' +
      '.pa-dlg{background:#fff;border-radius:12px;padding:1.6rem 1.75rem;width:100%;max-width:420px;margin:1rem;max-height:85vh;display:flex;flex-direction:column;box-sizing:border-box;box-shadow:0 8px 32px rgba(0,0,0,.18);text-align:left}' +
      '.pa-dlg-head{display:flex;align-items:center;gap:.85rem;margin-bottom:.6rem;flex-shrink:0}' +
      '.pa-dlg-ic{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0}' +
      '.pa-dlg-title{margin:0;font-size:1.05rem;font-weight:700;line-height:1.35;min-width:0;word-break:break-word}' +
      '.pa-dlg-msg{font-size:.86rem;color:#5F6B7A;line-height:1.65;white-space:pre-line;word-break:break-word;overflow-y:auto;flex:1 1 auto;min-height:0;overscroll-behavior:contain;padding-left:calc(44px + .85rem)}' +
      '.pa-dlg-input{display:block;width:100%;box-sizing:border-box;margin-top:.8rem;border:1.5px solid #e2e5ea;border-radius:8px;padding:.5rem .7rem;font-size:.88rem;font-family:inherit;color:#2D3748;outline:none;transition:border .15s;flex-shrink:0}' +
      '.pa-dlg-input:focus{border-color:#b45309}' +
      '.pa-dlg-btns{display:flex;gap:.65rem;justify-content:flex-end;margin-top:1.2rem;flex-shrink:0}' +
      '.pa-dlg-btn{padding:8px 20px;border:none;border-radius:8px;font-weight:600;font-size:.82rem;cursor:pointer;font-family:inherit;background:#b45309;color:#fff;transition:all .2s}' +
      '.pa-dlg-btn:hover{background:#92400e}' +
      '.pa-dlg-btn.danger{background:#E63946}.pa-dlg-btn.danger:hover{background:#c5303c}' +
      '.pa-dlg-btn.outline{background:transparent;border:1px solid #e2e5ea;color:#5F6B7A}.pa-dlg-btn.outline:hover{background:#f7f8fa}';
    document.head.appendChild(st);
  }

  const stack = [];
  // 返回 Promise：确认 → true（prompt 时为输入内容），取消 → false（prompt 时为 null）
  function dialog({ title, message, html = false, color = 'blue', okText, cancelText = null, danger = false, input = null }) {
    injectStyle();
    return new Promise(resolve => {
      const c = COLORS[color] || COLORS.blue;
      const ic = ICONS[color === 'green' ? 'check' : color === 'blue' ? 'info' : 'warn'];
      const bg = document.createElement('div');
      bg.className = 'pa-dlg-bg';
      bg.innerHTML =
        '<div class="pa-dlg" role="dialog" aria-modal="true">' +
          '<div class="pa-dlg-head">' +
            '<div class="pa-dlg-ic" style="background:' + c.bg + '"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="' + c.stroke + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + ic + '</svg></div>' +
            '<h2 class="pa-dlg-title" style="color:' + c.title + '"></h2>' +
          '</div>' +
          '<div class="pa-dlg-msg"></div>' +
          (input != null ? '<input type="text" class="pa-dlg-input">' : '') +
          '<div class="pa-dlg-btns">' +
            (cancelText != null ? '<button type="button" class="pa-dlg-btn outline pa-dlg-cancel"></button>' : '') +
            '<button type="button" class="pa-dlg-btn' + (danger ? ' danger' : '') + ' pa-dlg-ok"></button>' +
          '</div>' +
        '</div>';
      bg.querySelector('.pa-dlg-title').textContent = title;
      const msgEl = bg.querySelector('.pa-dlg-msg');
      if (html) msgEl.innerHTML = message; else msgEl.textContent = message;
      const okBtn = bg.querySelector('.pa-dlg-ok'), cancelBtn = bg.querySelector('.pa-dlg-cancel'), inp = bg.querySelector('.pa-dlg-input');
      okBtn.textContent = okText;
      if (cancelBtn) cancelBtn.textContent = cancelText;
      if (inp) inp.value = input;
      const ok = () => done(inp ? inp.value : true);
      const cancel = () => done(inp ? null : (cancelBtn ? false : true));
      const onKey = e => {
        if (stack[stack.length - 1] !== bg) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
        else if (e.key === 'Enter' && inp && e.target === inp && !e.isComposing) { e.preventDefault(); ok(); }
      };
      function done(r) {
        document.removeEventListener('keydown', onKey, true);
        const i = stack.indexOf(bg); if (i >= 0) stack.splice(i, 1);
        bg.remove();
        resolve(r);
      }
      okBtn.onclick = ok;
      if (cancelBtn) cancelBtn.onclick = cancel;
      bg.onclick = e => { if (e.target === bg) cancel(); };
      document.addEventListener('keydown', onKey, true);
      stack.push(bg);
      document.body.appendChild(bg);
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      // 回车 = 点聚焦的按钮；危险操作默认聚焦「取消」防误按
      setTimeout(() => {
        if (inp) { inp.focus(); inp.select(); }
        else ((danger && cancelBtn) || okBtn).focus();
      }, 0);
    });
  }

  function guessColor(m) {
    if (/失败|错误|出错|异常|error|fail|err[oó]r|fall[oó]/i.test(m)) return 'red';
    if (/^\s*✅|成功|完成|已(保存|发送|复制|创建|更新|清空|删除|生成|提交|导入|同步|通过|添加|撤销|恢复|请求|重新)|success|saved|done/i.test(m)) return 'green';
    if (/^\s*(⚠️|请)|不能|无法|不正确|不一致|无效|至少|必须|不可|未|过期|不足|please|must|required|seleccione|por favor/i.test(m)) return 'amber';
    return 'blue';
  }

  window.showAlert = function (message, opts) {
    const m = message == null ? '' : String(message);
    const o = opts || {}, t = labels(m), color = o.color || guessColor(m);
    return dialog({ title: o.title || t[color], message: m, color, okText: t.got }).then(() => {});
  };
  window.showConfirm = function (message, opts) {
    const m = message == null ? '' : String(message);
    const o = opts || {}, t = labels(o.html ? m.replace(/<[^>]*>/g, '') : m);
    const danger = o.danger != null ? o.danger : /删除|清空|撤销|撤回|作废|覆盖|失效|不可|解绑|移除|拒绝|delete|remove|block/i.test(m);
    return dialog({ title: o.title || t.confirm, message: m, html: !!o.html, color: danger ? 'red' : 'amber', okText: o.confirmLabel || t.ok, cancelText: o.cancelLabel || t.cancel, danger });
  };
  window.showPrompt = function (message, value, opts) {
    const m = message == null ? '' : String(message);
    const o = opts || {}, t = labels(m);
    return dialog({ title: o.title || t.input, message: m, color: 'blue', okText: o.confirmLabel || t.ok, cancelText: o.cancelLabel || t.cancel, input: value == null ? '' : String(value) });
  };
})();
