# Browse-use (TEX) — CLAUDE.md snippet

This is a drop-in snippet for **TEX**, the local browse-use capability. Paste the
fenced block below into your project's `CLAUDE.md` (or `~/.claude/CLAUDE.md`) so your
Claude knows the `browse_use` MCP tool exists and when to reach for it.

```md
## Browse-use (TEX)

There is an MCP tool `browse_use(task, url?, app?)` that drives a **real browser**
(Playwright) to operate web apps that have **no usable API/MCP/CLI**. Use it only as a
**last resort** for UI-only apps.

- **Prefer first:** a direct API/MCP/CLI for the app, or `WebFetch` for simply reading a
  public page. These are faster, cheaper, and more reliable.
- **Use `browse_use` when:** the task requires clicking/typing/navigating an app that has
  no programmatic access (login-gated dashboards, legacy admin UIs, web apps without an
  API). Describe the goal in `task`; pass `url` to start somewhere specific, and `app`
  to hint a known per-app skill.
- **Engine must be running:** TEX uses a local engine. Start it with `scripts/tex-up.sh`
  (it loads `.env`, launches the engine, and waits for `/health`). Run `tex_health`
  first to confirm it's up — if not, start it before calling `browse_use`.
- **Cost note:** `browse_use` runs a browser + LLM loop, so it costs more context/tokens
  than an API call. Reach for it only when no structured access exists.
```
