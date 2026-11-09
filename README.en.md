# dsh-long-context-budget

English | [简体中文](README.md)

[![npm](https://img.shields.io/npm/v/dsh-long-context-budget?logo=npm)](https://www.npmjs.com/package/dsh-long-context-budget)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0%20%3C0.3.0-3b82f6)](https://github.com/deepseek-ai/deepseek-harness)
[![GitHub](https://img.shields.io/github/stars/ASCII-58/long-context-budget?logo=github)](https://github.com/ASCII-58/long-context-budget)

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin published on npm: a **per-session context budget** on the composer. When the context crosses the trigger point, the oldest history is pruned and compacted **before the next step**. Budgets are remembered across sessions per model, and the panel shows live occupancy plus the compaction trigger.

---

## Features

- **Discrete tier slider** — a compact trigger and a Claude Code–style slider at `conversation.input.right`, with continuous drag, magnetic snapping and a direction-aware value transition. Tiers are derived from the model window by `min(128K, (W − 256K) × 0.5)`, with the full window as the last tier; windows at or below 256K need no tiers.
- **Compaction before the next step** — before every `agent/pre-step`, the packed context is checked: once it crosses `triggerRatio × budget`, a zero-cost tool-result prune runs first, then the host compaction summarizes the oldest history toward `targetRatio × budget` (the retained tail also has a 64K floor). Any error is logged only — the conversation is never blocked.
- **Real-prompt trigger** — the decision takes the larger of the provider-reported prompt size (`contextPressure.pressureTokens`) and the local `tokenMeter.measure()` estimate. The host's `chars / 4` heuristic undercounts CJK text and alone would miss the trigger; surface removed by pruning or compaction is subtracted from the provider snapshot so one step cannot compact repeatedly.
- **Per-model budget memory** — the budget you set on a model is persisted to `~/.dsh/long-context-budget-models.json`; a new session on the same model applies it automatically, and setting 0 clears that model's memory. Only the set value is stored — no usage statistics.
- **Usable before the first request** — a brand-new session with no measured window can still pick a budget: the window falls back through projection → `/context-budget-status` → the last measured window → a generic ladder (`128K/256K/512K/1M`), and the host realigns it once the real window arrives.
- **Usage readout** — the panel shows current occupancy, percentage and a bar; the top-right toggle switches the denominator between "full window / soft cap" (soft cap by default, choice kept in `localStorage`). It changes the readout only, never the trigger.
- **Trigger dot on the bar** — the trigger point is not a separate line but a dot on the usage bar: its position follows the selected basis, hovering shows the trigger length, and once crossed the fill turns amber and the dot red (over 100% stays red).
- **Status diagnostics** — `/context-budget-status` returns v3: `lastDecision` explains why a step did or did not compact; `model` / `modelBudget` report the budget remembered for the current model.
- **Opt-in behaviour** — without a budget, the plugin does nothing at all.
- **Bilingual UI** — Chinese and English strings, with a built-in fallback dictionary.

## Requirements

| Requirement | Version |
| --- | --- |
| DeepSeek Harness (DSH) | `>=0.2.0 <0.3.0` |
| Node.js (development only) | `>=22.12` |

## Installation

### From npm (recommended)

```bash
dsh plugin add dsh-long-context-budget
```

Optionally pin a profile:

```bash
dsh plugin --profile web add dsh-long-context-budget
```

Restart DSH afterwards. The package carries its own `cordis.patch.yml` and registers itself through `dsh.bundle.patch`; no manual patch editing is required.

### From source

1. Clone the repository and install dependencies:

   ```bash
   git clone https://github.com/ASCII-58/long-context-budget.git
   cd long-context-budget
   pnpm install
   ```

2. Register the folder in your profile's `cordis.patch.yml` (or a profile dependency pointing at the checkout):

   ```yaml
   - insert:
       - id: long-context-budget
         name: 'dsh-long-context-budget'
         config: {}
   ```

3. Restart or reload DSH. Client-plugin changes hot-reload only while `pnpm run dev:web` runs from the DSH checkout; otherwise rebuild the Web artifacts and refresh.

## Quick start

1. Click the **Context (上下文)** trigger to the right of the composer.
2. The upper half is **context usage**: current occupancy / percentage / bar; the dot is the compaction trigger (hover for the exact length). The top-right button switches the "full window / soft cap" basis.
3. The lower half is the **budget slider**: drag to pick a tier (Tighter → Roomier → Full window); the change takes effect on the next step. The top tier means "no extra limit".
4. Keep chatting. Before each step, the host compacts only when the trigger is crossed. A new session on the same model automatically reuses the budget you set last time.

> In a brand-new session the window may not be measured yet, and the slider still works:
> it offers a generic ladder (128K / 256K / 512K / 1M) and the panel footer says the
> window is estimated (or not measured yet). After the first request the real tiers and
> the full window replace them.
>
> **The host half only loads when DSH starts**: after upgrading the plugin or editing
> `index.js` you must restart DSH, otherwise the old code keeps running. A page refresh
> (or HMR) is enough for the client half.

The selected tier is sent to the host through the `/context-budget` command. You can also use the command directly:

```text
/context-budget 655360     # request 640K; the host snaps down to the largest tier at or below it
/context-budget 0          # clear the per-session budget and the model's memory
/context-budget-status     # debug: budget, window, settings, last decision and model memory (JSON v3)
```

> The command names `context-budget` / `context-budget-status` and the projection key
> `contextBudget` are a fixed Host↔Client contract, not configurable: the Client is a
> single-file module with no access to the config and no way to discover them at
> runtime. The requested value is snapped down to a tier, so the number you type is not
> necessarily the effective budget.
>
> **The panel does not run commands in steady state.** Budget, window, settings, model
> identity and the remembered budget are published as the session projection
> `contextBudget`, and the client reads that projection. Calling status on every mount
> writes a `command/run` + `command/done` pair — one visible chat row — which is exactly
> the duplicate-log spam users saw. The one exception is **a new session on the same
> model**: to put the remembered budget into the session log, mounting sends one
> `/context-budget` (the projection takes over afterwards). `context-budget-status`
> is only a fallback (older host / registration failure) and a debugging aid.

## Configuration

Every option is validated and clamped by the host. Defaults are safe; only change them if you know what you need.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch. When off, the plugin never intervenes. |
| `triggerRatio` | number (0.05–0.95) | `0.7` | Fraction of the session budget that triggers compaction. |
| `targetRatio` | number (0.05–0.9) | `0.5` | Fraction the packed context is compacted down toward (the retained tail also has a 64K floor). |
| `maxAttempts` | integer (1–8) | `3` | Maximum consecutive compaction attempts per check. |
| `minIntervalMs` | integer (0–60000) | `1000` | Minimum interval between compactions, to avoid loops. |
| `baseTokens` | number (≥1024) | `262144` (256K) | Tier base: context windows at or below this are not tiered. |
| `stepCap` | number (≥1024) | `131072` (128K) | Maximum span of a single tier step. |

Example (in your profile's `cordis.patch.yml`):

```yaml
- insert:
    - id: long-context-budget
      name: 'dsh-long-context-budget'
      config:
        triggerRatio: 0.7
        targetRatio: 0.5
        maxAttempts: 3
```

Environment variable (host process only):

| Variable | Description |
| --- | --- |
| `DSH_LCB_MODELS_FILE` | Override the path of the per-model budget memory file (default `~/.dsh/long-context-budget-models.json`). |

## How it works

- **Host half** (`index.js`) — folds each session's budget into the **session projection `contextBudget`**: the budget comes from `command/run.args` written by `/context-budget`, the window from `request/context`, and the model identity (`provider` / `model`) is folded in too so the view can carry that model's remembered budget `modelBudget`. Before the first request, the window is resolved from the default route at activation (`agentDefaultModel` + `llm.resolveModelInfo`, with service-readiness retries) and falls back to a window already measured in this process. It hooks `agent/pre-step` with `prepend` to run before the host's own `compaction-basic`. The trigger takes the larger of `contextPressure.pressureTokens` and `tokenMeter.measure()`, and compaction reuses the host's compaction transaction rather than inventing a new one. Per-model budgets live in a separate JSON file with throttled writes, so a corrupt file cannot affect a session.
- **Client half** (`client.js`) — a single-file browser module (no relative imports), rendered into `conversation.input.right`. It reads the `contextBudget` projection for budget / window / settings / model identity (with `contextPressure`'s real measurement taking priority for the window) and derives tiers from `baseTokens / stepCap`. The window falls back through projection → `/context-budget-status` → last measured window (localStorage) → generic absolute tiers, so **a budget can be set before the first request**. It reads `contextPressure.projectedTokens ?? pressureTokens` for occupancy, draws the `triggerRatio × budget` dot and changes colour once the trigger is crossed. The "full window / soft cap" basis only changes the denominator and is kept in `localStorage`. When the projection is absent (older host), it falls back to `/context-budget-status` at most once per session per page.
- **Tier math** (`tiers.js`) — the single normative implementation; both pure functions accept optional `baseTokens / stepCap`. `client.js` keeps a byte-for-byte copy, and `scripts/check-tier-math.mjs` compares both against a batch of windows under the default and two custom configs.

For a context window `W`:

| Window `W` | Step | Tiers |
| --- | --- | --- |
| `W ≤ 256K` | — | `[W]` (slider disabled) |
| `256K < W ≤ 512K` | `(W − 256K) / 2` | 256K, 256K+step, `W` |
| `W > 512K` | `128K` | 256K, 384K, 512K, …, `W` |

## Package layout

| Path | Description |
| --- | --- |
| `index.js` | Host half: `contextBudget` projection, `agent/pre-step` enforcement, per-model budget memory, `/context-budget` command, Config schema |
| `client.js` | Client half: trigger, usage readout and trigger dot, budget slider, projection reading and command channel |
| `tiers.js` | Normative tier math |
| `cordis.patch.yml` | Registration patch referenced by `dsh.bundle.patch` |
| `locale/zh.json`, `locale/en.json` | Chinese / English strings for the `long-context-budget` locale namespace |
| `icon.svg` | Plugin icon |
| `CHANGELOG.md` | Changelog (features only) |
| `scripts/` | Tier-math check, pre-step hook tests, slider tests, client mount tests, and local debug probes |

### Exports

| Specifier | File | Note |
| --- | --- | --- |
| `dsh-long-context-budget` | `index.js` | Host entry; named exports `Config`, `inject`, `apply`, `BASE_TOKENS` |
| `dsh-long-context-budget/client` | `client.js` | Client bundle loaded by the host module loader |
| `dsh-long-context-budget/locale/*.json` | `locale/*` | `zh` / `en` strings |
| `dsh-long-context-budget/icon` | `icon.svg` | Plugin icon |

## Development

```bash
node scripts/check-tier-math.mjs        # verify the two tier formulas agree
node scripts/test-pre-step-hook.mjs     # verify pre-step enforcement and the real-prompt trigger
node scripts/test-budget-slider.mjs     # verify slider / usage bar / trigger dot rendering and the projection path
node scripts/test-client-projection.mjs # verify mount issues no command, older-host fallback and budget migration
```

`probe-*.mjs` and `read-asar-file.mjs` are debug helpers for a locally running DSH instance; they are not part of the runtime and are not shipped in the npm package.

## Compatibility

- DSH `>=0.2.0 <0.3.0` (declared in `engines.dsh`).
- Built and tested on Windows against DSH 0.2.2-rc.1; the client half targets the Web GUI.
- The host half depends only on DSH public services (`commands`, `sessions`, `agentPresets`, `tokenMeter`, `llm`) and makes no network requests.

## Internationalization

- `meta.title` / `meta.description` in `locale/zh.json` / `locale/en.json` are read by the plugin manager and settings page (the name and description show even when the plugin is not active).
- `client.js` registers its built-in `DICTIONARIES.zh / DICTIONARIES.en` into the host's `long-context-budget` locale namespace at runtime; the same dictionaries are the fallback when the locale service, namespace or a key is missing. The UI strings in the two locale JSON files are kept in sync as static assets and documentation.
- The host follows the UI language (Chinese → `zh`, anything else → `en`).
- Command replies and Config descriptions on the host side are bilingual, readable in either language.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full feature-only changelog. Recent entries:

- **0.2.11** — real-prompt trigger, per-model budget memory, v3 status diagnostics, usage readout with a basis toggle, trigger dot on the bar, panel layout swap.
- **0.2.10** — README split into Chinese and English files.
- **0.2.9** — per-session budget, tier slider, usable before the first request, compaction before the next step, config-driven settings, no chat rows from the panel, bilingual UI.

## Links

- npm: <https://www.npmjs.com/package/dsh-long-context-budget>
- GitHub: <https://github.com/ASCII-58/long-context-budget>
- Issues: <https://github.com/ASCII-58/long-context-budget/issues>
- DSH: <https://github.com/deepseek-ai/deepseek-harness>

## License

MIT — see [LICENSE](LICENSE).
