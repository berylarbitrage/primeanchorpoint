// address-validator.js
// Client-side helper for Google Address Validation (US addresses).
// Calls the server-side proxy at /api/validate-address (API key is server-side only).

/**
 * Validate structured address fields.
 * @param {{ street, street2, city, state, zip }} fields
 * @returns {Promise<{ proceed: boolean, standardized?: { street, street2, city, state, zip } }>}
 */
async function validateAddress({ street, street2, city, state, zip }) {
  if (!street && !city && !zip) return { proceed: true };
  try {
    const res = await fetch('/api/validate-address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ street: street || '', street2: street2 || '', city: city || '', state: state || '', zip: zip || '' })
    });
    if (!res.ok) return { proceed: true };
    const data = await res.json();
    return _handleResult(data, { street, city, state, zip });
  } catch (e) {
    console.warn('[Google Address Validation] Error:', e);
    return { proceed: true };
  }
}

/**
 * Validate a single-line address string (e.g. "123 Main St, Chicago, IL 60601").
 * @param {string} address
 * @returns {Promise<{ proceed: boolean, standardized?: string }>}
 */
async function validateAddressSingleField(address) {
  if (!address || !address.trim()) return { proceed: true };
  try {
    const res = await fetch('/api/validate-address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ street: address.trim() })
    });
    if (!res.ok) return { proceed: true };
    const data = await res.json();
    const result = _handleResult(data, { street: address.trim() });
    if (result.standardized) {
      const std = result.standardized;
      const parts = [std.street];
      if (std.street2) parts.push(std.street2);
      const cityStateLine = [std.city, std.state].filter(Boolean).join(', ');
      const zipFull = std.zip + (std.zip4 ? '-' + std.zip4 : '');
      if (cityStateLine || zipFull) parts.push(cityStateLine + (cityStateLine && zipFull ? ' ' : '') + zipFull);
      return { proceed: true, standardized: parts.join(', ') };
    }
    return result;
  } catch (e) {
    console.warn('[Google Address Validation] Error:', e);
    return { proceed: true };
  }
}

function _handleResult(data, original) {
  if (data.skipped) return { proceed: true };

  if (!data.valid) {
    const addrStr = [original.street, original.city, original.state, original.zip].filter(Boolean).join(', ');
    const proceed = confirm(
      '⚠️ 地址无法验证 / Address could not be verified\n\n' +
      '输入地址 / Entered: ' + addrStr + '\n\n' +
      '该地址在 USPS 数据库中未找到匹配。\n' +
      'No match found in the USPS database.\n\n' +
      '是否仍要继续提交？/ Continue submitting anyway?'
    );
    return { proceed };
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
    const zipFull   = std.zip + (std.zip4 ? '-' + std.zip4 : '');
    const stdLines  = [std.street, std.street2, [std.city, std.state].filter(Boolean).join(', ') + ' ' + zipFull].filter(Boolean).join('\n');
    const useStd = confirm(
      '✅ 地址已验证 / Address Verified\n\n' +
      'Google 建议标准化地址 / Google suggests:\n\n' +
      stdLines + '\n\n' +
      '点击「确定」使用此标准化地址 / OK = use standardized address\n' +
      '点击「取消」保留原始输入 / Cancel = keep original'
    );
    if (useStd) {
      return {
        proceed: true,
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

  return { proceed: true };
}
