# dsh-long-context-budget

[English](README.md) | [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-long-context-budget?logo=npm)](https://www.npmjs.com/package/dsh-long-context-budget)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0%20%3C0.3.0-3b82f6)](https://github.com/deepseek-ai/deepseek-harness)
[![GitHub](https://img.shields.io/github/stars/ASCII-58/long-context-budget?logo=github)](https://github.com/ASCII-58/long-context-budget)

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin published on npm: a **per-session context budget** on the composer. Pick a budget tier once; when the context grows past it, the oldest history is pruned and compacted **before the next step**, so every request fits — without interrupting the session.

---

## Features

- **Composer control** — a compact trigger and a Claude Code–style discrete tier slider, injected at `conversation.input.right`.
- **Budget enforcement** — before every `agent/pre-step`, if the packed context exceeds `triggerRatio × budget`, a zero-cost tool-result prune runs first; only then does the host compaction summarize the oldest history toward `targetRatio × budget`.
- **Discrete tiers** — tiers are derived from the model's context window by `min(128K, (W − 256K) × 0.5)`, with the full window as the last tier. Windows at or below 256K need no tiers.
- **Opt-in behaviour** — without a budget, the plugin does nothing at all.
- **Bilingual UI** — Chinese and English strings, with a built-in fallback dictionary.

## Requirements

| Requirement | Version |
| --- | --- |
| DeepSeek Harness (DSH) | `>=0.2.0 <0.3.0` |
| Node.js (development only) | `>=22.12` |
| Platform | DSH Web (the client half targets `web`) |

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
2. Pick a tier on the slider (Tighter → Roomier → Full window). The panel also shows the 70% trigger point and notes that the change takes effect on the next step.
3. Keep chatting. Before each step, the host checks the packed context and compacts only when the budget is exceeded. The top tier means "no extra limit".

The selected tier is sent to the host through the `/context-budget` command. You can also use the command directly:

```text
/context-budget 640000     # set a 640k-token budget for this session
/context-budget 0          # clear the per-session budget
/context-budget-status     # report the effective budget
```

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

- **Host half** (`index.js`) — keeps the chosen budget per session in memory, mirrored to the client's `localStorage`. It hooks `agent/pre-step` with `prepend` so it runs before the stock `compaction-basic`; the host's own compaction transaction is reused rather than reimplemented. Any failure is logged and the step continues — compaction is an optimization and must never block a turn.
- **Client half** (`client.js`) — a single-file browser module (no relative imports), rendered into `conversation.input.right`. It reads only the `contextWindow` field of the context-pressure projection, derives tiers locally, and talks to the host exclusively through the `/context-budget` command channel.
- **Tier math** (`tiers.js`) — the canonical implementation. `client.js` keeps a byte-identical copy; `scripts/check-tier-math.mjs` compares both over a batch of windows on every run.

For a context window `W`:

| Window `W` | Step | Tiers |
| --- | --- | --- |
| `W ≤ 256K` | — | `[W]` (slider disabled) |
| `256K < W ≤ 512K` | `(W − 256K) / 2` | 256K, 256K+step, `W` |
| `W > 512K` | `128K` | 256K, 384K, 512K, … , `W` |

## Package layout

| Path | Purpose |
| --- | --- |
| `index.js` | Host half: budget state, `agent/pre-step` enforcement, `/context-budget` command, Config schema |
| `client.js` | Client half: composer trigger, budget slider, command channel |
| `tiers.js` | Canonical tier math |
| `cordis.patch.yml` | Plugin registration patch, referenced by `dsh.bundle.patch` |
| `locale/zh.json`, `locale/en.json` | UI strings for the `long-context-budget` locale namespace |
| `icon.svg` | Plugin icon |
| `scripts/` | Tier-math check, pre-step hook test, slider test, and local debugging probes |

### Exports

| Specifier | File | Notes |
| --- | --- | --- |
| `dsh-long-context-budget` | `index.js` | Host entry; named exports `Config`, `inject`, `apply`, `DEFAULTS` |
| `dsh-long-context-budget/client` | `client.js` | Client bundle loaded by the host module loader |
| `dsh-long-context-budget/locale/*.json` | `locale/*` | `zh` / `en` dictionaries |
| `dsh-long-context-budget/icon` | `icon.svg` | Plugin icon |

## Development

```bash
node scripts/check-tier-math.mjs        # verify host and client tier math agree
node scripts/test-pre-step-hook.mjs     # exercise pre-step budget enforcement
node scripts/test-budget-slider.mjs     # exercise the budget slider logic
```

The `probe-*.mjs` and `read-asar-file.mjs` scripts are local debugging helpers aimed at a running DSH instance; they are not part of the runtime and are not shipped in the npm tarball.

## Compatibility

- DSH `>=0.2.0 <0.3.0` (declared in `engines.dsh`).
- Built and tested against DSH 0.2.2-rc.1 on Windows; the client half targets the Web GUI.
- The host half depends only on public DSH services (`commands`, `sessions`, `agentPresets`, `tokenMeter`, `llm`, `sessionProjections`); it never makes network requests.

## Internationalization

- `locale/zh.json` / `locale/en.json` are registered to the host locale namespace `long-context-budget`.
- `client.js` also ships a built-in `DICTIONARIES.zh / DICTIONARIES.en` fallback, used when the locale service, the namespace, or a key is missing.
- The host follows the active UI language (Chinese → `zh`, anything else → `en`).
- Host-side command hints and Config descriptions are written bilingually so they stay readable in any language.

## Links

- npm: <https://www.npmjs.com/package/dsh-long-context-budget>
- GitHub: <https://github.com/ASCII-58/long-context-budget>
- Issues: <https://github.com/ASCII-58/long-context-budget/issues>
- DSH: <https://github.com/deepseek-ai/deepseek-harness>

## License

MIT — see [LICENSE](LICENSE).
