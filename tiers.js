/**
 * 上下文预算的分级数学 —— 唯一的规范实现。
 *
 * 需求原式：当模型上下文窗口 W > base 时，以
 *   step = min(cap, (W - base) * 0.5)
 * 为「一段」把 [base, W] 划成层级；滑块就在这些层级之间切换。
 * 默认 base = 256K、cap = 128K，可由 Host 配置覆盖并下发给 Client。
 *
 * 由此推出两个自洽的性质（默认配置下，用于验证）：
 *   - 256K < W <= 512K 时 step = (W-256K)/2，所以正好 3 层；
 *   - W > 512K 时 step = 128K，(W-256K)/128K 层再加整窗那一层；
 *   - W <= 256K 时只有「整窗」一层，滑块不可用。
 *
 * 本文件被 Host 半边（index.js）直接 import；Client 半边是单文件模块、
 * 拿不到同目录相对导入，因此 client.js 里内联了逐字相同的副本，并用
 * scripts/check-tier-math.mjs 把两份实现对同一批窗口逐一比对，防止漂移。
 * 两个纯函数都接受可选的 base / cap，保证「配置改了以后 Host 与 Client
 * 仍用同一套档位」——这也是修掉「改 baseTokens/stepCap 后 UI 档位与 Host
 * 档位分叉」这一缺陷的关键。
 */

/** 1K = 1024 token（与宿主 token 计量的显示口径一致）。 */
export const K = 1024;

/** 分级阈值：窗口超过它才需要分级。 */
export const BASE_TOKENS = 256 * K;

/** 单层最大跨度，避免超大窗口切成过多档。 */
export const STEP_CAP = 128 * K;

/**
 * 一层的跨度。
 * @param {number} windowTokens 模型上下文窗口。
 * @param {number} [baseTokens=BASE_TOKENS] 分级起点。
 * @param {number} [cap=STEP_CAP] 单层最大跨度。
 * @returns {number} 跨度 token 数；窗口不超过 baseTokens 时返回 0。
 */
export function stepTokens(windowTokens, baseTokens = BASE_TOKENS, cap = STEP_CAP) {
  const over = Math.floor(windowTokens) - baseTokens;
  if (!(over > 0)) return 0;
  return Math.min(cap, Math.floor(over * 0.5));
}

/**
 * 把窗口划成升序层级，最后一层永远是整窗。
 * @param {number} windowTokens 模型上下文窗口。
 * @param {number} [baseTokens=BASE_TOKENS] 分级起点。
 * @param {number} [cap=STEP_CAP] 单层最大跨度。
 * @returns {number[]} 升序层级；窗口未知/非正时为空数组。
 */
export function computeTiers(windowTokens, baseTokens = BASE_TOKENS, cap = STEP_CAP) {
  const total = Number.isFinite(windowTokens) ? Math.floor(windowTokens) : 0;
  if (!(total > 0)) return [];
  const step = stepTokens(total, baseTokens, cap);
  if (step <= 0) return [total];
  const tiers = [];
  for (let value = baseTokens; value < total; value += step) tiers.push(value);
  tiers.push(total);
  return tiers;
}

/**
 * 把任意预算对齐到最近的一层：距离相同时取更小的一层，避免无意中放宽。
 * 超出整窗时直接落到顶层（顶层等于「不额外限制」）。
 * @param {number[]} tiers 升序层级。
 * @param {number} tokens 期望预算。
 * @returns {number} 对齐后的层级值；层级为空时返回 0。
 */
export function nearestTier(tiers, tokens) {
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
