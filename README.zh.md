# long-context-budget

为 [DeepSeek Harness](https://github.com/)（DSH）设计的客户端插件，提供**按会话的上下文预算**控制：在输入框右侧放一枚紧凑触发件，用离散档位滑杆选择预算档；当上下文增长到超过所选预算时，在下一步 agent 请求开始前自动压缩最早的历史。

> 这是 DSH 插件，通过宿主插件机制 / `cordis.patch.yml` 加载，不是独立应用，也不是 npm 库。

## 功能

- **Client 半边**（`client.js`）：在 `conversation.input.right` 注入一个 Claude Code 风格的离散档位滑杆。触发件显示当前生效档位；面板列出可选预算档与 70% 触发点，并提示「下一步请求生效」。
- **Host 半边**（`index.js`）：按会话记住所选预算（进程内 `Map`，并镜像到客户端 `localStorage`）。在每次 `agent/pre-step`，若整包上下文超过 `0.7 × 预算`，先做零成本的 tool-result 剪枝；仍超标则调用宿主自己的 `compaction.compactRegion` 把最旧历史压成摘要、目标降到 `0.5 × 预算`，然后继续会话、不打断。未设置预算时插件完全不介入。
- **分级数学**（`tiers.js`）：唯一规范实现。上下文窗口 `W > 256K` 时，步长 `min(128K, (W − 256K) × 0.5)`；层级覆盖 `[256K, W]`，最后一级为整窗。`client.js` 内联一份逐字相同的公式副本（Client 是单文件浏览器模块、无法使用相对导入），`scripts/check-tier-math.mjs` 会把两份实现对同一批窗口逐一比对，防止漂移。

## 安装

1. 把本文件夹复制到 DSH 的插件目录（工作区 `plugins/` 下），例如 `E:\plugins\long-context-budget`。
2. 安装依赖：
   ```bash
   pnpm install
   ```
3. 在 `cordis.patch.yml` 中注册插件（仓库自带的文件即为此内容）：
   ```yaml
   - insert:
       - id: long-context-budget
         name: '@local/dsh-long-context-budget'
         config: {}
   ```
4. 重载 / 重启 DSH，使补丁与 client bundle 生效。Client 插件改动只有在 DSH 源码树里同时运行 `pnpm run dev:web` 时才会免刷新热重载；否则需要重建受影响的前端产物并刷新页面。

## 使用

- 点击输入框右侧的 **上下文 / Context** 触发件，打开预算面板。
- 拖动滑杆到某个档位（更省 → 更宽 / 整窗）。所选档位通过 `/context-budget <token 数>` 命令送到 Host；`0` 表示取消该会话的预算覆盖。
- Host 在每一步请求前按上文规则执行压缩。最高档等于「不额外限制」。

## 中英文界面

插件的界面文案同时提供中文与英文：

- `locale/zh.json` / `locale/en.json`：注册到宿主 locale 命名空间 `long-context-budget` 的词表。
- `client.js` 内置 `DICTIONARIES.zh / DICTIONARIES.en` 兜底词典：宿主 locale 服务不可用、命名空间未注册或某个 key 缺失时自动退回。
- 宿主跟随当前界面语言（中文 → 中文词条，其它语言 → 英文词条）。
- Host 侧的命令提示、成功/错误返回文案与设置项描述采用**中英双语并列**，不依赖宿主 locale 服务，任何语言下都能读懂。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `index.js` | Host 半边：预算状态、`agent/pre-step` 执行、`/context-budget` 命令 |
| `client.js` | Client 半边：触发件、预算滑杆、命令通道 |
| `tiers.js` | 分级数学规范实现 |
| `cordis.patch.yml` | 插件注册补丁 |
| `locale/*.json` | 中文 / 英文界面词条 |
| `icon.svg` | 插件图标 |
| `scripts/` | 分级数学校验、pre-step 钩子测试、滑杆测试、本地 UI/调试探针 |
| `package.json` | 插件清单（`@local/dsh-long-context-budget`，v0.2.0） |

## 脚本

```bash
node scripts/check-tier-math.mjs        # 校验 Host/Client 两份分级公式一致
node scripts/test-pre-step-hook.mjs     # 验证 pre-step 预算执行逻辑
node scripts/test-budget-slider.mjs     # 验证预算滑杆渲染与交互
```

`probe-*.mjs` 与 `read-asar-file.mjs` 是面向本地运行中的 DSH 实例的调试辅助脚本，不属于插件运行时。

## 许可

MIT — 见 [LICENSE](LICENSE)。
