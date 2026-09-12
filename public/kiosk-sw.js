// 打卡台离线壳 Service Worker: 把打卡页本体缓存在平板上,
// 系统部署/重启期间 (服务器 5xx 或完全连不上) 页面照常打开。
// 只拦截打卡页自身和它的静态依赖, API 等其他请求一概不碰。
const CACHE = 'kiosk-v1';
const PAGE_PATHS = ['/kiosk', '/kiosk.html'];
const ASSET_PATHS = ['/kiosk-manifest.json', '/js/jsqr.min.js'];

self.addEventListener('install', () => { self.skipWaiting(); });

// 首次安装就把当前打开的打卡页 URL (含 ?site=) 和静态依赖存进缓存,
// 不用等下一次刷新 —— 平板页面常开, 下一次刷新可能正赶上部署
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    await self.clients.claim();
    try {
      const cache = await caches.open(CACHE);
      const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of cs) {
        try {
          const u = new URL(c.url);
          if (u.origin === self.location.origin && PAGE_PATHS.includes(u.pathname)) await cache.add(c.url);
        } catch (_) {}
      }
      for (const p of ASSET_PATHS) { try { await cache.add(p); } catch (_) {} }
    } catch (_) {}
  })());
});

// 服务器部署中请求可能长时间挂起 → 给网络请求加超时, 超时按「拿不到」回退缓存
function _netWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sw-timeout')), ms);
    fetch(req).then(r => { clearTimeout(t); resolve(r); }, e => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let u;
  try { u = new URL(req.url); } catch (_) { return; }
  if (u.origin !== self.location.origin) return;
  const isPage = PAGE_PATHS.includes(u.pathname);
  if (!isPage && !ASSET_PATHS.includes(u.pathname)) return;
  // 网络优先: 正常时永远拿服务器最新版并刷新缓存; 拿不到 (断网/超时/5xx) 才回退缓存
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fromCache = async () => {
      let hit = await cache.match(req);
      if (!hit && isPage) hit = await cache.match(req, { ignoreSearch: true }); // ?site= 变了也能兜底
      return hit || null;
    };
    let r = null;
    try { r = await _netWithTimeout(req, 8000); } catch (_) {}
    if (r && r.ok) {
      try { await cache.put(req, r.clone()); } catch (_) {}
      return r;
    }
    if (r && r.status < 500) return r; // 404 等正常响应原样返回, 只有 5xx 才当「服务器不在」
    const hit = await fromCache();
    if (hit) return hit;
    if (r) return r;
    return Response.error();
  })());
});
