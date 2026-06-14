---
name: browse-use
description: Use when the user wants to operate a website or web app that has no usable API/CLI — "log into X and do Y", "read/extract data from this dashboard", "fill out this web form", "click through this portal", "check what this page shows", or any task that requires driving a real browser. Powered by the TEX engine via the browse_use MCP tool.
version: 1.0.0
argument-hint: <task> [url]
---

# Browse-use (TEX)

Operate any web app by driving a real browser when there is **no API, MCP, CLI, or A2A** path. TEX runs a fallback ladder — cheap DOM agent first, escalating to vision + stealth — and reports back what it found or did.

## When to use this

Reach for `browse_use` when the task genuinely needs a browser:
- Logging into a web app and reading/changing something there
- Extracting data from a dashboard or report that has no export/API
- Filling in or submitting a web form
- Clicking through a multi-step portal flow
- Verifying what a live page actually displays

Do **not** use it when a normal API, `WebFetch`, or CLI already does the job — those are faster and cheaper. Browse-use is the last resort for UI-only apps.

## How to use it

The plugin exposes two MCP tools (server `tex-browse-use`):

- **`browse_use(task, url?, app?)`** — give a clear, specific task in plain language and (usually) a start `url`. It blocks until done and returns the agent's findings plus a run summary (status, gear/strategy, steps, tokens, final URL). Optional `app` reuses a saved login session, learned skills, and stored credentials for that app (e.g. `app: "acme-crm"`).
- **`tex_health()`** — check the engine is up and which capabilities (vision, DOM, stealth, compiled replay) are available.

Write the `task` so the agent knows both **what to do** and **what to report back**, e.g.
> "Open the orders page, find the most recent order, and report its order number and total."

## Prerequisite: the engine must be running

`browse_use` talks to a local TEX engine over HTTP. If it returns an "engine not reachable" error, start the engine first:

```bash
scripts/tex-up.sh
```

Then retry. Run `tex_health` to confirm it's up. See the plugin README for one-time setup (`.env` with an LLM provider key, `npm install`, `playwright install chromium`).
