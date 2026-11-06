/**
 * 离线渲染 client.js，验证三件事：
 *   1. 触发器显示**窗口容量**（`1000.0K`），不是占用率；
 *   2. 浮层**只**有切换控件（滑杆 + 状态 + 关闭），没有用量条/图例/百分比；
 *   3. 滑杆定位走 transform（scaleX / translate3d），不再动 left/width —— 修卡顿。
 *
 * 做法：用最小 React 替身驱动 `window.__ModuleLoader__.load()`，
 * 从 slot 注册里取出组件并真实渲染一次。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CLIENT = 'E:/plugins/dsh-long-context-budget/client.js';

/* ------------------------------------------------------------ 最小 React 替身 */
function createElement(type, props, ...children) {
  return { type, props: props || {}, children };
}
let hookCursor = 0;
let hookValues = [];
const reactStub = {
  createElement,
  useState: (initial) => {
    const index = hookCursor++;
    const seeded = Object.prototype.hasOwnProperty.call(hookValues, index);
    const value = seeded ? hookValues[index] : (typeof initial === 'function' ? initial() : initial);
    hookValues[index] = value;
    return [value, () => {}];
  },
  useRef: (initial) => ({ current: initial ?? null }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useId: () => 'lcb-test',
};

/* --------------------------------------------------------------- 模块加载器 */
let loaded = null;
const moduleTable = {
  react: reactStub,
  'react-dom': {},
  '@deepseek-ai/dsh-client-ui-primitives': {},
};
const sandbox = {
  window: { __ModuleLoader__: { load(mod) { loaded = mod; } } },
  document: undefined,
  console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(CLIENT, 'utf8'), sandbox, { filename: CLIENT });

if (!loaded || typeof loaded.factory !== 'function') throw new Error('client.js did not register a module');
const plugin = loaded.factory((name) => moduleTable[name] ?? {});
if (!plugin || typeof plugin.apply !== 'function') throw new Error('client.js factory returned no apply()');

/* ----------------------------------------------------- 取出 slot 注册的组件 */
let seat = null;
plugin.apply({
  get: () => null,
  slots: {
    inject: (_slot, factory) => factory(),
    register: (_meta, component) => { seat = component; return () => {}; },
  },
});
if (typeof seat !== 'function') throw new Error('no slot component registered');

/* ------------------------------------------------------------------ 渲染一次 */
const K = 1024;
const tiers = [256 * K, 384 * K, 512 * K, 640 * K, 768 * K, 896 * K, 1000 * K];
const pressure = { contextWindow: 1000 * K, pressureTokens: 253 * K };
const selectedBudget = 640 * K; /* 与面板「预算 640.0K」对应 */

/* 每个函数组件用自己独立的 hook 数组。BudgetSeat 的第 2 个 useState 是 open，
   强制成 true 才能渲染出面板。BudgetSlider 的第 1 个 useState 是 width，
   喂一个真实轨道宽度让刻度点渲染出来。 */
function invoke(element, hooks) {
  const savedValues = hookValues;
  const savedCursor = hookCursor;
  hookValues = hooks;
  hookCursor = 0;
  try {
    return element.type({ ...element.props, children: element.children });
  } finally {
    hookValues = savedValues;
    hookCursor = savedCursor;
  }
}
function render(element) {
  if (element && typeof element.type === 'function') {
    return render(invoke(element, [{ 'sess-test': selectedBudget }, true])); /* budgets, open */
  }
  return element;
}

let tree;
try {
  tree = render(seat({
    sessionId: 'sess-test',
    useProjection: (key) => (key === 'contextPressure' ? pressure : undefined),
  }));
} catch (error) {
  console.error('render threw:', error);
  process.exit(1);
}

/* 收集整棵树里出现的 class / 文案 / inline style。 */
const found = [];
const styles = [];
function walk(node) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const child of node) walk(child); return; }
  if (typeof node !== 'object') return;
  let element = node;
  if (typeof element.type === 'function') {
    element = invoke(element, [272]);
    walk(element);
    return;
  }
  if (typeof element.type === 'string') {
    const p = element.props || {};
    if (typeof p.className === 'string') found.push(...p.className.split(/\s+/).filter(Boolean));
    if (typeof p.role === 'string') found.push(`role:${p.role}`);
    if (typeof p['aria-valuenow'] === 'number') found.push(`valuenow:${p['aria-valuenow']}`);
    if (typeof p.title === 'string') found.push(`title:${p.title}`);
    if (typeof p['aria-label'] === 'string') found.push(`aria:${p['aria-label']}`);
    if (p.style && typeof p.style === 'object') styles.push({ cls: p.className, ...p.style });
    for (const child of element.children || []) {
      if (typeof child === 'string') found.push(`text:${child}`);
      else walk(child);
    }
  }
}
walk(tree);

const texts = found.filter((x) => x.startsWith('text:')).map((x) => x.slice(5));
const knobStyle = styles.find((s) => s.cls === 'lcb-slider-knob') || {};
const fillStyle = styles.find((s) => s.cls === 'lcb-slider-fill') || {};

const checks = {
  'panel rendered': found.includes('lcb-panel'),
  'slider rendered': found.includes('lcb-slider'),
  'slider track role': found.includes('role:slider'),
  'slider knob': found.includes('lcb-slider-knob'),
  'slider fill': found.includes('lcb-slider-fill'),
  'fill clip wrapper': found.includes('lcb-slider-fill-clip'),
  'slider ticks': found.filter((x) => x === 'lcb-slider-tick').length === tiers.length,
  'ends label tighter': found.includes('text:更省'),
  'ends label roomier': found.includes('text:更宽'),
  'panel value equals SELECTED TIER 640.0K': texts.filter((x) => x === '640.0K').length >= 2,
  'no "整窗" while a lower tier is active': !texts.includes('整窗'),
  'trigger shows SELECTED TIER 640.0K': texts.includes('640.0K'),
  'trigger does NOT show window capacity 1000.0K': !texts.includes('1000.0K'),
  'trigger does NOT show usage percent': !texts.some((x) => /^\d+\.\d%$/.test(x)),
  'window capacity kept in tooltip': found.some((x) => x.startsWith('title:') && x.includes('1000.0K')),
  'window capacity kept in aria-label': found.some((x) => x.startsWith('aria:') && x.includes('1000.0K')),
  'no usage percent heading': !found.includes('lcb-percent'),
  'no stacked usage bar': !found.includes('lcb-bar') && !found.includes('lcb-segment'),
  'no legend rows': !found.includes('lcb-rows') && !found.includes('lcb-row') && !found.includes('lcb-swatch'),
  'no usage figures': !found.includes('lcb-figures') && !found.includes('lcb-waiting'),
  'no legacy select': !found.some((x) => x.includes('lcb-select') || x === 'lcb-budget'),
  'no legacy divider': !found.includes('lcb-divider'),
  'knob uses translate3d (GPU)': typeof knobStyle.transform === 'string' && knobStyle.transform.includes('translate3d'),
  'knob has NO left': !('left' in knobStyle),
  'fill uses scaleX (GPU)': typeof fillStyle.transform === 'string' && fillStyle.transform.includes('scaleX'),
  'fill has NO width': !('width' in fillStyle),
};

let failed = false;
for (const [name, ok] of Object.entries(checks)) {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
if (failed) {
  console.error('\nfindings:', found.filter((x) => x.startsWith('text:') || x.startsWith('role:') || x.includes('lcb-')).join(', '));
  console.error('styles:', JSON.stringify(styles));
  process.exit(1);
}
console.log('\nslider render: all checks passed');
