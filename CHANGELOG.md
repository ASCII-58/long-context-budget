# 更新日志

只记功能，不记分类、内部修复与发版流程。完整功能说明见 [README.md](README.md) / [README.en.md](README.en.md)。

版本以 npm 上实际发布的为准；0.2.4–0.2.8 是开发过程中的提交，没有单独发版，功能汇总在 0.2.9。

## 0.2.11（未发布）

- **真实口径触发** —— 触发判定取 provider 上报的提示词大小（`contextPressure.pressureTokens`）与本地 `tokenMeter.measure()` 估算的较大值。宿主的 `chars / 4` 估算对中文偏小，只看它会漏触发。剪枝与压缩缩掉的 surface 量会从提供方快照里扣除，避免同一轮反复压。
- **按模型记住预算** —— 每个模型设过的预算记在 `~/.dsh/long-context-budget-models.json`（可用 `DSH_LCB_MODELS_FILE` 覆盖路径）；同模型的新会话挂载时自动套用，设成 0 即取消该模型的记忆。记录只含设置值，不含用量统计。
- **投影与状态诊断** —— `contextBudget` 投影增加 `provider` / `model` / `modelBudget`；`/context-budget-status` 升到 v3，返回 `lastDecision`（`action` / `measured` / `pressure` / `total` / `triggerAt` / `targetAt`）与 `model` / `modelBudget`，可以直接看出某一步为什么压或没压。
- **上下文占用读数** —— 面板显示当前计入、占比与占用条；标题栏右上角的「整窗 / 软上限」切换只改读数口径，不改触发行为，选择记在 `localStorage`。
- **占用条上的触发点** —— 触发点不再单独成行，改为占用条上的一个圆点：位置按当前统计基准换算，悬停显示触发长度；占用越过触发点时填充变琥珀色、圆点变红，超过 100% 时保持红色。
- **面板布局** —— 上下文占用区在上，预算滑杆区在下。
- **词条** —— 移除 `budget.trigger`，新增 `usage.title` / `usage.basis` / `usage.line` / `usage.trigger` 等中英词条。

## 0.2.10

- README 拆成中英两份（`README.md` / `README.en.md`），替换 npm 页面上的旧版说明；包元数据同步。

## 0.2.9

- **按会话的上下文预算** —— 在输入框右侧为当前会话选一个预算；不设预算时插件完全不介入。
- **档位滑杆** —— 档位由模型窗口按 `min(128K, (W − 256K) × 0.5)` 推出，最后一级是整窗；连续拖动、靠近刻度磁性吸附、档位文案按方向滑入。窗口不超过 256K 时无需分级。
- **首次请求之前就能设** —— 窗口还没量到时也给出可选档位（128K / 256K / 512K / 1M），并标明是估算值；第一次请求完成后自动换成当前模型的真实档位。
- **下一步开始前压缩** —— 上下文一旦超过触发比例（默认 70%），先做零成本 tool-result 剪枝，仍然超标才把最早的历史压向目标比例（默认 50%），全程不打断会话。
- **配置随宿主下发** —— `triggerRatio` / `targetRatio` / `baseTokens` / `stepCap` / `maxAttempts` / `minIntervalMs` 可调，档位、触发比例与触发点跟着变。
- **面板不刷聊天记录** —— 预算、窗口与配置通过会话投影 `contextBudget` 下发，面板挂载不执行任何命令；预算从会话日志派生，Host 重启后自动恢复。
- **中英双语界面** —— 内置中英文词条，缺词条时退回内置词典。
