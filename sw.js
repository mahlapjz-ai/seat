// 【修复PWA离线缓存】Service Worker v4
// 缓存策略：stale-while-revalidate（优先缓存，后台更新）
// 离线时从缓存返回，在线时先返回缓存再后台更新缓存
const CACHE_NAME = 'seat-cache-v4';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './seat-icon.png'
];

// 安装：预缓存核心资源
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))
  );
  // 不自动 skipWaiting，等用户点击更新提示后再激活
});

// 接收页面消息：用户点击更新提示后，新 SW 立即激活
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 激活：清理旧版本缓存，立即接管所有客户端
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 请求拦截：stale-while-revalidate 策略
self.addEventListener('fetch', e => {
  // 只处理同源 GET 请求
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // 外部 CDN 资源（如 jszip）：网络优先，失败回退缓存
  if (url.origin !== self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          // 缓存成功的响应
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 同源资源：stale-while-revalidate（优先缓存，后台更新）
  e.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(e.request).then(cached => {
        // 后台发起网络请求更新缓存
        const fetchPromise = fetch(e.request)
          .then(resp => {
            if (resp.ok) {
              cache.put(e.request, resp.clone());
            }
            return resp;
          })
          .catch(() => cached); // 网络失败时回退缓存

        // 有缓存就先返回缓存，否则等网络
        return cached || fetchPromise;
      })
    )
  );
});
