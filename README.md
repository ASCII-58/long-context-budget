# long-context-budget

[English](README.md) | [简体中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that puts a **per-session context budget** on the composer. A compact trigger opens a discrete tier slider; once the context grows past the chosen budget, the oldest history is pruned and compacted **before the next step**, so every request fits — without interrupting the session.

> This is a DSH plugin, loaded through the host plugin mechanism and `cordis.patch.yml`. It is not a standalone app or an npm library.

## How it works

- **Composer control** (`client.js`): adds a Claude Code–style discrete tier slider to `conversation.input.right`. The trigger shows the active tier; the panel lists the available tiers and the 70% trigger point, and notes that a change takes effect on the next step. The context-window size stays in the tooltip and aria label as a reference.
- **Budget enforcement** (`index.js`): remembers the chosen budget per session (in memory, mirrored to the client's `localStorage`). On every `agent/pre-step`, if the whole context pack exceeds `0.7 × budget`, it first runs a zero-cost tool-result prune; if that is not enough, it calls the host's `compaction.compactRegion` to summarize the oldest history down toward `0.5 × budget`, then resumes the session. When no budget is set, the plugin stays out of the way entirely.
- **Tier math** (`tiers.js`): one canonical implementation. For a context window `W > 256K`, the step is `min(128K, (W − 256K) × 0.5)`; tiers span `[256K, W]`, with the full window as the last tier. `client.js` keeps a byte-identical copy (the client half is a single-file browser module and cannot use relative imports); `scripts/check-tier-math.mjs` compares both copies over a batch of windows to catch drift.

## Install

### From npm

```bash
dsh plugin --profile web add dsh-long-context-budget
```

Restart DSH afterwards; the package registers itself through `cordis.patch.yml`.

### From source

1. Copy this folder into your DSH plugins directory (the workspace `plugins/` folder), e.g. `E:\plugins\long-context-budget`.
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Register it in `cordis.patch.yml` (the included file already does this):
   ```yaml
   - insert:
       - id: long-context-budget
         name: 'dsh-long-context-budget'
         config: {}
   ```
4. Restart or reload DSH so the patch and client bundle are picked up. Client-plugin changes reload without a refresh only while `pnpm run dev:web` runs from the DSH checkout; otherwise rebuild the Web artifacts and refresh.

## Use

- Click the **Context (上下文)** trigger to the right of the composer to open the budget panel.
- Pick a tier on the slider (Tighter → Roomier → Full window). The choice goes to the host through `/context-budget <token count>`; `0` clears the per-session override.
- Before every step the host enforces the budget as described above. The top tier means "no extra limit".

## Repository layout

| Path | Purpose |
| --- | --- |
| `index.js` | Host half: budget state, `agent/pre-step` enforcement, `/context-budget` command |
| `client.js` | Client half: composer trigger, budget slider, command channel |
| `tiers.js` | Canonical tier math |
| `cordis.patch.yml` | Plugin registration patch |
| `locale/*.json` | zh / en UI strings, registered to the host `long-context-budget` locale namespace |
| `README.zh.md` | Full Chinese documentation |
| `icon.svg` | Plugin icon |
| `scripts/` | Tier-math check, pre-step hook test, budget-slider test, and local UI/debug probes |
| `package.json` | Plugin manifest (`dsh-long-context-budget`, v0.2.1) |

## Scripts

```bash
node scripts/check-tier-math.mjs        # verify host/client tier math agree
node scripts/test-pre-step-hook.mjs     # exercise the pre-step budget enforcement
node scripts/test-budget-slider.mjs     # exercise the budget slider logic
```

The `probe-*.mjs` and `read-asar-file.mjs` scripts are local debugging helpers that target a running DSH instance; they are not part of the plugin runtime.

## Internationalization

The UI ships both Chinese and English strings:

- `locale/zh.json` / `locale/en.json` are registered to the host locale namespace `long-context-budget`.
- `client.js` carries a built-in `DICTIONARIES.zh / DICTIONARIES.en` fallback for when the host locale service, the namespace, or a key is missing.
- The host follows the active UI language (Chinese → zh, anything else → en).
- Host-side command hints, success/error replies and Config descriptions are written bilingually (Chinese / English), so they stay readable under any language without depending on the host locale service.

## License

MIT — see [LICENSE](LICENSE).
