/**
 * 离线驱动 index.js：用假 ctx / 假 session / 假服务验证这次改造的关键行为。
 * 不碰真实宿主，只检查监听器注册点、next() 语义、剪枝顺序和失败退出。
 */
import { pathToFileURL } from 'node:url';

const INDEX = 'E:/plugins/dsh-long-context-budget/index.js';

const listeners = [];
const registeredCommands = [];
const effects = [];

/* ------------------------------------------------------------- 假 ctx */
function makeCtx() {
  const services = new Map();
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

/* 2) 命令仍注册 */
findings.commands = registeredCommands.map((c) => c.name);
findings.effects = effects.length;

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

/* 6) step 0 且空 messages：这一轮不会真正执行，完全不测量 */
state.totalTokens = 999999;
let measured = 0;
ctx._services.set('tokenMeter', {
  measure(s) {
    measured += 1;
    return { totalTokens: state.totalTokens, nodes: [] };
  },
});
nextCalls = 0;
await hook.listener({ agent, messages: [], step: 0, signal: { aborted: false } }, next);
findings.emptyMessagesAtStep0_measureCalls = measured;
findings.emptyMessagesAtStep0_nextCalled = nextCalls === 1;

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

console.log(JSON.stringify(findings, null, 2));
