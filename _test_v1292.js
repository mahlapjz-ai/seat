/**
 * v1.29.2 自测脚本
 * 问题1：多图模式楼层时段文字隐藏滚动条
 * 问题2：回收站面板隐藏滚动条
 * 问题3：仅显示有图亮起时手动勾选异常
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

console.log('\n=== 问题1：多图模式楼层时段文字隐藏滚动条 ===');

// 1.1 multi-floor-slots 设置 scrollbar-width:none
assert(
  '.multi-floor-slots 设置 scrollbar-width:none',
  stylesCss.includes('.multi-floor-slots{') && stylesCss.includes('scrollbar-width:none'),
  '未设置 scrollbar-width:none'
);

// 1.2 multi-floor-slots ::-webkit-scrollbar display:none
assert(
  '.multi-floor-slots ::-webkit-scrollbar display:none',
  stylesCss.includes('.multi-floor-slots::-webkit-scrollbar{display:none}'),
  '未设置 webkit-scrollbar'
);

// 1.3 保留 overflow-x:auto
assert(
  '.multi-floor-slots 保留 overflow-x:auto',
  /\.multi-floor-slots\{[^}]*overflow-x:auto/.test(stylesCss),
  'overflow-x:auto 丢失'
);

// 1.4 保留 white-space:nowrap
assert(
  '.multi-floor-slots 保留 white-space:nowrap',
  /\.multi-floor-slots\{[^}]*white-space:nowrap/.test(stylesCss),
  'white-space:nowrap 丢失'
);

console.log('\n=== 问题2：回收站面板隐藏滚动条 ===');

// 2.1 trash-browser-list 设置 scrollbar-width:none
assert(
  '.trash-browser-list 设置 scrollbar-width:none',
  /\.trash-browser-list\{[^}]*scrollbar-width:none/.test(stylesCss),
  '未设置 scrollbar-width:none'
);

// 2.2 trash-browser-list ::-webkit-scrollbar display:none
assert(
  '.trash-browser-list ::-webkit-scrollbar display:none',
  stylesCss.includes('.trash-browser-list::-webkit-scrollbar{display:none}'),
  '未设置 webkit-scrollbar'
);

// 2.3 保留 overflow-y:auto
assert(
  '.trash-browser-list 保留 overflow-y:auto',
  /\.trash-browser-list\{[^}]*overflow-y:auto/.test(stylesCss),
  'overflow-y:auto 丢失'
);

console.log('\n=== 问题3：仅显示有图亮起时手动勾选异常 ===');

// 3.1 filterBody click 使用 isTimeSlotVisible 固化
// 提取 filterBody click 到下一个 addEventListener 之间的代码
const fbClickStart = scriptsJs.indexOf("filterBody.addEventListener('click'");
const fbClickEnd = scriptsJs.indexOf('refreshExpandedSeats();', fbClickStart);
const filterClickBlock = fbClickStart > -1 ? scriptsJs.substring(fbClickStart, fbClickEnd + 25) : '';
assert(
  'filterBody click 使用 isTimeSlotVisible 固化当前筛选结果',
  filterClickBlock.includes('if (isTimeSlotVisible(i)) state.visibleTimeSlots.add(i)'),
  '未使用 isTimeSlotVisible 固化'
);

// 3.2 filterBody click 不再从 _savedFilterState 恢复
assert(
  'filterBody click 不从 _savedFilterState 恢复',
  !filterClickBlock.includes('state._savedFilterState.slots'),
  '仍从 _savedFilterState 恢复'
);

// 3.3 filterBody click 清空 _savedFilterState
assert(
  'filterBody click 清空 _savedFilterState',
  filterClickBlock.includes('state._savedFilterState = null;'),
  '未清空 _savedFilterState'
);

// 3.4 关闭叠加筛选标记
assert(
  'filterBody click 关闭 _filterHidePassed 和 _filterOnlyImages',
  filterClickBlock.includes('state._filterHidePassed = false;') && filterClickBlock.includes('state._filterOnlyImages = false;'),
  '未关闭叠加筛选'
);

console.log('\n=== 按钮自身熄灭仍用 _savedFilterState 恢复(v1.29.1保留) ===');

// 4.1 "隐藏已过时段"按钮熄灭仍从 _savedFilterState 恢复
const savedStatePattern = '_savedFilterState = { slots: [...state.visibleTimeSlots], none: state._filterNone }';
const restorePattern = 'if (state._savedFilterState && Array.isArray(state._savedFilterState.slots))';
const saveCount = (scriptsJs.match(new RegExp(savedStatePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
const restoreCount = (scriptsJs.match(new RegExp(restorePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
assert(
  `两个按钮亮起时保存 _savedFilterState (共${saveCount}处)`,
  saveCount === 2,
  `实际 ${saveCount} 处`
);
assert(
  `两个按钮熄灭时从 _savedFilterState 恢复 (共${restoreCount}处)`,
  restoreCount === 2,
  `实际 ${restoreCount} 处`
);

console.log('\n=== 版本号验证 ===');

assert(
  'scripts.js APP_VERSION = v1.29.2',
  scriptsJs.includes("const APP_VERSION = 'v1.29.2'"),
  '版本号未更新'
);
const minCount = (scriptsMinJs.match(/v1\.29\.2/g) || []).length;
assert(
  'scripts.min.js v1.29.2 出现 4 次',
  minCount === 4,
  `实际 ${minCount} 次`
);
const oldMin = (scriptsMinJs.match(/v1\.29\.[01]/g) || []).length + (scriptsMinJs.match(/v1\.28\.\d+/g) || []).length;
assert(
  'scripts.min.js 无旧版本残留',
  oldMin === 0,
  `残留 ${oldMin} 处`
);
assert(
  'sw.js CACHE_NAME = seat-cache-v174',
  swJs.includes("const CACHE_NAME = 'seat-cache-v174'"),
  'CACHE_NAME 未更新'
);

console.log('\n=== 回归检查 ===');

// 多图模式相关
assert('多图模式 isFilterActive 保留', scriptsJs.includes('const isFilterActive ='), '丢失');
assert('多图模式 filterHitIconSvg 保留', scriptsJs.includes('filterHitIconSvg'), '丢失');
assert('多图模式 floorSlotSet 保留', scriptsJs.includes('floorSlotSet'), '丢失');
assert('多图模式 icon-filter-hit 保留', scriptsJs.includes('icon-filter-hit'), '丢失');
assert('多图模式 icon-hidden 保留', scriptsJs.includes('icon-hidden'), '丢失');

// 默认模式相关
assert('默认模式 applyTimeslotFilter 保留', scriptsJs.includes('applyTimeslotFilter(container)'), '丢失');
assert('默认模式 refreshExpandedSeats 保留', scriptsJs.includes('refreshExpandedSeats()'), '丢失');
assert('refreshExpandedSeats 多图模式分支保留', scriptsJs.includes('if (_multiMode) {'), '丢失');

console.log('\n=== min.js 一致性 ===');

assert('min.js 包含 isTimeSlotVisible 固化', scriptsMinJs.includes('isTimeSlotVisible'), '丢失');
assert('min.js 包含 _savedFilterState', scriptsMinJs.includes('_savedFilterState'), '丢失');
assert('min.js 包含 icon-filter-hit', scriptsMinJs.includes('icon-filter-hit'), '丢失');
assert('min.js 包含 floorSlotSet', scriptsMinJs.includes('.add(t)'), '丢失');

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
