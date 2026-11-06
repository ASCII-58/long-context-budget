# long-context-budget

A [DeepSeek Harness](https://github.com/) client plugin that adds a **per-session context budget** control. It shows a compact trigger on the right side of the composer, lets you pick a discrete context-window tier, and automatically compacts the oldest history before the next agent step when the context grows beyond the chosen budget.

> This is a plugin for DeepSeek Harness (DSH). It is loaded through the host's plugin / `cordis.patch.yml` mechanism; it is not a standalone app or an npm library.

## What it does

- **Client half** (`client.js`): injects a Claude-Code-style discrete tier slider into `conversation.input.right`. The trigger displays the current model's context-window capacity (e.g. `上下文 976.6K`). The panel lists the available budget tiers and the 70% trigger point, and reports "takes effect on the next request".
- **Host half** (`index.js`): remembers the selected budget per session (in memory, mirrored to the client's `localStorage`). On every `agent/pre-step`, if the whole context pack exceeds `0.7 × budget`, it first does a zero-cost tool-result prune; if still over budget, it runs the host's own `compaction.compactRegion` to summarize the oldest history down toward `0.5 × budget`, then continues the session without interruption. When no budget is set, the plugin is completely inert.
- **Tier math** (`tiers.js`): the single canonical implementation. For a context window `W > 256K`, the step is `min(128K, (W − 256K) × 0.5)`; tiers span `[256K, W]` with the full window as the last tier. `client.js` inlines a byte-for-byte copy of this math (the client half is a single-file browser module and cannot use a relative import); `scripts/check-tier-math.mjs` compares both copies against a batch of windows to prevent drift.

## Install

1. Copy this folder into your DSH plugins directory (the workspace `plugins/` folder), e.g. `E:\plugins\long-context-budget`.
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Register the plugin in your `cordis.patch.yml` (the included one does exactly this):
   ```yaml
   - insert:
       - id: long-context-budget
         name: '@local/dsh-long-context-budget'
         config: {}
   ```
4. Reload / restart DSH so the patch and the client bundle are picked up. Client-plugin changes reload without a refresh only while `pnpm run dev:web` is running from the DSH checkout; otherwise rebuild the affected Web artifacts and refresh.

## Usage

- Click the **上下文 / Context** trigger to the right of the composer to open the budget panel.
- Move the slider to a tier (更省 → 更宽 / Full window). The chosen tier is sent to the host via the `/context-budget <token 数>` command; `0` clears the per-session override.
- Before every step, the host enforces the budget as described above. The top tier equals "no extra limit".

## Repository layout

| Path | Purpose |
| --- | --- |
| `index.js` | Host half: budget state, `agent/pre-step` enforcement, `/context-budget` command |
| `client.js` | Client half: composer trigger, budget slider, API wiring |
| `tiers.js` | Canonical tier math |
| `cordis.patch.yml` | Plugin registration patch |
| `locale/*.json` | zh / en UI strings |
| `icon.svg` | Plugin icon |
| `scripts/` | Tier-math check, pre-step hook test, budget-slider test, and local UI/debug probes |
| `package.json` | Plugin manifest (`@local/dsh-long-context-budget`, v0.2.0) |

## Scripts

```bash
node scripts/check-tier-math.mjs        # verify host/client tier math agree
node scripts/test-pre-step-hook.mjs     # exercise the pre-step budget enforcement
node scripts/test-budget-slider.mjs     # exercise the budget slider logic
```

The `probe-*.mjs` and `read-asar-file.mjs` scripts are local debugging helpers that target a running local DSH instance; they are not part of the plugin runtime.

## License

MIT — see [LICENSE](LICENSE).
