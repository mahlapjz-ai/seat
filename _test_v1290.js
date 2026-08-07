/**
 * v1.29.0 自测脚本
 * 问题1：第二种显示模式筛选后座位列表未刷新
 * 问题2：第二种显示模式新增楼层时段文字
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const scriptsJs = fs.readFileSync(path.join(ROOT, 'scripts.js'), 'utf8');
const scriptsMinJs = fs.readFileSync(path.join(ROOT, 'scripts.min.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const swJs = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' -> ' + detail : ''}`); }
}

console.log('\n=== 问题1：第二种显示模式筛选后座位列表未刷新 ===');

// 1.1 refreshExpandedSeats 多图模式提前分支
assert(
  'refreshExpandedSeats 存在多图模式提前分支(if (_multiMode))',
  scriptsJs.includes('if (_multiMode) {'),
  '未找到多图模式提前分支'
);

// 1.2 多图模式分支在遍历.seat-btn之前
const multiBranchIdx = scriptsJs.indexOf('if (_multiMode) {');
const seatBtnIdx = scriptsJs.indexOf("querySelectorAll('.seat-btn')");
assert(
  '多图模式分支在 querySelectorAll(.seat-btn) 之前',
  multiBranchIdx > -1 && seatBtnIdx > -1 && multiBranchIdx < seatBtnIdx,
  `multiBranchIdx=${multiBranchIdx}, seatBtnIdx=${seatBtnIdx}`
);

// 1.3 多图模式分支包含 renderMultiMode（在多图分支之后、querySelectorAll之前）
assert(
  '多图模式分支调用 renderMultiMode',
  scriptsJs.includes('await renderMultiMode();'),
  '未调用 renderMultiMode'
);

// 1.4 多图模式分支包含 return（跳过后续默认模式逻辑）
// 检查 if (_multiMode) { 到 querySelectorAll 之间有 return
const multiBlockEnd = scriptsJs.indexOf('querySelectorAll', multiBranchIdx);
const multiBlock = scriptsJs.substring(multiBranchIdx, multiBlockEnd > -1 ? multiBlockEnd : multiBranchIdx + 200);
assert(
  '多图模式分支内有 return 语句',
  multiBlock.includes('return;'),
  '无 return 语句'
);

// 1.5 原末尾的重复多图模式重渲已移除
const oldTailPattern = /\/\/ 【v1\.21\.2】多图模式下，筛选变化后重新渲染/;
assert(
  '原末尾重复的多图模式重渲代码已移除',
  !oldTailPattern.test(scriptsJs),
  '旧代码仍存在'
);

// 1.6 toggleMultiMode 切换前刷新 stats
assert(
  'toggleMultiMode 切换到多图模式前调用 refreshSeatImageStats',
  scriptsJs.includes('await refreshSeatImageStats();') && scriptsJs.includes('await renderMultiMode();'),
  '未在 renderMultiMode 前调用 refreshSeatImageStats'
);

console.log('\n=== 问题2：第二种显示模式新增楼层时段文字 ===');

// 2.1 renderMultiMode 中收集 floorSlotSet
assert(
  'renderMultiMode 中新增 floorSlotSet 收集逻辑',
  scriptsJs.includes('floorSlotSet') && scriptsJs.includes('floorSlotSet.add(t)'),
  '未找到 floorSlotSet 收集逻辑'
);

// 2.2 时段去重+排序
assert(
  '时段去重(Set)+排序(sort)',
  scriptsJs.includes('[...floorSlotSet].sort'),
  '未找到去重排序逻辑'
);

// 2.3 生成 multi-floor-slots 元素
assert(
  '生成 .multi-floor-slots 元素',
  scriptsJs.includes('class="multi-floor-slots"'),
  '未生成 multi-floor-slots 元素'
);

// 2.4 使用 multi-floor-header 包裹
assert(
  '使用 .multi-floor-header 包裹楼层名和时段文字',
  scriptsJs.includes('class="multi-floor-header"'),
  '未使用 multi-floor-header'
);

// 2.5 无座位时不显示时段文字
assert(
  '无座位时不输出 multi-floor-slots',
  scriptsJs.includes('floorSlotSet.size > 0') && scriptsJs.includes(": ''"),
  '未处理空楼层'
);

// 2.6 时段文字用顿号分隔
assert(
  '时段文字用顿号(、)分隔',
  scriptsJs.includes(".join('、')"),
  '未使用顿号分隔'
);

console.log('\n=== CSS 样式验证 ===');

// 3.1 multi-floor-header flex 布局
assert(
  '.multi-floor-header 为 flex 布局',
  stylesCss.includes('.multi-floor-header{display:flex;align-items:center'),
  '未设置 flex 布局'
);

// 3.2 multi-floor-slots overflow-x:auto
assert(
  '.multi-floor-slots 设置 overflow-x:auto',
  stylesCss.includes('.multi-floor-slots{') && stylesCss.includes('overflow-x:auto'),
  '未设置 overflow-x:auto'
);

// 3.3 multi-floor-slots white-space:nowrap
assert(
  '.multi-floor-slots 设置 white-space:nowrap',
  stylesCss.includes('white-space:nowrap'),
  '未设置 white-space:nowrap'
);

// 3.4 multi-floor-name flex-shrink:0（固定不动）
assert(
  '.multi-floor-name 设置 flex-shrink:0',
  stylesCss.includes('.multi-floor-name{') && stylesCss.includes('flex-shrink:0'),
  '未设置 flex-shrink:0'
);

// 3.5 multi-floor-name 移除了 margin-bottom（移到 header）
assert(
  '.multi-floor-name 不再有 margin-bottom',
  !/\.multi-floor-name\{[^}]*margin-bottom/.test(stylesCss),
  '仍保留 margin-bottom'
);

// 3.6 multi-floor-header 有 margin-bottom
assert(
  '.multi-floor-header 有 margin-bottom',
  /\.multi-floor-header\{[^}]*margin-bottom/.test(stylesCss),
  '无 margin-bottom'
);

// 3.7 默认主题(彩色楼层)时段文字颜色
assert(
  '默认主题(彩色楼层)时段文字为半透明白色',
  stylesCss.includes('.multi-floor-block.floor-1 .multi-floor-slots') && stylesCss.includes('rgba(255,255,255,.75)'),
  '未设置默认主题颜色'
);

// 3.8 护眼主题适配
assert(
  '护眼主题(.theme-normal)时段文字颜色适配',
  stylesCss.includes('.theme-normal .multi-floor-block .multi-floor-slots'),
  '未适配护眼主题'
);

// 3.9 蓝色主题适配
assert(
  '蓝色主题(.theme-yiban)时段文字颜色适配',
  stylesCss.includes('.theme-yiban .multi-floor-block .multi-floor-slots'),
  '未适配蓝色主题'
);

// 3.10 怀旧主题适配
assert(
  '怀旧主题(.theme-pixel)时段文字颜色适配',
  stylesCss.includes('.theme-pixel .multi-floor-block .multi-floor-slots'),
  '未适配怀旧主题'
);

console.log('\n=== 版本号验证 ===');

// 4.1 scripts.js APP_VERSION
assert(
  'scripts.js APP_VERSION = v1.29.0',
  scriptsJs.includes("const APP_VERSION = 'v1.29.0'"),
  '版本号未更新'
);

// 4.2 min.js 版本号(4处)
const minCount = (scriptsMinJs.match(/v1\.29\.0/g) || []).length;
assert(
  'scripts.min.js v1.29.0 出现 4 次(1声明+3内联)',
  minCount === 4,
  `实际 ${minCount} 次`
);

// 4.3 min.js 无残留旧版本
const oldMin = (scriptsMinJs.match(/v1\.28\.\d+/g) || []).length;
assert(
  'scripts.min.js 无 v1.28.x 残留',
  oldMin === 0,
  `残留 ${oldMin} 处`
);

// 4.4 sw.js CACHE_NAME
assert(
  'sw.js CACHE_NAME = seat-cache-v172',
  swJs.includes("const CACHE_NAME = 'seat-cache-v172'"),
  'CACHE_NAME 未更新'
);

console.log('\n=== 回归检查(不影响默认模式) ===');

// 5.1 默认模式的筛选回调仍调用 refreshExpandedSeats
const filterCallbacks = scriptsJs.match(/refreshExpandedSeats\(\)/g) || [];
assert(
  `筛选回调仍调用 refreshExpandedSeats (共${filterCallbacks.length}处)`,
  filterCallbacks.length >= 5,
  `仅 ${filterCallbacks.length} 处`
);

// 5.2 默认模式的 applyTimeslotFilter 逻辑保留
assert(
  '默认模式 applyTimeslotFilter 逻辑保留',
  scriptsJs.includes('applyTimeslotFilter(container)'),
  'applyTimeslotFilter 被移除'
);

// 5.3 默认模式的 updateAreaVisual 逻辑保留
assert(
  '默认模式 updateAreaVisual 逻辑保留',
  scriptsJs.includes('updateAreaVisual(parseInt(p[0]), p[1])'),
  'updateAreaVisual 被移除'
);

// 5.4 默认模式的 refreshSingleSeatStats 逻辑保留
assert(
  '默认模式 refreshSingleSeatStats 逻辑保留',
  scriptsJs.includes('refreshSingleSeatStats(sk)'),
  'refreshSingleSeatStats 被移除'
);

// 5.5 toggleMultiMode 恢复默认模式逻辑不变
assert(
  'toggleMultiMode 恢复默认模式时调用 renderMain',
  scriptsJs.includes('renderMain();'),
  'renderMain 调用丢失'
);

// 5.6 多图模式原有筛选逻辑(multiSlots)不变
assert(
  'renderMultiMode 仍使用 imageCountCache 判断 multiSlots',
  scriptsJs.includes('imageCountCache.get(ck)') && scriptsJs.includes('>= 2'),
  '筛选逻辑被修改'
);

// 5.7 多图模式座位按钮 data-multi-slots 属性保留
assert(
  '座位按钮仍输出 data-multi-slots 属性',
  scriptsJs.includes('data-multi-slots='),
  'data-multi-slots 属性丢失'
);

console.log('\n=== min.js 一致性检查 ===');

// 6.1 min.js 包含多图模式提前分支
assert(
  'min.js 包含多图模式提前分支(if(_multiMode){)',
  scriptsMinJs.includes('if(_multiMode){'),
  'min.js 缺少多图模式分支'
);

// 6.2 min.js 包含 floorSlotSet（压缩后可能被混淆，检查 add 逻辑）
assert(
  'min.js 包含时段收集逻辑(.add(t))',
  scriptsMinJs.includes('.add(t)'),
  'min.js 缺少时段收集逻辑'
);

// 6.3 min.js 包含 multi-floor-header
assert(
  'min.js 包含 multi-floor-header',
  scriptsMinJs.includes('multi-floor-header'),
  'min.js 缺少 multi-floor-header'
);

// 6.4 min.js 包含 multi-floor-slots
assert(
  'min.js 包含 multi-floor-slots',
  scriptsMinJs.includes('multi-floor-slots'),
  'min.js 缺少 multi-floor-slots'
);

// 6.5 min.js 包含 refreshSeatImageStats+renderMultiMode 调用
assert(
  'min.js toggleMultiMode 中 refreshSeatImageStats+renderMultiMode',
  /refreshSeatImageStats\(\)/.test(scriptsMinJs) && /renderMultiMode\(\)/.test(scriptsMinJs),
  'min.js 缺少切换前刷新逻辑'
);

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
