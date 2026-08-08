// 图书馆座位图片管理 - Service Worker
// 策略说明：
//   index.html / styles.css / scripts.min.js → Network-First（网络优先，保证每次打开都是最新版）
//   manifest.json → Network-First（网络优先，确保图标等配置更新及时生效）
//   seat-icon.png → Cache-First（缓存优先，不常变，省流量）
//   外部 CDN（jszip）→ Network-First（网络优先，离线回退缓存）

// 【v1.25.6】更新缓存版本号（每次发布新版本时必须递增，否则浏览器不会检测到 SW 更新）
// 【v1.28.10】第三批+第四批修复：SW 离线策略/并发锁/数据校验，递增 CACHE_NAME 触发更新
// 【v1.28.12】H5 修复：9 个弹窗补 ARIA + 焦点管理（ESC/Tab 陷阱/焦点返回），递增 CACHE_NAME 触发更新
// 【v1.28.13】第五批修复：键盘焦点样式/缩略图alt/SVG aria-hidden/record弹窗a11y/controllerchange叠加/AI结果XSS/删除弃用Worker
// 【v1.28.14】AI比对分阶段进度提示，缓解等待焦虑
// 【v1.28.15】新增拍照提醒 + AI比对功能开关(AI_COMPARE_ENABLED=false)
// 【v1.28.16】拍照提醒文字扫光动效 + 删除AI比对优化日志
// 【v1.28.17】修复扫光动效(text-shadow覆盖根因)+photo-tip移至mode-hint同行+动画重启
// 【v1.28.18】photo-tip移至设置按钮左侧+修复蓝色主题色块(background简写重置clip)+动画6s
// 【v1.28.19】photo-tip与设置按钮底边对齐(header-right容器+align-items:flex-end)
// 【v1.28.20】标题栏两行结构(header-top+header-bottom),photo-tip右边缘与设置按钮对齐
// 【v1.28.21】回退标题栏至 v1.28.18 单行布局+最小改动：photo-tip 移入 header-bottom 与 mode-hint 同行
// 【v1.28.22】修复 mode-hint 左边缘对齐：header-bottom padding-left 48px→0（已在 title-group 内 48px 处，避免重复计算）
// 【v1.28.23】扫光动画 200%→100% 修复扫两次 + header-bottom align-self:stretch 对齐版本号右边缘
// 【v1.28.24】修复 footer-collapsible 标题与内容间距过大（min-height:44px→padding 14px 16px 2px）
// 【v1.28.25】修复 min.js 中 APP_VERSION 内联引用未同步(标题栏显示v1.28.20的根因)
// 【v1.28.26】全屏预览 Blob URL 失效回退 IndexedDB Base64（修复微信内置浏览器破损图片）
// 【v1.29.0】第二种显示模式：修复筛选后座位列表未刷新 + 新增楼层时段文字
// 【v1.29.1】修复叠加筛选手动勾选时段异常 + 多图模式补充筛选命中图标
// 【v1.29.6】蓝色主题"记录完成时间"按钮点击向右偏移修复（:active 缺少 translateX(-50%) 导致覆盖居中定位）
const CACHE_NAME = 'seat-cache-v178';

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
// 【v1.28.8 P1修复】改用 fetch(cache:'no-cache') 逐个 put，替代 addAll
//   原因：addAll 走默认缓存语义，可能拿到 CDN/浏览器 HTTP 缓存的旧版本，
//   导致预缓存的资源是过期版本。逐个 fetch + put 可绕过 HTTP 缓存确保拿到最新版。
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(async c => {
      await Promise.allSettled(PRECACHE_ASSETS.map(async url => {
        try {
          const resp = await fetch(url, { cache: 'no-cache' });
          if (resp.ok) await c.put(url, resp);
        } catch (err) {
          console.warn('SW 预缓存失败:', url, err);
        }
      }));
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
  // 【v1.28.8 P1同步】改用 fetch(cache:'no-cache') 逐个 put，确保绕过 HTTP 缓存
  // 【v1.28.9 M3修复】用 e.waitUntil 包裹，防止 SW 在预缓存完成前被终止
  //   原实现 message 事件无 waitUntil，9 个资源预缓存耗时较长时 SW 可能被浏览器杀掉
  if (e.data && e.data.type === 'CLEAR_CACHE') {
    e.waitUntil(
      caches.keys()
        .then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .then(() => caches.open(CACHE_NAME).then(async c => {
          await Promise.allSettled(PRECACHE_ASSETS.map(async url => {
            try {
              const resp = await fetch(url, { cache: 'no-cache' });
              if (resp.ok) await c.put(url, resp);
            } catch (err) {
              console.warn('SW 重新预缓存失败:', url, err);
            }
          }));
        }))
        .then(() => {
          if (e.source) e.source.postMessage({ type: 'CACHE_CLEARED' });
        })
        .catch(err => {
          // 【v1.28.9】失败时发送不同的信号，前端可区分真实成功还是失败
          console.warn('SW 清理缓存失败:', err);
          if (e.source) e.source.postMessage({ type: 'CACHE_CLEAR_FAILED', error: String(err) });
        })
    );
  }
});

// ===== 激活事件 =====
// 【v1.25.9 修复】调整顺序：先预缓存新资源 → 后清理旧缓存。
//   原顺序（先清后填）在激活窗口期会同时丢失新旧缓存，叠加网络抖动会返回裸露"离线"文本，
//   导致用户看到左上角只有"离线"两个小字的页面。
//   新顺序确保任意时刻至少有一份可用缓存（旧或新）。
//   同时用 Promise.allSettled 替代 addAll：单个资源失败不导致整体回滚。
//   【v1.28.8 P1同步】c.add 改为 fetch(cache:'no-cache')+put，绕过 HTTP 缓存
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(async c => {
      await Promise.allSettled(PRECACHE_ASSETS.map(async url => {
        try {
          const resp = await fetch(url, { cache: 'no-cache' });
          if (resp.ok) await c.put(url, resp);
        } catch (err) {
          console.warn('SW 激活时预缓存失败:', url, err);
        }
      }));
    }).then(() =>
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

  // 【v1.28.2】过滤非 http/https 协议请求（如 chrome-extension://、ws:// 等）
  //   Cache API 不支持这些协议，尝试缓存会导致 TypeError: Request scheme 'chrome-extension' is unsupported
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

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
        // 【v1.28.9 M2修复】缓存未命中时返回 503，避免 respondWith 收到 undefined 报错
        .catch(() => caches.match(e.request).then(cached =>
          cached || new Response('', { status: 503 })
        ))
    );
    return;
  }

  // --- index.html / styles.css / scripts.min.js / manifest.json：Network-First（网络优先）---
  // 每次打开都优先请求网络，确保拿到最新版；网络失败时才用缓存
  // 【v1.23.4】用 cache:'no-cache' 绕过浏览器 HTTP 缓存，避免拿到旧版本
  // 【v1.28.8 B1修复】从条件中移除 sw.js：SW 由浏览器独立管理，不需要 fetch 拦截
  //   原逻辑会将 sw.js 纳入 Network-First，离线时回退到缓存的 index.html，
  //   返回 Content-Type: text/html 但被浏览器当作 SW 解析，触发 MIME 类型错误，
  //   导致 SW 注册失败、整个离线能力崩溃。
  if (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html') || url.pathname === '/' || url.pathname.endsWith('/manifest.json') || url.pathname.endsWith('/styles.css') || url.pathname.endsWith('/scripts.min.js')) {
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
          // 【v1.28.9 M1修复】跨类型回退仅用于导航请求，子资源（css/js/json）回退到 HTML
          //   会触发 MIME 类型不匹配错误，导致样式/脚本彻底加载失败，比直接 503 更糟
          return caches.match(e.request).then(cached => {
            if (cached) return cached;
            // 仅导航请求（页面跳转）才回退到 index.html / 离线页
            if (e.request.mode === 'navigate') {
              return caches.match('./index.html')
                || caches.match('./')
                || new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
            }
            // 子资源（css/js/json）离线时返回 503，不跨类型回退
            return new Response('', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
          });
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
        // 【v1.28.9 M2修复】网络失败时返回 503，避免 respondWith 收到 rejected promise
        return fetch(e.request).then(resp => {
          // 【v1.23.9】先同步 clone，再异步 put
          if (resp.ok) {
            const respClone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, respClone));
          }
          return resp;
        }).catch(() => new Response('', { status: 503 }));
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
          // 【v1.28.9 M2修复】缓存未命中且网络失败时返回 503，避免返回 undefined
          .catch(() => cached || new Response('', { status: 503 }));
        return cached || fetchPromise;
      })
    )
  );
});
