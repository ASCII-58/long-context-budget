# dsh-long-context-budget

[English](README.md) | [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-long-context-budget?logo=npm)](https://www.npmjs.com/package/dsh-long-context-budget)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0%20%3C0.3.0-3b82f6)](https://github.com/deepseek-ai/deepseek-harness)
[![GitHub](https://img.shields.io/github/stars/ASCII-58/long-context-budget?logo=github)](https://github.com/ASCII-58/long-context-budget)

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin published on npm: a **per-session context budget** on the composer. Pick a budget tier once; when the context grows past it, the oldest history is pruned and compacted **before the next step**, so every request fits — without interrupting the session.

---

## Features

- **Composer control** — a compact trigger and a Claude Code–style discrete tier slider at `conversation.input.right`, with continuous drag, magnetic snapping to tiers and a direction-aware value transition.
- **Budget enforcement** — before every `agent/pre-step`, if the packed context exceeds `triggerRatio × budget`, a zero-cost tool-result prune runs first; only then does the host compaction summarize the oldest history toward `targetRatio × budget`.
- **Discrete tiers** — tiers are derived from the model's context window by `min(128K, (W − 256K) × 0.5)`, with the full window as the last tier. Windows at or below 256K need no tiers.
- **Usable before the first request** — a brand-new session with no measured window can still pick a budget: the window falls back through projection → `/context-budget-status` → the last measured window → a generic ladder (`128K/256K/512K/1M`), and the host realigns it once the real window arrives.
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
2. Pick a tier on the slider (Tighter → Roomier → Full window). The panel also shows the trigger point for the current trigger ratio (70% by default, following the host config) and notes that the change takes effect on the next step.
3. Keep chatting. Before each step, the host checks the packed context and compacts only when the budget is exceeded. The top tier means "no extra limit".

> In a brand-new session the window may not be measured yet, and the slider still works:
> it offers a generic ladder (128K / 256K / 512K / 1M) and the panel footer says the
> window is estimated (or not measured yet). After the first request the real tiers and
> the full window replace them.
> One prerequisite is worth knowing: **the host half only loads when DSH starts**, so
> after upgrading the plugin or editing `index.js` you must restart DSH — otherwise the
> old code keeps running.

The selected tier is sent to the host through the `/context-budget` command. You can also use the command directly:

```text
/context-budget 655360     # request 640K; the host snaps down to the largest tier at or below it
/context-budget 0          # clear the per-session budget
/context-budget-status     # debug: effective budget, window and the settings sent to the UI (JSON)
```

> The command names `context-budget` / `context-budget-status` and the projection key
> `contextBudget` are a fixed Host↔Client contract, not configurable: the Client is a
> single-file module with no access to the config and no way to discover them at
> runtime. The requested value is snapped down to a tier, so the number you type is not
> necessarily the effective budget.
>
> **The panel does not run commands in steady state.** The budget, the context window and
> the settings are published as the session projection `contextBudget`, and the client
> reads that projection. Calling status on every mount writes a `command/run` +
> `command/done` pair — one visible chat row — which is exactly the duplicate-log spam
> users saw. `context-budget-status` is only a fallback (older host / registration
> failure) and a debugging aid.

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

## How it works

- **Host half** (`index.js`) — folds each session's budget into the **session projection `contextBudget`**: the budget comes from the `command/run.args` the `/context-budget` command writes to the log, the window from `request/context` events, and before the first request the window is resolved at activation from the default route (`agentDefaultModel` + `llm.resolveModelInfo`, with a service-readiness retry); if that resolution fails it falls back to a window already measured in this process. It hooks `agent/pre-step` with `prepend` so it runs before the stock `compaction-basic`; the host's own compaction transaction is reused rather than reimplemented. Any failure is logged and the step continues — compaction is an optimization and must never block a turn. Because the budget is log-derived, it survives a host restart.
- **Client half** (`client.js`) — a single-file browser module (no relative imports), rendered into `conversation.input.right`. It reads the `contextBudget` projection for the budget, window and settings (a measured `contextPressure` window wins when available) and derives tiers from `baseTokens / stepCap`; the window itself falls back through projection → `/context-budget-status` → the last measured window (localStorage) → a generic absolute ladder, so **a budget can be set before the first request** and the host realigns it once the real window arrives. It sends `/context-budget` **only when the user changes a tier**, so mounting produces no command and no chat row. Only when the projection is absent (older host) does it fall back to `/context-budget-status`, at most once per page and session.
- **Tier math** (`tiers.js`) — the canonical implementation; both pure functions accept optional `baseTokens / stepCap`. `client.js` keeps a byte-identical copy; `scripts/check-tier-math.mjs` compares both over a batch of windows under the default and two custom configs on every run.

For a context window `W`:

| Window `W` | Step | Tiers |
| --- | --- | --- |
| `W ≤ 256K` | — | `[W]` (slider disabled) |
| `256K < W ≤ 512K` | `(W − 256K) / 2` | 256K, 256K+step, `W` |
| `W > 512K` | `128K` | 256K, 384K, 512K, … , `W` |

## Package layout

| Path | Purpose |
| --- | --- |
| `index.js` | Host half: `contextBudget` session projection, `agent/pre-step` enforcement, `/context-budget` command, Config schema |
| `client.js` | Client half: composer trigger, budget slider, projection reader, command channel |
| `tiers.js` | Canonical tier math |
| `cordis.patch.yml` | Plugin registration patch, referenced by `dsh.bundle.patch` |
| `locale/zh.json`, `locale/en.json` | UI strings for the `long-context-budget` locale namespace |
| `icon.svg` | Plugin icon |
| `scripts/` | Tier-math check, pre-step hook test, slider test, client mount test, and local debugging probes |

### Exports

| Specifier | File | Notes |
| --- | --- | --- |
| `dsh-long-context-budget` | `index.js` | Host entry; named exports `Config`, `inject`, `apply`, `BASE_TOKENS` |
| `dsh-long-context-budget/client` | `client.js` | Client bundle loaded by the host module loader |
| `dsh-long-context-budget/locale/*.json` | `locale/*` | `zh` / `en` dictionaries |
| `dsh-long-context-budget/icon` | `icon.svg` | Plugin icon |

## Development

```bash
node scripts/check-tier-math.mjs        # verify host and client tier math agree
node scripts/test-pre-step-hook.mjs     # exercise pre-step budget enforcement
node scripts/test-budget-slider.mjs     # exercise the budget slider logic (incl. the pre-request projection path)
node scripts/test-client-projection.mjs # mount path: no commands, older-host fallback, legacy budget migration
```

The `probe-*.mjs` and `read-asar-file.mjs` scripts are local debugging helpers aimed at a running DSH instance; they are not part of the runtime and are not shipped in the npm tarball.

## Compatibility

- DSH `>=0.2.0 <0.3.0` (declared in `engines.dsh`).
- Built and tested against DSH 0.2.2-rc.1 on Windows; the client half targets the Web GUI.
- The host half depends only on public DSH services (`commands`, `sessions`, `agentPresets`, `tokenMeter`, `llm`); it never makes network requests.

## Internationalization

- `meta.title` / `meta.description` in `locale/zh.json` / `locale/en.json` are read by Plugin Manager and Settings without activating the plugin (display name and description).
- `client.js` registers its built-in `DICTIONARIES.zh / DICTIONARIES.en` to the host locale namespace `long-context-budget` at runtime; the same dictionaries are the fallback when the locale service, namespace, or a key is missing. The UI strings in the two locale JSON files mirror the built-in dictionaries and serve as static resources / documentation.
- The host follows the active UI language (Chinese → `zh`, anything else → `en`).
- Host-side command hints and Config descriptions are written bilingually so they stay readable in any language.

## Changelog

### 0.2.9

- **Per-session context budget** — pick a budget for the current session from the composer; with no budget set the plugin does nothing at all.
- **Tier slider** — tiers are derived from the model's context window by `min(128K, (W − 256K) × 0.5)`, with the full window as the last tier: continuous drag, magnetic snapping and a direction-aware value transition. Windows at or below 256K need no tiers.
- **Usable before the first request** — when the window has not been measured yet the slider offers 128K / 256K / 512K / 1M and marks them as estimates; the first request replaces them with the model's real tiers.
- **Compaction before the next step** — once the context passes the trigger ratio (70% by default) a zero-cost tool-result prune runs first; only if that is not enough is the oldest history summarized toward the target ratio (50% by default), without interrupting the conversation.
- **Config-driven** — `triggerRatio` / `targetRatio` / `baseTokens` / `stepCap` / `maxAttempts` / `minIntervalMs` are configurable, and tiers, trigger ratio and trigger point follow them.
- **No chat rows from the panel** — the budget, window and settings are published through the `contextBudget` session projection, so mounting the panel sends no command; the budget is derived from the session log and survives a host restart.
- **Bilingual UI** — Chinese and English strings, with a built-in fallback dictionary.

## Links

- npm: <https://www.npmjs.com/package/dsh-long-context-budget>
- GitHub: <https://github.com/ASCII-58/long-context-budget>
- Issues: <https://github.com/ASCII-58/long-context-budget/issues>
- DSH: <https://github.com/deepseek-ai/deepseek-harness>

## License

MIT — see [LICENSE](LICENSE).
