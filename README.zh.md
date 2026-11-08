# dsh-long-context-budget

[English](README.md) | [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-long-context-budget?logo=npm)](https://www.npmjs.com/package/dsh-long-context-budget)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0%20%3C0.3.0-3b82f6)](https://github.com/deepseek-ai/deepseek-harness)
[![GitHub](https://img.shields.io/github/stars/ASCII-58/long-context-budget?logo=github)](https://github.com/ASCII-58/long-context-budget)

> 一个发布在 npm 上的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：在输入框旁提供**按会话的上下文预算**。选好预算档位后，一旦上下文超过它，最早的历史会在**下一步开始前**被剪枝并压缩，让每次请求都落在预算之内，且不打断会话。

---

## 功能

- **输入框控件** —— 在 `conversation.input.right` 注入一个紧凑触发件和 Claude Code 风格的离散档位滑杆：拖动连续跟手、靠近刻度磁性吸附，档位文案按方向滑入并轻微模糊。
- **预算执行** —— 每次 `agent/pre-step` 前，若整包上下文超过 `triggerRatio × 预算`，先做零成本的 tool-result 剪枝；仍不够才调用宿主压缩，把最旧的历史压向 `targetRatio × 预算`。
- **离散档位** —— 档位由模型窗口按 `min(128K, (W − 256K) × 0.5)` 推出，最后一级是整窗；窗口不超过 256K 时无需分级。
- **首次请求前就能设** —— 会话刚建、窗口还没量到时也能选档：窗口依次退到「投影 → `/context-budget-status` → 上次实测窗口 → 通用档位 `128K/256K/512K/1M`」，真实窗口到达后由 Host 自动重新对齐。
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
2. 在滑杆上选择档位（更省 → 更宽 → 整窗）。面板同时显示当前触发比例（默认 70%，随配置变化）对应的触发点，并提示改动在下一步生效。
3. 正常对话即可。每一步开始前，Host 会检查整包上下文，只在超出预算时压缩。最高档等于「不额外限制」。

> 会话刚开始、还没量到窗口时，滑杆不会变灰：它先给出通用档位
> （128K / 256K / 512K / 1M），面板脚注会说明窗口是估算的（或尚未测量）；
> 第一次请求完成后自动换成当前模型的真实档位与整窗。
> 已知一个前提：**Host 半边只在 DSH 启动时加载**，升级插件或改 `index.js`
> 后必须重启 DSH，否则仍会跑旧代码。

所选档位通过 `/context-budget` 命令送到 Host，也可以直接使用命令：

```text
/context-budget 655360     # 请求 640K；Host 会向下对齐到不超过它的最大档（1M 窗口下为 640K）
/context-budget 0          # 取消当前会话的预算
/context-budget-status     # 调试用：返回当前生效预算、窗口与下发给 UI 的配置（JSON）
```

> 命令名 `context-budget` / `context-budget-status` 与投影 key `contextBudget`
> 是 Host 与 Client 的固定契约，不是可配置项：Client 是单文件模块，拿不到配置，
> 也无法在运行时发现它们。预算值会向下对齐到分级档位，因此命令里写的数字
> 不一定是最终生效值。
>
> **面板平时不跑命令。** 预算、上下文窗口和配置都由 Host 发布成会话投影
> `contextBudget`，客户端直接读投影 —— 每次挂载都调一次 status 会在聊天记录里
> 留下一行（`command/run` + `command/done`），那正是「重复日志」的来源。
> `context-budget-status` 只在投影缺席（老 Host / 注册失败）或调试时使用。

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

## 工作原理

- **Host 半边**（`index.js`）—— 把每个会话的预算折进**会话投影 `contextBudget`**：预算来自 `/context-budget` 命令写进日志的 `command/run.args`，窗口来自 `request/context` 事件；首次请求之前，窗口由 Host 在激活时解析默认路由（`agentDefaultModel` + `llm.resolveModelInfo`，带服务就绪重试），解析不出来则退到本进程里已经量到过的窗口。它以 `prepend` 挂到 `agent/pre-step`，抢在宿主自带的 `compaction-basic` 之前执行；压缩复用宿主的压缩事务，而不是另写一套。任何异常都只记日志并继续当前步骤 —— 压缩是优化，绝不能阻塞对话。预算是日志派生的，Host 重启后照样恢复。
- **Client 半边**（`client.js`）—— 单文件浏览器模块（不能使用相对导入），渲染进 `conversation.input.right`。它读 `contextBudget` 投影拿预算 / 窗口 / 配置（窗口另以 `contextPressure` 的真实测量优先），用 `baseTokens / stepCap` 推导档位；窗口依次退到「投影 → `/context-budget-status` → 上次实测缓存（localStorage）→ 通用绝对档位」，所以**首次请求之前也能先设预算**，真实窗口到达后再由 Host 对齐。它**只在用户改档位时**发一次 `/context-budget` 命令，挂载阶段不产生任何命令与聊天记录行。投影缺席（老 Host）时才退回 `/context-budget-status` 兜底，且同一页面每个会话最多问一次。
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
| `index.js` | Host 半边：`contextBudget` 会话投影、`agent/pre-step` 执行、`/context-budget` 命令、Config 模式 |
| `client.js` | Client 半边：触发件、预算滑杆、投影读取与命令通道 |
| `tiers.js` | 分级数学规范实现 |
| `cordis.patch.yml` | 插件注册补丁，由 `dsh.bundle.patch` 引用 |
| `locale/zh.json`、`locale/en.json` | `long-context-budget` locale 命名空间的中英词条 |
| `icon.svg` | 插件图标 |
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
node scripts/test-pre-step-hook.mjs     # 验证 pre-step 预算执行逻辑
node scripts/test-budget-slider.mjs     # 验证预算滑杆渲染与交互（含首次请求前读投影）
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

## 更新记录

### 0.2.9

- **按会话的上下文预算** —— 在输入框右侧为当前会话选一个预算；不设预算时插件完全不介入。
- **档位滑杆** —— 档位由模型窗口按 `min(128K, (W − 256K) × 0.5)` 推出，最后一级是整窗；连续拖动、靠近刻度磁性吸附、档位文案按方向滑入。窗口不超过 256K 时无需分级。
- **首次请求之前就能设** —— 窗口还没量到时也给出可选档位（128K / 256K / 512K / 1M），并标明是估算值；第一次请求完成后自动换成当前模型的真实档位。
- **下一步开始前压缩** —— 上下文一旦超过触发比例（默认 70%），先做零成本 tool-result 剪枝，仍然超标才把最早的历史压向目标比例（默认 50%），全程不打断会话。
- **配置随宿主下发** —— `triggerRatio` / `targetRatio` / `baseTokens` / `stepCap` / `maxAttempts` / `minIntervalMs` 可调，档位、触发比例与触发点跟着变。
- **面板不刷聊天记录** —— 预算、窗口与配置通过会话投影 `contextBudget` 下发，面板挂载不执行任何命令；预算从会话日志派生，Host 重启后自动恢复。
- **中英双语界面** —— 内置中英文词条，缺词条时退回内置词典。

## 链接

- npm：<https://www.npmjs.com/package/dsh-long-context-budget>
- GitHub：<https://github.com/ASCII-58/long-context-budget>
- 反馈：<https://github.com/ASCII-58/long-context-budget/issues>
- DSH：<https://github.com/deepseek-ai/deepseek-harness>

## 许可

MIT — 见 [LICENSE](LICENSE)。
