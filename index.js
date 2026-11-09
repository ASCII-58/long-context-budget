/**
 * 上下文预算 · Host 半边。
 *
 * 职责（按用户确认的语义）：
 *   1. 记住每个会话当前的上下文预算（由输入框右侧面板设置，命令通道写入）；
 *   2. **每一步（step）开始前**，如果整包上下文超过 `triggerRatio × 预算`（默认
 *      0.7），先做零成本的 tool-result 剪枝，仍然超标才执行宿主自己的压缩事务
 *      （`compaction.compactRegion`），把最旧的一段历史压成摘要，目标降到
 *      `targetRatio × 预算`（默认 0.5）；压完继续，不打断会话；
 *   3. 未设置预算时本插件完全不介入。
 *
 * ## 为什么挂在 `agent/pre-step`
 *
 * `dsh-agent-loop` 的 `turn()` 循环里，每一步都先跑
 *   `dispatch.waterfall('agent/pre-step', ...)`
 * 然后才 `append('step/start')`，最后 `buildRequest()` 里才
 *   `session.deriveMessages()`
 * 因此在这里压缩，对**本次请求立即生效**；而 `agent/turn-stopping` 要等本轮
 * 最后一步跑完（`turn()` 里 `turnEnds && inbox.nextStep.length === 0` 之后），
 * 单 turn 内多次工具往返就来不及 —— 中间那几次请求可能已经超标，甚至一个大
 * 工具输出就能直接顶爆窗口。
 *
 * `pre-step` 发生在 `turn/start` 之后、`turn/end` 之前，`openTurn` 必然非空，
 * 满足 `compactRegion` 的前置条件。
 *
 * ## 为什么 prepend
 *
 * `compaction-basic` 也挂在 `agent/pre-step` 且不带 prepend。抢在它前面，
 * 先按会话预算压到目标值，它再测量时通常已低于其冻结阈值而直接返回 null，
 * 不会重复压缩。两者共用 durable 锁（compaction/start ↔ compaction/end），
 * `assertNoActiveCompaction` 保证不会并发。
 *
 * ## 作用域陷阱
 *
 * `compaction` 属于 **agent 预设的隔离分组**（`standard.patch.yml` 里的
 * `isolate: {compaction: true, toolResultPruner: true}`），根层级的
 * `ctx.get('compaction')` 看不见它 —— 必须走
 * `ctx.get('agentPresets').serviceFor(agent, 'compaction')`。
 * `tokenMeter` / `llm` 在 Host 平面，两处都要试。
 *
 * ## 预算的存储与会话投影
 *
 * 预算是**会话状态**，权威来源写进会话日志：`/context-budget` 命令保留了
 * 原始输入（`recordInput` 默认值），所以日志里有一条 `command/run{name,
 * args}`。插件把这条事件折进自己注册的 **会话投影** `contextBudget`：
 *
 *   - `budget`   生效预算（已按当前窗口对齐到档位；0 = 不限制）
 *   - `window`   路由上下文窗口（`request/context` 事件，或激活时解析的默认路由）
 *   - 其余字段（`triggerRatio` / `targetRatio` / `baseTokens` / `stepCap`）
 *     是 Host 配置，随视图一起下发
 *
 * 这样：
 *   1. 客户端读 `useProjection('contextBudget')` 就能拿到预算 / 窗口 / 配置，
 *      **不再需要跑 `/context-budget-status`** —— 命令会往聊天记录里写
 *      `command/run` + `command/done` 两行，之前每次挂载都刷一行正是
 *      用户看到的「重复日志」来源之一；
 *   2. Host 重启后预算从日志里折回来，客户端不必再把 localStorage 的值推一遍；
 *   3. 窗口在**第一次请求之前**就有值（激活时用 `agentDefaultModel` +
 *      `llm.resolveModelInfo` 解析默认路由，带服务就绪重试；解析不出来时
 *      退到本进程里量到过的窗口），面板不再显示「尚未测量上下文窗口」。
 *
 * 投影的 `stateSchema` / `viewSchema` 是**鸭子类型**：注册表只调用 `.parse()`，
 * 所以不需要额外依赖（zod / schemastery 都不是必需的）。
 *
 * 进程内的 `Map<sessionId, tokens>` 仍保留：投影服务缺席时（极端裁剪的宿主）
 * 它是唯一来源，而且 `agent/disposed` 清理也以它为准。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { BASE_TOKENS, STEP_CAP, computeTiers } from './tiers.js';

/** 根层级需要命令注册与会话服务。 */
export const inject = ['commands', 'sessions'];

export { BASE_TOKENS };

/**
 * 命令名是 Host/Client 的固定契约：Client 是单文件模块、拿不到配置，也无法
 * 在运行时发现命令名，因此**不**把它做成可配置项。改这里就必须同步改
 * client.js 的 `COMMAND_NAME` / `STATUS_COMMAND` / `PROJECTION_KEY`（自测会拦住漂移）。
 */
const COMMAND_NAME = 'context-budget';
const STATUS_COMMAND = `${COMMAND_NAME}-status`;
/**
 * 会话投影 key：Host 把「预算 + 窗口 + 配置」发布成客户端可读的投影。
 * `stateVersion` 只在状态字段或折叠语义变化时递增（改字段名要一起改
 * client.js，两边靠 `scripts/test-budget-slider.mjs` 的契约检查对齐）。
 */
const PROJECTION_KEY = 'contextBudget';
const PLUGIN_NAME = 'long-context-budget';

/* ------------------------------------------------------------------ 记录 */

/**
 * 跨会话的「按模型记住的预算」文件。
 *
 * 会话投影只能描述**一条**会话，而「这个模型上次设了多少」是跨会话的事实，
 * 只能由 Host 自己维护。放在 DSH 数据目录下（`$DSH_HOME` 或 `~/.dsh`），
 * 与会话日志分开，损坏也不影响会话本身。
 */
const MODEL_BUDGET_FILE =
  process.env.DSH_LCB_MODELS_FILE && process.env.DSH_LCB_MODELS_FILE.length > 0
    ? process.env.DSH_LCB_MODELS_FILE
    : join(
        process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh'),
        'long-context-budget-models.json',
      );
/** 只保留最近这么多个模型，避免文件随模型列表无限增长。 */
const MODEL_BUDGET_LIMIT = 64;
/** 落盘节流：连续设预算不会每次都写盘。 */
const MODEL_BUDGET_FLUSH_MS = 1500;

/**
 * `provider/model` → `{ budget, window, at }`：这个模型上次设的预算。
 *
 * 只记「设过多少」，不记用量统计；`budget = 0` 表示用户明确取消过，
 * 直接把该模型从表里删掉，下次不会再自动套用。
 */
const budgetByModel = new Map();
/** 每个会话最近一次判定的快照，供 `/context-budget-status` 诊断。 */
const lastDecisionBySession = new Map();
let modelBudgetFlushTimer = null;

/** 模型键：provider 缺失记成 `?`；模型名缺失返回 null（不记）。 */
function modelKeyOf(provider, model) {
  const name = typeof model === 'string' ? model.trim() : '';
  if (name.length === 0) return null;
  const vendor = typeof provider === 'string' && provider.trim().length > 0 ? provider.trim() : '?';
  return `${vendor}/${name}`;
}

/** 从磁盘恢复按模型预算；文件不存在/损坏都当作空记录，绝不抛错。 */
function loadModelBudgets() {
  try {
    const parsed = JSON.parse(readFileSync(MODEL_BUDGET_FILE, 'utf8'));
    const models = parsed && typeof parsed === 'object' ? parsed.models : null;
    if (!models || typeof models !== 'object') return;
    for (const [key, value] of Object.entries(models)) {
      if (typeof key !== 'string' || !value || typeof value !== 'object') continue;
      const number = (raw) => {
        const parsedNumber = Math.floor(Number(raw));
        return Number.isFinite(parsedNumber) && parsedNumber > 0 ? parsedNumber : 0;
      };
      const budget = number(value.budget);
      if (budget <= 0) continue;
      budgetByModel.set(key, { budget, window: number(value.window), at: number(value.at) });
    }
  } catch {
    /* 首次运行、文件被删、JSON 坏掉：都从空记录开始。 */
  }
}

/** 把按模型预算同步写盘（调用方负责节流）。 */
function flushModelBudgets() {
  modelBudgetFlushTimer = null;
  try {
    const models = {};
    for (const [key, value] of budgetByModel) models[key] = value;
    mkdirSync(dirname(MODEL_BUDGET_FILE), { recursive: true });
    writeFileSync(MODEL_BUDGET_FILE, `${JSON.stringify({ version: 1, models })}\n`, 'utf8');
  } catch {
    /* 只读目录、磁盘满：记录功能失效不影响压缩。 */
  }
}

/** 安排一次节流写盘。 */
function scheduleModelBudgetFlush() {
  if (modelBudgetFlushTimer !== null) return;
  modelBudgetFlushTimer = setTimeout(flushModelBudgets, MODEL_BUDGET_FLUSH_MS);
  /* 定时器不能把宿主进程钉住。 */
  modelBudgetFlushTimer.unref?.();
}

/**
 * 记住一个模型设过的预算。
 *
 * @param {string} provider 路由 provider。
 * @param {string} model 路由 model。
 * @param {number} budget 对齐后的预算；0 = 取消该模型的记忆。
 * @param {number} window 当时的窗口（0 = 未知）。
 */
function recordModelBudget(provider, model, budget, window) {
  const key = modelKeyOf(provider, model);
  if (key === null) return;
  const value = Math.max(0, Math.floor(Number(budget)) || 0);
  if (value <= 0) {
    if (budgetByModel.delete(key)) scheduleModelBudgetFlush();
    return;
  }
  budgetByModel.set(key, {
    budget: value,
    window: Math.max(0, Math.floor(Number(window)) || 0),
    at: Date.now(),
  });
  if (budgetByModel.size > MODEL_BUDGET_LIMIT) {
    const oldest = [...budgetByModel.entries()].sort((left, right) => left[1].at - right[1].at)[0];
    if (oldest) budgetByModel.delete(oldest[0]);
  }
  scheduleModelBudgetFlush();
}

/** 这个模型上次设的预算；没有记过就是 0。 */
function rememberedBudgetFor(provider, model) {
  const key = modelKeyOf(provider, model);
  if (key === null) return 0;
  return budgetByModel.get(key)?.budget ?? 0;
}

const DEFAULTS = Object.freeze({
  /** 分级起点：窗口不超过它就不分级。 */
  baseTokens: BASE_TOKENS,
  /** 单层最大跨度。 */
  stepCap: STEP_CAP,
  /** 触发压缩的阈值比例：`triggerRatio × 预算`。 */
  triggerRatio: 0.7,
  /** 压缩目标比例：压到 `targetRatio × 预算` 以下才算收工。 */
  targetRatio: 0.5,
  /** 单轮最多压几次；超过就放弃并记日志，绝不卡住会话。 */
  maxAttempts: 3,
  /** 两次压缩之间的最小间隔，防止死循环（允许 0 = 不设间隔）。 */
  minIntervalMs: 1000,
  /** 总开关。 */
  enabled: true,
});

/**
 * 暴露给 Loader 的 Config 模式。
 *
 * 没有它是「Config status = absent」：Loader 只知道这个 entry 存在，
 * 设置页拿不到任何可调项，`cordis_inspect_query` 也读不到 schema。
 * 这里只声明真正会被 `resolveConfig()` 读取的字段，默认值与 `DEFAULTS`
 * 保持一致；越界值仍由 `resolveConfig()` 夹紧，schema 只负责投影与默认值。
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULTS.enabled).description('总开关；关掉后完全不介入会话 / Master switch; off = never intervene in a session'),
  triggerRatio: Schema.number()
    .min(0.05)
    .max(0.95)
    .default(DEFAULTS.triggerRatio)
    .description('触发压缩的阈值比例（相对会话预算） / Trigger ratio relative to the session budget'),
  targetRatio: Schema.number()
    .min(0.05)
    .max(0.9)
    .default(DEFAULTS.targetRatio)
    .description('压缩目标比例（相对会话预算），实际保留量另有 64K 下限 / Target ratio relative to the session budget (kept tail has a 64K floor)'),
  maxAttempts: Schema.number()
    .min(1)
    .max(8)
    .step(1)
    .default(DEFAULTS.maxAttempts)
    .description('单次检查最多连续压缩几次 / Max compaction attempts per check'),
  minIntervalMs: Schema.number()
    .min(0)
    .max(60000)
    .step(100)
    .default(DEFAULTS.minIntervalMs)
    .description('两次压缩之间的最小间隔（毫秒），防止死循环 / Min interval between compactions (ms), guards against loops'),
  baseTokens: Schema.number()
    .min(1024)
    .default(DEFAULTS.baseTokens)
    .description('分级起点：上下文窗口不超过它就不分级 / Tier base: windows at or below this get no tiers'),
  stepCap: Schema.number()
    .min(1024)
    .default(DEFAULTS.stepCap)
    .description('层级单段最大跨度 / Max span of a single tier step'),
});

/** 合并用户配置并夹紧到安全范围。 */
function resolveConfig(config) {
  const source = config && typeof config === 'object' ? config : {};
  const positive = (value, fallback) => {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
  };
  const ratio = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number < 1 ? number : fallback;
  };
  /* minIntervalMs 允许 0（=不设间隔）：先夹紧到 [0, 60000]，再取整。
     旧实现用 positive() 会把合法的 0 误判成缺省 1000ms（P2-8）。 */
  const rawInterval = Number(source.minIntervalMs);
  const minIntervalMs = Number.isFinite(rawInterval)
    ? Math.min(60000, Math.max(0, Math.floor(rawInterval)))
    : DEFAULTS.minIntervalMs;
  return {
    baseTokens: positive(source.baseTokens, DEFAULTS.baseTokens),
    stepCap: positive(source.stepCap, DEFAULTS.stepCap),
    triggerRatio: ratio(source.triggerRatio, DEFAULTS.triggerRatio),
    targetRatio: ratio(source.targetRatio, DEFAULTS.targetRatio),
    maxAttempts: Math.min(8, positive(source.maxAttempts, DEFAULTS.maxAttempts)),
    minIntervalMs,
    enabled: source.enabled === false ? false : DEFAULTS.enabled,
  };
}

/**
 * 在给定毫秒数后继续（用于服务就绪的退避轮询）。
 *
 * @param {number} ms 等待毫秒。
 * @returns {Promise<void>} 到点后兑现。
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));
}

/**
 * 预算向下对齐到「不大于请求值的最大档」。
 *
 * 为什么要向下而不是就近：预算是**上限**。用户写 350K 时，就近会选到 384K，
 * 等于悄悄放宽了限制；向下取 256K/320K 才符合「我要 350K 以内」的语义。
 * 低于第一档时取第一档（仍然比整窗严格），高于整窗时取整窗。
 *
 * @param {number[]} tiers 升序层级。
 * @param {number} tokens 期望预算。
 * @returns {number} 对齐后的层级值；层级为空时返回 0。
 */
function tierAtMost(tiers, tokens) {
  if (!Array.isArray(tiers) || tiers.length === 0) return 0;
  const target = Number(tokens);
  if (!Number.isFinite(target) || target <= 0) return 0;
  let best = 0;
  for (let index = 0; index < tiers.length; index += 1) {
    if (tiers[index] <= target) best = tiers[index];
    else break;
  }
  /* 比第一档还小：仍取第一档，它已经比整窗更严格。 */
  return best > 0 ? best : tiers[0];
}

/**
 * 按配置重算层级。直接复用 `tiers.js` 的参数化实现，Host / Client 用同一套
 * 公式 —— 之前这里手抄了一份，改 baseTokens/stepCap 时极易与 Client 分叉。
 */
function tiersFor(windowTokens, settings) {
  return computeTiers(windowTokens, settings.baseTokens, settings.stepCap);
}

/* ------------------------------------------------------------- 工具配对 */

/**
 * 一条事件里「未回复的工具调用」净增减。
 *
 * 与宿主 `@deepseek-ai/dsh-compaction` 的 `eventDelta` 同义：
 * `assistant/message` 里每个 `tool-call` 块 +1，`tool/result` −1。
 */
function pairingDelta(event) {
  if (!event) return 0;
  if (event.type === 'assistant/message') {
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) return 0;
    return content.filter((block) => block?.type === 'tool-call').length;
  }
  if (event.type === 'tool/result') return -1;
  return 0;
}

/**
 * 一次性算出整条 surface 的「工具配对前缀平衡表」。
 *
 * 宿主 `@deepseek-ai/dsh-compaction` 把这份平衡缓存在 WeakMap 里；我们是外挂
 * 插件，只在压缩触发时才用一次，所以直接一次 O(n) 算完，避免在挑选切点时
 * 反复重扫造成的 O(n²)。
 *
 * @returns {{prefix:number[], clean:boolean[]}|null}
 *   `prefix[i]` = 前 i 个事件之后仍未回复的工具调用数；
 *   `clean[i]`  = 前 i 个事件的过程中从未出现过「结果多于调用」的坏状态。
 *   两者都能正常算出时返回 null 以外的东西；surface 与事件日志对不上则返回 null。
 */
function balanceTable(session, seqs) {
  const prefix = new Array(seqs.length + 1);
  const clean = new Array(seqs.length + 1);
  prefix[0] = 0;
  clean[0] = true;
  for (let index = 0; index < seqs.length; index += 1) {
    const event = session.eventAt(seqs[index]);
    if (!event) return null;
    const open = prefix[index] + pairingDelta(event);
    prefix[index + 1] = open;
    clean[index + 1] = clean[index] && open >= 0;
  }
  return { prefix, clean };
}

/**
 * 选出「把最早的一段压掉、尾部保留 retainTokens」的区间。
 *
 * 与宿主 `compaction-basic` 的 `selectCompactableRange` 同构：
 *   - 从尾部往回累加 token 直到攒够 retainTokens，得到保留尾部的起点；
 *   - 若 surface 首节点是 `system/message`，永远不压它（起点后移一位）；
 *   - 向前找第一个「之前切口平衡」的位置作为压缩区间末尾，再校验「之后切口」。
 *
 * @returns {{start:number,end:number}|null} 可压缩的闭区间。
 */
function selectRange(session, priced, retainTokens) {
  const nodes = session.surface.nodes;
  if (nodes.length === 0) return null;
  if (priced.length !== nodes.length) return null;
  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index] !== priced[index]?.seq) return null;
  }
  const head = session.eventAt(nodes[0]);
  const firstIdx = head && head.type === 'system/message' ? 1 : 0;
  if (nodes.length <= firstIdx) return null;

  const table = balanceTable(session, nodes);
  if (table === null) return null;
  /* `nodes[seq]` 之前的切口是否平衡，就是 `prefix[seq] === 0`。 */
  const balancedBefore = (index) => table.clean[index] && table.prefix[index] === 0;
  /* `nodes[seq]` 之后的切口。 */
  const balancedAfter = (index) => table.clean[index + 1] && table.prefix[index + 1] === 0;

  let accumulated = 0;
  let keepFrom = nodes.length;
  for (let index = priced.length - 1; index >= 0; index -= 1) {
    accumulated += priced[index].tokens;
    keepFrom = index;
    if (accumulated >= retainTokens) break;
  }
  if (keepFrom <= firstIdx) return null;
  while (keepFrom > firstIdx && !balancedBefore(keepFrom)) keepFrom -= 1;
  if (keepFrom <= firstIdx) return null;
  const start = nodes[firstIdx];
  const endIndex = keepFrom - 1;
  if (!balancedAfter(endIndex)) return null;
  return { start, end: nodes[endIndex] };
}

/* ------------------------------------------------------------------ apply */

export function apply(ctx, rawConfig) {
  const settings = resolveConfig(rawConfig);
  const log = (level, message) => {
    try {
      const logger = ctx.logger?.[level];
      if (typeof logger === 'function') logger.call(ctx.logger, `[${PLUGIN_NAME}] ${message}`);
    } catch {
      /* 日志永远不能让功能失败。 */
    }
  };

  /** sessionId -> 选中预算（token 数）。缺失 = 不额外限制。 */
  const budgetBySession = new Map();
  /** sessionId -> 上一次压缩的时间戳，防死循环。 */
  const lastCompactAt = new Map();

  /* 跨会话的按模型记录：进程启动时读回来，卸载时落盘。 */
  loadModelBudgets();
  ctx.effect(() => () => {
    if (modelBudgetFlushTimer !== null) {
      clearTimeout(modelBudgetFlushTimer);
      modelBudgetFlushTimer = null;
    }
    flushModelBudgets();
  }, `[${PLUGIN_NAME}] usage persistence`);

  const presetsOf = () => {
    try {
      return ctx.get('agentPresets') ?? null;
    } catch {
      return null;
    }
  };

  /**
   * 取一个 agent 真正在用的服务。
   *
   * `compaction` 与 `toolResultPruner` 都属于 agent 预设的**隔离分组**
   * （`standard.patch.yml` 的 `isolate: {compaction: true, toolResultPruner: true}`），
   * 必须用 `agent.ctx`（隔离组内经 scope 解析）或
   * `ctx.agentPresets.serviceFor(...)` 拿 preset 里的那一份。
   *
   * 为什么**故意不**回落根层级 `ctx.get('compaction')`：根平面上的
   * compaction 是**另一个实例**（Web 下通常直接 disabled，CLI 下存在），
   * 用它压缩会绕过 preset 的 tokenMeter 策略，且与自动压缩不共用锁。
   * 拿不到就干脆不做 —— 宁可不动，也不能压错。
   *
   * `toolResultPruner` 可能根本没注册（preset 里若关掉就不存在），
   * 必须容忍 `null`，不能当硬依赖。
   *
   * `tokenMeter` / `llm` 在 Host 平面（Web 的 `cordis.patch.yml` 明确保留），
   * `agent.ctx.get()` 与根 `ctx.get()` 都能读到，两条都试。
   */
  const scoped = (agent) => {
    const scope = agent?.ctx;
    const get = (key) => {
      try {
        if (scope) {
          const local = scope.get?.(key);
          if (local) return local;
        }
      } catch {
        /* 回落到根层级。 */
      }
      try {
        return ctx.get(key) ?? null;
      } catch {
        return null;
      }
    };

    let compaction = null;
    let pruner = null;
    if (agent) {
      /* preset 隔离服务优先，而且只认这一份。 */
      try {
        compaction = scope?.get?.('compaction') ?? null;
      } catch {
        compaction = null;
      }
      try {
        pruner = scope?.get?.('toolResultPruner') ?? null;
      } catch {
        pruner = null;
      }
      if (!compaction || !pruner) {
        const presets = presetsOf();
        if (presets) {
          if (!compaction) {
            try {
              compaction = presets.serviceFor(agent, 'compaction') ?? null;
            } catch {
              compaction = null;
            }
          }
          if (!pruner) {
            try {
              pruner = presets.serviceFor(agent, 'toolResultPruner') ?? null;
            } catch {
              pruner = null;
            }
          }
        }
      }
      /* 兜底：preset 没开 compaction 时，某些组合下 agent 作用域仍能解析到
         隔离组内的实例；这两条都失败就不再尝试根平面。 */
    }

    return { compaction, meter: get('tokenMeter'), llm: get('llm'), pruner };
  };

  /**
   * 解析这个会话当前路由的上下文窗口。
   *
   *   1. `session.requestContext()` —— 已经发过请求时日志里记着窗口；
   *   2. `llm.resolveModelInfo(provider, model)` —— 还没发过请求时问适配器；
   *   3. 都没有就返回 0。
   */
  const windowOf = async (agent, signal) => {
    const session = agent?.session;
    if (!session) return 0;
    const routed = session.requestContext?.();
    if (routed?.contextWindow) return routed.contextWindow;

    const { llm } = scoped(agent);
    const provider = routed?.provider ?? agent?.options?.provider;
    const model = routed?.model ?? agent?.options?.model;
    if (!llm || !provider || !model) return 0;
    try {
      const info = await llm.resolveModelInfo(provider, model, signal);
      return info?.context?.contextWindow ?? 0;
    } catch {
      return 0;
    }
  };

  /* ------------------------------------- 会话投影：预算 / 窗口 / 配置 */
  /*
   * 客户端**只读投影**，不跑命令：命令会把 `command/run` + `command/done`
   * 写进会话日志，聊天记录里各占一行 —— 之前每次挂载都对账一次，就是用户
   * 截图里那串重复日志。投影是日志派生的：预算从 `command/run.args` 折出来，
   * 窗口从 `request/context` 折出来，Host 重启后照样重建。
   */

  /** 默认路由的上下文窗口；激活时异步解析一次，投影 `init` 用它兜底。 */
  let defaultWindow = 0;
  /**
   * 本进程里见过的最大窗口（任何会话的 `request/context` / 现场解析）。
   *
   * 默认路由解析不出来（模型不支持元数据查询、或服务尚未就绪）时，新会话的
   * 投影 `init` 至少能拿到一个真实量过的值，而不是 0 —— 0 会让面板没有档位，
   * 也就是「会话开始前不能设预算」。同一次运行里窗口基本不会变，用它兜底
   * 比猜一个常数可靠；真窗口到达后 `request/context` 仍会覆盖它。
   */
  let lastSeenWindow = 0;
  /** 默认路由的身份：新会话在首次请求前就能按模型取回「上次设的预算」。 */
  let defaultProvider = '';
  let defaultModel = '';
  /** 已注册的投影句柄。未就绪时 `budgetOf()` 退回进程内 Map。 */
  let projectionHandle = null;

  /** 非负整数守卫：任何进入状态/视图的数字都先过这一关。 */
  const tokenFloor = (value) => {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : 0;
  };

  /**
   * 把请求值对齐到「不大于它的最大档」。
   *
   * 预算语义是上限：用户点的是档位（本身就是档位值，对齐是恒等），手打
   * 350K 时向下取到 320K，而不是就近放宽到 384K。窗口未知（0）时按原值记。
   */
  const alignBudget = (tokens, window) => {
    const target = tokenFloor(tokens);
    if (target <= 0) return 0;
    const tiers = tiersFor(window, settings);
    return tiers.length > 0 ? tierAtMost(tiers, target) : target;
  };

  /**
   * 折一条会话事件进投影状态。
   *
   * 必须**同步**且对无关事件返回同一个引用（注册表用 `Object.is` 跳过下游
   * 工作）。两种事件会改状态：
   *   - `command/run`（本命令）：`args` 是用户请求的 token 数 → 对齐成 `budget`；
   *   - `request/context`：路由窗口 → `window`，并把已有请求值按新窗口重算，
   *     否则「窗口先未知、后测到」时 UI 显示和实际执行会分叉。
   */
  const foldProjection = (state, event) => {
    if (!event || typeof event !== 'object') return state;
    const safe =
      state && typeof state === 'object'
        ? state
        : { requested: 0, budget: 0, window: 0, seeded: false, provider: '', model: '' };
    if (event.type === 'command/run' && event.data?.name === COMMAND_NAME) {
      /* v0.2.7 及更早的命令设了 `recordInput: false`，日志里没有 `args`：
         这类事件不能当成「预算 = 0」，否则用户升级后预算会凭空消失。
         留 `seeded: false`，让客户端把 localStorage 里的旧值补推一次。 */
      if (event.data.args === undefined) return state;
      const requested = tokenFloor(event.data.args);
      const window = safe.window > 0 ? safe.window : defaultWindow;
      const budget = requested > 0 ? alignBudget(requested, window) : 0;
      if (requested === safe.requested && budget === safe.budget && safe.seeded === true) return state;
      return { ...safe, requested, budget, seeded: true };
    }
    if (event.type === 'request/context') {
      const nextWindow = tokenFloor(event.data?.contextWindow);
      const nextProvider =
        typeof event.data?.provider === 'string' ? event.data.provider : typeof safe.provider === 'string' ? safe.provider : '';
      const nextModel =
        typeof event.data?.model === 'string' ? event.data.model : typeof safe.model === 'string' ? safe.model : '';
      const modelChanged = nextProvider !== (safe.provider ?? '') || nextModel !== (safe.model ?? '');
      if (nextWindow <= 0) {
        /* 窗口没给但路由给了：模型身份也要折进来，按模型记忆的预算才能生效。 */
        return modelChanged ? { ...safe, provider: nextProvider, model: nextModel } : state;
      }
      /* 任何会话量到的窗口都给后续新会话当兜底（同一进程里窗口几乎不变）。 */
      if (nextWindow > lastSeenWindow) lastSeenWindow = nextWindow;
      if (nextWindow === safe.window && !modelChanged) return state;
      const budget = safe.requested > 0 ? alignBudget(safe.requested, nextWindow) : 0;
      return { ...safe, window: nextWindow, budget, provider: nextProvider, model: nextModel };
    }
    return state;
  };

  /** 投影状态 → 客户端视图。配置是 Host 启动常量，放在视图里随投影下发。 */
  const projectionView = (state) => ({
    budget: tokenFloor(state?.budget),
    window: tokenFloor(state?.window),
    /* 预算是否来自日志里的本命令；false 时客户端做一次性迁移（推回旧值）。 */
    seeded: state?.seeded === true,
    /* 路由身份：客户端用它去取「这个模型上次设的预算」。 */
    provider: typeof state?.provider === 'string' ? state.provider : '',
    model: typeof state?.model === 'string' ? state.model : '',
    /* 跨会话记忆：该模型上次设过的预算（0 = 没记过 / 已取消）。 */
    modelBudget: rememberedBudgetFor(state?.provider, state?.model),
    triggerRatio: settings.triggerRatio,
    targetRatio: settings.targetRatio,
    baseTokens: settings.baseTokens,
    stepCap: settings.stepCap,
  });

  /*
   * 注册表只调用 `.parse()`（见 `@deepseek-ai/dsh-session-projection`），
   * 所以这里不需要 zod / schemastery；两个 schema 负责把持久化行或视图
   * 夹紧到安全范围，绝不抛错。
   */
  const projectionStateSchema = {
    parse(value) {
      const source = value && typeof value === 'object' ? value : {};
      return {
        requested: tokenFloor(source.requested),
        budget: tokenFloor(source.budget),
        window: tokenFloor(source.window),
        seeded: source.seeded === true,
        provider: typeof source.provider === 'string' ? source.provider : '',
        model: typeof source.model === 'string' ? source.model : '',
      };
    },
  };

  const projectionViewSchema = {
    parse(value) {
      const source = value && typeof value === 'object' ? value : {};
      return {
        budget: tokenFloor(source.budget),
        window: tokenFloor(source.window),
        seeded: source.seeded === true,
        provider: typeof source.provider === 'string' ? source.provider : '',
        model: typeof source.model === 'string' ? source.model : '',
        modelBudget: tokenFloor(source.modelBudget),
        triggerRatio: settings.triggerRatio,
        targetRatio: settings.targetRatio,
        baseTokens: settings.baseTokens,
        stepCap: settings.stepCap,
      };
    },
  };

  /**
   * 解析默认路由的上下文窗口（激活时一次，带服务就绪重试）。
   *
   * 客户端拿不到「首次请求前」的窗口：`contextPressure` 投影要等
   * `request/context` 事件才出现，`remote.session.modelCatalog()` 又刻意
   * 不带 `contextWindow`。所以由 Host 用 `agentDefaultModel` + `llm`
   * 预先解析，放进投影 —— 面板在会话刚开始时就有档位可选。
   *
   * **为什么必须重试**：插件 apply 可能早于 `agentDefaultModel` / `llm`
   * 注册（加载顺序取决于宿主组合）。v0.2.8 以前这里只问一次，服务还没
   * 就绪就直接返回 0，而且进程内再也不会重算 —— 于是整个进程生命周期里
   * 新会话都没有默认窗口，面板永远显示「尚未测量上下文窗口」。现在按
   * 250ms 退避等最多 ~2s；服务齐了但适配器给不出元数据时立刻退出（那是
   * 模型本身没有窗口信息，等下去也没用）。
   */
  const ensureDefaultWindow = async () => {
    if (defaultWindow > 0) return defaultWindow;
    if (lastSeenWindow > 0) defaultWindow = lastSeenWindow;
    const resolveOnce = async () => {
      let selection = null;
      let llm = null;
      try {
        selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null;
      } catch {
        selection = null;
      }
      try {
        llm = ctx.get('llm') ?? null;
      } catch {
        llm = null;
      }
      const provider = selection?.provider;
      const model = selection?.model;
      if (!llm || typeof llm.resolveModelInfo !== 'function' || !provider || !model) return null;
      /* 路由身份先记下来：即便窗口解析失败，新会话也能按模型取回预算。 */
      defaultProvider = String(provider);
      defaultModel = String(model);
      try {
        const info = await llm.resolveModelInfo(provider, model);
        return tokenFloor(info?.context?.contextWindow);
      } catch (error) {
        log('info', `default context window unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      /* 服务在、模型却解析不出窗口：换默认路由也没用，交给 request/context。 */
      return 0;
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (attempt > 0) await delay(250);
      const window = await resolveOnce();
      if (window === null) continue; /* 服务还没就绪，继续等 */
      if (window > 0) {
        defaultWindow = window;
        if (window > lastSeenWindow) lastSeenWindow = window;
        log('info', `default context window resolved: ${window}`);
        return window;
      }
      return defaultWindow;
    }
    log('info', 'default context window: agentDefaultModel/llm still unavailable after retries');
    return defaultWindow;
  };

  /**
   * 这个会话当前生效的预算。
   *
   * 投影是权威（日志派生，跨重启）；没有投影服务时才退回进程内 Map。
   * 已经在本次进程里设过、但投影还没折到的事件不用担心：`command/run` 在
   * handler 之前就写进日志了，投影在同一次提交里已经更新。
   */
  const budgetOf = (session) => {
    if (!session) return 0;
    if (projectionHandle) {
      try {
        const state = projectionHandle.stateOf(session);
        if (state && typeof state === 'object') return tokenFloor(state.budget);
      } catch {
        /* 投影读失败就退回 Map，绝不让预算检查炸掉。 */
      }
    }
    return tokenFloor(budgetBySession.get(session.id));
  };

  /* -------------------------------------- 核心：每一步开始前检查并压缩 */
  /**
   * 在 step 边界检查并压缩。
   *
   * 阈值 `triggerRatio × 预算`，先剪枝再摘要，目标 `targetRatio × 预算`；
   * 最多压 `maxAttempts` 次。任何异常都只记日志 —— 压缩是优化，
   * 绝不能拦住这一轮或下一轮。
   */
  const enforce = async (agent, signal) => {
    if (!settings.enabled) return;
    if (signal?.aborted) return;
    const session = agent?.session;
    if (!session) return;

    const budget = budgetOf(session);
    if (!(budget > 0)) return;

    const { meter, compaction, pruner } = scoped(agent);
    if (!meter || !compaction) {
      log('warn', 'tokenMeter or compaction service unavailable; skipping budget enforcement');
      return;
    }

    const triggerAt = Math.floor(budget * settings.triggerRatio);
    /*
     * 保留尾部的下限：`0.5 × 预算`，但绝不低于 64K。
     *
     * 没有下限时（预算被设得很小，或窗口未知时按原值记），`retainTokens`
     * 会趋近 0，`selectRange` 就只肯压掉最后 1–2 个节点，压了等于没压。
     * 64K 是宿主 `compaction-basic` 默认 headroom 的数量级，足够保住最近
     * 几轮的上下文连贯性，又不会让压缩空转。
     */
    const MIN_RETAIN_TOKENS = 64 * 1024;
    const targetAt = Math.max(MIN_RETAIN_TOKENS, Math.floor(budget * settings.targetRatio));

    let routed = null;
    try {
      routed = session.requestContext?.() ?? null;
    } catch {
      routed = null;
    }
    const provider = routed?.provider ?? agent?.options?.provider ?? '';
    const model = routed?.model ?? agent?.options?.model ?? '';
    const window = tokenFloor(routed?.contextWindow) || tokenFloor(lastSeenWindow);

    let measurement;
    try {
      measurement = meter.measure(session);
    } catch (error) {
      log('warn', `measure failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    /*
     * **真实口径**：`contextPressure.pressureTokens` 是 provider 上报的提示词
     * 大小（input + cache），和界面圆环、模型窗口同一个数。`measure()` 走的是
     * 宿主的 `chars / 4` 启发式，中文叙述会被低估三到四成 —— 只看它就会
     * 出现「界面 192K、插件认为 167K、永远不触发」的分叉。
     *
     * 因此取两者较大值：任一口径越线都算越线。`pressure` 是上一次请求的快照，
     * 本次剪枝/压缩缩掉的 surface 量 `removedSurface` 要从它里面扣掉，否则
     * 压完仍拿旧的大数判定，会在同一个 step 里反复压。
     */
    const pressureOf = () => {
      try {
        return tokenFloor(meter.contextPressure?.(session)?.pressureTokens);
      } catch {
        return 0;
      }
    };
    let pressure = pressureOf();
    let removedSurface = 0;
    const effective = () => Math.max(measurement.totalTokens, Math.max(0, pressure - removedSurface));
    const note = (action, extra = {}) => {
      lastDecisionBySession.set(session.id, {
        action,
        at: Date.now(),
        measured: measurement.totalTokens,
        pressure,
        total: effective(),
        triggerAt,
        targetAt,
        budget,
        window,
        model: `${provider}/${model}`,
        ...extra,
      });
    };

    if (!(effective() >= triggerAt)) {
      note('idle');
      return;
    }

    /*
     * 仿宿主 compactIfNeeded 的顺序：先做零成本的 tool-result 剪枝，
     * 剪完够低就不再花钱调模型摘要。
     */
    if (pruner) {
      try {
        const surfaceBefore = tokenFloor(measurement.surfaceTokens);
        pruner.pruneSession(session);
        measurement = meter.measure(session);
        removedSurface += Math.max(0, surfaceBefore - tokenFloor(measurement.surfaceTokens));
      } catch (error) {
        log('warn', `prune failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!(effective() >= triggerAt)) {
        note('pruned');
        log(
          'info',
          `pruned down to ${effective()} tokens (measure ${measurement.totalTokens}, provider ${pressure}); no summarization needed`,
        );
        return;
      }
    }

    const now = Date.now();
    if (now - (lastCompactAt.get(session.id) ?? 0) < settings.minIntervalMs) {
      note('throttled');
      return;
    }

    log(
      'info',
      `step boundary at ${effective()} tokens (measure ${measurement.totalTokens}, provider ${pressure}) >= ${settings.triggerRatio * 100}% of budget ${budget} (${triggerAt}); compacting toward ${targetAt}`,
    );

    for (let attempt = 0; attempt < settings.maxAttempts; attempt += 1) {
      if (signal?.aborted) return;
      /* 目标值本身就是「压缩后要保留的尾部预算」：被压掉的部分整段消失，
         剩下的总量就该落在 targetAt 附近。 */
      const range = selectRange(session, measurement.nodes, targetAt);
      if (range === null) {
        note('no-range');
        log('info', 'no compactable range (tool-pairing cannot be satisfied); stopping');
        return;
      }
      try {
        const result = await compaction.compactRegion(range.start, range.end, agent, signal);
        lastCompactAt.set(session.id, Date.now());
        log(
          'info',
          `compacted ${result?.shadowedSeqs?.length ?? '?'} nodes (~${result?.shadowedTokenCount ?? '?'} tokens)`,
        );
      } catch (error) {
        /*
         * 失败可能留下未闭合的 `compaction/start`，重试会被
         * `assertCompactionInactive` 一路拒绝，形成静默失效。立即放弃，交给宿主。
         */
        lastCompactAt.set(session.id, Date.now());
        note('failed', { error: error instanceof Error ? error.message : String(error) });
        log('warn', `compaction failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      try {
        const surfaceBefore = tokenFloor(measurement.surfaceTokens);
        measurement = meter.measure(session);
        removedSurface += Math.max(0, surfaceBefore - tokenFloor(measurement.surfaceTokens));
      } catch (error) {
        log('warn', `re-measure failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!(effective() >= triggerAt)) {
        note('compacted');
        log('info', `context now ${effective()} tokens, below trigger ${triggerAt}; resuming session`);
        return;
      }
      log('info', `still ${effective()} >= ${triggerAt}; compacting again`);
    }
    note('max-attempts');
    log('warn', `still above trigger after ${settings.maxAttempts} attempts; leaving it to the host`);
  };

  ctx.effect(() => {
    const dispose = ctx.on(
      'agent/pre-step',
      async ({ agent, signal }, next) => {
        /*
         * 与 compaction-basic 同点，但必须 prepend 抢在它前面：
         * 它用冻结的 config 算阈值，先跑可能把我们要压的区间压掉。
         * waterfall 语义：不调用 next() 等于否决整条链，因此下面无条件返回 next()。
         *
         * 每个 step 都检查一次，包括「本步认领输入为空」的中途 step（长回合
         * 多次工具往返时，正是这些 step 会把上下文涨过阈值）。宿主 `turn()`
         * 里首个 step 就是 `phase.step + 1 = 1`，从 0 开始、以 `step === 0`
         * 判断「本轮是否真的开始」是错的（那分支永远不成立），所以这里不做
         * 任何基于 step 编号的早退；`enforce()` 自己会在无预算 / 无会话 /
         * 服务不可用 / 未超阈值时快速返回，空消息的开销只是一次测量。
         */
        try {
          if (signal?.aborted) return next();
          await enforce(agent, signal);
        } catch (error) {
          log('warn', `budget enforcement crashed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return next();
      },
      { prepend: true },
    );
    return () => dispose();
  }, `[${PLUGIN_NAME}] step-boundary budget enforcement`);

  /* ------------------------------------------------- 投影注册（客户端只读） */
  /*
   * 注册**不等待**默认窗口解析：`init` 每次调用都读当时的 `defaultWindow` /
   * `lastSeenWindow`，而会话通常在本插件激活之后才创建，解析几乎总能赶在
   * `init` 之前完成。反过来让注册干等解析（旧实现等 1.5s）有两个坏处：
   * 服务就绪慢时整块投影迟到，且解析一旦失败就再也没有第二次机会。
   * 窗口解析失败也照样注册（`init` 退到 `lastSeenWindow` / 0，等
   * `request/context` 再补），绝不能因为解析挂了就让整个插件不工作。
   *
   * 注册句柄归本 fiber 所有；`dispose()` 可重复调用。effect 返回的是同步
   * disposer，异步注册完成后如果 fiber 已经销毁，就地释放句柄。
   */
  ctx.effect(() => {
    let active = true;
    const boot = async () => {
      /* 后台解析，不阻塞注册；`init` 会用解析结果（若已完成）。 */
      void ensureDefaultWindow();
      /* 服务注册顺序取决于宿主组合：投影服务是 base 层，通常已经在，但插件
         激活可能早于它。找不到就短退避重试几次，绝不因为顺序问题永久降级。 */
      const registryOf = () => {
        try {
          return ctx.get('sessionProjections') ?? null;
        } catch {
          return null;
        }
      };
      let registry = registryOf();
      for (let attempt = 0; !registry && attempt < 6 && active; attempt += 1) {
        await delay(400);
        registry = registryOf();
      }
      if (!active) return;
      if (!registry || typeof registry.register !== 'function') {
        log('info', 'sessionProjections unavailable; budget stays process-local and the client falls back to /context-budget-status');
        return;
      }
      const definition = {
        key: PROJECTION_KEY,
        stateVersion: 1,
        stateSchema: projectionStateSchema,
        init: () => ({
          requested: 0,
          budget: 0,
          /* 默认路由解析不出来时用本进程里量到过的窗口兜底：0 会让新会话
             在首次请求前没有任何档位可选。 */
          window: defaultWindow > 0 ? defaultWindow : lastSeenWindow,
          seeded: false,
          /* 新会话还没发过请求，先用默认路由的身份，客户端才能按模型
             取回上次设的预算。 */
          provider: defaultProvider,
          model: defaultModel,
        }),
        apply: foldProjection,
        wire: { viewSchema: projectionViewSchema, view: projectionView, summary: false },
      };
      try {
        const registered = await Promise.resolve(registry.register(definition));
        if (!active) {
          try {
            await registered?.dispose?.();
          } catch {
            /* 已经释放过就无所谓。 */
          }
          return;
        }
        projectionHandle = registered ?? null;
      } catch (error) {
        log('warn', `session projection registration failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    boot().catch((error) => {
      log('warn', `session projection bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      active = false;
      const handle = projectionHandle;
      projectionHandle = null;
      try {
        const pending = handle?.dispose?.();
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch {
        /* 释放失败不该让卸载炸掉。 */
      }
    };
  }, `[${PLUGIN_NAME}] session projection`);

  /* 会话销毁后立刻丢掉它的两份运行期状态，否则 Map 会随会话数无限增长。 */
  ctx.effect(() => {
    const dispose = ctx.on('agent/disposed', ({ agent }) => {
      const id = agent?.session?.id ?? agent?.id;
      if (!id) return;
      budgetBySession.delete(id);
      lastCompactAt.delete(id);
      lastDecisionBySession.delete(id);
    });
    return () => dispose();
  }, `[${PLUGIN_NAME}] session cleanup`);

  /* --------------------------------------------------------- 命令：设置预算 */

  ctx.effect(() => {
    const dispose = ctx.commands.register({
      name: COMMAND_NAME,
      description: '设置本会话的上下文预算（token 数；0 表示取消） / Set this session’s context budget (token count; 0 clears it).',
      input: { hint: '<token 数；0 表示取消 / token count; 0 clears it>' },
      /*
       * **不能**设 `recordInput: false`：`command/run.args` 是预算进入会话
       * 日志的唯一通道，投影（以及 Host 重启后的恢复）全靠它。命令行的
       * 输入本来也会显示在聊天记录的那一行里，隐藏它反而让「设成了多少」
       * 查不到。
       */
      handler: async (invocation) => {
        const raw = String(invocation.rawInput ?? '').trim();
        const tokens = Number(raw);
        if (!Number.isFinite(tokens) || tokens < 0) {
          return { kind: 'error', text: `用法：/${COMMAND_NAME} <token 数>（0 表示取消） / Usage: /${COMMAND_NAME} <token count> (0 clears it)` };
        }
        const agent = invocation.agent;
        const sessionId = agent?.session?.id;
        if (!sessionId) return { kind: 'error', text: '当前会话不可用 / No active session.' };

        /*
         * `windowOf` 要等一次 `resolveModelInfo`（可能走网络）。整个 handler
         * 必须自带 try/catch：命令执行器在 handler 抛错时会 rethrow，客户端
         * 拿到的是 RPC 错误而不是一句人话。
         */
        let window = 0;
        try {
          window = await windowOf(agent, invocation.signal);
        } catch (error) {
          log('warn', `resolve window failed: ${error instanceof Error ? error.message : String(error)}`);
          window = 0;
        }

        /* 向下对齐到「不大于请求值」的档；窗口未知时按原值记。 */
        const next = tokens > 0 ? alignBudget(tokens, window) : 0;
        /*
         * 按模型记住这次设置（跨会话）：下一次同模型的新会话挂载时，客户端
         * 会把它推回来。设成 0 视为「取消该模型的记忆」，不再自动套用。
         */
        let budgetProvider = '';
        let budgetModel = '';
        try {
          const routed = agent?.session?.requestContext?.() ?? null;
          budgetProvider = routed?.provider ?? agent?.options?.provider ?? '';
          budgetModel = routed?.model ?? agent?.options?.model ?? '';
        } catch {
          budgetProvider = '';
          budgetModel = '';
        }
        if (!budgetModel) {
          budgetProvider = defaultProvider;
          budgetModel = defaultModel;
        }
        recordModelBudget(budgetProvider, budgetModel, next, window);
        const current = budgetOf(agent?.session);
        if (next === current && budgetBySession.get(sessionId) !== undefined) {
          /* 重复设置同一个值：不写状态、不再记一条 host 日志。命令本身的两条
             生命周期事件由执行器写，客户端已经不会再重复发起。 */
          return {
            kind: 'success',
            text:
              next > 0
                ? `上下文预算已经是 ${next} token（窗口 ${window}）；超过 ${Math.floor(next * settings.triggerRatio)} 时，下一步开始前会自动压缩最早的历史 / Budget already ${next} tokens (window ${window})`
                : '上下文预算本来就没有设置 / No context budget was set',
          };
        }
        if (next > 0) budgetBySession.set(sessionId, next);
        else budgetBySession.delete(sessionId);
        log('info', `budget for ${sessionId}: ${next} (window ${window})`);

        const triggerAt = next > 0 ? Math.floor(next * settings.triggerRatio) : 0;
        return {
          kind: 'success',
          text:
            next > 0
              ? `上下文预算已设为 ${next} token（窗口 ${window}）；超过 ${triggerAt} 时，下一步开始前会自动压缩最早的历史 / Budget set to ${next} tokens (window ${window}); once usage passes ${triggerAt}, the oldest history is compacted before the next step`
              : '已取消上下文预算限制 / Context budget cleared',
        };
      },
    });
    return () => dispose();
  }, `[${PLUGIN_NAME}] command`);

  /* ---------------------------------------- 只读状态：客户端挂载时对账用 */
  /*
   * 客户端把预算镜像在 localStorage，但 Host 的 Map 才是权威：Host 重启、
   * 会话被 `agent/disposed` 清理、或配置改了 baseTokens/stepCap 之后，
   * 本地值都可能与 Host 不一致。客户端在挂载时先调这条命令，用返回的
   * `budget` 覆盖本地值，并用 `triggerRatio` / `baseTokens` / `stepCap`
   * 渲染面板与档位 —— 这使得「改配置后 UI 与 Host 分叉」不再发生。
   * 返回体是 JSON（作为 `result.text` 的字符串），`v` 是协议版本。
   */
  ctx.effect(() => {
    const dispose = ctx.commands.register({
      name: STATUS_COMMAND,
      description: '查询本会话当前生效的上下文预算与配置 / Report this session’s effective context budget and settings.',
      recordInput: false,
      handler: async (invocation) => {
        const agent = invocation.agent;
        const session = agent?.session ?? null;
        const budget = budgetOf(session);
        /* 窗口：`windowOf` 会先读 `session.requestContext()`，没有就现场解析
           默认/当前路由。客户端只在投影缺席（老 Host 或投影还没注册）时
           才会退回来问这条命令。 */
        let window = 0;
        try {
          window = await windowOf(agent, invocation.signal);
        } catch {
          window = 0;
        }
        /* 当前会话的路由身份：状态命令里一并报出「这个模型记住的预算」。 */
        let provider = '';
        let model = '';
        try {
          const routed = session?.requestContext?.() ?? null;
          provider = routed?.provider ?? agent?.options?.provider ?? '';
          model = routed?.model ?? agent?.options?.model ?? '';
        } catch {
          provider = '';
          model = '';
        }
        if (!model) {
          provider = defaultProvider;
          model = defaultModel;
        }
        const payload = {
          v: 3,
          budget,
          window,
          enabled: settings.enabled,
          triggerRatio: settings.triggerRatio,
          targetRatio: settings.targetRatio,
          baseTokens: settings.baseTokens,
          stepCap: settings.stepCap,
          maxAttempts: settings.maxAttempts,
          minIntervalMs: settings.minIntervalMs,
          projection: PROJECTION_KEY,
          /*
           * 诊断：为什么这一步压/没压。`total` 是判定用的数（真实提示词与估算
           * 取大），`measured` 是 `tokenMeter.measure()`、`pressure` 是 provider
           * 上报 —— 两者相差多少一眼就能看出来。
           */
          lastDecision: session ? lastDecisionBySession.get(session.id) ?? null : null,
          /* 跨会话的按模型预算记忆（只记设置值，不记用量统计）。 */
          model: modelKeyOf(provider, model) ?? null,
          modelBudget: rememberedBudgetFor(provider, model),
        };
        return { kind: 'success', text: JSON.stringify(payload) };
      },
    });
    return () => dispose();
  }, `[${PLUGIN_NAME}] status command`);
}
