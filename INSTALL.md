# TEX — Installation & Troubleshooting Guide

This is the detailed setup guide for **TEX**, a Claude Code plugin (`tex-browse-use`) that bundles a self-hosted **browse-use** capability: a local agent that drives a *real* browser to operate web apps that have no usable API, MCP, or CLI.

If you just want the short version, jump to [macOS local install](#macos-local-install-the-common-path). For background on *why* TEX exists and how the capability ladder works, see the README. This document is about getting it running and keeping it running.

> **Scope note:** The common, fully-supported path is **local macOS**. The core engine is Node-only and runs headless there without any extra system services. The optional Python tiers (stealth / gateway / a11y) are Linux-oriented and covered briefly at the end under [Advanced: full Linux stack](#advanced-full-linux-stack).

---

## Table of contents

- [Prerequisites](#prerequisites)
- [macOS local install (the common path)](#macos-local-install-the-common-path)
- [Registering with Claude Code (three ways)](#registering-with-claude-code-three-ways)
- [Configuring `.env` — anthropic vs bedrock](#configuring-env--anthropic-vs-bedrock)
- [Verifying the install](#verifying-the-install)
- [Troubleshooting](#troubleshooting)
- [Advanced: full Linux stack](#advanced-full-linux-stack)
- [Honest status](#honest-status)

---

## Prerequisites

| Requirement | Needed for | Notes |
|---|---|---|
| **Node.js 20+** | The core engine | Verified working on **Node 25 with tsx 4.22.4**. The engine entry point is `stack/src/server.ts`, run via `node --import tsx/esm src/server.ts` — **tsx runs the TypeScript directly, so there is no build step.** You never compile the engine. |
| **Playwright Chromium** | Driving the real browser | Install the Node browser binary: `npx playwright install chromium` (run from inside `stack/`). On Linux you may also want the Python one (`playwright install chromium`); on macOS the Node binary is the one that matters. |
| **Python 3.11+** | *Optional* Python tiers only | Only needed for the stealth / gateway / a11y tiers, which are Linux-oriented. **Not required** for the core engine on macOS. |
| **Postgres** | *Optional* audit log | **Fully optional.** Leave `CU_AUDIT_DATABASE_URL` empty in `.env` and the engine still runs — audit is simply disabled. Don't install Postgres just to try TEX. |
| An LLM provider key | The agent's reasoning | Either an Anthropic API key (`ANTHROPIC_API_KEY`) or AWS Bedrock credentials. See [Configuring `.env`](#configuring-env--anthropic-vs-bedrock). |

> **Why no build step?** `tsx` is a TypeScript execution engine for Node. The engine is started with `node --import tsx/esm src/server.ts`, which transpiles on the fly. This keeps the dev loop tight — edit `.ts`, restart, done. (One consequence: an *old* Node paired with an *old* tsx can choke on a `playwright-core` JSON import — see [Troubleshooting](#troubleshooting).)

---

## macOS local install (the common path)

The repo root **is** the plugin root. All paths below are relative to it unless stated otherwise.

### 1. Install engine dependencies + the browser

```bash
cd stack && npm install && npx playwright install chromium
```

Installs the engine's Node dependencies (Hono, Playwright, tsx, …) and downloads the Chromium binary Playwright will drive. This is the heaviest step (Chromium is a few hundred MB).

### 2. Install the MCP server dependencies

```bash
cd ../mcp && npm install
```

Installs dependencies for `mcp/server.mjs`, the thin HTTP client that bridges Claude Code to the engine.

### 3. Create your `.env`

```bash
cp .env.example .env   # run this at the repo root
```

Copies the config template. `.env` is gitignored, so your keys stay out of version control. Open it and set `LLM_PROVIDER` plus the matching key — see [Configuring `.env`](#configuring-env--anthropic-vs-bedrock) for the exact blocks.

### 4. Start the engine

```bash
scripts/tex-up.sh
```

`tex-up.sh` loads `./.env`, starts the engine in the background, waits for `/health` to come up, and prints status. On macOS the engine and Playwright run **headless** — no Xvfb, no virtual display, nothing else to start.

To stop it again later:

```bash
scripts/tex-down.sh
```

`tex-down.sh` kills the running engine.

### 5. Register the plugin/server with Claude Code

Pick one of the three options in the next section.

### 6. Confirm and use

In Claude Code, run `tex_health` to confirm the engine is reachable, then call `browse_use` — or just describe a browser task in natural language and the bundled skill (`skills/browse-use/SKILL.md`) will trigger `browse_use` for you.

---

## Registering with Claude Code (three ways)

TEX exposes two MCP tools to Claude Code:

- `browse_use(task, url?, app?)` — run a browser task.
- `tex_health()` — check that the engine is up.

Both are served by `mcp/server.mjs`, which talks HTTP to the engine. The MCP server reads the engine URL from **`TEX_ENGINE_URL`** (default `http://127.0.0.1:18802`). There are three ways to wire this into Claude Code — choose whichever fits how you work.

### Option A — Load the whole plugin from a local directory

```bash
claude --plugin-dir /ABS/PATH/TO/tex
```

Loads the entire plugin: the MCP server (via the bundled `.mcp.json`), the `browse-use` skill, and the `.claude-plugin/plugin.json` manifest (`name: "tex-browse-use"`). This is the most complete option — you get the skill that teaches Claude *when* to reach for `browse_use`, not just the raw tools. Use an **absolute** path.

### Option B — Register just the MCP server

```bash
claude mcp add tex-browse-use -- node /ABS/PATH/TO/tex/mcp/server.mjs
```

Registers only the MCP server, no skill. Claude Code will have the `browse_use` and `tex_health` tools available, but without the skill it won't auto-trigger them from a vague natural-language request — you'll typically call `browse_use` explicitly. Good when you want the tools but not the plugin packaging. Use an **absolute** path to `server.mjs`.

### Option C — Commit the repo's `.mcp.json` in your project

The repo ships a `.mcp.json` that registers the server using the plugin-root variable:

```json
{
  "mcpServers": {
    "tex-browse-use": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"]
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` is expanded by Claude Code to the plugin's root directory, so the path stays correct no matter where the repo lives — nothing hard-coded. Keep this `.mcp.json` in your project (commit it), and on the next session Claude Code will prompt you to approve the server. This is the best option for teams: everyone who checks out the repo gets the server with no per-machine setup.

> **Engine URL override.** If you run the engine on a non-default port or host, set `TEX_ENGINE_URL` in the environment Claude Code launches the MCP server in (e.g. `TEX_ENGINE_URL=http://127.0.0.1:9001`). It defaults to `http://127.0.0.1:18802`.

---

## Configuring `.env` — anthropic vs bedrock

Pick **one** provider. `LLM_PROVIDER` selects it; if `LLM_PROVIDER` is unset, the engine auto-detects (if `ANTHROPIC_API_KEY` is present → `anthropic`, otherwise → `bedrock`).

### Anthropic (recommended for local)

The simplest path for local macOS use. No AWS account, no SigV4 — just an API key.

```dotenv
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Postgres audit is optional — leave empty to disable
CU_AUDIT_DATABASE_URL=
```

- The model defaults to **`claude-sonnet-4-6`**, which is a computer-use-capable model — exactly what the vision tier needs.
- The beta header **`computer-use-2025-11-24`** is applied automatically; you do not set it yourself.
- **Note:** Claude Fable 5 (`claude-fable-5`) does **not** support computer use, so don't point the model at it for the vision tier — keep the computer-use-capable default unless you know a given task never needs the vision fallback.

### Bedrock (EU / DSGVO)

Use this when you need EU-region / DSGVO hosting via AWS.

```dotenv
LLM_PROVIDER=bedrock
AWS_REGION=eu-central-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
BEDROCK_MODEL=eu.anthropic.claude-sonnet-4-6

# Postgres audit is optional — leave empty to disable
CU_AUDIT_DATABASE_URL=
```

The Bedrock model ID carries the region/provider prefix (`eu.anthropic.claude-sonnet-4-6`). This is the path that has been verified end-to-end (see [Honest status](#honest-status)).

---

## Verifying the install

1. **Engine health (shell).** `scripts/tex-up.sh` already waits for `/health` and prints status. If it printed a healthy status, the engine is up on `http://127.0.0.1:18802`.

2. **Tool health (Claude Code).** In a Claude Code session with the plugin/server registered, run:

   ```
   tex_health
   ```

   This calls through the MCP server to the engine's health endpoint. A healthy result means the full path `Claude Code → MCP → engine` is wired correctly.

3. **First `browse_use` call.** A known-good smoke test (verified end-to-end):

   - **Task:** `Report the main heading then say AUFGABE ERLEDIGT`
   - **url:** `https://example.com`

   Expected: it completes in roughly **7 seconds** on gear 1 (`screenshot-new`, ~3.4k tokens) and returns:

   ```
   The main heading is "Example Domain". AUFGABE ERLEDIGT
   ```

   This exercises the whole chain: `Claude Code → MCP browse_use → engine → Playwright → LLM`. If you get that response, everything is working.

   You can also just ask in natural language (e.g. "go to example.com and tell me the main heading") — if you loaded the whole plugin (Option A or the `.mcp.json` from Option C plus the skill), the `browse-use` skill will trigger `browse_use` automatically.

---

## Troubleshooting

### "Engine not reachable" / `tex_health` fails / `browse_use` errors connecting

The MCP server can't reach the engine. The engine is a separate process from Claude Code — it has to be running.

- Start it: `scripts/tex-up.sh` (it waits for `/health` and prints status).
- Confirm the URL matches. The MCP server uses `TEX_ENGINE_URL` (default `http://127.0.0.1:18802`). If you changed the engine's port, set `TEX_ENGINE_URL` accordingly in the environment Claude Code launches the server in.
- If `tex-up.sh` itself never reports healthy, check its log output for a startup error (most often a missing/invalid LLM key or the Node+tsx import error below).

### No LLM key, or an invalid key

The engine boots, but `browse_use` fails the moment it needs the model.

- Make sure `.env` exists at the repo root (`cp .env.example .env`) and `tex-up.sh` is loading it.
- Set **one** provider correctly:
  - `LLM_PROVIDER=anthropic` + a valid `ANTHROPIC_API_KEY`, **or**
  - `LLM_PROVIDER=bedrock` + `AWS_REGION` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `BEDROCK_MODEL`.
- If `LLM_PROVIDER` is unset, auto-detect kicks in: it picks `anthropic` when `ANTHROPIC_API_KEY` is present, else `bedrock`. A half-configured `.env` (e.g. Bedrock vars set but `LLM_PROVIDER=anthropic` and no Anthropic key) will fail — set the provider and its key as a matched pair.

### Old Node + tsx: `playwright-core` JSON import error

On an **older Node paired with an older tsx**, the engine can fail at startup with an error about importing a JSON file from `playwright-core` (an ESM JSON-import incompatibility).

**Fix:** upgrade tsx to **>= 4.22.4**, or run on **Node 20 / 22 LTS**. The combination verified working is Node 25 + tsx 4.22.4. After upgrading tsx (`cd stack && npm install tsx@latest`), restart with `scripts/tex-up.sh`.

### Port 18802 already in use

Another process (or a previous engine that didn't shut down) holds the port.

- Stop a stale engine: `scripts/tex-down.sh`.
- Or run the engine on a different port by setting **`PORT`** (e.g. `PORT=18902`) before `scripts/tex-up.sh`. If you do, set `TEX_ENGINE_URL` to match (e.g. `http://127.0.0.1:18902`) so the MCP server points at the new port.

---

## Advanced: full Linux stack

On macOS you only ever run the **engine** (`:18802`) plus headless Playwright — that's the whole supported local setup. The richer multi-service deployment is how TEX runs on a **Linux server**, where the stealth and DOM-gateway tiers come into play.

The full Linux stack is **five systemd services**:

| Service | Port | Role |
|---|---|---|
| engine | `:18802` | The Node/Hono engine (same one you run locally) |
| stealth | `:18803` | SeleniumBase UC (undetected-Chromedriver) stealth browser |
| gateway | `:18804` | The browser-use DOM "gateway" |
| a11y | `:18805` | Accessibility-tree tier |
| Xvfb | `:99` | Virtual display the GUI browsers render into |

The **stealth** (SeleniumBase UC) browser and the browser-use **DOM gateway** (`:18804`) are **Linux-oriented**: they need a Linux box with a display (or **Xvfb** as the virtual display) and a **Python venv**. Set the venv up from the engine's Python requirements:

```bash
# on the Linux box, in a Python 3.11+ venv
pip install -r stack/requirements.txt
playwright install chromium
```

The truly-required Python packages for those tiers are **`seleniumbase`**, **`browser-use`**, **`playwright`**, and **`boto3`**.

> These Python tiers were **not** run on macOS during this build (they're Linux-oriented). For local macOS work you don't need Python at all — the Node engine + Playwright cover the common path.

---

## Honest status

Stated plainly, no overclaiming:

**Verified**
- The engine boots on macOS (Node 25 + tsx 4.22.4).
- Postgres-optional mode works — empty `CU_AUDIT_DATABASE_URL` runs fine with audit disabled.
- The full `MCP → engine → browser → LLM` path is verified **end-to-end against AWS Bedrock** on `example.com` (the ~7s `screenshot-new` smoke test described above).

**Not yet verified**
- The **direct Anthropic-API provider** is implemented and the engine boots with it, but it has **not** been exercised with a live `ANTHROPIC_API_KEY` (none was available at build time). Smoke-test it with your own key using the `example.com` task above.
- The optional **Python stealth / gateway / a11y tiers** were **not** run on macOS — they are Linux-oriented and untested here.
