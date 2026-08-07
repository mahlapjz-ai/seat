/**
 * v1.29.3 自测脚本 - "仅显示有图"按钮时段筛选逻辑
 * 使用 puppeteer-core + Edge headless 打开网页进行真实交互测试
 *
 * 验证规则：
 * 1. "仅显示有图"亮起 → 只勾选有图时段
 * 2. 手动勾选其他时段 → 该时段被勾选，有图时段保持，按钮熄灭
 * 3. 不应出现其他时段被自动勾选
 * 4. "清除"后"仅显示有图"亮起 → 勾选有图时段
 * 5. 再手动勾选 → 该时段+有图时段，无全选
 * 6. 所有手动操作后不应有自动恢复或全选行为
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = __dirname;
const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 时间段索引映射
// 09:00=0, 18:00=16, 19:00=18
const TIDX_09 = 0;
const TIDX_18 = 16;
const TIDX_19 = 18;

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' -> ' + detail : ''}`); }
}

// 启动本地 HTTP 服务器
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

// 获取 checkbox 状态（通过 isTimeSlotVisible 判断实际显示状态）
async function getCheckboxStates(page) {
  return await page.evaluate(() => {
    const items = document.querySelectorAll('.filter-slot-item');
    const states = {};
    items.forEach(item => {
      const tidx = parseInt(item.dataset.tidx);
      const cb = item.querySelector('.filter-slot-cb');
      states[tidx] = cb.classList.contains('checked');
    });
    return states;
  });
}

// 获取按钮亮起状态
async function getButtonState(page, btnId) {
  return await page.evaluate((id) => {
    const btn = document.getElementById(id);
    return btn ? btn.classList.contains('primary') : false;
  }, btnId);
}

// 获取 visibleTimeSlots 和 filter 状态
async function getState(page) {
  return await page.evaluate(() => {
    return {
      visibleTimeSlots: [...state.visibleTimeSlots].sort((a, b) => a - b),
      filterNone: state._filterNone,
      filterOnlyImages: state._filterOnlyImages,
      filterHidePassed: state._filterHidePassed,
      savedFilterState: state._savedFilterState,
      slotsWithImages: [...state._slotsWithImages].sort((a, b) => a - b),
    };
  });
}

async function clickSlot(page, tidx) {
  await page.evaluate((idx) => {
    const item = document.querySelector(`.filter-slot-item[data-tidx="${idx}"]`);
    if (item) item.click();
  }, tidx);
  await sleep(100);
}

async function clickButton(page, btnId) {
  await page.evaluate((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.click();
  }, btnId);
  await sleep(150);
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

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 480, height: 800 });

    // 收集 console 日志
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('筛选持久化') || text.includes('异常')) {
        // 静默，不输出
      }
    });

    console.log('加载页面...');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000); // 等待应用初始化完成

    // 注入 mock 图片数据：只有 19:00 有图（floor 1, 中庭, seat 0, tidx 18）
    await page.evaluate(() => {
      imageCountCache.clear();
      imageCountCache.set('1-中庭-0-18', 1); // 19:00 有一张图
      // 触发统计刷新
      refreshSeatImageStatsFromCache();
      computeSlotsWithImages();
    });
    await sleep(200);

    // 验证 mock 数据生效
    const mockCheck = await page.evaluate(() => ({
      slotsWithImages: [...state._slotsWithImages],
      cacheSize: imageCountCache.size,
    }));
    assert('mock 数据注入：_slotsWithImages = [18]', 
      JSON.stringify(mockCheck.slotsWithImages) === '[18]',
      `实际: ${JSON.stringify(mockCheck.slotsWithImages)}, cache: ${mockCheck.cacheSize}`);

    console.log('\n=== 测试1：默认状态下打开"仅显示有图" ===');

    // 先重置为默认状态（全选）
    await page.evaluate(() => {
      state.visibleTimeSlots = new Set();
      state._filterNone = false;
      state._filterHidePassed = false;
      state._filterOnlyImages = false;
      state._savedFilterState = null;
      deriveFilterButtonState();
      saveFilterState();
    });

    // 打开筛选面板
    await page.evaluate(() => openFilterSheet());
    await sleep(400);

    // 点击"仅显示有图"
    await clickButton(page, 'filter-only-images');

    const state1 = await getState(page);
    const cb1 = await getCheckboxStates(page);
    const btn1 = await getButtonState(page, 'filter-only-images');

    assert('1.1 "仅显示有图"按钮亮起', btn1 === true, `按钮状态: ${btn1}`);
    assert('1.2 visibleTimeSlots = [18] (19:00)', 
      JSON.stringify(state1.visibleTimeSlots) === '[18]',
      `实际: ${JSON.stringify(state1.visibleTimeSlots)}`);
    assert('1.3 19:00 checkbox 选中', cb1[TIDX_19] === true, `19:00: ${cb1[TIDX_19]}`);
    assert('1.4 18:00 checkbox 未选中', cb1[TIDX_18] === false, `18:00: ${cb1[TIDX_18]}`);
    assert('1.5 09:00 checkbox 未选中', cb1[TIDX_09] === false, `09:00: ${cb1[TIDX_09]}`);
    assert('1.6 _savedFilterState 已保存', state1.savedFilterState !== null, `savedFilterState: ${JSON.stringify(state1.savedFilterState)}`);

    console.log('\n=== 测试2：手动勾选 18:00（无图时段） ===');

    await clickSlot(page, TIDX_18);

    const state2 = await getState(page);
    const cb2 = await getCheckboxStates(page);
    const btn2 = await getButtonState(page, 'filter-only-images');

    assert('2.1 "仅显示有图"按钮熄灭', btn2 === false, `按钮状态: ${btn2}`);
    assert('2.2 visibleTimeSlots = [16, 18] (18:00 + 19:00)', 
      JSON.stringify(state2.visibleTimeSlots) === '[16,18]',
      `实际: ${JSON.stringify(state2.visibleTimeSlots)}`);
    assert('2.3 18:00 checkbox 选中', cb2[TIDX_18] === true, `18:00: ${cb2[TIDX_18]}`);
    assert('2.4 19:00 checkbox 保持选中', cb2[TIDX_19] === true, `19:00: ${cb2[TIDX_19]}`);
    assert('2.5 09:00 未被自动勾选', cb2[TIDX_09] === false, `09:00: ${cb2[TIDX_09]}`);
    assert('2.6 _savedFilterState 已清空（不恢复）', state2.savedFilterState === null, `savedFilterState: ${JSON.stringify(state2.savedFilterState)}`);

    // 统计未被勾选的时段数量（除18和19外不应有其他时段被勾选）
    const checkedCount = Object.values(cb2).filter(v => v === true).length;
    assert('2.7 仅 2 个时段被勾选（18:00 + 19:00）', checkedCount === 2, `实际勾选: ${checkedCount} 个`);

    console.log('\n=== 测试3：手动取消 19:00（有图时段） ===');

    await clickSlot(page, TIDX_19);

    const state3 = await getState(page);
    const cb3 = await getCheckboxStates(page);

    assert('3.1 visibleTimeSlots = [16] (仅 18:00)', 
      JSON.stringify(state3.visibleTimeSlots) === '[16]',
      `实际: ${JSON.stringify(state3.visibleTimeSlots)}`);
    assert('3.2 19:00 checkbox 未选中', cb3[TIDX_19] === false, `19:00: ${cb3[TIDX_19]}`);
    assert('3.3 18:00 checkbox 保持选中', cb3[TIDX_18] === true, `18:00: ${cb3[TIDX_18]}`);

    console.log('\n=== 测试4："清除"后点"仅显示有图" ===');

    // 点击清除
    await clickButton(page, 'filter-clear');

    const state4a = await getState(page);
    const cb4a = await getCheckboxStates(page);
    const btn4a = await getButtonState(page, 'filter-only-images');

    assert('4.1 清除后 visibleTimeSlots 为空', state4a.visibleTimeSlots.length === 0, `实际: ${JSON.stringify(state4a.visibleTimeSlots)}`);
    assert('4.2 清除后 _filterNone = true', state4a.filterNone === true, `filterNone: ${state4a.filterNone}`);
    assert('4.3 清除后"仅显示有图"熄灭', btn4a === false, `按钮: ${btn4a}`);
    assert('4.4 清除后所有 checkbox 未选中', Object.values(cb4a).every(v => v === false), `有选中的: ${Object.entries(cb4a).filter(([,v]) => v).map(([k]) => k).join(',')}`);

    // 点击"仅显示有图"
    await clickButton(page, 'filter-only-images');

    const state4b = await getState(page);
    const cb4b = await getCheckboxStates(page);
    const btn4b = await getButtonState(page, 'filter-only-images');

    assert('4.5 "仅显示有图"按钮亮起', btn4b === true, `按钮: ${btn4b}`);
    assert('4.6 visibleTimeSlots = [18] (仅 19:00)', 
      JSON.stringify(state4b.visibleTimeSlots) === '[18]',
      `实际: ${JSON.stringify(state4b.visibleTimeSlots)}`);
    assert('4.7 19:00 checkbox 选中', cb4b[TIDX_19] === true, `19:00: ${cb4b[TIDX_19]}`);
    assert('4.8 18:00 checkbox 未选中', cb4b[TIDX_18] === false, `18:00: ${cb4b[TIDX_18]}`);
    assert('4.9 _savedFilterState 已保存（保存的是清除后的空状态）', 
      state4b.savedFilterState !== null && state4b.savedFilterState.slots.length === 0 && state4b.savedFilterState.none === true,
      `实际: ${JSON.stringify(state4b.savedFilterState)}`);

    console.log('\n=== 测试5：清除后"仅显示有图"亮起，手动勾选 18:00 ===');

    await clickSlot(page, TIDX_18);

    const state5 = await getState(page);
    const cb5 = await getCheckboxStates(page);
    const btn5 = await getButtonState(page, 'filter-only-images');

    assert('5.1 "仅显示有图"按钮熄灭', btn5 === false, `按钮: ${btn5}`);
    assert('5.2 visibleTimeSlots = [16, 18] (18:00 + 19:00)', 
      JSON.stringify(state5.visibleTimeSlots) === '[16,18]',
      `实际: ${JSON.stringify(state5.visibleTimeSlots)}`);
    assert('5.3 18:00 checkbox 选中', cb5[TIDX_18] === true, `18:00: ${cb5[TIDX_18]}`);
    assert('5.4 19:00 checkbox 保持选中', cb5[TIDX_19] === true, `19:00: ${cb5[TIDX_19]}`);
    assert('5.5 09:00 未被自动勾选', cb5[TIDX_09] === false, `09:00: ${cb5[TIDX_09]}`);

    const checkedCount5 = Object.values(cb5).filter(v => v === true).length;
    assert('5.6 仅 2 个时段被勾选（无全选现象）', checkedCount5 === 2, `实际勾选: ${checkedCount5} 个`);

    console.log('\n=== 测试6："仅显示有图"亮起→熄灭（恢复 _savedFilterState） ===');

    // 先设置一个已知状态：选中 09:00 和 20:00
    await page.evaluate(() => {
      state.visibleTimeSlots = new Set([0, 20]); // 09:00 和 20:30
      state._filterNone = false;
      state._filterHidePassed = false;
      state._filterOnlyImages = false;
      state._savedFilterState = null;
      deriveFilterButtonState();
      saveFilterState();
      renderFilterBody();
    });
    await sleep(100);

    // 点击"仅显示有图"亮起
    await clickButton(page, 'filter-only-images');

    const state6a = await getState(page);
    assert('6.1 亮起后 visibleTimeSlots = [18] (有图时段)', 
      JSON.stringify(state6a.visibleTimeSlots) === '[18]',
      `实际: ${JSON.stringify(state6a.visibleTimeSlots)}`);
    assert('6.2 _savedFilterState 保存了 [0, 20]', 
      state6a.savedFilterState && JSON.stringify(state6a.savedFilterState.slots) === '[0,20]',
      `实际: ${JSON.stringify(state6a.savedFilterState)}`);

    // 点击"仅显示有图"熄灭
    await clickButton(page, 'filter-only-images');

    const state6b = await getState(page);
    assert('6.3 熄灭后 visibleTimeSlots 恢复为 [0, 20]', 
      JSON.stringify(state6b.visibleTimeSlots) === '[0,20]',
      `实际: ${JSON.stringify(state6b.visibleTimeSlots)}`);
    assert('6.4 熄灭后 _savedFilterState 清空', state6b.savedFilterState === null, `实际: ${JSON.stringify(state6b.savedFilterState)}`);

    console.log('\n=== 测试7：版本号验证 ===');

    const scriptsJs = fs.readFileSync(path.join(ROOT, 'scripts.js'), 'utf8');
    const scriptsMinJs = fs.readFileSync(path.join(ROOT, 'scripts.min.js'), 'utf8');
    const swJs = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

    assert('7.1 scripts.js APP_VERSION = v1.29.3', scriptsJs.includes("const APP_VERSION = 'v1.29.3'"), '版本号未更新');

    const minCount = (scriptsMinJs.match(/v1\.29\.3/g) || []).length;
    assert('7.2 scripts.min.js v1.29.3 出现 4 次', minCount === 4, `实际 ${minCount} 次`);

    const oldMin = (scriptsMinJs.match(/v1\.29\.[012]/g) || []).length + (scriptsMinJs.match(/v1\.28\.\d+/g) || []).length;
    assert('7.3 scripts.min.js 无旧版本残留', oldMin === 0, `残留 ${oldMin} 处`);

    assert('7.4 sw.js CACHE_NAME = seat-cache-v175', swJs.includes("const CACHE_NAME = 'seat-cache-v175'"), 'CACHE_NAME 未更新');

    console.log('\n=== 测试8：min.js 一致性检查 ===');

    assert('8.1 min.js 包含 visibleTimeSlots=new Set(state._slotsWithImages)',
      scriptsMinJs.includes('new Set(state._slotsWithImages)'),
      'min.js 缺少 visibleTimeSlots=new Set(state._slotsWithImages)');

    assert('8.2 min.js 包含 _savedFilterState 恢复逻辑',
      scriptsMinJs.includes('_savedFilterState'),
      'min.js 缺少 _savedFilterState');

    assert('8.3 min.js 包含 _filterOnlyImages',
      scriptsMinJs.includes('_filterOnlyImages'),
      'min.js 缺少 _filterOnlyImages');

    // 验证 min.js 中"仅显示有图"亮起时直接设置 visibleTimeSlots
    // terser 可能混淆变量名，但 state._slotsWithImages 是属性访问不会被混淆
    assert('8.4 min.js 中"仅显示有图"亮起逻辑包含 _slotsWithImages 赋值',
      scriptsMinJs.includes('state.visibleTimeSlots=new Set(state._slotsWithImages)'),
      'min.js 缺少 visibleTimeSlots=_slotsWithImages 赋值');

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
