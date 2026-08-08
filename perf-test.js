/**
 * 性能压力测试脚本 - 座位图片管理应用
 *
 * 使用 Node.js + Puppeteer 模拟用户核心操作，收集性能数据并生成分析报告。
 *
 * 运行方式：node perf-test.js
 * 环境变量：
 *   PERF_URL  - 目标 URL（默认 https://seat-def.pages.dev）
 *   PERF_ROUNDS - 测试轮次（默认 3）
 *
 * 输出：performance-report.md
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TARGET_URL = process.env.PERF_URL || 'https://seat-def.pages.dev';
const ROUNDS = parseInt(process.env.PERF_ROUNDS || '3');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 生成 1x1 红色 JPEG base64（模拟测试图片，最小体积）
const TINY_IMG_BASE64 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AfwD/2Q==';

// ===== 性能数据收集器（注入浏览器端） =====
const PERF_COLLECTOR = `
(function() {
  window.__perf = {
    fps: { frames: 0, drops: 0, lastTime: performance.now(), minFps: Infinity, samples: [] },
    memory: { peaks: [], samples: [] },
    operations: [],
    idb: { reads: 0, writes: 0, readTime: 0, writeTime: 0 },
  };

  // FPS 监测：每秒采样一次
  let rafId;
  function fpsLoop() {
    window.__perf.fps.frames++;
    const now = performance.now();
    const elapsed = now - window.__perf.fps.lastTime;
    if (elapsed >= 1000) {
      const fps = Math.round((window.__perf.fps.frames * 1000) / elapsed);
      window.__perf.fps.samples.push(fps);
      if (fps < window.__perf.fps.minFps) window.__perf.fps.minFps = fps;
      if (fps < 30) window.__perf.fps.drops++;
      window.__perf.fps.frames = 0;
      window.__perf.fps.lastTime = now;
      // 内存采样
      if (performance.memory) {
        const mem = {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        };
        window.__perf.memory.samples.push(mem);
      }
    }
    rafId = requestAnimationFrame(fpsLoop);
  }
  rafId = requestAnimationFrame(fpsLoop);

  // 操作计时辅助
  window.__perfStart = function(opName) {
    window.__perf._currentOp = { name: opName, start: performance.now(), memBefore: performance.memory ? performance.memory.usedJSHeapSize : 0 };
  };
  window.__perfEnd = function() {
    if (!window.__perf._currentOp) return null;
    const op = window.__perf._currentOp;
    op.duration = performance.now() - op.start;
    op.memAfter = performance.memory ? performance.memory.usedJSHeapSize : 0;
    op.memDelta = op.memAfter - op.memBefore;
    window.__perf.operations.push({ name: op.name, duration: op.duration, memDelta: op.memDelta });
    window.__perf._currentOp = null;
    return op;
  };

  // IndexedDB 包装：拦截原始方法统计耗时
  if (window.indexedDB) {
    const origOpen = indexedDB.open;
    // 已有 db 实例时拦截事务
    window.__perf.idbWrap = function(db) {
      if (!db || db.__perfWrapped) return;
      db.__perfWrapped = true;
      const origTransaction = db.transaction.bind(db);
      db.transaction = function() {
        const tx = origTransaction.apply(null, arguments);
        const origObjStore = tx.objectStore.bind(tx);
        tx.objectStore = function() {
          const store = origObjStore.apply(null, arguments);
          const origGet = store.get.bind(store);
          const origGetAll = store.getAll.bind(store);
          const origPut = store.put.bind(store);
          const origDelete = store.delete.bind(store);
          store.get = function() {
            const t0 = performance.now();
            const req = origGet.apply(null, arguments);
            req.onsuccess = () => { window.__perf.idb.readTime += performance.now() - t0; window.__perf.idb.reads++; };
            return req;
          };
          store.getAll = function() {
            const t0 = performance.now();
            const req = origGetAll.apply(null, arguments);
            req.onsuccess = () => { window.__perf.idb.readTime += performance.now() - t0; window.__perf.idb.reads++; };
            return req;
          };
          store.put = function() {
            const t0 = performance.now();
            const req = origPut.apply(null, arguments);
            req.onsuccess = () => { window.__perf.idb.writeTime += performance.now() - t0; window.__perf.idb.writes++; };
            return req;
          };
          store.delete = function() {
            const t0 = performance.now();
            const req = origDelete.apply(null, arguments);
            req.onsuccess = () => { window.__perf.idb.writeTime += performance.now() - t0; window.__perf.idb.writes++; };
            return req;
          };
          return store;
        };
        return tx;
      };
    };
  }

  console.log('[perf] 性能收集器已注入');
})();
`;

// 注入 mock 图片数据到 IndexedDB + imageCountCache
async function injectMockData(page) {
  const result = await page.evaluate(async (imgBase64) => {
    // 直接通过 IndexedDB API 注入
    const DB_NAME = 'SeatImageDB';

    function openDBPerf() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME);
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
      });
    }

    let db;
    try {
      db = await openDBPerf();
    } catch (e) {
      console.error('[perf] IndexedDB 打开失败:', e);
      return { ok: false, reason: 'IndexedDB 打开失败' };
    }

    // 检查 store 是否存在
    if (!db.objectStoreNames.contains('cells')) {
      return { ok: false, reason: 'cells store 不存在，应用未初始化完成' };
    }

    // 清除旧 mock 数据
    try {
      const tx = db.transaction(['cells', 'trash'], 'readwrite');
      tx.objectStore('cells').clear();
      if (db.objectStoreNames.contains('trash')) tx.objectStore('trash').clear();
      await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    } catch (e) {}

    // 注入 mock 图片：floor 1 中庭 seat 0，时段 18(19:00) 和 19(19:30) 各 2 张
    const mockCells = [
      { key: '1-中庭-0-18', images: [
        { data: imgBase64, thumbnail: imgBase64, width: 100, height: 100, size: 1000, timestamp: Date.now() },
        { data: imgBase64, thumbnail: imgBase64, width: 100, height: 100, size: 1000, timestamp: Date.now() },
      ]},
      { key: '1-中庭-0-19', images: [
        { data: imgBase64, thumbnail: imgBase64, width: 100, height: 100, size: 1000, timestamp: Date.now() },
        { data: imgBase64, thumbnail: imgBase64, width: 100, height: 100, size: 1000, timestamp: Date.now() },
      ]},
    ];

    const tx2 = db.transaction(['cells'], 'readwrite');
    for (const cell of mockCells) {
      tx2.objectStore('cells').put(cell);
    }
    await new Promise(r => { tx2.oncomplete = r; tx2.onerror = r; });

    // 尝试调用应用内部刷新函数（通过全局查找）
    // 压缩后函数名可能混淆，但尝试常见全局引用
    const appGlobals = ['state', 'imageCountCache', 'refreshSeatImageStatsFromCache', 'computeSlotsWithImages', 'renderMain'];
    const found = {};
    appGlobals.forEach(g => { if (window[g] !== undefined) found[g] = typeof window[g]; });

    // 尝试更新 imageCountCache（如果可访问）
    try {
      if (window.imageCountCache) {
        window.imageCountCache.clear();
        window.imageCountCache.set('1-中庭-0-18', 2);
        window.imageCountCache.set('1-中庭-0-19', 2);
      }
      if (window.refreshSeatImageStatsFromCache) window.refreshSeatImageStatsFromCache();
      if (window.computeSlotsWithImages) window.computeSlotsWithImages();
    } catch (e) {}

    db.close();
    return { ok: true, foundGlobals: found };
  }, TINY_IMG_BASE64);

  if (result.ok) {
    console.log('  mock 数据注入成功', result.foundGlobals ? `全局变量: ${JSON.stringify(result.foundGlobals)}` : '');
    // 刷新页面让应用重新加载 IndexedDB 数据
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(3000);
    // 重新注入性能收集器（reload 后丢失）
    await page.evaluate(PERF_COLLECTOR);
    // 重新注入 IDB 包装器（包装应用的 dbInstance）
    await page.evaluate(() => {
      if (window.__perf && window.__perf.idbWrap) {
        // 尝试获取应用的 db 实例（通过 openDB 函数）
        try {
          if (typeof window.openDB === 'function') {
            window.openDB().then(db => {
              if (db) window.__perf.idbWrap(db);
            });
          }
        } catch (e) {}
      }
    });
    await sleep(500);
  } else {
    console.error('mock 数据注入失败:', result.reason);
  }
  return result.ok;
}

// 清理 mock 数据
async function cleanupMockData(page) {
  await page.evaluate(async () => {
    try {
      const req = indexedDB.open('SeatImageDB');
      req.onsuccess = async (e) => {
        const db = e.target.result;
        if (db.objectStoreNames.contains('cells')) {
          const tx = db.transaction(['cells', 'trash'], 'readwrite');
          tx.objectStore('cells').clear();
          if (db.objectStoreNames.contains('trash')) tx.objectStore('trash').clear();
        }
        db.close();
      };
    } catch (e) {}
  });
}

// ===== 单个操作模拟 =====

async function measureOp(page, opName, fn) {
  await page.evaluate(n => window.__perfStart(n), opName);
  const t0 = Date.now();
  try {
    await fn();
  } catch (e) {
    console.error(`  [操作异常] ${opName}: ${e.message}`);
  }
  const wallTime = Date.now() - t0;
  const perfOp = await page.evaluate(() => window.__perfEnd());
  return {
    name: opName,
    duration: perfOp ? perfOp.duration : wallTime,
    memDelta: perfOp ? perfOp.memDelta : 0,
    wallTime,
  };
}

// 1. 上传图片（模拟拍照，通过 uploadInput 注入 File）
async function opUpload(page) {
  // 先重置该座位 19:00 时段的图片（清除已有图片，确保上传按钮可用）
  await page.evaluate(async () => {
    try {
      const req = indexedDB.open('SeatImageDB');
      req.onsuccess = async (e) => {
        const db = e.target.result;
        if (db.objectStoreNames.contains('cells')) {
          const tx = db.transaction(['cells'], 'readwrite');
          // 删除 1-中庭-0-18 的数据，让上传按钮可用
          tx.objectStore('cells').delete('1-中庭-0-18');
          // 重新注入 1 张图（保持有图状态用于预览等操作）
          tx.objectStore('cells').put({
            key: '1-中庭-0-18',
            images: [
              { data: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AfwD/2Q==',
                thumbnail: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AfwD/2Q==',
                width: 100, height: 100, size: 1000, timestamp: Date.now()
              }
            ]
          });
          tx.oncomplete = () => { db.close(); };
        } else {
          db.close();
        }
      };
    } catch (e) {}
  });
  await sleep(500);

  // 刷新展开座位的时段卡片
  await page.evaluate(() => {
    if (window.state && window.state.expandedSeats) {
      window.state.expandedSeats.forEach(sk => {
        if (window.invalidateTimeslotCache) window.invalidateTimeslotCache(sk);
        if (window.renderTimeSlots) window.renderTimeSlots(sk);
      });
    }
    if (window.refreshSeatImageStatsFromCache) window.refreshSeatImageStatsFromCache();
    if (window.computeSlotsWithImages) window.computeSlotsWithImages();
  });
  await sleep(1000);
  // 确保一楼中庭座位0已展开，找到上传按钮
  const uploadReady = await page.evaluate(() => {
    const btn = document.querySelector('.ts-btn-upload[data-cell-key="1-中庭-0-18"]');
    return btn && !btn.disabled;
  });
  if (!uploadReady) return { skipped: true, reason: '上传按钮未就绪' };

  // 通过 puppeteer 设置文件 input
  const fileInput = await page.$('input[type="file"][accept="image/*"]:not([capture])');
  if (!fileInput) return { skipped: true, reason: '文件 input 未找到' };

  // 写临时测试图片文件
  const tmpFile = path.join(__dirname, '_perf_test_img.jpg');
  fs.writeFileSync(tmpFile, Buffer.from(TINY_IMG_BASE64.split(',')[1], 'base64'));

  await page.evaluate(() => {
    const btn = document.querySelector('.ts-btn-upload[data-cell-key="1-中庭-0-18"]');
    if (btn) btn.click();
  });
  await sleep(200);

  await fileInput.uploadFile(tmpFile);
  await sleep(2000); // 等待上传处理完成

  try { fs.unlinkSync(tmpFile); } catch (e) {}
}

// 2. 切换主题
async function opSwitchTheme(page, theme) {
  await page.evaluate((t) => {
    // 直接调用 applyTheme，不走 UI 面板（更快、更稳定）
    if (window.state && window.applyTheme) {
      window.state.currentTheme = t;
      window.applyTheme(t);
      window.saveThemeState();
    }
  }, theme);
  await sleep(800);
}

// 3. 展开楼层和区域
async function opExpandFloorArea(page) {
  await page.evaluate(() => {
    const floors = document.querySelectorAll('.floor-btn');
    if (floors[0] && !floors[0].classList.contains('expanded')) floors[0].click();
  });
  await sleep(800);
  await page.evaluate(() => {
    const areas = document.querySelectorAll('.area-btn');
    if (areas[0] && !areas[0].classList.contains('expanded')) areas[0].click();
  });
  await sleep(800);
}

// 4. 全屏预览
async function opPreview(page) {
  const hasThumb = await page.evaluate(() => {
    const thumb = document.querySelector('.thumb-wrap img[data-action="preview"]');
    if (thumb) { thumb.click(); return true; }
    return false;
  });
  if (hasThumb) {
    await sleep(1500);
    // 关闭预览
    await page.evaluate(() => {
      const closeBtn = document.getElementById('preview-close');
      if (closeBtn) closeBtn.click();
    });
    await sleep(500);
  }
}

// 5. 时段筛选
async function opFilter(page) {
  await page.evaluate(() => {
    if (window.openFilterSheet) window.openFilterSheet();
  });
  await sleep(800);
  // 勾选/取消几个时段
  await page.evaluate(() => {
    const items = document.querySelectorAll('.filter-slot-item');
    if (items[0]) items[0].click();
    if (items[5]) items[5].click();
  });
  await sleep(500);
  await page.evaluate(() => {
    if (window.closeFilterSheet) window.closeFilterSheet();
  });
  await sleep(800);
}

// 6. 批量下载（测量打包过程）
async function opBatchDownload(page) {
  await page.evaluate(() => {
    if (window.openFilterSheet) {} // 确保函数引用存在
    // 通过功能面板入口打开批量下载
    const funcBtn = document.getElementById('func-btn');
    if (funcBtn) funcBtn.click();
  });
  await sleep(600);
  await page.evaluate(() => {
    const item = document.querySelector('.func-item[data-func="open-batch-dl"]');
    if (item) item.click();
  });
  await sleep(1000);
  // 勾选区域和时段
  await page.evaluate(() => {
    const area = document.querySelector('#batch-areas .batch-chip');
    if (area) area.click();
    const time = document.querySelector('#batch-times .batch-chip');
    if (time) time.click();
  });
  await sleep(500);
  // 点击打包下载
  await page.evaluate(() => {
    const exec = document.getElementById('batch-exec');
    if (exec && !exec.disabled) exec.click();
  });
  // 等待打包完成：精确检测最终 toast "下载完成"（最终完成提示，唯一文本）
  // 【修正】原逻辑用 "下载"/"打包" 等宽泛关键词，会误匹配 showPersistentToast("正在处理...下载框...")
  //   导致提前误判；同时 30 秒超时过高，实际 32 张图打包约 1-3 秒。
  //   改为：精确匹配 "下载完成" 或 "无图片" 或 "失败"，超时降至 15 秒，轮询 200ms。
  for (let i = 0; i < 75; i++) {
    await sleep(200);
    const done = await page.evaluate(() => {
      const toast = document.querySelector('.toast');
      const toastText = toast ? toast.textContent : '';
      // 仅匹配最终完成提示，避免误匹配 "正在处理...下载框..."
      const isDone = toastText.includes('下载完成') ||
                     toastText.includes('无图片') ||
                     toastText.includes('打包失败') ||
                     toastText.includes('下载失败');
      return isDone;
    });
    if (done) break;
  }
  // 关闭面板和功能面板
  await page.evaluate(() => {
    const cancel = document.getElementById('batch-cancel');
    if (cancel) cancel.click();
    const funcClose = document.getElementById('func-panel-close');
    if (funcClose) funcClose.click();
  });
  await sleep(500);
}

// 7. 清除图片（只测到打开面板+勾选，不实际执行）
async function opCleanupPanel(page) {
  await page.evaluate(() => {
    const funcBtn = document.getElementById('func-btn');
    if (funcBtn) funcBtn.click();
  });
  await sleep(600);
  await page.evaluate(() => {
    const item = document.querySelector('.func-item[data-func="open-cleanup"]');
    if (item) item.click();
  });
  await sleep(1000);
  // 勾选区域（不点确认清除，避免破坏数据）
  await page.evaluate(() => {
    const area = document.querySelector('#cleanup-areas .batch-chip');
    if (area) area.click();
  });
  await sleep(500);
  // 关闭面板
  await page.evaluate(() => {
    const cancel = document.getElementById('cleanup-cancel');
    if (cancel) cancel.click();
    const funcClose = document.getElementById('func-panel-close');
    if (funcClose) funcClose.click();
  });
  await sleep(500);
}

// 8. 展开座位（点击座位按钮展开时段卡片）
async function opExpandSeat(page) {
  await page.evaluate(() => {
    const btn = document.querySelector('.seat-btn[data-floor="1"][data-area="中庭"][data-seat="0"]');
    if (btn && !btn.classList.contains('expanded')) btn.click();
  });
  await sleep(2000); // 等待 renderTimeSlots async 完成
}

// ===== 收集性能数据 =====
async function collectPerfData(page) {
  return await page.evaluate(() => {
    const p = window.__perf;
    const fpsSamples = p.fps.samples;
    const memSamples = p.memory.samples;
    const memPeak = memSamples.length > 0
      ? Math.max(...memSamples.map(m => m.usedJSHeapSize))
      : 0;
    const memAvg = memSamples.length > 0
      ? memSamples.reduce((s, m) => s + m.usedJSHeapSize, 0) / memSamples.length
      : 0;

    return {
      fps: {
        samples: fpsSamples,
        min: fpsSamples.length > 0 ? Math.min(...fpsSamples) : 0,
        avg: fpsSamples.length > 0 ? Math.round(fpsSamples.reduce((s, f) => s + f, 0) / fpsSamples.length) : 0,
        drops: p.fps.drops,
      },
      memory: {
        peak: memPeak,
        avg: memAvg,
        latest: memSamples.length > 0 ? memSamples[memSamples.length - 1].usedJSHeapSize : 0,
        limit: memSamples.length > 0 ? memSamples[0].jsHeapSizeLimit : 0,
      },
      idb: { ...p.idb },
      operations: p.operations.map(op => ({ ...op })),
    };
  });
}

async function resetPerfCounters(page) {
  await page.evaluate(() => {
    const p = window.__perf;
    p.operations = [];
    p.fps.samples = [];
    p.fps.drops = 0;
    p.fps.minFps = Infinity;
    p.fps.frames = 0;
    p.fps.lastTime = performance.now();
    p.memory.samples = [];
    p.idb = { reads: 0, writes: 0, readTime: 0, writeTime: 0 };
  });
}

// ===== 格式化辅助 =====
function fmtBytes(bytes) {
  if (bytes === 0 || !bytes) return '0 B';
  const sign = bytes < 0 ? '-' : '';
  let abs = Math.abs(bytes);
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (abs >= 1024 && i < units.length - 1) { abs /= 1024; i++; }
  return sign + abs.toFixed(1) + ' ' + units[i];
}

function fmtMs(ms) {
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(2) + 's';
}

// ===== 生成报告 =====
function generateReport(allRounds, loadTime) {
  const lines = [];
  lines.push('# 性能压力测试报告');
  lines.push('');
  lines.push(`**测试时间**: ${new Date().toLocaleString('zh-CN')}`);
  lines.push(`**目标 URL**: \`${TARGET_URL}\``);
  lines.push(`**测试轮次**: ${ROUNDS}`);
  lines.push(`**页面加载时间**: ${fmtMs(loadTime)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // 各轮次概要
  lines.push('## 一、各轮次测试概要');
  lines.push('');
  allRounds.forEach((round, i) => {
    lines.push(`### 第 ${i + 1} 轮`);
    lines.push('');
    lines.push('| 指标 | 数值 |');
    lines.push('|------|------|');
    lines.push(`| 内存峰值 | ${fmtBytes(round.perf.memory.peak)} |`);
    lines.push(`| 内存均值 | ${fmtBytes(round.perf.memory.avg)} |`);
    lines.push(`| FPS 最低 | ${round.perf.fps.min} fps |`);
    lines.push(`| FPS 均值 | ${round.perf.fps.avg} fps |`);
    lines.push(`| 卡顿次数（FPS<30） | ${round.perf.fps.drops} 次 |`);
    lines.push(`| IndexedDB 读取 | ${round.perf.idb.reads} 次 / ${fmtMs(round.perf.idb.readTime)} |`);
    lines.push(`| IndexedDB 写入 | ${round.perf.idb.writes} 次 / ${fmtMs(round.perf.idb.writeTime)} |`);
    lines.push('');

    // 各操作耗时
    lines.push('| 操作 | 耗时 | 内存增量 |');
    lines.push('|------|------|----------|');
    round.ops.forEach(op => {
      if (op.skipped) {
        lines.push(`| ${op.name} | 跳过（${op.reason || 'N/A'}） | - |`);
      } else {
        lines.push(`| ${op.name} | ${fmtMs(op.duration)} | ${fmtBytes(op.memDelta)} |`);
      }
    });
    lines.push('');
  });

  // 汇总分析
  lines.push('## 二、汇总分析');
  lines.push('');

  // 操作平均耗时
  const opStats = {};
  allRounds.forEach(round => {
    round.ops.forEach(op => {
      if (op.skipped) return;
      if (!opStats[op.name]) opStats[op.name] = { durations: [], memDeltas: [] };
      opStats[op.name].durations.push(op.duration);
      opStats[op.name].memDeltas.push(op.memDelta);
    });
  });

  lines.push('### 操作平均耗时（跨轮次）');
  lines.push('');
  lines.push('| 操作 | 平均耗时 | 最大耗时 | 平均内存增量 |');
  lines.push('|------|----------|----------|--------------|');
  const opList = Object.entries(opStats)
    .map(([name, s]) => ({
      name,
      avg: s.durations.reduce((a, b) => a + b, 0) / s.durations.length,
      max: Math.max(...s.durations),
      memAvg: s.memDeltas.reduce((a, b) => a + b, 0) / s.memDeltas.length,
    }))
    .sort((a, b) => b.avg - a.avg);

  opList.forEach(op => {
    lines.push(`| ${op.name} | ${fmtMs(op.avg)} | ${fmtMs(op.max)} | ${fmtBytes(op.memAvg)} |`);
  });
  lines.push('');

  // 内存趋势
  const memPeaks = allRounds.map(r => r.perf.memory.peak);
  const memAvgs = allRounds.map(r => r.perf.memory.avg);
  lines.push('### 内存趋势');
  lines.push('');
  lines.push('| 轮次 | 内存峰值 | 内存均值 |');
  lines.push('|------|----------|----------|');
  allRounds.forEach((round, i) => {
    lines.push(`| 第 ${i + 1} 轮 | ${fmtBytes(round.perf.memory.peak)} | ${fmtBytes(round.perf.memory.avg)} |`);
  });
  const memGrowth = memPeaks[memPeaks.length - 1] - memPeaks[0];
  lines.push('');
  lines.push(`内存增长（首轮→末轮）: ${fmtBytes(memPeaks[0])} → ${fmtBytes(memPeaks[memPeaks.length - 1])}（${memGrowth > 0 ? '+' : ''}${fmtBytes(memGrowth)}）`);
  lines.push('');

  // FPS 分析
  lines.push('### FPS 分析');
  lines.push('');
  const allMinFps = allRounds.map(r => r.perf.fps.min);
  const allAvgFps = allRounds.map(r => r.perf.fps.avg);
  const totalDrops = allRounds.reduce((s, r) => s + r.perf.fps.drops, 0);
  lines.push(`- 最低 FPS: ${Math.min(...allMinFps)} fps`);
  lines.push(`- 平均 FPS: ${Math.round(allAvgFps.reduce((a, b) => a + b, 0) / allAvgFps.length)} fps`);
  lines.push(`- 卡顿总次数（FPS<30）: ${totalDrops} 次`);
  lines.push('');

  // IndexedDB 分析
  const totalReads = allRounds.reduce((s, r) => s + r.perf.idb.reads, 0);
  const totalWrites = allRounds.reduce((s, r) => s + r.perf.idb.writes, 0);
  const totalReadTime = allRounds.reduce((s, r) => s + r.perf.idb.readTime, 0);
  const totalWriteTime = allRounds.reduce((s, r) => s + r.perf.idb.writeTime, 0);
  lines.push('### IndexedDB 分析');
  lines.push('');
  lines.push(`- 总读取次数: ${totalReads} 次，总耗时: ${fmtMs(totalReadTime)}`);
  lines.push(`- 总写入次数: ${totalWrites} 次，总耗时: ${fmtMs(totalWriteTime)}`);
  if (totalReads > 0) lines.push(`- 平均单次读取: ${fmtMs(totalReadTime / totalReads)}`);
  if (totalWrites > 0) lines.push(`- 平均单次写入: ${fmtMs(totalWriteTime / totalWrites)}`);
  lines.push('');

  // 性能瓶颈列表
  lines.push('## 三、性能瓶颈列表（按优先级排序）');
  lines.push('');
  const bottlenecks = [];

  // 最慢操作
  if (opList.length > 0) {
    const slowest = opList[0];
    bottlenecks.push({
      priority: 'P0',
      area: slowest.name,
      issue: `平均耗时 ${fmtMs(slowest.avg)}，最大耗时 ${fmtMs(slowest.max)}`,
      suggestion: getOptimizationSuggestion(slowest.name),
    });
  }

  // 内存泄漏检测
  if (memGrowth > 5 * 1024 * 1024) {
    bottlenecks.push({
      priority: 'P1',
      area: '内存泄漏',
      issue: `跨轮次内存增长 ${fmtBytes(memGrowth)}（${fmtBytes(memPeaks[0])} → ${fmtBytes(memPeaks[memPeaks.length - 1])}）`,
      suggestion: '检查 Blob URL 是否未 revoke、DOM 缓存是否未清理、事件监听器是否未移除。使用 Chrome DevTools Memory 面板进行堆快照对比。',
    });
  }

  // FPS 卡顿
  if (totalDrops > ROUNDS) {
    bottlenecks.push({
      priority: 'P1',
      area: '帧率卡顿',
      issue: `共 ${totalDrops} 次 FPS<30 卡顿，最低 ${Math.min(...allMinFps)} fps`,
      suggestion: '检查大列表渲染是否使用虚拟滚动、图片解码是否使用 lazy loading、CSS 动画是否使用 transform/opacity（GPU 加速）。',
    });
  }

  // IndexedDB 频繁读取
  if (totalReads > 50) {
    bottlenecks.push({
      priority: 'P2',
      area: 'IndexedDB 读取频繁',
      issue: `共 ${totalReads} 次读取，总耗时 ${fmtMs(totalReadTime)}`,
      suggestion: '使用内存缓存（Map）减少重复读取；对 getAll 全表扫描加索引；批量操作时合并为单事务。',
    });
  }

  // IndexedDB 写入慢
  if (totalWrites > 0 && totalWriteTime / totalWrites > 50) {
    bottlenecks.push({
      priority: 'P2',
      area: 'IndexedDB 写入慢',
      issue: `平均单次写入 ${fmtMs(totalWriteTime / totalWrites)}`,
      suggestion: '检查是否每次写入都开启新事务；考虑批量 put 合并为单事务；图片数据压缩后再存储。',
    });
  }

  if (bottlenecks.length === 0) {
    lines.push('未检测到明显性能瓶颈。');
  } else {
    bottlenecks.forEach(b => {
      lines.push(`### ${b.priority} - ${b.area}`);
      lines.push('');
      lines.push(`**问题**: ${b.issue}`);
      lines.push('');
      lines.push(`**优化建议**: ${b.suggestion}`);
      lines.push('');
    });
  }

  lines.push('## 四、推荐优化方案');
  lines.push('');
  lines.push('1. **IndexedDB 全表扫描优化**: `trashGetAll()` 和 `trashGetBySlot()` 使用 `getAll()` 全表扫描，建议在 `deletedAt` 字段上创建索引，或维护内存计数器减少查询。');
  lines.push('2. **DOM 缓存策略**: `timeslotDOMCache` 已实现 LRU 缓存，建议监控缓存命中率，适当调大 `TIMESLOT_DOM_CACHE_MAX`。');
  lines.push('3. **Blob URL 生命周期管理**: 拍照后的 Blob URL 需在座位折叠或图片删除时及时 `URL.revokeObjectURL()`，避免内存泄漏。');
  lines.push('4. **图片懒加载**: 缩略图已使用 `IntersectionObserver` 懒加载，确保 `rootMargin` 设置合理（建议 `100px`）提前加载。');
  lines.push('5. **批量下载并发控制**: JSZip 打包大量图片时可能阻塞主线程，考虑使用 Web Worker 或分片打包。');
  lines.push('6. **主题切换重绘**: 主题切换会触发全量 CSS 重计算，建议使用 CSS 变量减少重绘范围。');
  lines.push('7. **FPS 监控常态化**: 在开发环境常驻 FPS 监控，及时发现卡顿回归。');

  lines.push('');
  lines.push('---');
  lines.push(`*报告由 perf-test.js 自动生成*`);

  return lines.join('\n');
}

function getOptimizationSuggestion(opName) {
  const suggestions = {
    '上传图片': '检查 FileReader 读取 + Canvas 转换 + IndexedDB 写入链路；考虑使用 createImageBitmap 替代 Image + Canvas；图片压缩前置。',
    '切换主题': '使用 CSS 变量减少重绘范围；避免主题切换时触发 renderMain 全量重绘。',
    '展开楼层区域': '预渲染未展开楼层的 DOM 结构；使用 content-visibility: auto 跳过离屏内容渲染。',
    '全屏预览': '检查 Blob URL 生成 + 图片解码耗时；大图使用渐进式解码（decode() 异步 API）。',
    '时段筛选': '筛选切换已用 CSS 显隐（applyTimeslotFilter），确认未触发 renderTimeSlots 全量重建。',
    '批量下载': 'JSZip 打包阻塞主线程，考虑 Web Worker；图片收集阶段减少重复 IndexedDB 读取。',
    '清除图片面板': '面板初始化时 initCleanupModal 遍历所有区域统计图片数，建议使用缓存计数。',
    '展开座位': 'renderTimeSlots 渲染 23 个时段卡片，考虑虚拟列表或分批渲染。',
  };
  return suggestions[opName] || '分析具体操作链路，定位耗时最长的函数。';
}

// ===== 主流程 =====
async function main() {
  console.log(`\n=== 性能压力测试 ===`);
  console.log(`目标: ${TARGET_URL}`);
  console.log(`轮次: ${ROUNDS}`);
  console.log(`浏览器: Edge headless\n`);

  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--window-size=480,800',
      '--enable-precise-memory-info',
    ],
  });

  const allRounds = [];
  let loadTime = 0;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 480, height: 800 });

    // 拦截下载请求（批量下载会触发下载，不保存到磁盘）
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (req.url().startsWith('blob:') || req.url().startsWith('data:application/zip')) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // 捕获控制台日志
    page.on('console', msg => {
      if (msg.text().includes('[perf]')) console.log('  ' + msg.text());
    });

    console.log('加载页面...');
    const navStart = Date.now();
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(3000);

    // 获取页面加载时间
    loadTime = await page.evaluate(() => {
      const t = performance.timing;
      return t.loadEventEnd - t.navigationStart;
    });
    console.log(`页面加载时间: ${fmtMs(loadTime)}`);

    // 注入性能收集器
    await page.evaluate(PERF_COLLECTOR);
    await sleep(200);

    // 注入 mock 数据
    console.log('注入 mock 图片数据...');
    const injected = await injectMockData(page);
    if (!injected) {
      console.error('mock 数据注入失败，终止测试');
      return;
    }
    console.log('mock 数据注入成功');

    // 先展开一楼中庭座位0（为后续操作做准备）
    await page.evaluate(() => {
      state.expandedFloors.add(1);
      state.expandedAreas.add('1-中庭');
      saveUIState();
    });
    await page.evaluate(() => renderMain());
    await sleep(1000);
    // 展开座位0
    await page.evaluate(() => {
      const btn = document.querySelector('.seat-btn[data-floor="1"][data-area="中庭"][data-seat="0"]');
      if (btn) btn.click();
    });
    await sleep(2000);

    // 开始多轮测试
    for (let round = 0; round < ROUNDS; round++) {
      console.log(`\n--- 第 ${round + 1}/${ROUNDS} 轮 ---`);
      await resetPerfCounters(page);

      const ops = [];

      // 操作1：上传图片（模拟拍照）
      console.log('  [1/8] 上传图片...');
      ops.push(await measureOp(page, '上传图片', () => opUpload(page)));
      await sleep(1500);

      // 操作2：切换主题
      console.log('  [2/8] 切换主题（护眼→蓝色→怀旧→默认）...');
      ops.push(await measureOp(page, '切换主题', async () => {
        await opSwitchTheme(page, 'normal');
        await sleep(1000);
        await opSwitchTheme(page, 'yiban');
        await sleep(1000);
        await opSwitchTheme(page, 'pixel');
        await sleep(1000);
        await opSwitchTheme(page, 'default');
      }));
      await sleep(1500);

      // 操作3：展开楼层和区域
      console.log('  [3/8] 展开楼层和区域...');
      ops.push(await measureOp(page, '展开楼层区域', () => opExpandFloorArea(page)));
      await sleep(1500);

      // 操作4：全屏预览
      console.log('  [4/8] 全屏预览...');
      ops.push(await measureOp(page, '全屏预览', () => opPreview(page)));
      await sleep(1500);

      // 操作5：时段筛选
      console.log('  [5/8] 时段筛选...');
      ops.push(await measureOp(page, '时段筛选', () => opFilter(page)));
      await sleep(1500);

      // 操作6：批量下载
      console.log('  [6/8] 批量下载...');
      ops.push(await measureOp(page, '批量下载', () => opBatchDownload(page)));
      await sleep(1500);

      // 操作7：清除图片面板
      console.log('  [7/8] 清除图片面板...');
      ops.push(await measureOp(page, '清除图片面板', () => opCleanupPanel(page)));
      await sleep(1500);

      // 操作8：展开座位
      console.log('  [8/8] 展开座位...');
      ops.push(await measureOp(page, '展开座位', () => opExpandSeat(page)));
      await sleep(1500);

      // 收集本轮性能数据
      const perf = await collectPerfData(page);
      allRounds.push({ round: round + 1, ops, perf });

      console.log(`  本轮: 内存峰值 ${fmtBytes(perf.memory.peak)}, FPS 均值 ${perf.fps.avg}, 卡顿 ${perf.fps.drops} 次`);
    }

    // 清理 mock 数据
    console.log('\n清理 mock 数据...');
    await cleanupMockData(page);

  } finally {
    await browser.close();
  }

  // 生成报告
  console.log('\n生成报告...');
  const report = generateReport(allRounds, loadTime);
  const reportPath = path.join(__dirname, 'performance-report.md');
  fs.writeFileSync(reportPath, report, 'utf8');
  console.log(`报告已生成: ${reportPath}`);

  // 打印摘要
  console.log('\n=== 测试摘要 ===');
  console.log(`页面加载: ${fmtMs(loadTime)}`);
  allRounds.forEach(r => {
    console.log(`第${r.round}轮: 内存峰值 ${fmtBytes(r.perf.memory.peak)}, FPS ${r.perf.fps.avg}avg/${r.perf.fps.min}min, 卡顿 ${r.perf.fps.drops}次`);
  });
  console.log('');
}

main().catch(err => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
