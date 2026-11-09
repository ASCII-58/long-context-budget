/**
 * 长上下文预算 · Client 半边。
 *
 * 输入框右侧（`conversation.input.right`）放一枚紧凑触发器，显示**当前生效的
 * 上下文预算档位**（如 `上下文 640.0K`），而不是窗口容量/占用率；点开是一块小
 * 浮层，里面**只有**上下文长度切换件（Claude Code 风格的离散档位滑杆）：
 *
 *   预算  640.0K              触发点 70% = 448.0K   ← 比例由 Host 配置下发
 *   更省                                    更宽
 *   [═════ 26px 圆角轨道 + 每档刻度点 + 16×30 滑块 ═════]
 *   下一步请求生效
 *
 * 数据来源：
 *   - `contextBudget` 投影 → `{ budget, window, triggerRatio, baseTokens, stepCap }`
 *     —— Host 把「预算 + 窗口 + 配置」发布成会话投影，正常路径**只读它**，
 *     不跑 `/context-budget-status`（命令会在聊天记录里留一行，反复对账
 *     就是用户看到的重复日志）。预算本身也是日志派生的，Host 重启不丢。
 *   - `contextPressure` 投影 → `{ contextWindow }`：发过请求后的真实窗口，
 *     优先级最高（比 Host 预解析的默认路由更准）。
 *   - 窗口的兜底链：`contextPressure` → `contextBudget.window` →
 *     `/context-budget-status` → 上次实测窗口（localStorage）→ 通用绝对档位。
 *     最后两级保证「会话开始前/宿主解析失败」时**仍然能设预算**：档位只是
 *     选值的便利，真实窗口到达后 Host 会把同一预算重新对齐。
 *   - `/context-budget <token 数>` 命令：**只**在用户改档位时发一次。
 *
 * 纯浏览器模块：React 来自宿主模块表；与 Host 的通道是
 * `/context-budget` 命令（`ctx.get('remote.commands')`）与会话投影
 * （`useProjection`）。`/context-budget-status` 仅作为投影缺席时的兜底。
 */
window.__ModuleLoader__.load({
  id: 'dsh-long-context-budget',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo, useId } = React;

    /* 宿主的定位/外部点击 hook。它们在平台 seed 表里，可以直接 require；
       拿不到就退回自己算位置（面板仍然可用，只是定位略糙）。

       注意：seed 里的包是**平台级**的，插件不需要在 `dsh.client.external`
       里声明它们 —— 那个字段是「哪些 import 保持 external 不打进 bundle」，
       不是白名单。 */
    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch {
      primitives = null;
    }

    /* 面板要逃出输入框的 `overflow:hidden` 和可能的 `transform` 包含块，
       所以优先用 portal 挂到 body；拿不到 react-dom 时退回就地渲染。 */
    let ReactDOM = null;
    try {
      ReactDOM = require('react-dom');
    } catch {
      /* portal 是可选的。 */
    }

    const SLOT = 'conversation.input.right';
    const ENTRY_ID = 'long-context-budget';
    const LOCALE_NS = 'long-context-budget';
    /* Host/Client 固定契约：改这里必须同步改 index.js 的 COMMAND_NAME /
       STATUS_COMMAND / PROJECTION_KEY（scripts/test-budget-slider.mjs 会做一致性检查）。 */
    const COMMAND_NAME = 'context-budget';
    const STATUS_COMMAND = `${COMMAND_NAME}-status`;
    /* 会话投影 key：Host 把「预算 + 窗口 + 配置」发布成客户端可读的投影。
       正常路径只读它，**不跑** /context-budget-status —— 命令会往聊天记录里
       写 command/run + command/done 两行，每次挂载都刷正是用户看到的重复日志。 */
    const PROJECTION_KEY = 'contextBudget';
    const STORAGE_KEY = 'dsh-long-context-budget.budgets';
    /* 上一次实测到的窗口容量（全局，不按会话）。新会话在首次请求之前宿主
       还没有真实窗口，面板就一个档位都没有；把上回量到的值记下来，新会话
       就能立刻出档位，等真实窗口到达再自动校正。 */
    const WINDOW_STORAGE_KEY = 'dsh-long-context-budget.last-window';
    /* 面板里「统计基准」的选择：整窗 / 插件软上限。只影响读数，不影响触发。 */
    const BASIS_STORAGE_KEY = 'dsh-long-context-budget.basis';
    /* 投影是 Host 激活后异步注册的（Host 会先等一次默认窗口解析，最多 1.5s）：
       挂载瞬间 undefined 不代表宿主不支持它。超过这个宽限期还没有投影，才退回
       命令通道（老 Host），否则每次挂载都会白跑一对命令、在聊天记录里多两行。
       离线自测可以调小它（`globalThis.__DSH_LCB_PROJECTION_GRACE_MS__`）。 */
    const PROJECTION_GRACE_OVERRIDE = Number(globalThis.__DSH_LCB_PROJECTION_GRACE_MS__);
    const PROJECTION_GRACE_MS =
      Number.isFinite(PROJECTION_GRACE_OVERRIDE) && PROJECTION_GRACE_OVERRIDE >= 0
        ? PROJECTION_GRACE_OVERRIDE
        : 4000;

    /* 挂载时向 Host 拉取配置前的兜底值；拿到 status 后整体替换。
       值必须与 tiers.js 的默认常量一致，但不能引用 BASE_TOKENS/STEP_CAP
       —— 那两个 const 声明在下面的 tier math 区块里，此处在 TDZ 中。 */
    const DEFAULT_SETTINGS = {
      triggerRatio: 0.7,
      baseTokens: 256 * 1024,
      stepCap: 128 * 1024,
    };

    /* 窗口完全未知时的通用绝对档位。
       档位本该由窗口推出，但「还没量到窗口」不等于「不能设预算」：宿主接受
       任意 token 数，等真实窗口到达后同一预算会按真实窗口重新对齐。这里刻意
       给整档位，覆盖常见窗口，而不是假装知道当前模型的窗口。 */
    const GENERIC_TIERS = Object.freeze([128 * 1024, 256 * 1024, 512 * 1024, 1024 * 1024]);

    /* ------------------------------------------------------------ 宿主 hook 适配 */

    /**
     * 宿主的两个定位 hook（`useAnchoredPosition` / `useDismissOnOutsidePointer`）
     * 都在平台 seed 里，正常情况下拿得到。但它们是**条件存在**的，所以这里
     * 永远调用同一组 stub hook —— 绝不因为「有没有拿到」而改变 hook 调用
     * 顺序（那会让 React 在重渲染时炸掉）。
     */
    function anchoredStub() {
      return null;
    }
    function dismissStub() {
      /* 无操作：外面点击关闭由本组件自己的 document 监听负责。 */
    }
    const hasAnchoredPosition =
      primitives && typeof primitives.useAnchoredPosition === 'function';
    const hasDismissOnOutsidePointer =
      primitives && typeof primitives.useDismissOnOutsidePointer === 'function';
    const anchoredHook = hasAnchoredPosition ? primitives.useAnchoredPosition : anchoredStub;
    const dismissHook = hasDismissOnOutsidePointer ? primitives.useDismissOnOutsidePointer : dismissStub;

    /* ------------------------------------------------------- tier math (mirror) */
    /* 与 `tiers.js` 逐字等价。Client 模块拿不到同目录相对导入，所以这里必须
       有一份副本；`scripts/check-tier-math.mjs` 会把两份实现对同一批窗口逐一
       比对，任何一边改了公式都会当场失败。 */

    const K = 1024;
    const BASE_TOKENS = 256 * K;
    const STEP_CAP = 128 * K;

    function stepTokens(windowTokens, baseTokens = BASE_TOKENS, cap = STEP_CAP) {
      const over = Math.floor(windowTokens) - baseTokens;
      if (!(over > 0)) return 0;
      return Math.min(cap, Math.floor(over * 0.5));
    }

    function computeTiers(windowTokens, baseTokens = BASE_TOKENS, cap = STEP_CAP) {
      const total = Number.isFinite(windowTokens) ? Math.floor(windowTokens) : 0;
      if (!(total > 0)) return [];
      const step = stepTokens(total, baseTokens, cap);
      if (step <= 0) return [total];
      const tiers = [];
      for (let value = baseTokens; value < total; value += step) tiers.push(value);
      tiers.push(total);
      return tiers;
    }

    function nearestTier(tiers, tokens) {
      if (!Array.isArray(tiers) || tiers.length === 0) return 0;
      const target = Number(tokens);
      if (!Number.isFinite(target) || target <= 0) return 0;
      const top = tiers[tiers.length - 1];
      if (target >= top) return top;
      let best = 0;
      let bestDistance = Infinity;
      for (let index = 0; index < tiers.length; index += 1) {
        const distance = Math.abs(tiers[index] - target);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      return tiers[best];
    }

    /* --------------------------------------------------------------- formatting */

    /** 有限数守卫：任何来自投影/存储的数字都要先过这一关。 */
    function finite(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }

    /** 1024 进制的一位小数紧凑写法：`35.9K` / `192.0K` / `1.0M`。 */
    function formatTokens(tokens) {
      const value = finite(tokens);
      if (value === null || value <= 0) return '—';
      if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}M`;
      if (value >= 1024) return `${(value / 1024).toFixed(1)}K`;
      return String(Math.round(value));
    }

    /**
     * 当前生效档位的文案。触发件与面板滑杆必须共用这一份，否则底部显示的
     * 数字和面板里的「预算」会对不上（之前底部显示窗口容量就与档位脱节）。
     * 没设预算时默认取最高档 = 整窗。
     */
    function tierText(tiers, budget, t, generic = false) {
      if (tiers.length === 0) return '—';
      /* 通用档位只是「可选值」，没选过就还是没设预算 —— 不能把最高档
         显示成已生效的数字。 */
      if (generic && !(Number(budget) > 0)) return '—';
      const top = tiers[tiers.length - 1];
      const tier = budget > 0 ? nearestTier(tiers, budget) : top;
      /* 通用档位不知道整窗是多少，所以绝不把最高档说成「整窗」。 */
      return !generic && tier >= top ? t('tier.full') : t('tier.value', { tier: formatTokens(tier) });
    }

    /* ------------------------------------------------------------------ locale */

    /* 词典是「key → 文案」的平表，按语言分两组；宿主 locale 服务按 namespace
       绑定，缺哪个 key 就退回这里的内置值。 */
    const DICTIONARIES = {
      zh: {
        'slot.label': '上下文长度预算',
        'trigger.label': '上下文',
        'trigger.aria': '当前上下文长度预算',
        'panel.title': '上下文长度',
        'panel.close': '关闭',
        'budget.label': '预算',
        'budget.economy': '更省',
        'budget.roomy': '更宽',
        'tier.full': '整窗',
        'tier.value': '{tier}',
        'budget.nextRequest': '下一步请求生效',
        'budget.notGraded': '当前模型窗口未超过 {base}，无需分级',
        'budget.unknownWindow': '尚未测量上下文窗口',
        'budget.generic': '窗口尚未测量，先按通用档位选择',
        'budget.estimated': '窗口按上次测量 {window} 估算，首次请求后自动校正',
        'budget.failed': '预算设置失败',
        'trigger.window': '窗口',
        'usage.title': '上下文占用',
        'usage.basis': '统计基准',
        'usage.basis.window': '整窗',
        'usage.basis.budget': '软上限',
        'usage.line': '占用 ~{used} / {cap}（{percent}%）',
        'usage.unavailable': '还没有实测占用',
        'usage.trigger': '触发点 {tier}',
      },
      en: {
        'slot.label': 'Context budget',
        'trigger.label': 'Context',
        'trigger.aria': 'Active context length budget',
        'panel.title': 'Context length',
        'panel.close': 'Close',
        'budget.label': 'Budget',
        'budget.economy': 'Tighter',
        'budget.roomy': 'Roomier',
        'tier.full': 'Full window',
        'tier.value': '{tier}',
        'budget.nextRequest': 'Takes effect on the next step',
        'budget.notGraded': 'This model window does not exceed {base}, so no tiers apply',
        'budget.unknownWindow': 'Context window not measured yet',
        'budget.generic': 'Window not measured yet — pick a budget from the generic tiers',
        'budget.estimated': 'Window estimated from the last measurement ({window}); it corrects after the first request',
        'budget.failed': 'Could not save the budget',
        'trigger.window': 'Window',
        'usage.title': 'Context usage',
        'usage.basis': 'Measured against',
        'usage.basis.window': 'Full window',
        'usage.basis.budget': 'Soft cap',
        'usage.line': 'Using ~{used} / {cap} ({percent}%)',
        'usage.unavailable': 'No measured usage yet',
        'usage.trigger': 'Trigger at {tier}',
      },
    };

    /** 内置词典（宿主 locale 不可用时的最终兜底）。 */
    function builtinStrings(language) {
      const dict = DICTIONARIES[language] ?? DICTIONARIES.zh;
      return {
        language,
        t: (key, params) => {
          const template = dict[key];
          if (typeof template !== 'string') return key;
          if (!params) return template;
          return template.replace(/\{(\w+)\}/g, (match, name) =>
            name in params ? String(params[name]) : match
          );
        },
      };
    }

    /**
     * 词表：优先用宿主 locale 服务绑定本插件的 namespace；宿主没装 locale
     * 服务、没注册过这个 namespace、或某个 key 缺失时，都退回内置词典。
     */
    function resolveStrings(localeService) {
      let language = 'zh';
      try {
        const active = String(localeService?.getLocale?.().active ?? 'zh').toLowerCase();
        language = active.startsWith('zh') ? 'zh' : 'en';
      } catch {
        language = 'zh';
      }
      const fallback = builtinStrings(language);
      let bound = null;
      try {
        if (typeof localeService?.bind === 'function') bound = localeService.bind(LOCALE_NS);
      } catch {
        bound = null;
      }
      if (typeof bound !== 'function') return fallback;
      const t = (key, params) => {
        try {
          const value = bound(key, params);
          if (typeof value !== 'string' || value === '' || value === key) return fallback.t(key, params);
          return value;
        } catch {
          return fallback.t(key, params);
        }
      };
      return { language, t };
    }

    /**
     * 把本插件的词典注册进宿主 locale namespace。注册失败（namespace 已存在、
     * 服务不存在）不算错误：内置词典照样能出文案。
     */
    function ensureLocaleNamespace(localeService) {
      if (!localeService || typeof localeService.register !== 'function') return null;
      try {
        return localeService.register(LOCALE_NS, { zh: DICTIONARIES.zh, en: DICTIONARIES.en });
      } catch {
        /* 已经注册过，或者服务不接受 —— 都无所谓。 */
        return null;
      }
    }

    /**
     * 槽位标签：复用同一套词条，让设置/扩展面板里的名字也跟随界面语言。
     * 拿不到宿主 locale 服务时退回中文内置值（与原行为一致）。
     */
    function slotLabel() {
      try {
        const locale = hostCtx?.get?.('locale') ?? null;
        return resolveStrings(locale).t('slot.label');
      } catch {
        return DICTIONARIES.zh['slot.label'];
      }
    }

    /* --------------------------------------------------------------------- CSS */

    const CSS = `
.lcb-root{position:relative;min-width:0;display:inline-flex}
.lcb-trigger{border-radius:var(--dsw-radius-sm,8px);height:28px;min-width:0;color:var(--dsw-alias-label-secondary,#b9bec7);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:0 8px;font:inherit;font-size:12px;line-height:18px;display:inline-flex}
.lcb-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e6e8eb)}
.lcb-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#3b82f6)}
.lcb-trigger-label{white-space:nowrap;font-variant-numeric:tabular-nums}
.lcb-trigger-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#e6e8eb);font-weight:500}
.lcb-trigger-dot{width:6px;height:6px;flex:0 0 auto;border-radius:999px;background:var(--dsw-static-blue-450,#3b82f6)}

/* 浮层只装切换件：固定宽度、没有用量条/图例，避免尺寸随投影刷新而抖动。 */
.lcb-panel{z-index:1100;position:fixed;box-sizing:border-box;width:288px;padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-l1,#1f2126));color:var(--dsw-alias-label-secondary,#b9bec7);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.44));font-size:12px;line-height:18px;contain:layout paint style}
.lcb-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.lcb-head-title{font-size:12px;color:var(--dsw-alias-label-secondary,#b9bec7)}
.lcb-close{margin-left:auto;border:none;background:0 0;color:var(--dsw-alias-label-tertiary,#8b929c);cursor:pointer;font-size:13px;line-height:1;padding:2px 4px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center}
.lcb-close:hover{color:var(--dsw-alias-label-primary,#e6e8eb);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.lcb-close:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#3b82f6)}

/* 预算切换件：照 Claude Code 风格的「思考强度」滑杆排布。
   动画一律走 transform（合成器线程），不碰 left / width —— 那两属性每帧
   都要重排+重绘，切档时就会卡顿。fill 用 scaleX、knob 用 translate3d。 */
.lcb-slider{--lcb-accent:var(--dsw-alias-brand-primary,#d97757);--lcb-ease-glide:cubic-bezier(.22,.61,.36,1);--lcb-duration-move:.2s;--lcb-timing-feedback:.12s ease;display:flex;flex-direction:column;gap:3px;margin:0}
.lcb-slider-head{display:flex;align-items:baseline;gap:6px;min-width:0}
.lcb-slider-label{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary,#b9bec7)}
.lcb-slider-value{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-primary,#e6e8eb);font-variant-numeric:tabular-nums}
.lcb-slider-meta{flex:none;margin-left:auto;font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary,#8b929c);font-variant-numeric:tabular-nums}
.lcb-slider-ends{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary,#8b929c)}
.lcb-slider-track{position:relative;height:30px;margin-top:2px;cursor:pointer;touch-action:none;outline:none;border-radius:8px;contain:layout paint style}
.lcb-slider-track:before{content:"";position:absolute;left:0;right:0;top:50%;height:26px;margin-top:-13px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.lcb-slider-fill-clip{position:absolute;left:0;top:50%;width:100%;height:26px;margin-top:-13px;border-radius:8px 0 0 8px;overflow:hidden;pointer-events:none;contain:layout paint style}
.lcb-slider-fill{position:absolute;inset:0;background:color-mix(in srgb,var(--lcb-accent) 24%,transparent);transform:scaleX(0);transform-origin:left center;will-change:transform;transition:transform var(--lcb-duration-move) var(--lcb-ease-glide),opacity var(--lcb-duration-move) ease}
.lcb-slider-ticks{position:absolute;inset:0;pointer-events:none}
.lcb-slider-tick{position:absolute;top:50%;width:4px;height:4px;margin-top:-2px;transform:translate3d(-50%,0,0);border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-label-primary,#e6e8eb) 26%,transparent)}
.lcb-slider-knob{position:absolute;left:0;top:50%;width:16px;height:30px;margin-top:-15px;border-radius:5px;background:var(--dsw-alias-bg-elevated,#fff);box-shadow:0 1px 3px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.06);pointer-events:none;transform:translate3d(0,0,0);will-change:transform,scale;scale:1;transition:transform var(--lcb-duration-move) var(--lcb-ease-glide),scale var(--lcb-timing-feedback),box-shadow .3s ease}
.lcb-slider[data-dragging] .lcb-slider-fill{transition:none}
.lcb-slider[data-dragging] .lcb-slider-knob{scale:1.1;transition:scale var(--lcb-timing-feedback),box-shadow .3s ease}
.lcb-slider[data-apex] .lcb-slider-fill{background:color-mix(in srgb,var(--lcb-accent) 42%,transparent)}
.lcb-slider[data-apex] .lcb-slider-knob{box-shadow:0 0 10px color-mix(in srgb,var(--lcb-accent) 60%,transparent),0 0 0 1px color-mix(in srgb,var(--lcb-accent) 35%,transparent)}
.lcb-slider[data-apex] .lcb-slider-value{color:var(--lcb-accent)}
.lcb-slider[data-disabled] .lcb-slider-track{cursor:default}
.lcb-slider[data-disabled] .lcb-slider-track:before{opacity:.55}
.lcb-slider[data-disabled] .lcb-slider-value{color:var(--dsw-alias-label-tertiary,#8b929c)}
.lcb-slider-track:focus-visible{outline:2px solid var(--lcb-accent);outline-offset:1px;border-radius:10px}
.lcb-status{margin-top:6px;color:var(--dsw-alias-label-tertiary,#8b929c)}
.lcb-error{margin-top:6px;color:var(--dsw-alias-state-error-primary,#ef4444)}
/* 占用读数 + 统计基准切换（右上角）。 */
.lcb-basis{flex:none;margin-left:auto;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));background:0 0;color:var(--dsw-alias-label-tertiary,#8b929c);cursor:pointer;font:inherit;font-size:11px;line-height:16px;padding:0 7px;border-radius:999px;font-variant-numeric:tabular-nums;white-space:nowrap}
.lcb-basis:hover{color:var(--dsw-alias-label-primary,#e6e8eb);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.lcb-basis:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#3b82f6)}
.lcb-basis[data-basis="budget"]{color:var(--dsw-alias-brand-primary,#d97757);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#d97757) 45%,transparent)}
.lcb-close{margin-left:0}
.lcb-usage{margin:0 0 10px;display:flex;flex-direction:column;gap:4px}
.lcb-usage-head{display:flex;align-items:baseline;gap:8px}
.lcb-usage-title{color:var(--dsw-alias-label-tertiary,#8b929c)}
.lcb-usage-line{margin-left:auto;color:var(--dsw-alias-label-primary,#e6e8eb);font-variant-numeric:tabular-nums}
.lcb-usage-bar{position:relative;height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.lcb-usage-fill{height:100%;border-radius:999px;background:var(--dsw-static-blue-450,#3b82f6);transition:width .2s ease,background .2s ease}
.lcb-usage-fill[data-triggered="1"]{background:var(--dsw-alias-state-warning-primary,#f59e0b)}
.lcb-usage-fill[data-over="1"]{background:var(--dsw-alias-state-error-primary,#ef4444)}
/* 触发点：占用条上的一个点；悬停显示触发长度，越过触发线后变红。 */
.lcb-usage-marker{position:absolute;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:999px;background:var(--dsw-alias-label-tertiary,#8b929c);box-shadow:0 0 0 1.5px var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-l1,#1f2126));cursor:help}
.lcb-usage-marker[data-triggered="1"]{background:var(--dsw-alias-state-error-primary,#ef4444)}
.lcb-usage-note{color:var(--dsw-alias-label-tertiary,#8b929c)}
/* 档位文案切换：按方向滑入并轻微模糊，和滑块一起构成「换挡」的手感。 */
@keyframes lcb-value-swap{from{opacity:.35;transform:translateY(calc(6px * var(--lcb-swap-dir,1)));filter:blur(3px)}to{opacity:1;transform:translateY(0);filter:blur(0)}}
.lcb-slider-value{animation:lcb-value-swap var(--lcb-duration-move) var(--lcb-ease-glide) both}
.lcb-slider[data-dragging] .lcb-slider-value{animation:none}
@media (prefers-reduced-motion:reduce){.lcb-slider-fill,.lcb-slider-knob{transition:none}.lcb-slider-value{animation:none}}
`;

    /* --------------------------------------------------------------- 预算存储 */

    function readLocalBudgets() {
      try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
          const tokens = Number(value);
          if (typeof key === 'string' && key.length > 0 && Number.isFinite(tokens) && tokens > 0) {
            out[key] = Math.floor(tokens);
          }
        }
        return out;
      } catch {
        return {};
      }
    }

    function writeLocalBudgets(budgets) {
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(budgets));
      } catch {
        /* 存不下也只是下次要重推一次，不该让界面出错。 */
      }
    }

    /** 上次实测窗口；没有 / 坏值都归一成 0（=「不知道」）。 */
    function readLastWindow() {
      try {
        const raw = globalThis.localStorage?.getItem(WINDOW_STORAGE_KEY);
        const tokens = Number(raw);
        return Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
      } catch {
        return 0;
      }
    }

    function writeLastWindow(tokens) {
      const value = Number(tokens);
      if (!Number.isFinite(value) || value <= 0) return;
      try {
        globalThis.localStorage?.setItem(WINDOW_STORAGE_KEY, String(Math.floor(value)));
      } catch {
        /* 存不下只是下次还得重新等窗口，不影响本次。 */
      }
    }

    /** 面板「统计基准」：`window` = 整窗容量，`budget` = 插件软上限（默认）。 */
    function readBasis() {
      try {
        const raw = globalThis.localStorage?.getItem(BASIS_STORAGE_KEY);
        return raw === 'window' ? 'window' : 'budget';
      } catch {
        return 'budget';
      }
    }

    function writeBasis(basis) {
      try {
        globalThis.localStorage?.setItem(BASIS_STORAGE_KEY, basis === 'budget' ? 'budget' : 'window');
      } catch {
        /* 存不下只是下次回到默认口径。 */
      }
    }

    /* ---------------------------------------------------------------- 投影读取 */

    /**
     * 读一个投影键。任何异常、任何缺省都归一成 `undefined`。
     * 投影值本身也可能整个缺失（宿主没装对应插件），一律当「没有数据」。
     */
    function readProjection(useProjection, key) {
      if (typeof useProjection !== 'function') return undefined;
      try {
        const value = useProjection(key);
        if (value === null || typeof value !== 'object') return undefined;
        return value;
      } catch {
        return undefined;
      }
    }

    /** 非负 token 数守卫；0 也算有效（宿主可能报 0）。 */
    function tokenCount(value) {
      const number = finite(value);
      if (number === null || number < 0) return null;
      return number;
    }

    /** 正数 token 守卫：0 / 缺失 / 负数都归一成 `null`（=「没有这个值」）。 */
    function positiveTokens(value) {
      const number = tokenCount(value);
      return number !== null && number > 0 ? Math.floor(number) : null;
    }

    /**
     * 已知上下文窗口容量：只认正数，0 / 缺失都当「未测到」。
     * 触发器显示的就是它（如 `976.6K`），不再显示占用率。
     */
    function contextWindowOf(pressure) {
      const window = tokenCount(pressure?.contextWindow);
      return window !== null && window > 0 ? window : null;
    }

    /**
     * 当前上下文占用（真实提示词口径）。
     *
     * 优先 `projectedTokens`（最近一次 provider 采样 + 之后的 surface 增量），
     * 没有就退回 `pressureTokens`（最近一次请求的提示词大小）。
     */
    function contextUsedOf(pressure) {
      const used = tokenCount(pressure?.projectedTokens) ?? tokenCount(pressure?.pressureTokens);
      return used !== null && used > 0 ? used : null;
    }

    /* -------------------------------------------------------------- 命令通道 */

    /**
     * 宿主 ctx 的持有者。`apply(ctx)` 一定先于任何一次渲染，所以这里在
     * apply 里赋值、在组件里读取是安全的；组件拿不到 ctx 作为 prop，而命令
     * 通道必须从 ctx 上取。
     */
    let hostCtx = null;

    /**
     * 命令通道：`ctx.remote.commands.execute(...)`。
     *
     * `remote.commands` 是宿主挂在 `remote` 服务下的命名空间服务
     * （`remoteServiceKey(namespace)` = `remote.<namespace>`），所以它要通过
     * `ctx.get('remote.commands')` 取，而不是 `ctx.get('remote').commands`。
     */
    function commandsApi() {
      try {
        const commands = hostCtx?.get?.('remote.commands');
        if (!commands || typeof commands.execute !== 'function') return null;
        return commands;
      } catch {
        return null;
      }
    }

    /**
     * 把选中档位送到宿主。
     *
     * `commands/execute` 的签名是 `(agentId, line, submittedAttachments?, signal?)`
     * —— 全是位置参数。`agentId` 在宿主那条 RPC 上的声明是
     * `{ source: 'lookup', lookup: 'agent' }` + `typeSymbol: SessionId`
     * （`dsh-commands/lib/typert.host.js:70-90`），而 `Agent.id` 的类型正是
     * `SessionId`（`dsh-agent/lib/types/index.js`）——**所以传 sessionId 就是
     * 传 agentId**，宿主按它查 agent。
     *
     * 返回值形状是 `{ ok, value }`，`value` 是 `{ commandId, result }`，
     * `result.kind` 为 `'success'` / `'error'`；`ok` 为 false 时 `error` 里带
     * `{ code, message }`。
     */
    async function writeBudget(agentId, tokens, signal) {
      const api = commandsApi();
      if (!api) throw new Error('command transport unavailable');
      const response = await api.execute(agentId, `/${COMMAND_NAME} ${tokens}`, [], signal);
      if (!response?.ok) {
        const error = response?.error;
        const message = error?.message ?? error?.code ?? 'command rejected';
        throw new Error(String(message));
      }
      const execution = response?.value;
      if (!execution) throw new Error('command not found on the host');
      const result = execution?.result;
      if (result?.kind === 'error') throw new Error(String(result?.text ?? 'command failed'));
      return execution;
    }

    /**
     * 向 Host 查询「当前生效预算 + 窗口 + 配置」。
     *
     * 这是**兜底通道**：正常路径读 `PROJECTION_KEY` 投影，不跑命令。只有
     * 投影缺席（老 Host / 注册失败）或投影还没带窗口时才用一次。
     *
     * 返回 `null` 表示通道/命令暂不可用（调用方保留本地值）。兼容两种
     * 历史返回：v0.2.6 的纯数字预算文本、v0.2.7+ 的 JSON。纯数字**必须**
     * 解析成预算 —— 曾经因为只认 JSON 对象而返回 null，客户端便把它当成
     * 「老 Host 不支持查询」，于是又把同一个预算推了一遍，日志里就多出一条
     * 重复的 `/context-budget 960000`。
     */
    async function readStatus(agentId, signal) {
      const api = commandsApi();
      if (!api) return null;
      const response = await api.execute(agentId, `/${STATUS_COMMAND}`, [], signal);
      if (!response?.ok) throw new Error(String(response?.error?.message ?? response?.error?.code ?? 'status rejected'));
      const execution = response?.value;
      const result = execution?.result;
      if (!execution || result?.kind !== 'success') {
        throw new Error(String(result?.text ?? 'status command failed'));
      }
      const text = String(result.text ?? '').trim();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const object = parsed && typeof parsed === 'object' ? parsed : null;
      const numeric = object === null ? Number(text) : NaN;
      if (object === null && !Number.isFinite(numeric)) return null;
      const source = object ?? { budget: numeric };
      const positive = (value) => {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
      };
      const ratio = (value) => {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 && number < 1 ? number : null;
      };
      return {
        /* `legacy`：老 Host 只回了预算数字，其余配置一律缺省。 */
        legacy: object === null,
        budget: Math.max(0, Math.floor(Number(source.budget) || 0)),
        window: positive(source.window),
        triggerRatio: ratio(source.triggerRatio),
        baseTokens: positive(source.baseTokens),
        stepCap: positive(source.stepCap),
      };
    }

    /** 把 status 里的配置夹紧成可安全用于渲染的值。 */
    function normalizeSettings(status) {
      if (!status) return DEFAULT_SETTINGS;
      const ratio = (value, fallback) =>
        Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
      const positive = (value, fallback) =>
        Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
      return {
        triggerRatio: ratio(status.triggerRatio, DEFAULT_SETTINGS.triggerRatio),
        baseTokens: positive(status.baseTokens, DEFAULT_SETTINGS.baseTokens),
        stepCap: positive(status.stepCap, DEFAULT_SETTINGS.stepCap),
      };
    }

    /**
     * 每个页面、每个会话最多问一次 Host 的 status。
     *
     * 命令执行一定会在会话日志里留下 `command/run` + `command/done`，也就是
     * 聊天记录里的一行。之前挂载时无条件对账、失败还退避重试 4 次，
     * 于是同一份配置/预算被反复查询、反复推送 —— 这正是「重复日志」的成因。
     * 现在 status 只是投影缺席时的兜底，且同一页面内共享同一个 Promise
     * （组件重复挂载不会重复发起）。
     *
     * @param {string} sessionId 会话 id。
     * @returns {Promise<object|null>} status；不可用时为 null。
     */
    const statusProbe = new Map();
    /* 已经做过「旧版预算补推」的会话：每个页面每会话只推一次。 */
    const migrationPushed = new Set();
    function probeStatus(sessionId) {
      if (!sessionId) return Promise.resolve(null);
      const cached = statusProbe.get(sessionId);
      if (cached) return cached;
      const run = (async () => {
        const controller = new AbortController();
        let attempt = 0;
        for (;;) {
          try {
            const status = await readStatus(sessionId, controller.signal);
            return status ?? null;
          } catch {
            attempt += 1;
            if (attempt >= 4) return null;
            await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
          }
        }
      })();
      statusProbe.set(sessionId, run);
      return run;
    }

    /* ------------------------------------------------------------------ 面板 */

    /**
     * 浮层现在只装切换件：标题 + 一行关闭按钮 + `BudgetSlider` + 状态/错误。
     * 用量百分比、堆叠条、五段图例全部删掉 —— 用户要的是「切换上下文长度」，
     * 不是用量仪表盘；而且那些投影每次 tool 往返都会变，动画跟着抖。
     */
    function ContextLengthPanel(props) {
      const {
        strings,
        tiers,
        budget,
        busy,
        error,
        contextWindow,
        generic,
        estimated,
        settings,
        usage,
        basis,
        onBasisChange,
        onSelectTier,
        onClose,
        panelRef,
        panelId,
        panelStyle,
      } = props;
      const t = strings.t;

      const gradable = tiers.length > 1;
      const topTier = tiers.length > 0 ? tiers[tiers.length - 1] : 0;
      const selectedTier = budget > 0 ? nearestTier(tiers, budget) : topTier;
      const labelForTier = (tier) =>
        !generic && !estimated && tier >= topTier
          ? t('tier.full')
          : t('tier.value', { tier: formatTokens(tier) });
      /* 通用档位 + 还没选过：预算仍然是「未设置」，别让最高档看起来像已生效。 */
      const unset = generic && !(budget > 0);
      const notGraded = t('budget.notGraded', { base: formatTokens(settings.baseTokens) });

      /*
       * 占用读数：分母跟随右上角的统计基准。
       * `window` = 模型真实窗口；`budget` = 本插件设的软上限（没设就退回窗口）。
       */
      const used = usage && Number.isFinite(usage.used) ? Math.max(0, Math.floor(usage.used)) : null;
      const cap =
        basis === 'budget' && budget > 0
          ? budget
          : contextWindow !== null && contextWindow > 0
            ? contextWindow
            : budget > 0
              ? budget
              : null;
      const percent = used !== null && cap !== null && cap > 0 ? Math.round((used / cap) * 100) : null;
      const over = percent !== null && percent > 100;
      /* 触发点画在占用条里：位置按同一分母（整窗 / 软上限）换算，越线变色。 */
      const triggerRatio = Number(settings.triggerRatio);
      const triggerAt =
        budget > 0 && Number.isFinite(triggerRatio) && triggerRatio > 0
          ? Math.floor(budget * triggerRatio)
          : null;
      const triggered = used !== null && triggerAt !== null && used >= triggerAt;
      const triggerPos =
        triggerAt !== null && cap !== null && cap > 0
          ? Math.min(100, Math.max(0, (triggerAt / cap) * 100))
          : null;

      return h(
        'div',
        {
          ref: panelRef,
          id: panelId,
          style: panelStyle,
          className: 'lcb-panel',
          role: 'dialog',
          'aria-label': t('panel.title'),
        },
        h(
          'div',
          { className: 'lcb-head' },
          h('span', { className: 'lcb-head-title' }, t('panel.title')),
          h(
            'button',
            {
              type: 'button',
              className: 'lcb-basis',
              'data-basis': basis,
              'aria-label': `${t('usage.basis')}：${basis === 'budget' ? t('usage.basis.budget') : t('usage.basis.window')}`,
              title: t('usage.basis'),
              onClick: () => onBasisChange(basis === 'budget' ? 'window' : 'budget'),
            },
            basis === 'budget' ? t('usage.basis.budget') : t('usage.basis.window')
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'lcb-close',
              'aria-label': t('panel.close'),
              title: t('panel.close'),
              onClick: onClose,
            },
            '✕'
          )
        ),
        h(
          'div',
          { className: 'lcb-usage' },
          h(
            'div',
            { className: 'lcb-usage-head' },
            h('span', { className: 'lcb-usage-title' }, t('usage.title')),
            h(
              'span',
              { className: 'lcb-usage-line' },
              used !== null && cap !== null && percent !== null
                ? t('usage.line', {
                    used: formatTokens(used),
                    cap: formatTokens(cap),
                    percent: String(percent),
                  })
                : t('usage.unavailable')
            )
          ),
          percent !== null
            ? h(
                'div',
                { className: 'lcb-usage-bar' },
                h('div', {
                  className: 'lcb-usage-fill',
                  'data-over': over ? '1' : undefined,
                  'data-triggered': triggered ? '1' : undefined,
                  style: { width: `${Math.min(100, Math.max(0, percent))}%` },
                }),
                triggerPos !== null
                  ? h('span', {
                      className: 'lcb-usage-marker',
                      'data-triggered': triggered ? '1' : undefined,
                      style: { left: `${triggerPos}%` },
                      title: t('usage.trigger', { tier: formatTokens(triggerAt) }),
                      'aria-label': t('usage.trigger', { tier: formatTokens(triggerAt) }),
                    })
                  : null
              )
            : null,
          h(
            'div',
            { className: 'lcb-usage-note' },
            basis === 'budget' && budget > 0
              ? `${t('usage.basis')}：${t('usage.basis.budget')} ${formatTokens(budget)}`
              : contextWindow !== null
                ? `${t('usage.basis')}：${t('usage.basis.window')} ${formatTokens(contextWindow)}`
                : ''
          )
        ),
        h(BudgetSlider, {
          strings,
          tiers,
          selectedTier,
          gradable,
          busy,
          unset,
          labelForTier,
          onSelectTier,
          settings,
        }),
        h(
          'div',
          { className: 'lcb-status' },
          generic
            ? t('budget.generic')
            : estimated
              ? t('budget.estimated', { window: formatTokens(contextWindow ?? 0) })
              : gradable
                ? t('budget.nextRequest')
                : contextWindow === null
                  ? t('budget.unknownWindow')
                  : notGraded
        ),
        error ? h('div', { className: 'lcb-error', role: 'alert' }, error) : null
      );
    }

    /**
     * 预算切换件：Claude Code 风格的滑杆。
     *
     * 参照 `dsh-claude-style` 的「推理等级」控件结构（它自己没有开放扩展点，
     * 只能照着复刻，不能直接借用它的组件）：头部一行「预算 + 当前档」，
     * 两端语义「更省 / 更宽」，下面一条 26px 圆角轨道 —— 左侧填充、每档一个
     * 刻度点、16×30 的圆角滑块。交互按原生 range 的习惯来：
     *   - 指针按下即取最近档，拖动实时预览，松手才 commit（一次命令往返）；
     *   - ⬅/➡、⬆/⬇、Home/End、PageUp/PageDown 逐档切换；
     *   - 拖动中给 `data-dragging`（CSS 关掉过渡、滑块微放大）。
     *
     * 档位是离散的（`tiers` 由窗口尺寸推出），所以滑块只停在刻度上，
     * 不做连续取值 —— 否则「预算 = 313.7K」这种值没有语义。
     */
    function BudgetSlider(props) {
      const { strings, tiers, selectedTier, gradable, busy, unset, labelForTier, onSelectTier, settings } = props;
      const t = strings.t;

      const trackRef = useRef(null);
      /* 第 1 个 useState 必须是 width：scripts/test-budget-slider.mjs 依赖这个顺序。 */
      const [width, setWidth] = useState(0);
      const [dragging, setDragging] = useState(false);
      const [previewIndex, setPreviewIndex] = useState(-1);
      /* 拖动过程中的连续像素位置；null = 由已提交档位推导。 */
      const [knobPx, setKnobPx] = useState(null);
      /* 指针移动超过死区才进入「拖动」视觉态，避免点击时抖一下。 */
      const [engaged, setEngaged] = useState(false);
      /* 档位文案切换的方向与代号（±1），驱动滑入/模糊动画。 */
      const [swap, setSwap] = useState({ key: 0, dir: 1 });

      const anchorXRef = useRef(0);
      const pointXRef = useRef(0);
      const frameRef = useRef(0);
      const lastIndexRef = useRef(-1);
      const lastSelectedRef = useRef(selectedTier);

      const count = tiers.length;
      const disabled = !gradable || busy || count === 0;

      /* 已提交档位对应的下标（`selectedTier` 可能来自 localStorage，未必精确命中）。 */
      const committedIndex = useMemo(() => {
        if (count === 0) return -1;
        let best = 0;
        let bestDistance = Infinity;
        for (let index = 0; index < count; index += 1) {
          const distance = Math.abs(tiers[index] - selectedTier);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = index;
          }
        }
        return best;
      }, [tiers, selectedTier, count]);

      const activeIndex = dragging && previewIndex >= 0 ? previewIndex : committedIndex;

      /* 轨道宽度要实测：滑块的 translate 是按像素算的，不是百分比。 */
      useEffect(() => {
        const node = trackRef.current;
        if (!node) return undefined;
        const sync = () => setWidth(node.clientWidth || 0);
        sync();
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(sync);
          observer.observe(node);
          return () => observer.disconnect();
        }
        window.addEventListener('resize', sync);
        return () => window.removeEventListener('resize', sync);
      }, []);

      const KNOB = 16;
      const span = Math.max(0, width - KNOB);

      /* 档位 → 像素。离散档位只决定最终停靠点；拖动过程中滑块走连续像素。 */
      const indexToPx = useCallback(
        (index) => {
          if (count < 2 || index <= 0) return 0;
          return (Math.min(index, count - 1) / (count - 1)) * span;
        },
        [count, span]
      );

      /* 磁性吸附：滑块靠近刻度时被轻轻吸住，离开时再放开。
         与 dsh-claude-style「思考强度」滑杆同一套公式（q = 0.8），
         让离散档位也有连续拖动的顺滑感，而不是一格一格跳。 */
      const MAGNET = 0.8;
      const warp = useCallback(
        (rawPx) => {
          if (count < 2 || span <= 0) return rawPx;
          const segment = span / (count - 1);
          if (segment <= 0) return rawPx;
          const index = Math.floor(rawPx / segment);
          if (index >= count - 1) return rawPx;
          const fraction = (rawPx - index * segment) / segment;
          return (index + fraction - (MAGNET * Math.sin(2 * Math.PI * fraction)) / (2 * Math.PI)) * segment;
        },
        [count, span]
      );

      const activePx = knobPx === null ? indexToPx(activeIndex) : knobPx;
      const knobLeft = Math.round(activePx);

      /* 指针 x → 连续像素位置（夹在轨道内并做磁性吸附）。 */
      const pointerToPx = useCallback(
        (clientX) => {
          const node = trackRef.current;
          if (!node || span <= 0) return 0;
          const rect = node.getBoundingClientRect();
          const raw = Math.max(0, Math.min(span, clientX - rect.left - KNOB / 2));
          return warp(raw);
        },
        [span, warp]
      );

      const pxToIndex = useCallback(
        (px) => {
          if (count === 0 || span <= 0) return -1;
          if (count === 1) return 0;
          return Math.max(0, Math.min(count - 1, Math.round((px / span) * (count - 1))));
        },
        [count, span]
      );

      /* 拖动期间在 document 上跟手；指针可能在面板外松开。
         rAF 合并 pointermove：每帧最多写一次位置，高速拖动也不空转。
         指针移动超过 3px 才进入视觉「拖动」态，避免单击时抖一下。 */
      useEffect(() => {
        if (!dragging) return undefined;
        const flush = () => {
          frameRef.current = 0;
          const px = pointerToPx(pointXRef.current);
          setKnobPx(px);
          const next = pxToIndex(px);
          if (next >= 0) setPreviewIndex((current) => (current === next ? current : next));
        };
        const onMove = (event) => {
          pointXRef.current = event.clientX;
          /* 一旦越过死区就保持拖动态到松手，回移不反复切换。 */
          setEngaged((current) => current || Math.abs(event.clientX - anchorXRef.current) >= 3);
          if (frameRef.current) return;
          frameRef.current =
            typeof requestAnimationFrame === 'function' ? requestAnimationFrame(flush) : setTimeout(flush, 16);
        };
        const onUp = () => {
          if (frameRef.current) {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current);
            else clearTimeout(frameRef.current);
            frameRef.current = 0;
          }
          setDragging(false);
          setEngaged(false);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp, true);
        document.addEventListener('pointercancel', onUp, true);
        return () => {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp, true);
          document.removeEventListener('pointercancel', onUp, true);
        };
      }, [dragging, pointerToPx, pxToIndex]);

      /* 档位变化时给文案一个方向感：向上/向下滑入并轻微模糊。 */
      useEffect(() => {
        if (lastIndexRef.current === activeIndex) return;
        const dir = activeIndex >= lastIndexRef.current ? 1 : -1;
        lastIndexRef.current = activeIndex;
        setSwap((current) => ({ key: current.key + 1, dir }));
      }, [activeIndex]);

      /* 已提交档位被宿主或其它入口改动时，把连续位置同步回刻度。 */
      useEffect(() => {
        if (dragging) return;
        if (lastSelectedRef.current === selectedTier) return;
        lastSelectedRef.current = selectedTier;
        setKnobPx(indexToPx(committedIndex));
      }, [selectedTier, committedIndex, indexToPx, dragging]);

      /* 轨道宽度变化（窗口缩放/面板重排）时，把连续位置按新像素重算。 */
      const spanRef = useRef(span);
      useEffect(() => {
        if (spanRef.current === span) return;
        spanRef.current = span;
        if (!dragging) setKnobPx(indexToPx(committedIndex));
      }, [span, dragging, indexToPx, committedIndex]);

      /* 松手之后才 commit：一次拖动最多一次命令往返。
         先把连续位置吸附到目标刻度，再触发提交；提交结果回来时位置已经对齐。 */
      useEffect(() => {
        if (dragging || previewIndex < 0) return;
        const target = tiers[previewIndex];
        setKnobPx(indexToPx(previewIndex));
        setPreviewIndex(-1);
        if (!Number.isFinite(target) || target === selectedTier) return;
        onSelectTier(target);
      }, [dragging, previewIndex, tiers, selectedTier, onSelectTier, indexToPx]);

      const commitIndex = useCallback(
        (index) => {
          if (disabled) return;
          const next = Math.max(0, Math.min(count - 1, index));
          if (next === committedIndex) return;
          const target = tiers[next];
          if (Number.isFinite(target)) onSelectTier(target);
        },
        [disabled, count, committedIndex, tiers, onSelectTier]
      );

      const onKeyDown = useCallback(
        (event) => {
          if (disabled) return;
          const key = event.key;
          let next = null;
          if (key === 'ArrowRight' || key === 'ArrowUp') next = committedIndex + 1;
          else if (key === 'ArrowLeft' || key === 'ArrowDown') next = committedIndex - 1;
          else if (key === 'PageUp') next = committedIndex + 1;
          else if (key === 'PageDown') next = committedIndex - 1;
          else if (key === 'Home') next = 0;
          else if (key === 'End') next = count - 1;
          if (next === null) return;
          event.preventDefault();
          commitIndex(next);
        },
        [disabled, committedIndex, count, commitIndex]
      );

      const currentIndex = activeIndex >= 0 ? activeIndex : 0;
      const currentTier = count > 0 ? tiers[Math.min(currentIndex, count - 1)] : 0;
      /* 拖动时永远显示预览档位（否则拉起来没有反馈）；静止且「未设置」才显示 —。 */
      const showUnset = unset === true && !(dragging && previewIndex >= 0);
      const valueText = count > 0 && !showUnset ? labelForTier(currentTier) : '—';

      const ticks = [];
      if (count > 1 && span > 0) {
        for (let index = 0; index < count; index += 1) {
          ticks.push(
            h('span', {
              key: `tick-${index}`,
              className: 'lcb-slider-tick',
              style: { left: `${Math.round((index / (count - 1)) * span + KNOB / 2)}px` },
            })
          );
        }
      }

      return h(
        'div',
        {
          className: 'lcb-slider',
          'data-dragging': engaged ? 'true' : undefined,
          'data-apex': count > 1 && currentIndex === count - 1 ? '' : undefined,
          'data-disabled': disabled ? '' : undefined,
        },
        h(
          'div',
          { className: 'lcb-slider-head' },
          h('span', { className: 'lcb-slider-label' }, t('budget.label')),
          h(
            'span',
            {
              key: swap.key,
              className: 'lcb-slider-value',
              style: { '--lcb-swap-dir': String(swap.dir) },
            },
            valueText
          ),
        ),
        h(
          'div',
          { className: 'lcb-slider-ends', 'aria-hidden': 'true' },
          h('span', null, t('budget.economy')),
          h('span', null, t('budget.roomy'))
        ),
        h(
          'div',
          {
            ref: trackRef,
            className: 'lcb-slider-track',
            role: 'slider',
            tabIndex: disabled ? -1 : 0,
            'aria-label': t('budget.label'),
            'aria-valuemin': 0,
            'aria-valuemax': Math.max(0, count - 1),
            'aria-valuenow': currentIndex,
            'aria-valuetext': valueText,
            'aria-disabled': disabled ? 'true' : undefined,
            'aria-orientation': 'horizontal',
            onKeyDown,
            onPointerDown: (event) => {
              if (disabled) return;
              /* preventDefault 会连带取消浏览器给轨道的焦点，显式补上，
                 这样点完就能直接用方向键微调档位。 */
              try {
                event.currentTarget.focus?.();
              } catch {
                /* ignore */
              }
              event.preventDefault();
              try {
                event.currentTarget.setPointerCapture?.(event.pointerId);
              } catch {
                /* 捕获失败也能靠 document 监听跟手。 */
              }
              /* 按下即定位（不经过档位跳变），松手再吸附提交。 */
              const px = pointerToPx(event.clientX);
              anchorXRef.current = event.clientX;
              pointXRef.current = event.clientX;
              setEngaged(false);
              setKnobPx(px);
              setPreviewIndex(pxToIndex(px));
              setDragging(true);
            },
          },
          h('div', { className: 'lcb-slider-fill-clip' },
            h('div', {
              className: 'lcb-slider-fill',
              style: { transform: `scaleX(${width > 0 ? Math.min(1, (knobLeft + KNOB / 2) / width) : 0})` },
            })
          ),
          h('div', { className: 'lcb-slider-ticks' }, ticks),
          h('div', {
            className: 'lcb-slider-knob',
            style: { transform: `translate3d(${knobLeft}px,0,0)` },
          })
        )
      );
    }

    function BudgetSeat(props) {
      const { sessionId, useProjection } = props;

      const [budgets, setBudgets] = useState(() => readLocalBudgets());
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [strings, setStrings] = useState(() => resolveStrings(null));
      /* Host 下发的配置。投影正常时配置直接从投影读，这里只在投影缺席（老
         Host）或窗口兜底查询时被填上。必须放在 open 之后：
         scripts/test-budget-slider.mjs 依赖前两个 useState（budgets / open）
         的固定下标来强制面板展开。 */
      const [fallbackSettings, setFallbackSettings] = useState(DEFAULT_SETTINGS);
      /* 窗口兜底：投影与 contextPressure 都给不出窗口时（首次请求前且 Host
         解析失败）用一次 status 查询补上。 */
      const [fallbackWindow, setFallbackWindow] = useState(0);
      /* 上次实测窗口（localStorage）。所有实时来源都缺席时用它出档位 ——
         新会话在首次请求前至少能设预算，而不是整块面板不可用。 */
      const [cachedWindow, setCachedWindow] = useState(() => readLastWindow());
      /* 统计基准：整窗 / 插件软上限。只影响读数，不影响触发。 */
      const [basis, setBasis] = useState(() => readBasis());

      const rootRef = useRef(null);
      const panelRef = useRef(null);
      const triggerRef = useRef(null);
      const id = useId();

      /* 词表：宿主 locale 到位后重算一次；切换语言也会跟着变。 */
      useEffect(() => {
        let disposed = false;
        let service = null;
        try {
          service = hostCtx?.get?.('locale') ?? null;
        } catch {
          service = null;
        }
        const publish = () => {
          if (disposed) return;
          try {
            setStrings(resolveStrings(service));
          } catch {
            /* 词表永远不该让面板崩。 */
          }
        };
        publish();
        let unsubscribe = null;
        try {
          if (typeof service?.subscribe === 'function') unsubscribe = service.subscribe(publish);
        } catch {
          unsubscribe = null;
        }
        return () => {
          disposed = true;
          try {
            unsubscribe?.();
          } catch {
            /* ignore */
          }
        };
      }, []);

      /* 只读窗口容量这一个投影：其它占用投影不再订阅，避免每次 tool 往返
         都触发重渲染（那正是切档动画卡顿的来源之一）。 */
      const pressure = readProjection(useProjection, 'contextPressure');
      /* Host 发布的权威状态：预算 + 窗口 + 配置。正常路径只读它、不跑命令。 */
      const projection = readProjection(useProjection, PROJECTION_KEY);
      const projectionBudget = projection ? tokenCount(projection.budget) : null;
      const projectionWindow = projection ? positiveTokens(projection.window) : null;
      /* 配置随投影下发；投影缺席（老 Host）时才用 status 兜底值。 */
      const settings = projection ? normalizeSettings(projection) : fallbackSettings;
      /* 窗口优先级：真实测量（`contextPressure`，最可信）→ 投影（首次请求前由
         Host 解析默认路由）→ 一次性 status 兜底 → 上次实测缓存。任一来源有值，
         面板就能出档位。 */
      const measuredWindow = contextWindowOf(pressure) ?? projectionWindow ?? positiveTokens(fallbackWindow);
      const contextWindow = measuredWindow ?? positiveTokens(cachedWindow);
      /* 窗口完全未知：退回通用绝对档位（`GENERIC_TIERS`），先把预算设上，
         真实窗口到达后由 Host 重新对齐。 */
      const generic = contextWindow === null;
      /* 窗口来自上次测量（本次还没量到）：档位形状可信，但不是「当前模型窗口」，
         所以既不把最高档叫「整窗」，也在面板里说明它会自动校正。 */
      const estimated = !generic && measuredWindow === null;
      /* 档位用 Host 下发的 baseTokens/stepCap 计算：改配置后 UI 与 Host 不再分叉。 */
      const tiers = useMemo(
        () => (generic ? GENERIC_TIERS : computeTiers(contextWindow, settings.baseTokens, settings.stepCap)),
        [generic, contextWindow, settings.baseTokens, settings.stepCap]
      );

      /* 记住实测窗口：下次新会话开在「本周第一条消息」之前时，面板也能立刻出档位。 */
      useEffect(() => {
        if (!measuredWindow) return;
        writeLastWindow(measuredWindow);
        setCachedWindow((current) => (current === measuredWindow ? current : measuredWindow));
      }, [measuredWindow]);

      /* 预算：有投影就以投影为准（日志派生，跨重启不丢）；投影缺席时用本地镜像。 */
      const localBudget = sessionId ? Number(budgets[sessionId]) : 0;
      const budget = projection
        ? Math.max(0, projectionBudget ?? 0)
        : Number.isFinite(localBudget) && localBudget > 0
          ? localBudget
          : 0;

      /* 投影是权威：把本地镜像同步过去。首屏（投影还没到）与下次冷启动
         仍能立刻显示上次的档位，而整个过程不写命令，聊天记录里不会多一行。 */
      useEffect(() => {
        if (!sessionId || !projection) return;
        /* 日志里还没有本命令（`seeded: false`）：投影的 0 不代表「用户没设过」，
           先别动本地镜像，等迁移把它推回日志。 */
        if (projection.seeded !== true) return;
        const value = Math.max(0, projectionBudget ?? 0);
        const local = readLocalBudgets();
        const current = Number(local[sessionId]);
        const hasCurrent = Number.isFinite(current) && current > 0;
        if (value > 0 ? current === value : !hasCurrent) return;
        const next = { ...local };
        if (value > 0) next[sessionId] = value;
        else delete next[sessionId];
        writeLocalBudgets(next);
        setBudgets(next);
      }, [sessionId, projection, projectionBudget]);

      /* 一次性迁移：v0.2.7 及更早把预算只记在进程内（日志里没有 `args`），
         升级后投影会是 `seeded: false, budget: 0`。本地镜像还有值时补推一次，
         让选择回到日志里 —— 只推一次，之后投影的 `seeded` 就变 true 了。 */
      useEffect(() => {
        if (!sessionId || !projection || projection.seeded === true) return;
        if (migrationPushed.has(sessionId)) return;
        const local = readLocalBudgets();
        const value = Number(local[sessionId]);
        if (!Number.isFinite(value) || value <= 0) return;
        migrationPushed.add(sessionId);
        void writeBudget(sessionId, Math.floor(value)).catch(() => {
          /* 推不上去就下次再说：本地镜像还在。 */
          migrationPushed.delete(sessionId);
        });
      }, [sessionId, projection]);

      /* 按模型记忆：本会话日志里还没设过预算时，自动套用该模型上次设的值。
         用户主动取消（设 0）会删掉该模型的记忆，之后不会再自动套用。 */
      const rememberedBudget = projection ? positiveTokens(projection.modelBudget) : 0;
      useEffect(() => {
        if (!sessionId || !projection || projection.seeded === true) return;
        if (rememberedBudget <= 0) return;
        if (migrationPushed.has(sessionId)) return;
        migrationPushed.add(sessionId);
        void writeBudget(sessionId, rememberedBudget).catch(() => {
          /* 推不上去就下次再说。 */
          migrationPushed.delete(sessionId);
        });
      }, [sessionId, projection, rememberedBudget]);

      /* 兜底一：投影迟迟不出现（老 Host / 注册失败）。此时才走命令通道：
         先把 Host 的权威值拉回来，Host 是空的（重启过）就把本地选择推回去。
         宽限期用来避开「投影正在异步注册」的那一瞬间。 */
      useEffect(() => {
        if (!sessionId || projection !== undefined) return undefined;
        let active = true;
        const timer = setTimeout(() => {
          void probeStatus(sessionId).then((status) => {
            if (!active || !status) return;
            setFallbackSettings(normalizeSettings(status));
            if (status.window > 0) setFallbackWindow(status.window);
            const local = readLocalBudgets();
            const localValue = Number(local[sessionId]);
            const hasLocal = Number.isFinite(localValue) && localValue > 0;
            const next = { ...local };
            if (status.budget > 0) next[sessionId] = status.budget;
            else delete next[sessionId];
            writeLocalBudgets(next);
            setBudgets(next);
            /* Host 空、本地有值：Host 刚重启，把选择推回去（每个页面仅一次）。 */
            if (status.budget === 0 && hasLocal) {
              void writeBudget(sessionId, Math.floor(localValue)).catch(() => {});
            }
          });
        }, PROJECTION_GRACE_MS);
        return () => {
          active = false;
          clearTimeout(timer);
        };
      }, [sessionId, projection]);

      /* 兜底二：打开面板时窗口仍然未知（投影早于默认窗口解析注册、或解析
         失败）。用一次 status 补上窗口与配置；本页每个会话只问一次。 */
      useEffect(() => {
        if (!open || !sessionId || contextWindow !== null) return undefined;
        let active = true;
        void probeStatus(sessionId).then((status) => {
          if (!active || !status) return;
          setFallbackSettings(normalizeSettings(status));
          const window = positiveTokens(status.window);
          if (window) setFallbackWindow(window);
        });
        return () => {
          active = false;
        };
      }, [open, sessionId, contextWindow]);

      const changeBasis = useCallback((next) => {
        const value = next === 'budget' ? 'budget' : 'window';
        writeBasis(value);
        setBasis(value);
      }, []);

      const usage = useMemo(() => ({ used: contextUsedOf(pressure) }), [pressure]);


      const commit = useCallback(
        async (tokens) => {
          if (!sessionId) return;
          const previous = budgets;
          const next = { ...budgets };
          if (tokens > 0) next[sessionId] = tokens;
          else delete next[sessionId];
          writeLocalBudgets(next);
          setBudgets(next);
          setBusy(true);
          setError(null);
          try {
            await writeBudget(sessionId, tokens);
          } catch (failure) {
            /* 命令失败：保留本地值，只在面板里加一行红字，不弹窗。 */
            setBudgets(previous);
            writeLocalBudgets(previous);
            setError(
              failure instanceof Error && failure.message
                ? `${strings.t('budget.failed')}: ${failure.message}`
                : strings.t('budget.failed')
            );
          } finally {
            setBusy(false);
          }
        },
        [sessionId, budgets, strings]
      );

      const onSelectTier = useCallback(
        (tier) => {
          commit(nearestTier(tiers, tier));
        },
        [tiers, commit]
      );

      /* 面板定位：优先用宿主的锚定 hook；它缺席时，本组件自己算位置。 */
      const [fallback, setFallback] = useState(null);
      const place = useCallback(() => {
        const node = triggerRef.current;
        if (!node) return;
        const rect = node.getBoundingClientRect();
        const width = 300;
        const margin = 8;
        const left = Math.min(
          Math.max(margin, rect.right - width),
          Math.max(margin, window.innerWidth - width - margin)
        );
        const top = Math.max(margin, rect.top - 8);
        setFallback({ left, top, transform: 'translateY(-100%)' });
      }, []);

      /* 永远调用同一组 hook，顺序不随宿主 seed 是否可用而变。 */
      const anchored = anchoredHook({
        open,
        anchorRef: rootRef,
        panelRef,
        side: 'top',
        gap: 8,
        margin: 12,
      });
      const position = hasAnchoredPosition ? anchored : fallback;

      /* 外部点击关闭：宿主 hook 在时用它，否则自己挂 document 监听。 */
      useEffect(() => {
        if (!open || hasDismissOnOutsidePointer) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          if (!target || typeof target.closest !== 'function') return;
          if (rootRef.current && rootRef.current.contains(target)) return;
          if (panelRef.current && panelRef.current.contains(target)) return;
          setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => document.removeEventListener('pointerdown', onPointerDown, true);
      }, [open]);

      dismissHook(rootRef, open, setOpen, panelRef);

      /* Esc 关闭。 */
      useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          setOpen(false);
          try {
            triggerRef.current?.focus();
          } catch {
            /* ignore */
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, [open]);

      /* 打开时算一次位置（无锚定 hook 时的兜底）。 */
      useEffect(() => {
        if (!open || hasAnchoredPosition) return undefined;
        place();
        const onChange = () => place();
        window.addEventListener('resize', onChange);
        window.addEventListener('scroll', onChange, true);
        return () => {
          window.removeEventListener('resize', onChange);
          window.removeEventListener('scroll', onChange, true);
        };
      }, [open, place, hasAnchoredPosition]);

      const close = useCallback(() => {
        setOpen(false);
        try {
          triggerRef.current?.focus();
        } catch {
          /* ignore */
        }
      }, []);

      /* 底部触发件显示**当前生效档位**，与面板「预算」用同一个函数。
         之前显示窗口容量（937.5K）不随滑杆变，和档位 640.0K 对不上；
         窗口容量改放到 tooltip / aria 里，作为参考信息保留。 */
      const activeText = tierText(tiers, budget, strings.t, generic || estimated);
      const windowText = contextWindow === null ? null : formatTokens(contextWindow);
      const trigger = h(
        'button',
        {
          ref: triggerRef,
          type: 'button',
          className: 'lcb-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-controls': open ? `${id}-panel` : undefined,
          'aria-label': `${strings.t('trigger.aria')} ${activeText}${windowText ? `（${strings.t('trigger.window')} ${windowText}）` : ''}`,
          title: `${strings.t('panel.title')} · ${activeText}${windowText ? ` · ${strings.t('trigger.window')} ${windowText}` : ''}`,
          onClick: () => {
            if (!hasAnchoredPosition) place();
            setOpen((current) => !current);
          },
          onMouseDown: (event) => event.preventDefault(),
        },
        h('span', { className: 'lcb-trigger-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'lcb-trigger-label' }, strings.t('trigger.label')),
        h('span', { className: 'lcb-trigger-value' }, activeText)
      );

      /* 面板本体就是 `position:fixed` 的那个元素，所以定位样式必须落在它身上
         —— 外层再包一个 div 会让 fixed 相对那个 div 定位，位置就飘了。
         `panelRef` 也必须指向这个元素：宿主的 `useAnchoredPosition` 用它量
         面板的实际尺寸来夹住视口。 */
      const panel = open
        ? h(
            ContextLengthPanel,
            {
              panelRef,
              panelId: `${id}-panel`,
              panelStyle: position ?? { visibility: 'hidden', left: 0, top: 0 },
              strings,
              contextWindow,
              generic,
              estimated,
              tiers,
              budget,
              busy,
              error,
              settings,
              usage,
              basis,
              onBasisChange: changeBasis,
              onSelectTier,
              onClose: close,
            }
          )
        : null;

      /* 面板走 portal：输入框工具行是 `overflow:hidden`，而且宿主可能在某层
         祖先上加了 `transform`（会另开一个包含块，让 `position:fixed` 失效）。
         挂到 body 后，固定定位和宽度都由面板自己说了算。 */
      const portaled =
        panel !== null && ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined'
          ? ReactDOM.createPortal(panel, document.body)
          : panel;

      return h(
        'div',
        { ref: rootRef, className: 'lcb-root' },
        h('style', null, CSS),
        trigger,
        portaled
      );
    }

    /* -------------------------------------------------------------- registration */

    return {
      inject: ['slots'],
      apply(ctx) {
        hostCtx = ctx;

        /* 把词典注册进宿主 locale namespace；宿主没有 locale 服务或已经注册
           过时都无所谓 —— 组件里还有一份内置词典兜底。 */
        try {
          const locale = ctx.get?.('locale') ?? null;
          ensureLocaleNamespace(locale);
        } catch {
          /* ignore */
        }

        try {
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register(
              {
                name: SLOT,
                id: ENTRY_ID,
                order: 5,
                /* 槽位标签走词条，宿主切到英文界面时不再冒中文。 */
                label: () => slotLabel(),
              },
              function LongContextBudget(props) {
                return h(BudgetSeat, props);
              }
            )
          );
        } catch (error) {
          console.error('[dsh-long-context-budget] slot registration failed', error);
        }
      },
    };
  },
});
