/**
 * v1.29.4 自测脚本 - applyTimeslotFilter 读取 data-seat-key 异常修复
 *
 * 修复点：data-seat-key 属性在 .btn-delete-seat 上，不在 .seat-name-text
 *         原 applyTimeslotFilter 读 .seat-name-text.dataset.seatKey → undefined.split('-') 报错
 *
 * 验证：
 * 1. 展开座位后切换筛选，applyTimeslotFilter 不再抛 "Cannot read properties of undefined (reading 'split')"
 * 2. 隐藏有时段的图片时，"以下时段照片被隐藏：xxx"提示正确显示
 * 3. 无隐藏时段图片时，不显示提示
 * 4. 筛选恢复后，提示被移除
 * 5. 回归 v1.29.3 的"仅显示有图"逻辑
 * 6. 版本号 + min.js 一致性
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = __dirname;
const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 09:00=0, 18:00=16, 19:00=18, 19:30=19, 20:00=20, 20:30=21
const TIDX_09 = 0;
const TIDX_18 = 16;
const TIDX_19 = 18;   // 19:00
const TIDX_1930 = 19; // 19:30
const TIDX_20 = 20;   // 20:00
const TIDX_2030 = 21; // 20:30

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' -> ' + detail : ''}`); }
}

function startServer() {
  return new Promise((resolve) => {
    const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
    const server = http.createServer((req, res) => {
      let urlPath = req.url.split('?')[0];
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(ROOT, urlPath);
      try {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      } catch (e) {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    server.listen(0, () => resolve(server));
  });
}

async function getState(page) {
  return await page.evaluate(() => ({
    visibleTimeSlots: [...state.visibleTimeSlots].sort((a, b) => a - b),
    filterNone: state._filterNone,
    filterOnlyImages: state._filterOnlyImages,
    savedFilterState: state._savedFilterState,
    slotsWithImages: [...state._slotsWithImages].sort((a, b) => a - b),
    expandedSeats: [...state.expandedSeats],
  }));
}

async function clickButton(page, btnId) {
  await page.evaluate((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.click();
  }, btnId);
  await sleep(150);
}

async function clickSlot(page, tidx) {
  await page.evaluate((idx) => {
    const item = document.querySelector(`.filter-slot-item[data-tidx="${idx}"]`);
    if (item) item.click();
  }, tidx);
  await sleep(100);
}

async function runTests() {
  const server = await startServer();
  const port = server.address().port;
  const url = `http://localhost:${port}/index.html`;

  console.log(`\n服务器启动: http://localhost:${port}`);
  console.log('启动 Edge headless...\n');

  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--window-size=480,800'],
  });

  // 收集页面错误
  const pageErrors = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 480, height: 800 });

    // 捕获未捕获异常
    page.on('pageerror', err => {
      pageErrors.push({ type: 'pageerror', message: err.message, stack: err.stack });
    });
    // 捕获 console.error
    page.on('console', msg => {
      if (msg.type() === 'error') {
        pageErrors.push({ type: 'console.error', message: msg.text() });
      }
    });

    console.log('加载页面...');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    // 注入 mock 图片数据：19:00 和 20:00 有图（floor 1, 中庭, seat index 0）
    await page.evaluate(() => {
      imageCountCache.clear();
      imageCountCache.set('1-中庭-0-18', 1); // 19:00
      imageCountCache.set('1-中庭-0-20', 2); // 20:00（多图）
      refreshSeatImageStatsFromCache();
      computeSlotsWithImages();
    });
    await sleep(200);

    const mockCheck = await page.evaluate(() => ({
      slotsWithImages: [...state._slotsWithImages],
    }));
    assert('mock 数据注入：_slotsWithImages = [18, 20] (19:00 + 20:00)',
      JSON.stringify(mockCheck.slotsWithImages) === '[18,20]',
      `实际: ${JSON.stringify(mockCheck.slotsWithImages)}`);

    // 清空已收集的错误（初始化阶段可能有无关错误）
    pageErrors.length = 0;

    console.log('\n=== 测试1：展开座位 + 切换筛选，验证 applyTimeslotFilter 不报错 ===');

    // 重置筛选为全选
    await page.evaluate(() => {
      state.visibleTimeSlots = new Set();
      state._filterNone = false;
      state._filterHidePassed = false;
      state._filterOnlyImages = false;
      state._savedFilterState = null;
      deriveFilterButtonState();
      saveFilterState();
    });

    // 展开一楼 → 中庭 → 座位 1001
    await page.evaluate(() => {
      state.expandedFloors.add(1);
      state.expandedAreas.add('1-中庭');
      saveUIState();
    });
    await page.evaluate(() => renderMain());
    await sleep(500);

    // 点击座位 1001（index=0）展开
    const seatClicked = await page.evaluate(() => {
      const btn = document.querySelector('.seat-btn[data-floor="1"][data-area="中庭"][data-seat="0"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
    assert('1.1 点击座位 1001 (index=0) 展开', seatClicked, '座位按钮未找到');
    await sleep(800); // 等待 renderTimeSlots async 完成

    const expandedCheck = await page.evaluate(() => ({
      expandedSeats: [...state.expandedSeats],
      containerExists: !!document.getElementById('timeslots-1-中庭-0'),
      seatHeaderExists: !!document.querySelector('#timeslots-1-中庭-0 .seat-header'),
      delBtnExists: !!document.querySelector('#timeslots-1-中庭-0 .btn-delete-seat'),
      delBtnHasSeatKey: document.querySelector('#timeslots-1-中庭-0 .btn-delete-seat')?.dataset.seatKey,
    }));
    assert('1.2 座位已展开 (expandedSeats 含 1-中庭-0)',
      expandedCheck.expandedSeats.includes('1-中庭-0'),
      `expandedSeats: ${JSON.stringify(expandedCheck.expandedSeats)}`);
    assert('1.3 timeslots 容器存在', expandedCheck.containerExists, '容器不存在');
    assert('1.4 seat-header 存在', expandedCheck.seatHeaderExists, 'seat-header 不存在');
    assert('1.5 删除按钮存在且有 data-seat-key',
      expandedCheck.delBtnExists && expandedCheck.delBtnHasSeatKey === '1-中庭-0',
      `delBtn: ${expandedCheck.delBtnExists}, seatKey: ${expandedCheck.delBtnHasSeatKey}`);

    // 打开筛选面板，只勾选 19:00（隐藏 20:00，20:00 有图）
    await page.evaluate(() => openFilterSheet());
    await sleep(400);

    // 先点"清除"全不选，再勾选 19:00
    await clickButton(page, 'filter-clear');
    await clickSlot(page, TIDX_19);

    const state1 = await getState(page);
    assert('1.6 筛选后 visibleTimeSlots = [18] (仅 19:00)',
      JSON.stringify(state1.visibleTimeSlots) === '[18]',
      `实际: ${JSON.stringify(state1.visibleTimeSlots)}`);

    // 关闭筛选面板，触发 refreshExpandedSeats
    await page.evaluate(() => closeFilterSheet());
    await sleep(500);

    // 检查是否有 "split" 相关错误
    const splitErrors = pageErrors.filter(e =>
      e.message.includes('split') || (e.stack && e.stack.includes('applyTimeslotFilter'))
    );
    assert('1.7 applyTimeslotFilter 不再抛 "split" 错误',
      splitErrors.length === 0,
      `错误: ${JSON.stringify(splitErrors)}`);

    console.log('\n=== 测试2：隐藏有时段图片时，提示文字正确显示 ===');

    // 检查 hidden-ts-hint
    const hintCheck = await page.evaluate(() => {
      const hint = document.querySelector('#timeslots-1-中庭-0 .hidden-ts-hint');
      return {
        exists: !!hint,
        text: hint ? hint.textContent : null,
      };
    });
    assert('2.1 hidden-ts-hint 元素存在', hintCheck.exists, '提示元素不存在');
    assert('2.2 提示文字包含 20:00',
      hintCheck.exists && hintCheck.text.includes('20:00'),
      `实际文字: ${hintCheck.text}`);
    assert('2.3 提示文字格式正确（"以下时段照片被隐藏：20:00"）',
      hintCheck.exists && hintCheck.text === '以下时段照片被隐藏：20:00',
      `实际文字: ${hintCheck.text}`);

    console.log('\n=== 测试3：恢复全选后，提示被移除 ===');

    // 恢复全选
    await page.evaluate(() => {
      state.visibleTimeSlots = new Set();
      state._filterNone = false;
      deriveFilterButtonState();
      saveFilterState();
      refreshExpandedSeats();
    });
    await sleep(500);

    const hintCheck2 = await page.evaluate(() => {
      const hint = document.querySelector('#timeslots-1-中庭-0 .hidden-ts-hint');
      return { exists: !!hint };
    });
    assert('3.1 全选后 hidden-ts-hint 被移除', !hintCheck2.exists, '提示元素仍存在');

    console.log('\n=== 测试4：隐藏无图时段时，不显示提示 ===');

    // 只勾选 19:00 和 20:00，隐藏其他无图时段 → 不应显示提示
    await page.evaluate(() => openFilterSheet());
    await sleep(400);
    await clickButton(page, 'filter-clear');
    await clickSlot(page, TIDX_19);  // 19:00
    await clickSlot(page, TIDX_20);  // 20:00
    await page.evaluate(() => closeFilterSheet());
    await sleep(500);

    const hintCheck3 = await page.evaluate(() => {
      const hint = document.querySelector('#timeslots-1-中庭-0 .hidden-ts-hint');
      return { exists: !!hint };
    });
    assert('4.1 隐藏的时段都无图时，不显示提示', !hintCheck3.exists, '不应显示提示');

    console.log('\n=== 测试5：回归 v1.29.3 "仅显示有图" 逻辑 ===');

    // 重置 + 重新注入数据（只有 19:00 有图）
    await page.evaluate(() => {
      imageCountCache.clear();
      imageCountCache.set('1-中庭-0-18', 1); // 19:00
      refreshSeatImageStatsFromCache();
      computeSlotsWithImages();
      state.visibleTimeSlots = new Set();
      state._filterNone = false;
      state._filterHidePassed = false;
      state._filterOnlyImages = false;
      state._savedFilterState = null;
      deriveFilterButtonState();
      saveFilterState();
    });
    await sleep(200);

    await page.evaluate(() => openFilterSheet());
    await sleep(400);
    await clickButton(page, 'filter-only-images');

    const state5 = await getState(page);
    const btn5 = await page.evaluate(() => document.getElementById('filter-only-images').classList.contains('primary'));
    assert('5.1 "仅显示有图"按钮亮起', btn5 === true, `按钮: ${btn5}`);
    assert('5.2 visibleTimeSlots = [18] (19:00)',
      JSON.stringify(state5.visibleTimeSlots) === '[18]',
      `实际: ${JSON.stringify(state5.visibleTimeSlots)}`);

    // 手动勾选 18:00
    await clickSlot(page, TIDX_18);
    const state5b = await getState(page);
    const btn5b = await page.evaluate(() => document.getElementById('filter-only-images').classList.contains('primary'));
    assert('5.3 手动勾选 18:00 后按钮熄灭', btn5b === false, `按钮: ${btn5b}`);
    assert('5.4 visibleTimeSlots = [16, 18] (18:00 + 19:00)',
      JSON.stringify(state5b.visibleTimeSlots) === '[16,18]',
      `实际: ${JSON.stringify(state5b.visibleTimeSlots)}`);

    // 验证整个测试过程中无 applyTimeslotFilter 错误
    const allSplitErrors = pageErrors.filter(e =>
      e.message.includes('split') || (e.stack && e.stack.includes('applyTimeslotFilter'))
    );
    assert('5.5 全程无 applyTimeslotFilter "split" 错误',
      allSplitErrors.length === 0,
      `错误: ${JSON.stringify(allSplitErrors)}`);

    console.log('\n=== 测试6：版本号验证 ===');

    const scriptsJs = fs.readFileSync(path.join(ROOT, 'scripts.js'), 'utf8');
    const scriptsMinJs = fs.readFileSync(path.join(ROOT, 'scripts.min.js'), 'utf8');
    const swJs = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

    assert('6.1 scripts.js APP_VERSION = v1.29.4', scriptsJs.includes("const APP_VERSION = 'v1.29.4'"), '版本号未更新');

    const minCount = (scriptsMinJs.match(/v1\.29\.4/g) || []).length;
    assert('6.2 scripts.min.js v1.29.4 出现 4 次', minCount === 4, `实际 ${minCount} 次`);

    const oldMin = (scriptsMinJs.match(/v1\.29\.[0123]/g) || []).length + (scriptsMinJs.match(/v1\.28\.\d+/g) || []).length;
    assert('6.3 scripts.min.js 无旧版本残留', oldMin === 0, `残留 ${oldMin} 处`);

    assert('6.4 sw.js CACHE_NAME = seat-cache-v176', swJs.includes("const CACHE_NAME = 'seat-cache-v176'"), 'CACHE_NAME 未更新');

    console.log('\n=== 测试7：min.js 一致性检查 ===');

    // 7.1 min.js 中 applyTimeslotFilter 不再读 .seat-name-text 的 dataset.seatKey
    // 注意：seat-name-text 和 dataset.seatKey 各有其他合法用途（显示座位名/删除按钮）
    // 此处通过运行时测试（测试1.7 + 5.5）验证 applyTimeslotFilter 不报错即可
    // min.js 静态检查改为：btn-delete-seat 出现次数 >= 2（渲染1处 + applyTimeslotFilter 读取1处）
    const btnDeleteCount = (scriptsMinJs.match(/btn-delete-seat/g) || []).length;
    assert('7.1 min.js 中 btn-delete-seat 出现 >= 2 次（渲染+读取）',
      btnDeleteCount >= 2,
      `实际 ${btnDeleteCount} 次`);

    assert('7.2 min.js 包含 .btn-delete-seat 选择器',
      scriptsMinJs.includes('btn-delete-seat'),
      'min.js 缺少 btn-delete-seat');

    assert('7.3 min.js 包含 data-seat-key 读取',
      scriptsMinJs.includes('dataset.seatKey'),
      'min.js 缺少 dataset.seatKey');

    assert('7.4 min.js 包含 _slotsWithImages 赋值（v1.29.3 修复保留）',
      scriptsMinJs.includes('state.visibleTimeSlots=new Set(state._slotsWithImages)'),
      'min.js 缺少 v1.29.3 修复');

    // 打印所有收集到的错误（调试用）
    if (pageErrors.length > 0) {
      console.log('\n=== 收集到的页面错误（参考）===');
      pageErrors.forEach((e, i) => {
        console.log(`  ${i + 1}. [${e.type}] ${e.message.substring(0, 200)}`);
      });
    }

  } finally {
    await browser.close();
    server.close();
  }
}

runTests().then(() => {
  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
}).catch(err => {
  console.error('\n测试执行异常:', err);
  process.exit(1);
});
