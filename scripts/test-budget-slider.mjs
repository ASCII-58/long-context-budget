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
/* 最小 localStorage：窗口缓存与预算镜像都走它。 */
const memoryStore = new Map();
sandbox.localStorage = {
  getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
  setItem: (key, value) => memoryStore.set(key, String(value)),
  removeItem: (key) => memoryStore.delete(key),
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
/* BudgetSeat 的 useState 顺序：budget / open / busy / error / strings /
   settings / fallbackWindow / cachedWindow。 */
const defaultSettings = { triggerRatio: 0.7, baseTokens: 256 * K, stepCap: 128 * K };
const defaultSeatHooks = () => [{ 'sess-test': selectedBudget }, true, false, null, stringsStub, defaultSettings, 0, 0];
const stringsStub = {
  language: 'zh',
  t: (key, params) => {
    const dict = {
      'budget.label': '预算', 'budget.economy': '更省', 'budget.roomy': '更宽',
      'tier.full': '整窗', 'tier.value': '{tier}', 'budget.trigger': '触发点',
      'budget.nextRequest': '下一步请求生效', 'panel.title': '上下文长度',
      'panel.close': '关闭', 'trigger.label': '上下文', 'trigger.aria': '当前上下文长度预算',
      'trigger.window': '窗口', 'budget.notGraded': '当前模型窗口未超过 {base}，无需分级',
      'budget.generic': '窗口尚未测量，先按通用档位选择',
      'budget.estimated': '窗口按上次测量 {window} 估算，首次请求后自动校正',
    };
    let text = dict[key] ?? key;
    if (params) for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, String(v));
    return text;
  },
};
function render(element, hooks) {
  if (element && typeof element.type === 'function') {
    /* 前 8 个值喂给 BudgetSeat；[272] 喂给 BudgetSlider 的 width。 */
    return render(invoke(element, hooks ?? defaultSeatHooks()));
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
const disabledFlags = [];
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
    if (p['data-disabled'] !== undefined) disabledFlags.push(String(p['data-disabled']));
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

/* 命令名是 Host/Client 固定契约：两边漂移会让 status 对账静默失效。 */
const hostSource = readFileSync('E:/plugins/dsh-long-context-budget/index.js', 'utf8');
const clientSource = readFileSync(CLIENT, 'utf8');
const hostCommand = /const COMMAND_NAME = '([^']+)'/.exec(hostSource)?.[1];
const hostStatus = /const STATUS_COMMAND = `([^`]+)`/.exec(hostSource)?.[1];
const clientCommand = /const COMMAND_NAME = '([^']+)'/.exec(clientSource)?.[1];
const clientStatus = /const STATUS_COMMAND = `([^`]+)`/.exec(clientSource)?.[1];

const checks = {
  'host/client COMMAND_NAME match': !!hostCommand && hostCommand === clientCommand,
  'host/client STATUS_COMMAND match': !!hostStatus && hostStatus === clientStatus,
  'STATUS_COMMAND derives from COMMAND_NAME': hostStatus === '${COMMAND_NAME}-status',
  'no hardcoded 70% in meta rendering': !/预算\.trigger.*70%|trigger.*0\.7/.test(clientSource.slice(clientSource.indexOf('const triggerPercent'))),
  'panel rendered': found.includes('lcb-panel'),
  'slider rendered': found.includes('lcb-slider'),
  'slider track role': found.includes('role:slider'),
  'slider knob': found.includes('lcb-slider-knob'),
  'slider fill': found.includes('lcb-slider-fill'),
  'fill clip wrapper': found.includes('lcb-slider-fill-clip'),
  'slider ticks': found.filter((x) => x === 'lcb-slider-tick').length === tiers.length,
  'ends label tighter': found.includes('text:更省'),
  'ends label roomier': found.includes('text:更宽'),
  'trigger point uses dynamic 70%': texts.some((x) => x.includes('70%') && x.includes('448.0K')),
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

/* ---------------------------------------------------------------------------
 * 场景 2：会话刚开始、**一次请求都还没发**（没有 contextPressure）。
 * 窗口与预算只能来自 Host 的 `contextBudget` 投影 —— 这就是用户截图里
 * 「尚未测量上下文窗口、无法设置」的那个场景。
 * ------------------------------------------------------------------------- */
found.length = 0;
styles.length = 0;
disabledFlags.length = 0;
const hostProjectionKey = /const PROJECTION_KEY = '([^']+)'/.exec(hostSource)?.[1];
const clientProjectionKey = /const PROJECTION_KEY = '([^']+)'/.exec(clientSource)?.[1];
const projection = {
  budget: selectedBudget,
  window: 1000 * K,
  seeded: true,
  triggerRatio: 0.7,
  baseTokens: 256 * K,
  stepCap: 128 * K,
};
let projectionTree;
try {
  projectionTree = render(seat({
    sessionId: 'sess-proj',
    useProjection: (key) => (key === 'contextBudget' ? projection : undefined),
  }));
} catch (error) {
  console.error('projection render threw:', error);
  process.exit(1);
}
walk(projectionTree);
const projectionTexts = found.filter((x) => x.startsWith('text:')).map((x) => x.slice(5));

const projectionChecks = {
  'projection: panel rendered with no contextPressure': found.includes('lcb-panel'),
  'projection: tiers come from the projection window': found.filter((x) => x === 'lcb-slider-tick').length === tiers.length,
  'projection: slider is enabled before the first request': disabledFlags.length === 0,
  'projection: status says "takes effect next step"': projectionTexts.includes('下一步请求生效'),
  'projection: no "context window not measured" message': !projectionTexts.includes('budget.unknownWindow'),
  'projection: budget comes from the projection': projectionTexts.filter((x) => x === '640.0K').length >= 2,
  'projection: host/client PROJECTION_KEY match': !!hostProjectionKey && hostProjectionKey === clientProjectionKey,
  'client never calls status on mount when the projection exists': !/reconcile\(\)/.test(clientSource),
  'legacy plain-number status is parsed as a budget (no bogus re-push)': /const numeric = object === null \? Number\(text\)/.test(clientSource),
};

for (const [name, ok] of Object.entries(projectionChecks)) {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
if (failed) {
  console.error('\nprojection findings:', projectionTexts.join(' | '));
  process.exit(1);
}

/* ---------------------------------------------------------------------------
 * 场景 3：窗口**完全未知**（没有 contextPressure、没有投影、没有 status 兜底，
 * 也没有上次测量）。面板不能让滑杆变灰：「还没量到窗口」不等于「不能设预算」，
 * 退到通用绝对档位，真实窗口到达后 Host 会把同一预算重新对齐。
 * ------------------------------------------------------------------------- */
found.length = 0;
styles.length = 0;
disabledFlags.length = 0;
const genericTree = render(seat({ sessionId: 'sess-generic', useProjection: () => undefined }), [
  {},
  true,
  false,
  null,
  stringsStub,
  defaultSettings,
  0,
  0,
]);
walk(genericTree);
const genericTexts = found.filter((x) => x.startsWith('text:')).map((x) => x.slice(5));

const genericChecks = {
  'generic: panel rendered with no window at all': found.includes('lcb-panel'),
  'generic: slider enabled with 4 absolute tiers':
    disabledFlags.length === 0 && found.filter((x) => x === 'lcb-slider-tick').length === 4,
  'generic: footer explains the window is unknown': genericTexts.includes('窗口尚未测量，先按通用档位选择'),
  'generic: top tier is not called "full window"': !genericTexts.includes('整窗'),
  'generic: budget stays "—" until one is chosen': genericTexts.filter((x) => x === '—').length >= 2,
};

for (const [name, ok] of Object.entries(genericChecks)) {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
if (Object.values(genericChecks).some((ok) => !ok)) {
  console.error('\ngeneric findings:', genericTexts.join(' | '));
  process.exit(1);
}

/* ---------------------------------------------------------------------------
 * 场景 4：窗口来自上次测量（localStorage 缓存）。档位形状可用，但必须标明是
 * 估算值，而且不能把最高档叫「整窗」—— 当前模型可能已经换了。
 * ------------------------------------------------------------------------- */
found.length = 0;
styles.length = 0;
disabledFlags.length = 0;
const cachedTree = render(seat({ sessionId: 'sess-cached', useProjection: () => undefined }), [
  { 'sess-cached': 640 * K },
  true,
  false,
  null,
  stringsStub,
  defaultSettings,
  0,
  1000 * K,
]);
walk(cachedTree);
const cachedTexts = found.filter((x) => x.startsWith('text:')).map((x) => x.slice(5));

const cachedChecks = {
  'cached window: tiers rebuilt from the last measured window':
    disabledFlags.length === 0 && found.filter((x) => x === 'lcb-slider-tick').length === tiers.length,
  'cached window: footer marks the window as estimated': cachedTexts.includes(
    '窗口按上次测量 1000.0K 估算，首次请求后自动校正'
  ),
  'cached window: top tier is not called "full window"': !cachedTexts.includes('整窗'),
};

for (const [name, ok] of Object.entries(cachedChecks)) {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
if (Object.values(cachedChecks).some((ok) => !ok)) {
  console.error('\ncached-window findings:', cachedTexts.join(' | '));
  process.exit(1);
}

console.log('\nslider render: all checks passed (including the pre-request projection path)');
