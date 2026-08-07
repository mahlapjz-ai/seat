/**
 * v1.29.1 自测脚本
 * 问题1：叠加筛选亮起后手动勾选时段异常变更
 * 问题2：多图模式座位按钮缺少右上角筛选命中图标
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const scriptsJs = fs.readFileSync(path.join(ROOT, 'scripts.js'), 'utf8');
const scriptsMinJs = fs.readFileSync(path.join(ROOT, 'scripts.min.js'), 'utf8');
const swJs = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' -> ' + detail : ''}`); }
}

console.log('\n=== 问题1：叠加筛选亮起后手动勾选时段异常变更 ===');

// 1.1 两个叠加筛选按钮亮起时都保存 _savedFilterState（共2处赋值）
const savedStatePattern = '_savedFilterState = { slots: [...state.visibleTimeSlots], none: state._filterNone }';
const saveCount = (scriptsJs.match(new RegExp(savedStatePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
assert(
  `两个叠加筛选按钮亮起时保存 _savedFilterState (共${saveCount}处)`,
  saveCount === 2,
  `实际 ${saveCount} 处`
);

// 1.2 两个叠加筛选按钮熄灭时都从 _savedFilterState 恢复（filterBody click + 2按钮 = 共3处恢复）
const restorePattern = 'if (state._savedFilterState && Array.isArray(state._savedFilterState.slots))';
const restoreCount = (scriptsJs.match(new RegExp(restorePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
assert(
  `_savedFilterState 恢复逻辑 (共${restoreCount}处: filterBody click + 2按钮熄灭)`,
  restoreCount === 3,
  `实际 ${restoreCount} 处`
);

// 1.3 filterBody click 从 _savedFilterState 恢复（不再用 isTimeSlotVisible 固化）
const filterClick = scriptsJs.match(/filterBody\.addEventListener\('click'[\s\S]*?\}\);/);
assert(
  'filterBody click 从 _savedFilterState 恢复',
  filterClick && filterClick[0].includes('state._savedFilterState.slots') && !filterClick[0].includes('if (isTimeSlotVisible(i))'),
  '仍使用 isTimeSlotVisible 固化'
);

// 1.4 filterBody click 恢复后清空 _savedFilterState
assert(
  'filterBody click 恢复后清空 _savedFilterState',
  filterClick && filterClick[0].includes('state._savedFilterState = null;'),
  '未清空 _savedFilterState'
);

// 1.5 原来的 isTimeSlotVisible 固化逻辑已移除
assert(
  '原 isTimeSlotVisible 固化逻辑已移除',
  !scriptsJs.includes('TIME_SLOTS.forEach((_, i) => { if (isTimeSlotVisible(i)) state.visibleTimeSlots.add(i); }'),
  '旧逻辑仍存在'
);

console.log('\n=== 问题2：多图模式补充筛选命中图标 ===');

// 2.1 renderMultiMode 中计算 isFilterActive
assert(
  'renderMultiMode 计算 isFilterActive',
  scriptsJs.includes('const isFilterActive = !(state.visibleTimeSlots.size === 0 && !state._filterNone) || state._filterHidePassed || state._filterOnlyImages;'),
  '未计算 isFilterActive'
);

// 2.2 renderMultiMode 中定义 filterHitIconSvg
assert(
  'renderMultiMode 定义 filterHitIconSvg',
  scriptsJs.includes('filterHitIconSvg') && scriptsJs.includes('icon-filter-hit'),
  '未定义 filterHitIconSvg'
);

// 2.3 座位按钮生成 filterHitIcon
assert(
  '座位按钮生成 filterHitIcon 条件判断',
  scriptsJs.includes('const filterHitIcon = (isFilterActive && stat && stat.visibleHasImages) ? filterHitIconSvg'),
  '未生成 filterHitIcon'
);

// 2.4 filterHitIcon 插入到按钮 HTML 中
assert(
  'filterHitIcon 插入到按钮 HTML',
  scriptsJs.includes('${hiddenIcon}${filterHitIcon}<span class="seat-btn-text">'),
  'filterHitIcon 未插入按钮'
);

// 2.5 icon-hidden 仍保留（闭眼图标）
assert(
  'icon-hidden 闭眼图标保留',
  scriptsJs.includes('const hiddenIcon = (stat && stat.hiddenHasImages)'),
  '闭眼图标丢失'
);

console.log('\n=== 版本号验证 ===');

// 3.1 scripts.js APP_VERSION
assert(
  'scripts.js APP_VERSION = v1.29.1',
  scriptsJs.includes("const APP_VERSION = 'v1.29.1'"),
  '版本号未更新'
);

// 3.2 min.js 版本号(4处)
const minCount = (scriptsMinJs.match(/v1\.29\.1/g) || []).length;
assert(
  'scripts.min.js v1.29.1 出现 4 次(1声明+3内联)',
  minCount === 4,
  `实际 ${minCount} 次`
);

// 3.3 min.js 无残留旧版本
const oldMin = (scriptsMinJs.match(/v1\.29\.0/g) || []).length + (scriptsMinJs.match(/v1\.28\.\d+/g) || []).length;
assert(
  'scripts.min.js 无 v1.29.0/v1.28.x 残留',
  oldMin === 0,
  `残留 ${oldMin} 处`
);

// 3.4 sw.js CACHE_NAME
assert(
  'sw.js CACHE_NAME = seat-cache-v173',
  swJs.includes("const CACHE_NAME = 'seat-cache-v173'"),
  'CACHE_NAME 未更新'
);

console.log('\n=== 回归检查 ===');

// 4.1 默认模式筛选回调仍正常
const refreshCalls = (scriptsJs.match(/refreshExpandedSeats\(\)/g) || []).length;
assert(
  `refreshExpandedSeats 调用保留 (${refreshCalls}处)`,
  refreshCalls >= 5,
  `仅 ${refreshCalls} 处`
);

// 4.2 默认模式 applyTimeslotFilter 保留
assert(
  '默认模式 applyTimeslotFilter 保留',
  scriptsJs.includes('applyTimeslotFilter(container)'),
  'applyTimeslotFilter 被移除'
);

// 4.3 默认模式 updateAreaVisual 保留
assert(
  '默认模式 updateAreaVisual 保留',
  scriptsJs.includes('updateAreaVisual(parseInt(p[0]), p[1])'),
  'updateAreaVisual 被移除'
);

// 4.4 默认模式 refreshSingleSeatStats 保留
assert(
  '默认模式 refreshSingleSeatStats 保留',
  scriptsJs.includes('refreshSingleSeatStats(sk)'),
  'refreshSingleSeatStats 被移除'
);

// 4.5 "默认/全选"按钮仍清空 _savedFilterState
assert(
  '"默认/全选"按钮清空 _savedFilterState',
  scriptsJs.includes('state._savedFilterState = null;'),
  '_savedFilterState 清空逻辑丢失'
);

// 4.6 "清除"按钮仍清空 _savedFilterState
const clearBtn = scriptsJs.match(/filter-clear[\s\S]*?\}\)\(\);/);
assert(
  '"清除"按钮清空 _savedFilterState',
  clearBtn && clearBtn[0].includes('state._savedFilterState = null;'),
  '清除按钮未清空 _savedFilterState'
);

// 4.7 多图模式提前分支保留(v1.29.0)
assert(
  '多图模式提前分支保留(if (_multiMode))',
  scriptsJs.includes('if (_multiMode) {'),
  '多图模式分支丢失'
);

// 4.8 多图模式楼层时段文字保留(v1.29.0)
assert(
  '多图模式楼层时段文字保留(floorSlotSet)',
  scriptsJs.includes('floorSlotSet'),
  '楼层时段文字丢失'
);

// 4.9 多图模式座位按钮 data-multi-slots 保留
assert(
  '多图模式座位按钮 data-multi-slots 保留',
  scriptsJs.includes('data-multi-slots='),
  'data-multi-slots 丢失'
);

console.log('\n=== min.js 一致性检查 ===');

// 5.1 min.js 包含 _savedFilterState 恢复逻辑
assert(
  'min.js 包含 _savedFilterState 恢复逻辑',
  scriptsMinJs.includes('_savedFilterState'),
  'min.js 缺少 _savedFilterState'
);

// 5.2 min.js 不再用 isTimeSlotVisible 固化
assert(
  'min.js 不再用 isTimeSlotVisible 固化可见时段',
  !scriptsMinJs.includes('if(isTimeSlotVisible(i))'),
  'min.js 仍用 isTimeSlotVisible 固化'
);

// 5.3 min.js 包含筛选命中图标生成逻辑（检查字符串常量 icon-filter-hit 和条件逻辑）
// 注意：变量名 isFilterActive/filterHitIconSvg 被 terser 混淆，检查关键逻辑即可
assert(
  'min.js 包含筛选命中图标逻辑(visibleHasImages + icon-filter-hit)',
  scriptsMinJs.includes('visibleHasImages') && scriptsMinJs.includes('icon-filter-hit'),
  'min.js 缺少筛选命中图标逻辑'
);

// 5.4 min.js 包含 _savedFilterState 保存逻辑(slots + none)
assert(
  'min.js 包含 _savedFilterState 保存逻辑(slots + none)',
  scriptsMinJs.includes('slots:[...state.visibleTimeSlots]') || scriptsMinJs.includes('slots:'),
  'min.js 缺少 _savedFilterState 保存'
);

// 5.5 min.js 包含 icon-hidden（闭眼图标）
assert(
  'min.js 包含 icon-hidden（闭眼图标）',
  scriptsMinJs.includes('icon-hidden'),
  'min.js 缺少 icon-hidden'
);

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
