/**
 * 离线驱动 index.js：用假 ctx / 假 session / 假服务验证这次改造的关键行为。
 * 不碰真实宿主，只检查监听器注册点、next() 语义、剪枝顺序和失败退出。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const INDEX = 'E:/plugins/dsh-long-context-budget/index.js';
const CLIENT = 'E:/plugins/dsh-long-context-budget/client.js';

const listeners = [];
const registeredCommands = [];
const effects = [];

/* ------------------------------------------------------------- 假 ctx */
function makeCtx(extraServices) {
  const services = new Map();
  /* 默认路由解析用的两个服务：真实宿主里它们在插件激活前后就绪。
     个别场景会先把它们删掉，用来验证「解析不出来时如何兜底」。 */
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) });
  services.set('llm', {
    async resolveModelInfo() {
      return { context: { contextWindow: 1000000 } };
    },
  });
  if (extraServices) for (const [key, value] of Object.entries(extraServices)) services.set(key, value);
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn, label) {
      effects.push(label);
      return fn();
    },
    on(name, listener, options) {
      listeners.push({ name, listener, options });
      return () => {};
    },
    get(key) {
      return services.get(key) ?? null;
    },
    inject(deps, _cb) {
      /* sessionProjections 注入：本次测试不关心投影。 */
      return { dispose() {} };
    },
    commands: {
      register(spec) {
        registeredCommands.push(spec);
        return () => {};
      },
    },
    _services: services,
  };
  return ctx;
}

/* --------------------------------------------------------- 假 session */
function makeSession(totalTokens, nodeSeqs, opts = {}) {
  const surfaceNodes = nodeSeqs;
  const events = new Map();
  for (const seq of nodeSeqs) {
    events.set(seq, { type: 'user/message', seq, data: { role: 'user', content: [] } });
  }
  if (opts.firstIsSystem) {
    events.set(nodeSeqs[0], { type: 'system/message', seq: nodeSeqs[0], data: {} });
  }
  const session = {
    id: 'sess-1',
    surface: { nodes: surfaceNodes },
    eventAt(seq) {
      return events.get(seq);
    },
    requestContext() {
      return { contextWindow: 1000000, provider: 'p', model: 'm' };
    },
  };
  return session;
}

function makeMeter(state) {
  return {
    measure(session) {
      return {
        totalTokens: state.totalTokens,
        nodes: session.surface.nodes.map((seq) => ({ seq, tokens: state.perNode ?? 1000 })),
      };
    },
  };
}

const mod = await import(pathToFileURL(INDEX).href);
const ctx = makeCtx();
const state = { totalTokens: 800000, perNode: 200000 };

const meter = makeMeter(state);
const prunerCalls = [];
const compactionCalls = [];

const pruner = {
  pruneSession() {
    prunerCalls.push(Date.now());
    state.totalTokens = 100000; // 剪枝一次就降到阈值以下
  },
};

const compaction = {
  async compactRegion(start, end) {
    compactionCalls.push({ start, end });
    return { shadowedSeqs: [1, 2], shadowedTokenCount: 5000 };
  },
};

const presets = {
  serviceFor(agent, name) {
    if (name === 'compaction') return compaction;
    if (name === 'toolResultPruner') return pruner;
    return null;
  },
};

ctx._services.set('tokenMeter', meter);
ctx._services.set('agentPresets', presets);

mod.apply(ctx, { enabled: true });

const findings = {};

/* 1) 挂点与 prepend */
const hook = listeners.find((l) => l.name === 'agent/pre-step');
findings.hookName = hook ? hook.name : null;
findings.prepend = hook?.options?.prepend ?? null;
findings.oldHookPresent = listeners.some((l) => l.name === 'agent/turn-stopping');

/* 2) 命令仍注册；status 命令返回 JSON（预算 + 下发给客户端的配置）。 */
findings.commands = registeredCommands.map((c) => c.name);
findings.effects = effects.length;
const statusCmd = registeredCommands.find((c) => c.name === 'context-budget-status');
findings.statusCommandPresent = !!statusCmd;
if (statusCmd) {
  const statusResult = await statusCmd.handler({ agent: null, signal: { aborted: false } });
  let parsed = null;
  try { parsed = JSON.parse(String(statusResult.text)); } catch { /* ignore */ }
  findings.statusResultKind = statusResult.kind;
  findings.statusBudget = parsed?.budget ?? null;
  findings.statusHasTriggerRatio = Number.isFinite(parsed?.triggerRatio);
  findings.statusHasBaseTokens = Number.isFinite(parsed?.baseTokens);
  findings.statusHasStepCap = Number.isFinite(parsed?.stepCap);
}

/* 3) 未设预算时：零干预（next 被调用，服务未被触碰） */
const agent = {
  id: 'sess-1',
  session: makeSession(state.totalTokens, [1, 2, 3, 4]),
  ctx: {
    get(key) {
      if (key === 'compaction') return compaction;
      if (key === 'toolResultPruner') return pruner;
      return null;
    },
  },
};

let nextCalls = 0;
const next = async () => {
  nextCalls += 1;
  return { kind: 'enter', messages: [] };
};

/* 2b) status 必须带上窗口：客户端在首次请求前拿不到窗口，全靠这一个字段
       画档位（`session.requestContext()` 里已有 1000000）。 */
if (statusCmd) {
  const withAgent = await statusCmd.handler({ agent, signal: { aborted: false } });
  let parsedAgent = null;
  try { parsedAgent = JSON.parse(String(withAgent.text)); } catch { /* ignore */ }
  findings.statusWindow = parsedAgent?.window ?? null;
  findings.statusBudgetWithAgent = parsedAgent?.budget ?? null;
  findings.statusProjectionKey = parsedAgent?.projection ?? null;
}

/* 2c) 预算命令必须把输入写进日志：`command/run.args` 是投影与重启恢复的唯一
       数据源，设成 `recordInput: false` 会让预算在重启后丢失。 */
const budgetCmdSpec = registeredCommands.find((c) => c.name === 'context-budget');
findings.budgetCommandRecordInput = budgetCmdSpec?.recordInput ?? null;

await hook.listener({ agent, messages: [{ role: 'user' }], step: 1, signal: { aborted: false } }, next);
findings.noBudget_nextCalled = nextCalls === 1;
findings.noBudget_pruneCalls = prunerCalls.length;
findings.noBudget_compactCalls = compactionCalls.length;

/* 4) 设预算后：剪枝一步到位 → 不调模型摘要 */
await registeredCommands
  .find((c) => c.name === 'context-budget')
  .handler({ rawInput: '400000', agent, signal: { aborted: false } });

state.totalTokens = 800000;
nextCalls = 0;
await hook.listener({ agent, messages: [{ role: 'user' }], step: 1, signal: { aborted: false } }, next);
findings.budget_pruneCalls = prunerCalls.length;
findings.budget_compactCalls = compactionCalls.length;
findings.budget_nextCalled = nextCalls === 1;

/* 5) 剪枝不够 → 走压缩；压缩抛错后立即 return 且不重试 */
state.totalTokens = 800000;
pruner.pruneSession = () => {}; // 不再降
let failCalls = 0;
compaction.compactRegion = async () => {
  failCalls += 1;
  throw new Error('boom');
};
nextCalls = 0;
await hook.listener(
  { agent, messages: [{ role: 'user' }], step: 1, signal: { aborted: false } },
  next,
);
findings.fail_compactAttempts = failCalls;
findings.fail_nextCalled = nextCalls === 1;

/* 6) 首个 step（宿主是 1-based，turn() 里 step=phase.step+1）且空 messages：
      旧代码用 `step === 0` 跳过，但那个分支永远不成立 —— 现在必须照常测量。 */
state.totalTokens = 999999;
let measured = 0;
ctx._services.set('tokenMeter', {
  measure(s) {
    measured += 1;
    return { totalTokens: state.totalTokens, nodes: [] };
  },
});
nextCalls = 0;
await hook.listener({ agent, messages: [], step: 1, signal: { aborted: false } }, next);
findings.emptyMessagesAtFirstStep_measureCalls = measured;
findings.emptyMessagesAtFirstStep_nextCalled = nextCalls === 1;

/* 6b) 中途 step 的空 messages：仍要检查并压缩（长回合涨过阈值的关键路径） */
measured = 0;
nextCalls = 0;
await hook.listener({ agent, messages: [], step: 5, signal: { aborted: false } }, next);
findings.emptyMessagesMidTurn_measureCalls = measured;
findings.emptyMessagesMidTurn_nextCalled = nextCalls === 1;

/* 7) 监听器抛错也必须 next() */
nextCalls = 0;
const badAgent = null;
await hook.listener(
  { agent: badAgent, messages: [{ role: 'user' }], step: 1, signal: { aborted: false } },
  next,
);
findings.badAgent_nextCalled = nextCalls === 1;

/* 8) minIntervalMs: 0 不能被夹紧成 1000（P2-8）：用全新 ctx 单独 apply 一次，
      从 status 命令读回配置，确认 0 被原样保留。 */
{
  const savedListeners = listeners.length;
  const savedCommands = registeredCommands.length;
  const ctx2 = makeCtx();
  ctx2._services.set('tokenMeter', meter);
  ctx2._services.set('agentPresets', presets);
  mod.apply(ctx2, { enabled: true, minIntervalMs: 0 });
  const cmd2 = registeredCommands.slice(savedCommands).find((c) => c.name === 'context-budget-status');
  if (cmd2) {
    const r2 = await cmd2.handler({ agent: null, signal: { aborted: false } });
    try {
      const p2 = JSON.parse(String(r2.text));
      findings.minIntervalZeroPreserved = p2.minIntervalMs === 0;
    } catch {
      findings.minIntervalZeroPreserved = false;
    }
  } else {
    findings.minIntervalZeroPreserved = false;
  }
  /* 主测试的 hook 引用不受这次 apply 影响。 */
  findings.extraListenersForSecondApply = listeners.length - savedListeners;
}

/* 9) 会话投影：客户端从这里读预算/窗口/配置，不再跑 status 命令。
      投影 key 必须与 client.js 完全一致（漂移 = 面板永远读不到值）。 */
{
  const captured = [];
  const projectionState = { requested: 0, budget: 0, window: 0 };
  const registry = {
    register(definition) {
      captured.push(definition);
      return {
        dispose: async () => {},
        stateOf: () => projectionState,
        readerFor: () => () => projectionState,
      };
    },
  };
  const ctx3 = makeCtx();
  /* 这一块验证「窗口未知时先按原值记、测到窗口后再对齐」，所以先摘掉默认
     窗口解析的两个服务（否则 init 就带着 1M，400000 会当场被对齐）。 */
  ctx3._services.delete('agentDefaultModel');
  ctx3._services.delete('llm');
  ctx3._services.set('sessionProjections', registry);
  ctx3._services.set('tokenMeter', meter);
  ctx3._services.set('agentPresets', presets);
  mod.apply(ctx3, { enabled: true });
  /* 注册是异步的（先等一次默认窗口解析，最多 1.5s；这里没有 llm，立刻返回）。 */
  await new Promise((resolve) => setTimeout(resolve, 30));

  const definition = captured[0] ?? null;
  findings.projectionRegistered = !!definition;
  findings.projectionKey = definition?.key ?? null;
  findings.projectionStateVersion = definition?.stateVersion ?? null;
  findings.projectionSummary = definition?.wire?.summary ?? null;

  const clientSource = readFileSync(CLIENT, 'utf8');
  findings.clientProjectionKey = /const PROJECTION_KEY = '([^']+)'/.exec(clientSource)?.[1] ?? null;

  if (definition) {
    const s0 = definition.init();
    findings.projectionInit = JSON.stringify(s0);
    /* v0.2.7 之前的 `command/run` 没有 args：不能被当成「预算 = 0」，
       必须保持同一引用（seeded 仍为 false），交给客户端做一次性迁移。 */
    findings.legacyRunKeepsUnseeded = definition.apply(s0, { type: 'command/run', data: { name: 'context-budget' } }) === s0;
    /* 窗口未知时先按原值记 */
    const s1 = definition.apply(s0, { type: 'command/run', data: { name: 'context-budget', args: '400000' } });
    findings.projectionBudgetRaw = s1.budget;
    findings.projectionSeeded = s1.seeded === true;
    /* 测到窗口（1M）后，同一请求值对齐成「不大于它的最大档」393216（=384K） */
    const s2 = definition.apply(s1, { type: 'request/context', data: { contextWindow: 1000000 } });
    findings.projectionWindow = s2.window;
    findings.projectionBudgetAligned = s2.budget;
    /* 无关事件必须返回同一个引用，否则每次 tool 往返都会重新发布 */
    findings.projectionStableRef = definition.apply(s2, { type: 'tool/result', data: {} }) === s2;
    /* 取消：args 为 0 → 预算清空 */
    const s3 = definition.apply(s2, { type: 'command/run', data: { name: 'context-budget', args: '0' } });
    findings.projectionCleared = s3.budget === 0 && s3.requested === 0;
    /* 视图是客户端真正读到的形状 */
    const view = definition.wire.view(s2);
    findings.projectionViewFields = ['budget', 'window', 'seeded', 'triggerRatio', 'baseTokens', 'stepCap'].every(
      (key) => key in view,
    );
    findings.projectionViewSchema = JSON.stringify(definition.wire.viewSchema.parse(view)) === JSON.stringify(view);
    findings.projectionStateSchema = JSON.stringify(definition.stateSchema.parse(s2)) === JSON.stringify(s2);
  }

  /* 恢复：进程内 Map 是空的（Host 刚重启），预算必须从投影折回来 ——
     400000 → 0.7 触发点 280000，350000 应当触发剪枝。 */
  state.totalTokens = 350000;
  projectionState.requested = 400000;
  projectionState.budget = 400000;
  const hook3 = [...listeners].reverse().find((entry) => entry.name === 'agent/pre-step')?.listener ?? hook.listener;
  const pruningBefore = prunerCalls.length;
  const session3 = makeSession(state.totalTokens, [1, 2, 3, 4]);
  session3.id = 'sess-3';
  const recoveredPruner = { calls: 0, pruneSession() { this.calls += 1; } };
  const agent3 = {
    id: 'sess-3',
    session: session3,
    ctx: {
      get: (key) => (key === 'compaction' ? compaction : key === 'toolResultPruner' ? recoveredPruner : null),
    },
  };
  nextCalls = 0;
  await hook3({ agent: agent3, messages: [{ role: 'user' }], step: 1, signal: { aborted: false } }, next);
  findings.recoveredFromProjection = recoveredPruner.calls >= 1 && nextCalls === 1;
  findings.recoveryDidNotTouchMainSession = prunerCalls.length === pruningBefore;
}

/* 10) 默认路由解析不出来时，新会话用「本进程量到过的窗口」兜底。
       这正是「会话开始前没有档位」的第二种成因：宿主拿不到默认模型的窗口，
       而同一进程里别的会话早就量到过 —— 不能因为默认路由查不到就让新会话
       从 0 开始（0 = 面板一个档位都没有）。 */
{
  const captured = [];
  const registry = {
    register(definition) {
      captured.push(definition);
      return { dispose: async () => {}, stateOf: () => ({ requested: 0, budget: 0, window: 0 }), readerFor: () => () => ({}) };
    },
  };
  const ctx4 = makeCtx();
  /* 模拟「服务还没就绪 / 适配器给不出窗口」：两条路都没有。 */
  ctx4._services.delete('agentDefaultModel');
  ctx4._services.delete('llm');
  ctx4._services.set('sessionProjections', registry);
  mod.apply(ctx4, { enabled: true });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const definition = captured[0] ?? null;
  findings.fallbackProjectionRegistered = !!definition;
  findings.fallbackInitBeforeMeasure = definition ? definition.init().window : -1;
  if (definition) {
    /* 另一个会话量到了 768K：只折进投影内部状态，不改任何显式字段。 */
    definition.apply(definition.init(), { type: 'request/context', data: { contextWindow: 768000 } });
    findings.fallbackInitAfterMeasure = definition.init().window;
  }
}

console.log(JSON.stringify(findings, null, 2));

/* 关键不变量：任何一条不成立就 exit 1，避免「只打印、不把关」。 */
const assertions = {
  'hook is agent/pre-step': findings.hookName === 'agent/pre-step',
  'prepend is true': findings.prepend === true,
  'old agent/turn-stopping hook gone': findings.oldHookPresent === false,
  'context-budget command registered': findings.commands.includes('context-budget'),
  'context-budget-status command registered': findings.statusCommandPresent === true,
  'status returns success': findings.statusResultKind === 'success',
  'status budget is 0 before set': findings.statusBudget === 0,
  'status carries triggerRatio': findings.statusHasTriggerRatio === true,
  'status carries baseTokens': findings.statusHasBaseTokens === true,
  'status carries stepCap': findings.statusHasStepCap === true,
  'no budget -> no prune': findings.noBudget_pruneCalls === 0,
  'no budget -> no compact': findings.noBudget_compactCalls === 0,
  'no budget -> next called': findings.noBudget_nextCalled === true,
  'budget -> prune once': findings.budget_pruneCalls === 1,
  'budget -> no model summary needed': findings.budget_compactCalls === 0,
  'budget -> next called': findings.budget_nextCalled === true,
  'compaction failure -> one attempt': findings.fail_compactAttempts === 1,
  'compaction failure -> next called': findings.fail_nextCalled === true,
  'empty messages at FIRST step (1) still measured': findings.emptyMessagesAtFirstStep_measureCalls >= 1,
  'empty messages at FIRST step -> next called': findings.emptyMessagesAtFirstStep_nextCalled === true,
  'empty messages mid-turn still measured': findings.emptyMessagesMidTurn_measureCalls >= 1,
  'empty messages mid-turn -> next called': findings.emptyMessagesMidTurn_nextCalled === true,
  'null agent -> next called': findings.badAgent_nextCalled === true,
  'minIntervalMs:0 preserved (not clamped to 1000)': findings.minIntervalZeroPreserved === true,
  /* —— 会话投影：客户端的数据源 —— */
  'session projection registered': findings.projectionRegistered === true,
  'host/client PROJECTION_KEY match': !!findings.projectionKey && findings.projectionKey === findings.clientProjectionKey,
  'projection stateVersion is a positive integer': Number.isSafeInteger(findings.projectionStateVersion) && findings.projectionStateVersion > 0,
  'projection excluded from session-list summary': findings.projectionSummary === false,
  'projection folds budget from command/run args': findings.projectionBudgetRaw === 400000,
  'projection marks the budget as seeded': findings.projectionSeeded === true,
  'legacy command/run without args stays unseeded (client migrates once)': findings.legacyRunKeepsUnseeded === true,
  'projection folds window from request/context': findings.projectionWindow === 1000000,
  'projection aligns budget to a tier once the window is known': findings.projectionBudgetAligned === 393216,
  'projection returns the same state for unrelated events': findings.projectionStableRef === true,
  'projection clears the budget on args "0"': findings.projectionCleared === true,
  'projection view carries budget/window/config': findings.projectionViewFields === true,
  'projection viewSchema round-trips': findings.projectionViewSchema === true,
  'projection stateSchema round-trips': findings.projectionStateSchema === true,
  'budget command keeps its input in the log': findings.budgetCommandRecordInput !== false,
  'status carries window (pre-request panel)': findings.statusWindow === 1000000,
  'status advertises the projection key': findings.statusProjectionKey === findings.projectionKey,
  'budget recovered from projection after restart': findings.recoveredFromProjection === true,
  'projection registers even when the default window cannot be resolved': findings.fallbackProjectionRegistered === true,
  'init starts from 0 when nothing was ever measured': findings.fallbackInitBeforeMeasure === 0,
  'init falls back to the last measured window': findings.fallbackInitAfterMeasure === 768000,
};
const failed = Object.entries(assertions).filter(([, ok]) => !ok);
for (const [name, ok] of Object.entries(assertions)) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
if (failed.length > 0) process.exit(1);
console.log('\npre-step hook: all assertions passed');
