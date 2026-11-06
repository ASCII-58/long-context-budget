/**
 * 上下文预算 · Host 半边。
 *
 * 职责（按用户确认的语义）：
 *   1. 记住每个会话当前的上下文预算（由输入框右侧面板设置，命令通道写入）；
 *   2. **每一步（step）开始前**，如果整包上下文超过 `0.7 × 预算`，先做零成本的
 *      tool-result 剪枝，仍然超标才执行宿主自己的压缩事务
 *      （`compaction.compactRegion`），把最旧的一段历史压成摘要，目标降到
 *      `0.5 × 预算`；压完继续，不打断会话；
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
 * ## 预算的存储
 *
 * 存在进程内的 `Map<sessionId, tokens>`。为什么不落盘：插件包里拿不到
 * `@deepseek-ai/dsh-session`（profile 的 node_modules 里没有它），
 * `session.append()` 也只接受已知事件类型，`appendPluginRecord()` 因此不可用。
 * 预算是「当前这次会话想用多大上下文」的运行期偏好，客户端同时把它镜像到
 * localStorage，重启后由客户端把值重新推回来。
 */

import Schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import { BASE_TOKENS, STEP_CAP, computeTiers } from './tiers.js';

/** 根层级需要命令注册与会话服务。 */
export const inject = ['commands', 'sessions'];

/** 额外上下文构成的投影键（客户端按同名 key 读取）。 */
export const COMPOSITION_PROJECTION_KEY = 'long-context-composition';

export { BASE_TOKENS };

const DEFAULTS = Object.freeze({
  /** 分级起点：窗口不超过它就不分级。 */
  baseTokens: BASE_TOKENS,
  /** 单层最大跨度。 */
  stepCap: STEP_CAP,
  /** 触发压缩的阈值比例：`0.7 × 预算`。 */
  triggerRatio: 0.7,
  /** 压缩目标比例：压到 `0.5 × 预算` 以下才算收工。 */
  targetRatio: 0.5,
  /** 单轮最多压几次；超过就放弃并记日志，绝不卡住会话。 */
  maxAttempts: 3,
  /** 两次压缩之间的最小间隔，防止死循环。 */
  minIntervalMs: 1000,
  /** 总开关。 */
  enabled: true,
  /** 命令名，客户端按同名字符串调用。 */
  command: 'context-budget',
  /** 日志前缀。 */
  name: 'long-context-budget',
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
  return {
    baseTokens: positive(source.baseTokens, DEFAULTS.baseTokens),
    stepCap: positive(source.stepCap, DEFAULTS.stepCap),
    triggerRatio: ratio(source.triggerRatio, DEFAULTS.triggerRatio),
    targetRatio: ratio(source.targetRatio, DEFAULTS.targetRatio),
    maxAttempts: Math.min(8, positive(source.maxAttempts, DEFAULTS.maxAttempts)),
    minIntervalMs: positive(source.minIntervalMs, DEFAULTS.minIntervalMs),
    enabled: source.enabled === false ? false : DEFAULTS.enabled,
    command:
      typeof source.command === 'string' && /^[a-z0-9-]+$/.test(source.command)
        ? source.command
        : DEFAULTS.command,
    name: typeof source.name === 'string' && source.name.length > 0 ? source.name : DEFAULTS.name,
  };
}

/**
 * 把任意预算向下对齐到「不大于请求值的最大档」。
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

/** 一层的跨度：min(stepCap, max(0, window - base) / 2)。 */
function stepFor(windowTokens, settings) {
  const over = Math.floor(windowTokens) - settings.baseTokens;
  if (!(over > 0)) return 0;
  return Math.min(settings.stepCap, Math.floor(over * 0.5));
}

/** 按配置重算层级（默认配置下与 tiers.js 完全一致）。 */
function tiersFor(windowTokens, settings) {
  if (settings.baseTokens === BASE_TOKENS && settings.stepCap === STEP_CAP) {
    return computeTiers(windowTokens);
  }
  const total = Number.isFinite(windowTokens) ? Math.floor(windowTokens) : 0;
  if (!(total > 0)) return [];
  const step = stepFor(total, settings);
  if (step <= 0) return [total];
  const tiers = [];
  for (let value = settings.baseTokens; value < total; value += step) tiers.push(value);
  tiers.push(total);
  return tiers;
}

/* ------------------------------------------------- 上下文构成：技能那一段 */

/**
 * 注册一个只读投影，把「技能」这一段从对话消息里单独拆出来。
 *
 * 为什么只有技能、没有 MCP：
 *   - 技能目录是**真的**一条 surface 消息（`dsh-tool-skill/lib/index.js:966-1015`，
 *     `user/message` 且 `source.kind === 'skill-catalog'`），可以逐条定价；
 *   - MCP 的系统提示词段落根本不进事件日志（`renderPrompt` 拼完就丢了 section
 *     边界，见 `dsh-system-prompt/lib/index.js:117-119`），从 Host 侧无法可靠
 *     拆分。与其给一个猜出来的数字，不如不显示那一行。
 *
 * ## 必须处理压缩（照抄宿主的「影子价格」）
 *
 * 技能目录会被压缩掉。若只累加、不在 `compaction/summary` 之后减去被压掉的
 * 部分，这个数字会一路虚高到完全失真。宿主自己的 `contextBreakdown` 用的
 * 就是这套办法（`dsh-token-meter/lib/types/breakdown-projection.js:120-146`）：
 * `compaction/summary` 事件把被替换的 seq 区间与对应技能价「挂」在 state 上，
 * 紧随其后的那次 `replace` 把它扣掉。
 *
 * 投影是纯函数：只读事件、只用启发式定价，不发起任何调用。
 */
function registerComposition(ctx, settings, log) {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const meterOf = () => {
      try {
        return ctx.get('tokenMeter') ?? null;
      } catch {
        return null;
      }
    };

    /* 存活技能目录节点（surface 顺序）+ 一条已挂起的影子价。 */
    const stateSchema = z.object({
      nodes: z.array(z.object({ seq: z.number(), tokens: z.number() })),
      claim: z
        .object({
          start: z.number(),
          end: z.number(),
          tokens: z.number(),
        })
        .optional(),
    });

    const isSkillCatalog = (message) => message?.source?.kind === 'skill-catalog';

    const viewOf = (state) => ({
      skillTokens: state.nodes.reduce((total, node) => total + node.tokens, 0),
    });

    projectionCtx.effect(() => {
      return projectionCtx.sessionProjections.register({
        key: COMPOSITION_PROJECTION_KEY,
        stateVersion: 1,
        stateSchema,
        init: () => ({ nodes: [] }),
        apply: (state, event) => {
          /* 1) 压缩发生：把被替换区间里属于技能的价挂起来，等下一次 replace 扣掉。 */
          if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
            const shadowed = new Set(event.data?.shadowedSeqs ?? []);
            const start = event.data?.shadowedRange?.start;
            const end = event.data?.shadowedRange?.end;
            if (!Number.isFinite(start) || !Number.isFinite(end)) return state;
            const inside = state.nodes.filter((node) => shadowed.has(node.seq));
            if (inside.length === 0) return state;
            return {
              nodes: state.nodes,
              claim: {
                start,
                end,
                tokens: inside.reduce((total, node) => total + node.tokens, 0),
              },
            };
          }

          const claim = state.claim;
          const unclaimed = claim === undefined ? state : { nodes: state.nodes };
          const op = event.surfaceOp;

          /* 2) 替换（压缩提交本体）：解除挂起的影子价，并把新节点按需记成技能。 */
          if (op !== 'append' && typeof op === 'object' && op?.op === 'replace') {
            let nodes = unclaimed.nodes;
            if (claim !== undefined && claim.start === op.startSeq && claim.end === op.endSeq) {
              const removed = new Set(
                state.nodes.filter((node) => node.seq >= claim.start && node.seq <= claim.end).map((node) => node.seq)
              );
              nodes = nodes.filter((node) => !removed.has(node.seq));
            }
            if (isSkillCatalog(event.data)) {
              const meter = meterOf();
              if (meter && typeof meter.estimateMessage === 'function') {
                try {
                  const tokens = meter.estimateMessage(event.data);
                  if (Number.isFinite(tokens) && tokens > 0) {
                    nodes = [...nodes, { seq: event.seq, tokens }];
                  }
                } catch {
                  /* 定价失败就只保留已扣除的结果。 */
                }
              }
            }
            return { nodes };
          }

          /* 3) 普通追加：只关心技能目录消息。 */
          if (op !== 'append') return unclaimed;
          if (event.type !== 'user/message') return unclaimed;
          if (!isSkillCatalog(event.data)) return unclaimed;

          const meter = meterOf();
          if (!meter || typeof meter.estimateMessage !== 'function') return unclaimed;
          let tokens;
          try {
            tokens = meter.estimateMessage(event.data);
          } catch {
            return unclaimed;
          }
          if (!Number.isFinite(tokens) || tokens <= 0) return unclaimed;
          return { nodes: [...unclaimed.nodes, { seq: event.seq, tokens }] };
        },
        wire: {
          viewSchema: z.object({ skillTokens: z.number() }),
          view: viewOf,
        },
      });
    }, `[${settings.name}] composition projection`);
    log('info', 'composition projection registered');
  });
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
      if (typeof logger === 'function') logger.call(ctx.logger, `[${settings.name}] ${message}`);
    } catch {
      /* 日志永远不能让功能失败。 */
    }
  };

  /** sessionId -> 选中预算（token 数）。缺失 = 不额外限制。 */
  const budgetBySession = new Map();
  /** sessionId -> 上一次压缩的时间戳，防死循环。 */
  const lastCompactAt = new Map();

  /* 上下文构成投影：把「技能」从对话消息里单独拆出来，供面板显示。 */
  try {
    registerComposition(ctx, settings, log);
  } catch (error) {
    log('warn', `composition projection unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

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

  /* -------------------------------------- 核心：每一步开始前检查并压缩 */

  /**
   * 在 step 边界检查并压缩。
   *
   * 阈值 `0.7 × 预算`，先剪枝再摘要，目标 `0.5 × 预算`；最多压 `maxAttempts` 次。
   * 任何异常都只记日志 —— 压缩是优化，绝不能拦住这一轮或下一轮。
   */
  const enforce = async (agent, signal, messages) => {
    if (!settings.enabled) return;
    if (signal?.aborted) return;
    const session = agent?.session;
    if (!session) return;

    const budget = budgetBySession.get(session.id) ?? 0;
    if (!(budget > 0)) return;

    /*
     * pre-step 的 `messages` 是本轮**待进入的唤醒消息**，不是历史。为空只表示
     * 这一步不开新 step（`turn()` 会 break），压缩纯属白干，直接跳过。
     */
    if (Array.isArray(messages) && messages.length === 0) return;

    const { meter, compaction, pruner } = scoped(agent);
    if (!meter || !compaction) {
      log('warn', 'tokenMeter or compaction service unavailable; skipping budget enforcement');
      return;
    }

    const triggerAt = Math.floor(budget * settings.triggerRatio);
    let measurement;
    try {
      measurement = meter.measure(session);
    } catch (error) {
      log('warn', `measure failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!(measurement.totalTokens >= triggerAt)) return;

    /*
     * 仿宿主 compactIfNeeded 的顺序：先做零成本的 tool-result 剪枝，
     * 剪完够低就不再花钱调模型摘要。
     */
    if (pruner) {
      try {
        pruner.pruneSession(session);
        measurement = meter.measure(session);
      } catch (error) {
        log('warn', `prune failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!(measurement.totalTokens >= triggerAt)) {
        log('info', `pruned down to ${measurement.totalTokens} tokens; no summarization needed`);
        return;
      }
    }

    const now = Date.now();
    if (now - (lastCompactAt.get(session.id) ?? 0) < settings.minIntervalMs) return;

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

    log(
      'info',
      `step boundary at ${measurement.totalTokens} tokens >= ${settings.triggerRatio * 100}% of budget ${budget} (${triggerAt}); compacting toward ${targetAt}`
    );

    for (let attempt = 0; attempt < settings.maxAttempts; attempt += 1) {
      if (signal?.aborted) return;
      /* 目标值本身就是「压缩后要保留的尾部预算」：被压掉的部分整段消失，
         剩下的总量就该落在 targetAt 附近。 */
      const range = selectRange(session, measurement.nodes, targetAt);
      if (range === null) {
        log('info', 'no compactable range (tool-pairing cannot be satisfied); stopping');
        return;
      }
      try {
        const result = await compaction.compactRegion(range.start, range.end, agent, signal);
        lastCompactAt.set(session.id, Date.now());
        log(
          'info',
          `compacted ${result?.shadowedSeqs?.length ?? '?'} nodes (~${result?.shadowedTokenCount ?? '?'} tokens)`
        );
      } catch (error) {
        /*
         * 失败可能留下未闭合的 `compaction/start`，重试会被
         * `assertCompactionInactive` 一路拒绝，形成静默失效。立即放弃，交给宿主。
         */
        lastCompactAt.set(session.id, Date.now());
        log('warn', `compaction failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      try {
        measurement = meter.measure(session);
      } catch (error) {
        log('warn', `re-measure failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (measurement.totalTokens < triggerAt) {
        log('info', `context now ${measurement.totalTokens} tokens, below trigger ${triggerAt}; resuming session`);
        return;
      }
      log('info', `still ${measurement.totalTokens} >= ${triggerAt}; compacting again`);
    }
    log('warn', `still above trigger after ${settings.maxAttempts} attempts; leaving it to the host`);
  };

  ctx.effect(() => {
    const dispose = ctx.on(
      'agent/pre-step',
      async ({ agent, messages, signal }, next) => {
        /*
         * 与 compaction-basic 同点，但必须 prepend 抢在它前面：
         * 它用冻结的 config 算阈值，先跑可能把我们要压的区间压掉。
         * waterfall 语义：不调用 next() 等于否决整条链，因此下面无条件返回 next()。
         */
        try {
          if (signal?.aborted) return next();
          await enforce(agent, signal, messages);
        } catch (error) {
          log('warn', `budget enforcement crashed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return next();
      },
      { prepend: true },
    );
    return () => dispose();
  }, `[${settings.name}] step-boundary budget enforcement`);

  /* 会话销毁后立刻丢掉它的两份运行期状态，否则 Map 会随会话数无限增长。 */
  ctx.effect(() => {
    const dispose = ctx.on('agent/disposed', ({ agent }) => {
      const id = agent?.session?.id ?? agent?.id;
      if (!id) return;
      budgetBySession.delete(id);
      lastCompactAt.delete(id);
    });
    return () => dispose();
  }, `[${settings.name}] session cleanup`);

  /* --------------------------------------------------------- 命令：设置预算 */

  ctx.effect(() => {
    const dispose = ctx.commands.register({
      name: settings.command,
      description: '设置本会话的上下文预算（token 数；0 表示取消） / Set this session’s context budget (token count; 0 clears it).',
      input: { hint: '<token 数；0 表示取消 / token count; 0 clears it>' },
      /* 命令自己拥有这份输入，日志里不必再重复一遍。 */
      recordInput: false,
      handler: async (invocation) => {
        const raw = String(invocation.rawInput ?? '').trim();
        const tokens = Number(raw);
        if (!Number.isFinite(tokens) || tokens < 0) {
          return { kind: 'error', text: '用法：/context-budget <token 数>（0 表示取消） / Usage: /context-budget <token count> (0 clears it)' };
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

        const tiers = tiersFor(window, settings);
        let next = 0;
        if (tokens > 0) {
          /* 向下对齐到「不大于请求值」的档；窗口未知时按原值记。 */
          next = tiers.length > 0 ? tierAtMost(tiers, tokens) : Math.floor(tokens);
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
  }, `[${settings.name}] command`);

  /* ---------------------------------------------- 可选：把预算回显给客户端 */
  /* 客户端主要靠 localStorage 记忆；这里额外提供一个只读查询命令，便于面板
     在重载后向 Host 确认当前生效值。 */
  ctx.effect(() => {
    const dispose = ctx.commands.register({
      name: `${settings.command}-status`,
      description: '查询本会话当前生效的上下文预算 / Report this session’s effective context budget.',
      recordInput: false,
      handler: async (invocation) => {
        const sessionId = invocation.agent?.session?.id;
        const budget = sessionId ? budgetBySession.get(sessionId) ?? 0 : 0;
        return { kind: 'success', text: String(budget) };
      },
    });
    return () => dispose();
  }, `[${settings.name}] status command`);
}
