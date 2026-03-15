// address-validator.js
// Client-side helper for Google Address Validation (US addresses).
// Calls the server-side proxy at /api/validate-address (API key is server-side only).

/**
 * Validate structured address fields.
 * @param {{ street, street2, city, state, zip, regionCode? }} fields
 * @param {{ silent?: boolean }} opts  silent=true suppresses the "not found" dialog
 * @returns {Promise<{ proceed: boolean, skipped?: boolean, verified?: boolean, standardized?: object }>}
 */
async function validateAddress({ street, street2, city, state, zip, regionCode, countryName }, { silent = false } = {}) {
  if (!street && !city && !zip) return { proceed: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch('/api/validate-address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ street: street || '', street2: street2 || '', city: city || '', state: state || '', zip: zip || '', ...(regionCode && { regionCode }), ...(countryName && { countryName }) }),
      signal: controller.signal
    });
    if (!res.ok) return { proceed: true };
    const data = await res.json();
    return await _handleResult(data, { street, city, state, zip }, { silent });
  } catch (e) {
    if (e.name === 'AbortError') console.warn('[Google Address Validation] Request timed out');
    else console.warn('[Google Address Validation] Error:', e);
    return { proceed: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate a single-line address string (e.g. "123 Main St, Chicago, IL 60601").
 * @param {string} address
 * @returns {Promise<{ proceed: boolean, verified?: boolean, standardized?: string }>}
 */
async function validateAddressSingleField(address, { silent = false } = {}) {
  if (!address || !address.trim()) return { proceed: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch('/api/validate-address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ street: address.trim() }),
      signal: controller.signal
    });
    if (!res.ok) return { proceed: true };
    const data = await res.json();
    const result = await _handleResult(data, { street: address.trim() }, { silent });
    if (result.standardized) {
      const std = result.standardized;
      const parts = [std.street];
      if (std.street2) parts.push(std.street2);
      const cityStateLine = [std.city, std.state].filter(Boolean).join(', ');
      const zipFull = std.zip + (std.zip4 ? '-' + std.zip4 : '');
      if (cityStateLine || zipFull) parts.push(cityStateLine + (cityStateLine && zipFull ? ' ' : '') + zipFull);
      return { proceed: true, verified: true, standardized: parts.join(', ') };
    }
    return result;
  } catch (e) {
    if (e.name === 'AbortError') console.warn('[Google Address Validation] Request timed out');
    else console.warn('[Google Address Validation] Error:', e);
    return { proceed: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Show a styled in-app confirm dialog. Returns Promise<boolean>. */
function _showAddrDialog({ title, body, confirmLabel = '确认', cancelLabel = '取消', confirmDanger = false }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:10000;font-family:\'DM Sans\',sans-serif';

    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:12px;padding:1.75rem 2rem;width:100%;max-width:480px;box-shadow:0 8px 32px rgba(0,0,0,.18);margin:1rem';

    const confirmBg = confirmDanger ? '#E63946' : '#4A90D9';
    box.innerHTML =
      '<h3 style="font-size:1.05rem;font-weight:700;color:#0F2B5B;margin-bottom:.9rem;line-height:1.4">' + title + '</h3>' +
      '<div style="font-size:.88rem;color:#5F6B7A;line-height:1.7;margin-bottom:1.5rem">' + body + '</div>' +
      '<div style="display:flex;gap:.6rem;justify-content:flex-end">' +
        '<button class="_addr-cancel" style="padding:8px 18px;border:1px solid #e2e5ea;border-radius:8px;background:transparent;color:#5F6B7A;font-weight:600;font-size:.82rem;cursor:pointer;font-family:inherit">' + cancelLabel + '</button>' +
        '<button class="_addr-confirm" style="padding:8px 18px;border:none;border-radius:8px;background:' + confirmBg + ';color:#fff;font-weight:600;font-size:.82rem;cursor:pointer;font-family:inherit">' + confirmLabel + '</button>' +
      '</div>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const cleanup = result => { document.body.removeChild(overlay); resolve(result); };
    box.querySelector('._addr-confirm').onclick = () => cleanup(true);
    box.querySelector('._addr-cancel').onclick  = () => cleanup(false);
    overlay.onclick = e => { if (e.target === overlay) cleanup(false); };
  });
}

async function _handleResult(data, original, { silent = false } = {}) {
  if (data.skipped) return { proceed: true, skipped: true };

  if (!data.valid) {
    if (silent) return { proceed: true, verified: false };
    const enteredLine = [original.street, original.city, original.state, original.zip].filter(Boolean).join(', ');
    const proceed = await _showAddrDialog({
      title: '⚠ 地址无法验证 / Address Not Verified',
      body:
        '<b style="color:#2D3748">输入地址 / Entered:</b><br>' +
        '<span style="color:#0F2B5B;font-weight:600">' + enteredLine + '</span>' +
        '<br><br>该地址无法通过验证。<br>Address could not be verified.' +
        '<br><br>是否仍要继续提交？/ Continue submitting anyway?',
      confirmLabel: '继续提交 / Continue',
      cancelLabel: '取消 / Cancel',
      confirmDanger: true
    });
    return { proceed, verified: false };
  }

  const std = data.standardized;
  const origStreet = (original.street || '').trim().toLowerCase();
  const origCity   = (original.city  || '').trim().toLowerCase();
  const origState  = (original.state || '').trim().toLowerCase();
  const origZip    = (original.zip   || '').replace(/\D/g, '').substring(0, 5);

  const stdStreet = (std.street || '').trim().toLowerCase();
  const stdCity   = (std.city   || '').trim().toLowerCase();
  const stdState  = (std.state  || '').trim().toLowerCase();
  const stdZip    = (std.zip    || '').trim().substring(0, 5);

  const differs = origStreet !== stdStreet || origCity !== stdCity ||
                  origState  !== stdState  || origZip  !== stdZip;

  if (differs) {
    const zipFull  = std.zip + (std.zip4 ? '-' + std.zip4 : '');
    const stdParts = [std.street, std.street2, [std.city, std.state].filter(Boolean).join(', ') + ' ' + zipFull].filter(Boolean);
    const useStd = await _showAddrDialog({
      title: '✅ 地址已验证 / Address Verified',
      body:
        'Google 建议以下标准化地址 / Google suggests:<br><br>' +
        '<div style="background:#F0F9FF;border:1px solid #BAE6FD;border-radius:8px;padding:.6rem .9rem;font-weight:600;color:#0F2B5B;line-height:1.7">' +
          stdParts.join('<br>') +
        '</div>' +
        '<br>点击「使用建议地址」更新，或「保留原输入」保留您填写的内容。<br>' +
        'Click <b>Use Suggested</b> to update, or <b>Keep Original</b> to leave as entered.',
      confirmLabel: '使用建议地址 / Use Suggested',
      cancelLabel:  '保留原输入 / Keep Original'
    });
    if (useStd) {
      return {
        proceed: true,
        verified: true,
        standardized: {
          street:  std.street  || '',
          street2: std.street2 || '',
          city:    std.city    || '',
          state:   std.state   || '',
          zip:     std.zip + (std.zip4 ? '-' + std.zip4 : '')
        }
      };
    }
  }

  return { proceed: true, verified: true };
}
