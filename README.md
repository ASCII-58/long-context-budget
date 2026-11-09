# dsh-long-context-budget

[English](README.en.md) | 简体中文

[![npm](https://img.shields.io/npm/v/dsh-long-context-budget?logo=npm)](https://www.npmjs.com/package/dsh-long-context-budget)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0%20%3C0.3.0-3b82f6)](https://github.com/deepseek-ai/deepseek-harness)
[![GitHub](https://img.shields.io/github/stars/ASCII-58/long-context-budget?logo=github)](https://github.com/ASCII-58/long-context-budget)

> 一个发布在 npm 上的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：在输入框旁提供**按会话的上下文预算**。选好档位后，一旦上下文超过触发点，最早的历史会在**下一步开始前**被剪枝并压缩；预算按模型跨会话记住，面板里还能看到实时占用与压缩触发点。

---

## 功能

- **离散档位滑杆** —— 在 `conversation.input.right` 注入紧凑触发件和 Claude Code 风格的滑杆：连续拖动、磁性吸附、档位文案按方向滑入。档位由模型窗口按 `min(128K, (W − 256K) × 0.5)` 推出，最后一级是整窗；窗口不超过 256K 时无需分级。
- **下一步开始前压缩** —— 每次 `agent/pre-step` 前检查整包上下文：超过 `triggerRatio × 预算` 先做零成本 tool-result 剪枝，仍超标才调用宿主压缩事务，把最旧的历史压向 `targetRatio × 预算`（尾部另有 64K 下限）。任何异常都只记日志，绝不打断会话。
- **真实口径判定** —— 触发取「provider 上报的提示词大小」与本地估算的较大值。宿主的 `chars / 4` 启发式对中文偏小，只看它会漏触发；压缩缩掉的量会从提供方快照里扣除，避免同一轮反复压。
- **按模型记住预算** —— 你在某个模型上设过的预算记在 `~/.dsh/long-context-budget-models.json`；同模型的新会话自动套用，设成 0 即取消该模型的记忆。只记设置值，不含用量统计。
- **首次请求前就能设** —— 窗口还没量到时也能选档：窗口依次退到「投影 → `/context-budget-status` → 上次实测窗口 → 通用档位 `128K/256K/512K/1M`」，真实窗口到达后由 Host 自动重新对齐。
- **上下文占用读数** —— 面板显示当前计入、占比与占用条；标题栏右上角一键在「整窗 / 软上限」之间切换统计基准（默认软上限，选择记在 `localStorage`），只改读数，不改触发行为。
- **占用条上的触发点** —— 触发点不单独成行，而是占用条上的一个圆点：位置按当前统计基准换算，悬停显示触发长度；越过时填充变琥珀色、圆点变红，超过 100% 时保持红色。
- **状态诊断** —— `/context-budget-status` 返回 v3：`lastDecision` 说明某一步为什么压 / 没压，`model` / `modelBudget` 报出当前模型记住的预算。
- **按需启用** —— 未设置预算时插件完全不介入。
- **中英双语界面** —— 内置中英文词条与兜底词典。

## 环境要求

| 要求 | 版本 |
| --- | --- |
| DeepSeek Harness（DSH） | `>=0.2.0 <0.3.0` |
| Node.js（仅开发需要） | `>=22.12` |

## 安装

### 从 npm 安装（推荐）

```bash
dsh plugin add dsh-long-context-budget
```

也可以指定 profile：

```bash
dsh plugin --profile web add dsh-long-context-budget
```

装好后重启 DSH。包内自带 `cordis.patch.yml`，通过 `dsh.bundle.patch` 自动注册，无需手动改补丁。

### 从源码安装

1. 克隆仓库并安装依赖：

   ```bash
   git clone https://github.com/ASCII-58/long-context-budget.git
   cd long-context-budget
   pnpm install
   ```

2. 在 profile 的 `cordis.patch.yml` 中注册（或把该目录作为 profile 依赖）：

   ```yaml
   - insert:
       - id: long-context-budget
         name: 'dsh-long-context-budget'
         config: {}
   ```

3. 重载或重启 DSH。Client 插件改动只有在 DSH 源码树里同时运行 `pnpm run dev:web` 时才免刷新热重载；否则需要重建前端产物并刷新页面。

## 快速使用

1. 点击输入框右侧的 **上下文（Context）** 触发件。
2. 面板上半部是**上下文占用**：当前计入 / 占比 / 占用条，圆点是压缩触发点（悬停可见具体长度）；右上角按钮切换「整窗 / 软上限」统计基准。
3. 下半部是**预算滑杆**：拖动选档（更省 → 更宽 → 整窗），改动在下一步生效。最高档等于「不额外限制」。
4. 正常对话即可。每一步开始前，Host 只在超出触发点时压缩。同一个模型下次开新会话会自动套用上次设的预算。

> 会话刚开始、还没量到窗口时，滑杆不会变灰：它先给出通用档位
> （128K / 256K / 512K / 1M），面板脚注会说明窗口是估算的（或尚未测量）；
> 第一次请求完成后自动换成当前模型的真实档位与整窗。
>
> **Host 半边只在 DSH 启动时加载**：升级插件或改 `index.js` 后必须重启 DSH，否则仍会跑旧代码。Client 半边刷新页面（或 HMR）即可。

所选档位通过 `/context-budget` 命令送到 Host，也可以直接使用命令：

```text
/context-budget 655360     # 请求 640K；Host 会向下对齐到不超过它的最大档（1M 窗口下为 640K）
/context-budget 0          # 取消当前会话的预算，并清除该模型的记忆
/context-budget-status     # 调试用：返回生效预算、窗口、配置、上一次判定与模型记忆（JSON v3）
```

> 命令名 `context-budget` / `context-budget-status` 与投影 key `contextBudget`
> 是 Host 与 Client 的固定契约，不是可配置项：Client 是单文件模块，拿不到配置，
> 也无法在运行时发现它们。预算值会向下对齐到分级档位，因此命令里写的数字
> 不一定是最终生效值。
>
> **面板平时不跑命令。** 预算、窗口、配置、模型身份与记忆都由 Host 发布成会话投影
> `contextBudget`，客户端直接读投影；每次挂载都调 status 会在聊天记录里留一行
> （`command/run` + `command/done`），那正是「重复日志」的来源。唯一的例外是
> **同模型的新会话**：为了把记住的预算写进会话日志，挂载时补发一次
> `/context-budget`（之后仍走投影）。`context-budget-status` 只在投影缺席
> （老 Host / 注册失败）或调试时使用。

## 配置项

所有选项都会由 Host 校验并夹紧到安全范围；默认值即推荐值，确有所需再调整。

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关。关闭后完全不介入会话。 |
| `triggerRatio` | number（0.05–0.95） | `0.7` | 触发压缩的阈值比例（相对会话预算）。 |
| `targetRatio` | number（0.05–0.9） | `0.5` | 压缩目标比例（相对会话预算）；保留尾部另有 64K 下限。 |
| `maxAttempts` | integer（1–8） | `3` | 单次检查最多连续压缩几次。 |
| `minIntervalMs` | integer（0–60000） | `1000` | 两次压缩之间的最小间隔（毫秒），防止死循环。 |
| `baseTokens` | number（≥1024） | `262144`（256K） | 分级起点：窗口不超过它就不分级。 |
| `stepCap` | number（≥1024） | `131072`（128K） | 层级单段最大跨度。 |

示例（写入 profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: long-context-budget
      name: 'dsh-long-context-budget'
      config:
        triggerRatio: 0.7
        targetRatio: 0.5
        maxAttempts: 3
```

环境变量（仅 Host 进程）：

| 变量 | 说明 |
| --- | --- |
| `DSH_LCB_MODELS_FILE` | 覆盖按模型预算记忆文件的路径（默认 `~/.dsh/long-context-budget-models.json`）。 |

## 工作原理

- **Host 半边**（`index.js`）—— 把每个会话的预算折进**会话投影 `contextBudget`**：预算来自 `/context-budget` 命令写进日志的 `command/run.args`，窗口来自 `request/context` 事件，模型身份（`provider` / `model`）也一并折入，并用它带出该模型记住的预算 `modelBudget`。首次请求之前，窗口由 Host 在激活时解析默认路由（`agentDefaultModel` + `llm.resolveModelInfo`，带服务就绪重试），解析不出来则退到本进程里已经量到过的窗口。它以 `prepend` 挂到 `agent/pre-step`，抢在宿主自带的 `compaction-basic` 之前执行；触发判定取 `contextPressure.pressureTokens` 与 `tokenMeter.measure()` 的较大值，压缩复用宿主的压缩事务，而不是另写一套。按模型预算记在独立 JSON 文件、节流落盘，损坏也不影响会话。
- **Client 半边**（`client.js`）—— 单文件浏览器模块（不能使用相对导入），渲染进 `conversation.input.right`。它读 `contextBudget` 投影拿预算 / 窗口 / 配置 / 模型身份（窗口另以 `contextPressure` 的真实测量优先），用 `baseTokens / stepCap` 推导档位；窗口依次退到「投影 → `/context-budget-status` → 上次实测缓存（localStorage）→ 通用绝对档位」，所以**首次请求之前也能先设预算**。它读 `contextPressure.projectedTokens ?? pressureTokens` 显示占用，圆点标出 `triggerRatio × budget`，越过触发点变色。统计基准（整窗 / 软上限）只影响分母，选择存 `localStorage`。投影缺席（老 Host）时才退回 `/context-budget-status` 兜底，且同一页面每个会话最多问一次。
- **分级数学**（`tiers.js`）—— 唯一规范实现，两个纯函数都接受可选的 `baseTokens / stepCap`。`client.js` 保留一份逐字相同的副本；`scripts/check-tier-math.mjs` 会在默认与两组自定义配置下，对一批窗口逐一比对两份实现。

设上下文窗口为 `W`：

| 窗口 `W` | 步长 | 档位 |
| --- | --- | --- |
| `W ≤ 256K` | — | `[W]`（滑杆不可用） |
| `256K < W ≤ 512K` | `(W − 256K) / 2` | 256K、256K+step、`W` |
| `W > 512K` | `128K` | 256K、384K、512K、…、`W` |

## 包结构

| 路径 | 说明 |
| --- | --- |
| `index.js` | Host 半边：`contextBudget` 会话投影、`agent/pre-step` 执行、按模型预算记忆、`/context-budget` 命令、Config 模式 |
| `client.js` | Client 半边：触发件、占用读数与触发点、预算滑杆、投影读取与命令通道 |
| `tiers.js` | 分级数学规范实现 |
| `cordis.patch.yml` | 插件注册补丁，由 `dsh.bundle.patch` 引用 |
| `locale/zh.json`、`locale/en.json` | `long-context-budget` locale 命名空间的中英词条 |
| `icon.svg` | 插件图标 |
| `CHANGELOG.md` | 更新日志（只写功能） |
| `scripts/` | 分级数学校验、pre-step 钩子测试、滑杆测试、客户端挂载测试，以及本地调试探针 |

### 导出

| 说明符 | 文件 | 备注 |
| --- | --- | --- |
| `dsh-long-context-budget` | `index.js` | Host 入口；具名导出 `Config`、`inject`、`apply`、`BASE_TOKENS` |
| `dsh-long-context-budget/client` | `client.js` | 由宿主模块加载器加载的 Client bundle |
| `dsh-long-context-budget/locale/*.json` | `locale/*` | `zh` / `en` 词条 |
| `dsh-long-context-budget/icon` | `icon.svg` | 插件图标 |

## 开发

```bash
node scripts/check-tier-math.mjs        # 校验 Host 与 Client 两份分级公式一致
node scripts/test-pre-step-hook.mjs     # 验证 pre-step 预算执行逻辑与真实口径触发
node scripts/test-budget-slider.mjs     # 验证滑杆 / 占用条 / 触发点渲染与投影路径
node scripts/test-client-projection.mjs # 验证挂载不发命令、老 Host 兼容与旧预算迁移
```

`probe-*.mjs` 与 `read-asar-file.mjs` 是面向本地运行中 DSH 实例的调试辅助脚本，不属于运行时，也不会打进 npm 包。

## 兼容性

- DSH `>=0.2.0 <0.3.0`（声明在 `engines.dsh`）。
- 在 Windows 上基于 DSH 0.2.2-rc.1 构建与测试；Client 半边面向 Web GUI。
- Host 半边只依赖 DSH 的公开服务（`commands`、`sessions`、`agentPresets`、`tokenMeter`、`llm`），不发起任何网络请求。

## 中英文界面

- `locale/zh.json` / `locale/en.json` 的 `meta.title` / `meta.description` 由插件管理器与设置页读取（无需激活插件即可显示名称与说明）。
- `client.js` 在运行时把内置的 `DICTIONARIES.zh / DICTIONARIES.en` 注册到宿主 locale 命名空间 `long-context-budget`；locale 服务、命名空间或某个 key 缺失时，同一份词典也是兜底。两份 locale JSON 里的 UI 词条与内置词典保持一致（仅作静态资源与文档用途）。
- 宿主跟随当前界面语言（中文 → `zh`，其它语言 → `en`）。
- Host 侧的命令提示与 Config 描述采用中英双语，任何语言下都可读。

## 更新日志

完整更新日志见 [CHANGELOG.md](CHANGELOG.md)（只写功能）。最近一版摘要：

- **0.2.11** —— 真实口径触发、按模型记住预算、状态诊断（v3）、上下文占用读数与统计基准切换、占用条上的触发点圆点、面板布局调整。
- **0.2.10** —— README 拆成中英两份。
- **0.2.9** —— 按会话预算、档位滑杆、首次请求前可设、下一步开始前压缩、配置随宿主下发、面板不刷聊天记录、中英双语界面。

## 链接

- npm：<https://www.npmjs.com/package/dsh-long-context-budget>
- GitHub：<https://github.com/ASCII-58/long-context-budget>
- 反馈：<https://github.com/ASCII-58/long-context-budget/issues>
- DSH：<https://github.com/deepseek-ai/deepseek-harness>

## 许可

MIT — 见 [LICENSE](LICENSE)。
