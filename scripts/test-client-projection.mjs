/**
 * 客户端「挂载不在聊天记录里刷命令」的回归测试。
 *
 * 用最小 React 替身 + 假 `remote.commands` 载入真实的 client.js，验证：
 *   1. 投影存在时，挂载**一条命令都不发**（之前每次挂载都 status + 可能 set，
 *      就是用户截图里那串重复日志）；
 *   2. 老 Host 的 status 返回纯数字预算时，客户端把它当成预算采用，
 *      **不再**把同一个值重推一遍；
 *   3. Host 重启（status 报 0、本地有值）时，仍然会把选择推回去 —— 且只推一次；
 *   4. 同一页面重复挂载同样不发命令。
 *
 * 与 `test-budget-slider.mjs` 的分工：那边验证渲染结果，这边验证命令通道。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CLIENT = 'E:/plugins/dsh-long-context-budget/client.js';
const SOURCE = readFileSync(CLIENT, 'utf8');
const K = 1024;
const DEFAULT_SETTINGS = { triggerRatio: 0.7, baseTokens: 256 * K, stepCap: 128 * K };
/* 组件渲染时一定会用到 `strings.t`（触发器文案），替身给一个原样返回 key 的词表。 */
const STRINGS = { language: 'zh', t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) };

/* ------------------------------------------------------------ 最小 React 替身 */

function makeReact() {
  let hookValues = [];
  let cursor = 0;
  let effects = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => {
      const index = cursor++;
      const seeded = Object.prototype.hasOwnProperty.call(hookValues, index);
      const value = seeded ? hookValues[index] : typeof initial === 'function' ? initial() : initial;
      hookValues[index] = value;
      return [value, () => {}];
    },
    useRef: (initial) => ({ current: initial ?? null }),
    useEffect: (fn) => {
      effects.push(fn);
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useId: () => 'lcb-test',
  };
  return {
    react,
    seed(values) {
      hookValues = values.slice();
      cursor = 0;
    },
    /* 渲染完成后把 effect 全跑一遍（React 里它们在提交阶段执行）。 */
    flushEffects() {
      const pending = effects;
      effects = [];
      for (const fn of pending) {
        fn();
      }
    },
  };
}

/* --------------------------------------------------------------- 载入插件模块 */

/**
 * 每个场景一份全新 VM：client.js 的 `statusProbe` 缓存与宽限期都是模块级常量。
 *
 * @param {{ local?: object, graceMs?: number, status?: (line: string) => { ok: boolean, text: string } }} options
 */
function loadPlugin(options = {}) {
  const reactHarness = makeReact();
  const commands = [];
  const store = { ...(options.local ?? {}) };
  const localStorage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = String(value);
    },
    removeItem: (key) => {
      delete store[key];
    },
  };

  let loaded = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(module) {
          loaded = module;
        },
      },
    },
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    localStorage,
  };
  sandbox.globalThis = sandbox;
  if (typeof options.graceMs === 'number') sandbox.__DSH_LCB_PROJECTION_GRACE_MS__ = options.graceMs;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: CLIENT });

  if (!loaded || typeof loaded.factory !== 'function') {
    throw new Error('client.js did not register a module');
  }

  const commandsApi = {
    async execute(_agentId, line) {
      commands.push(line);
      const response = options.status ? options.status(line) : { ok: true, text: '' };
      if (response && response.ok === false) {
        return { ok: false, error: { code: 'rejected', message: 'rejected' } };
      }
      return {
        ok: true,
        value: { commandId: 'cmd-1', result: { kind: 'success', text: response?.text ?? '' } },
      };
    },
  };

  let seat = null;
  const plugin = loaded.factory((name) => {
    if (name === 'react') return reactHarness.react;
    if (name === 'react-dom') return {};
    return {};
  });
  plugin.apply({
    get: (key) => (key === 'remote.commands' ? commandsApi : null),
    slots: {
      inject: (_slot, factory) => factory(),
      register: (_meta, component) => {
        seat = component;
        return () => {};
      },
    },
  });
  if (typeof seat !== 'function') throw new Error('no slot component registered');
  return { reactHarness, seat, commands, store };
}

/**
 * 渲染一次组件并跑完 effect。
 *
 * 前 6 个 useState 的下标必须与 client.js 里的声明顺序一致（budgets / open /
 * busy / error / strings / fallbackSettings），与 test-budget-slider.mjs 的约定相同。
 */
function renderSeat(plugin, props = {}) {
  const { sessionId = 'sess-test', projection = null, budgets = {} } = props;
  const useProjection = (key) => (key === 'contextBudget' ? projection ?? undefined : undefined);
  /* slot 注册的是外壳组件（`h(BudgetSeat, props)`）；展开它才会真正执行
     BudgetSeat 的 hooks —— 与 test-budget-slider.mjs 的 invoke() 同理。 */
  const shell = plugin.seat({ sessionId, useProjection });
  if (!shell || typeof shell.type !== 'function') throw new Error('shell did not wrap a component');
  plugin.reactHarness.seed([budgets, false, false, null, STRINGS, DEFAULT_SETTINGS]);
  shell.type({ ...shell.props, children: shell.children });
  plugin.reactHarness.flushEffects();
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failed = false;
function report(name, ok, detail) {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`);
}

const PROJECTION = {
  budget: 640 * K,
  window: 1000 * K,
  seeded: true,
  triggerRatio: 0.7,
  baseTokens: 256 * K,
  stepCap: 128 * K,
};

/* ------------------------------------------------------------------- 场景 1：投影在 */
{
  const plugin = loadPlugin({ graceMs: 0 });
  renderSeat(plugin, { projection: PROJECTION, budgets: { 'sess-test': 640 * K } });
  await wait(40);
  report('projection present: mount issues zero commands', plugin.commands.length === 0, JSON.stringify(plugin.commands));
}

/* ------------------------------------- 场景 2：老 Host 纯数字 status，不重复推送 */
{
  const local = JSON.stringify({ 'sess-test': 640000 });
  const plugin = loadPlugin({
    graceMs: 0,
    local: { 'dsh-long-context-budget.budgets': local },
    status: () => ({ ok: true, text: '960000' }),
  });
  renderSeat(plugin, { projection: null, budgets: { 'sess-test': 640000 } });
  await wait(80);
  const statusCalls = plugin.commands.filter((line) => line === '/context-budget-status').length;
  const pushes = plugin.commands.filter((line) => line.startsWith('/context-budget '));
  const mirrored = JSON.parse(plugin.store['dsh-long-context-budget.budgets'] ?? '{}');
  report(
    'legacy numeric status is adopted, not re-pushed',
    statusCalls === 1 && pushes.length === 0 && mirrored['sess-test'] === 960000,
    `status=${statusCalls} pushes=${JSON.stringify(pushes)} local=${mirrored['sess-test']}`
  );
}

/* ----------------------------- 场景 3：Host 重启（status 报 0）→ 推回本地选择一次 */
{
  const plugin = loadPlugin({
    graceMs: 0,
    local: { 'dsh-long-context-budget.budgets': JSON.stringify({ 'sess-test': 500000 }) },
    status: () => ({
      ok: true,
      text: JSON.stringify({ v: 2, budget: 0, window: 1000000, triggerRatio: 0.7, baseTokens: 262144, stepCap: 131072 }),
    }),
  });
  renderSeat(plugin, { projection: null, budgets: { 'sess-test': 500000 } });
  await wait(80);
  const pushes = plugin.commands.filter((line) => line.startsWith('/context-budget '));
  report(
    'restart: local budget pushed back exactly once',
    pushes.length === 1 && pushes[0] === '/context-budget 500000',
    JSON.stringify(pushes)
  );
}

/* ------------------------- 场景 4：同一页面重复挂载不会重复发命令（防重复日志） */
{
  const plugin = loadPlugin({ graceMs: 0 });
  renderSeat(plugin, { projection: PROJECTION });
  renderSeat(plugin, { projection: PROJECTION });
  renderSeat(plugin, { projection: PROJECTION });
  await wait(40);
  report('remounts with a projection stay command-free', plugin.commands.length === 0, JSON.stringify(plugin.commands));
}

/* --------------------- 场景 5：没有投影、重复挂载也只问一次（共享同一个 Promise） */
{
  const status = () => ({ ok: true, text: JSON.stringify({ v: 2, budget: 640000, window: 1000000 }) });
  const plugin = loadPlugin({
    graceMs: 0,
    local: { 'dsh-long-context-budget.budgets': JSON.stringify({ 'sess-test': 640000 }) },
    status,
  });
  renderSeat(plugin, { projection: null, budgets: { 'sess-test': 640000 } });
  renderSeat(plugin, { projection: null, budgets: { 'sess-test': 640000 } });
  await wait(120);
  const statusCalls = plugin.commands.filter((line) => line === '/context-budget-status').length;
  report('legacy path probes status once per page/session', statusCalls === 1, `status=${statusCalls}, all=${JSON.stringify(plugin.commands)}`);
}

/* ------------------- 场景 6：旧版（日志里没有 args）预算被一次性推回，且只推一次 */
{
  const legacyProjection = { budget: 0, window: 1000 * K, seeded: false, triggerRatio: 0.7, baseTokens: 256 * K, stepCap: 128 * K };
  const plugin = loadPlugin({ graceMs: 0, local: { 'dsh-long-context-budget.budgets': JSON.stringify({ 'sess-test': 640000 }) } });
  renderSeat(plugin, { projection: legacyProjection, budgets: { 'sess-test': 640000 } });
  renderSeat(plugin, { projection: legacyProjection, budgets: { 'sess-test': 640000 } });
  await wait(40);
  const pushes = plugin.commands.filter((line) => line.startsWith('/context-budget '));
  report('legacy budget migrated into the log exactly once', pushes.length === 1 && pushes[0] === '/context-budget 640000', JSON.stringify(pushes));
}

/* ------------------- 场景 7：日志里已有本命令（seeded）→ 不再补推，尊重「已清空」 */
{
  const seededProjection = { budget: 0, window: 1000 * K, seeded: true, triggerRatio: 0.7, baseTokens: 256 * K, stepCap: 128 * K };
  const plugin = loadPlugin({ graceMs: 0, local: { 'dsh-long-context-budget.budgets': JSON.stringify({ 'sess-test': 640000 }) } });
  renderSeat(plugin, { projection: seededProjection, budgets: { 'sess-test': 640000 } });
  await wait(40);
  const pushes = plugin.commands.filter((line) => line.startsWith('/context-budget '));
  report('cleared budget is not resurrected from localStorage', pushes.length === 0, JSON.stringify(plugin.commands));
}

/* ----------------- 场景 8：量到窗口就写进 localStorage，供下一次新会话直接用 */
{
  const plugin = loadPlugin({ graceMs: 0 });
  renderSeat(plugin, { projection: PROJECTION });
  await wait(40);
  const cached = plugin.store['dsh-long-context-budget.last-window'];
  report(
    'measured window is cached for the next session',
    cached === String(1000 * K),
    `cached=${cached}`
  );
}

if (failed) process.exit(1);
console.log('\nclient projection mount: all assertions passed');
