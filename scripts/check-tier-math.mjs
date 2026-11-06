#!/usr/bin/env node
/**
 * 校验 `tiers.js` 与 `client.js` 里那份内联副本的分级公式真的逐字等价。
 *
 * Client 半边是单文件 `__ModuleLoader__` 模块，必须自带一份公式副本；两份
 * 实现一旦分叉，滑杆显示的档位和 Host 实际采用的档位就会不一致 —— 这种
 * bug 只在长会话里才看得出来，所以在这里当场拦住。
 *
 * 用法：node scripts/check-tier-math.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BASE_TOKENS, STEP_CAP, computeTiers, nearestTier, stepTokens } from '../tiers.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'client.js');

/** 从 Client 源码里抠出三个纯函数并求值，模拟它真实的运行环境。 */
function loadClientMath(source) {
  const start = source.indexOf('const K = 1024;');
  const end = source.indexOf('/* --------------------------------------------------------------- formatting */');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('client.js: 找不到内联的分级公式区块');
  }
  const block = source.slice(start, end);
  const factory = new Function(`${block}\nreturn { K, BASE_TOKENS, STEP_CAP, stepTokens, computeTiers, nearestTier };`);
  return factory();
}

/** 覆盖默认配置、边界、以及大量随机窗口。 */
function sampleWindows() {
  const windows = [
    0, 1, 1000,
    128 * 1024,
    200 * 1024,
    256 * 1024 - 1,
    256 * 1024,
    256 * 1024 + 1,
    300 * 1024,
    384 * 1024,
    512 * 1024 - 1,
    512 * 1024,
    512 * 1024 + 1,
    640 * 1024,
    768 * 1024,
    1024 * 1024,
    2 * 1024 * 1024,
    8 * 1024 * 1024,
  ];
  for (let index = 0; index < 400; index += 1) {
    windows.push(Math.floor(Math.random() * 4 * 1024 * 1024));
  }
  return windows;
}

const client = loadClientMath(readFileSync(clientPath, 'utf8'));

const problems = [];
if (client.BASE_TOKENS !== BASE_TOKENS) problems.push(`BASE_TOKENS: ${client.BASE_TOKENS} != ${BASE_TOKENS}`);
if (client.STEP_CAP !== STEP_CAP) problems.push(`STEP_CAP: ${client.STEP_CAP} != ${STEP_CAP}`);

for (const window of sampleWindows()) {
  const hostStep = stepTokens(window);
  const clientStep = client.stepTokens(window);
  if (hostStep !== clientStep) {
    problems.push(`stepTokens(${window}): host ${hostStep} != client ${clientStep}`);
    continue;
  }
  const hostTiers = computeTiers(window);
  const clientTiers = client.computeTiers(window);
  if (hostTiers.length !== clientTiers.length || hostTiers.some((value, index) => value !== clientTiers[index])) {
    problems.push(`computeTiers(${window}): host [${hostTiers}] != client [${clientTiers}]`);
    continue;
  }
  for (const tier of hostTiers.length > 0 ? hostTiers : [0]) {
    const hostNear = nearestTier(hostTiers, tier);
    const clientNear = client.nearestTier(clientTiers, tier);
    if (hostNear !== clientNear) {
      problems.push(`nearestTier(${window}, ${tier}): host ${hostNear} != client ${clientNear}`);
    }
  }
}

/* 需求原式必须在这几个点上给出可解释的档位数。 */
const expectations = [
  { window: 256 * 1024, tiers: [256 * 1024] },
  { window: 384 * 1024, tiers: [256 * 1024, 320 * 1024, 384 * 1024] },
  { window: 512 * 1024, tiers: [256 * 1024, 384 * 1024, 512 * 1024] },
  {
    window: 768 * 1024,
    tiers: [256 * 1024, 384 * 1024, 512 * 1024, 640 * 1024, 768 * 1024],
  },
];
for (const expectation of expectations) {
  const actual = computeTiers(expectation.window);
  if (actual.length !== expectation.tiers.length || actual.some((value, index) => value !== expectation.tiers[index])) {
    problems.push(`computeTiers(${expectation.window}): [${actual}] != [${expectation.tiers}]`);
  }
}

if (problems.length > 0) {
  console.error('tier math drift:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('tier math: client mirror matches tiers.js on every sampled window');
