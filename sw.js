// 图书馆座位图片管理 - Service Worker
// 策略说明：
//   index.html / styles.css / scripts.min.js → Network-First（网络优先，保证每次打开都是最新版）
//   manifest.json → Network-First（网络优先，确保图标等配置更新及时生效）
//   seat-icon.png → Cache-First（缓存优先，不常变，省流量）
//   外部 CDN（jszip）→ Network-First（网络优先，离线回退缓存）

// 【v1.25.6】更新缓存版本号（每次发布新版本时必须递增，否则浏览器不会检测到 SW 更新）
const CACHE_NAME = 'seat-cache-v146';

// 【v1.25.9】友好离线页：当所有缓存回退均失败时返回，替代原裸露"离线"文本
const OFFLINE_HTML = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>离线</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f2f5;color:#333}.box{text-align:center;padding:32px 24px;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:80vw}h2{margin:0 0 8px;font-size:18px;color:#1890ff}p{margin:0;font-size:14px;color:#666;line-height:1.6}button{margin-top:16px;padding:8px 24px;background:#1890ff;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer}button:active{opacity:.8}</style></head><body><div class="box"><h2>当前处于离线状态</h2><p>请检查网络连接后刷新页面</p><button onclick="location.reload()">重新加载</button></div></body></html>';

// 预缓存资源列表（安装时一次性缓存）
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './scripts.min.js',
  './manifest.json',
  './seat-icon.png',
  './seat-icon-192.png',
  './shenyelogo.png'
];

// Cache-First 资源：不常变，优先从缓存读取
const CACHE_FIRST_URLS = [
  './seat-icon.png',
  './seat-icon-192.png',
  './shenyelogo.png'
];

// ===== 安装事件 =====
// 预缓存核心资源，不自动 skipWaiting（等用户确认更新提示后再激活）
// 【v1.2.0 iOS兼容】添加 try-catch 防止 iOS 缓存失败导致 SW 安装中断
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(PRECACHE_ASSETS)).catch(err => {
      console.warn('SW 预缓存失败（iOS 可能限制），继续安装:', err);
    })
  );
});

// ===== 消息事件 =====
// 用户点击"有新版本可用，点击刷新"后，新 SW 立即激活
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // 【v1.23.4】收到清理缓存指令：删除所有缓存并重新预缓存，完成后通知页面
  // 【v1.23.14】修复 Promise.all 写法：原写法 Promise.all(promise.then(arr)) 语义不清，改为标准链式
  if (e.data && e.data.type === 'CLEAR_CACHE') {
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => caches.open(CACHE_NAME).then(c => c.addAll(PRECACHE_ASSETS)))
      .then(() => {
        if (e.source) e.source.postMessage({ type: 'CACHE_CLEARED' });
      })
      .catch(err => {
        console.warn('SW 清理缓存失败:', err);
        if (e.source) e.source.postMessage({ type: 'CACHE_CLEARED' });
      });
  }
});

// ===== 激活事件 =====
// 【v1.25.9 修复】调整顺序：先预缓存新资源 → 后清理旧缓存。
//   原顺序（先清后填）在激活窗口期会同时丢失新旧缓存，叠加网络抖动会返回裸露"离线"文本，
//   导致用户看到左上角只有"离线"两个小字的页面。
//   新顺序确保任意时刻至少有一份可用缓存（旧或新）。
//   同时用 Promise.allSettled 替代 addAll：单个资源失败不导致整体回滚。
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c =>
      Promise.allSettled(PRECACHE_ASSETS.map(url => c.add(url)))
    ).then(() =>
      caches.keys().then(keys =>
        Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : Promise.resolve()))
      )
    ).then(() => self.clients.claim())
  );
});

// ===== 请求拦截 =====
self.addEventListener('fetch', e => {
  // 只处理 GET 请求
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // --- 外部 CDN 资源（如 jszip）：网络优先，离线回退缓存 ---
  if (url.origin !== self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          // 【v1.23.9】先同步 clone，再异步 put，避免 body 已被消费
          if (resp.ok) {
            const respClone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, respClone));
          }
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // --- index.html / styles.css / scripts.min.js / manifest.json：Network-First（网络优先）---
  // 每次打开都优先请求网络，确保拿到最新版；网络失败时才用缓存
  // 【v1.23.4】用 cache:'no-cache' 绕过浏览器 HTTP 缓存，避免拿到旧版本
  if (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html') || url.pathname === '/' || url.pathname.endsWith('/manifest.json') || url.pathname.endsWith('/styles.css') || url.pathname.endsWith('/scripts.min.js') || url.pathname.endsWith('/sw.js')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' })
        .then(resp => {
          // 网络成功：更新缓存并返回最新内容
          // 【v1.23.9】先同步 clone，再异步 put
          if (resp.ok) {
            const respClone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, respClone));
          }
          return resp;
        })
        .catch(() => {
          // 【v1.25.9 修复】网络失败（离线）：逐级回退，避免裸露"离线"文本
          //   1. 精确匹配当前请求
          //   2. fallback 到缓存的 index.html 或 './'（保证至少有完整页面）
          //   3. 实在无缓存时返回友好离线页（带样式+重试按钮），而非裸露"离线"两字
          return caches.match(e.request).then(cached =>
            cached
            || caches.match('./index.html')
            || caches.match('./')
            || caches.match(new Request(e.request.url, { mode: 'same-origin' }))
            || new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
          );
        })
    );
    return;
  }

  // --- Cache-First 资源：seat-icon.png 等 ---
  // 不常变，优先从缓存读取，缓存没有才请求网络
  if (CACHE_FIRST_URLS.some(u => url.pathname.endsWith(u.replace('./', '')))) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(resp => {
          // 【v1.23.9】先同步 clone，再异步 put
          if (resp.ok) {
            const respClone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, respClone));
          }
          return resp;
        });
      })
    );
    return;
  }

  // --- 其他同源资源：Stale-While-Revalidate ---
  // 先返回缓存（秒开），后台静默更新缓存（下次访问生效）
  e.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(e.request).then(cached => {
        const fetchPromise = fetch(e.request)
          .then(resp => {
            // 【v1.23.9】先同步 clone，再异步 put
            if (resp.ok) {
              const respClone = resp.clone();
              cache.put(e.request, respClone);
            }
            return resp;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    )
  );
});
