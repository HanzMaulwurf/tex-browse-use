# ADR-001 — Universal "operate any app" fallback ladder

Status: accepted · Date: 2026-06-11 · Branch: `feature/wire-and-stabilize`

## Context
TEX must operate apps that expose **no usable API / MCP / CLI / A2A**.
For those, the only path is driving the real UI. The pre-existing stack had a
solid computer-use core but the surrounding "multi-harness / CDP / self-improving"
layer was ~70% non-functional: a cold-launch a11y service that read the wrong
browser, an orphaned `unified.py` written against an ancient browser-use API, a
fake `browser_harness` CDP tier that always fell into `except`, a Gear-4
"compiled, $0.00" strategy that was decided but never executed, and no git.

## Decision
A two-level capability ladder built only on primitives that actually run:

```
structured first:   API → MCP → CLI → A2A            (handled upstream)
UI fallback ladder:  compiled-replay → browser-use(DOM/CDP) → computer-use(vision+stealth)
```

- **Gateway :18804** is the universal entrypoint. `POST /solve` runs the cheap
  DOM tier (browser-use) first and **escalates to computer-use (vision+stealth)
  on failure**. Bot-protected domains skip straight to computer-use (auto UC).
- **computer-use :18802** is the vision engine (Bedrock EU). Inside it the
  smart-router picks the perception mode: compiled-replay (no-LLM) → a11y-tree
  (cheap DOM text) → screenshot → stealth.
- **browser-use 0.12.x** is the DOM/CDP tier. It runs as root with
  `chromium_sandbox=False` and needs `boto3` for the Bedrock LLM — both now
  durable (code + pinned requirements.txt).
- **a11y** is extracted **in-process from the live page** the agent acts in
  (same auth/SPA state, same 1024×768 viewport ⇒ coordinates valid). The old
  cold-launch service is no longer on the agent path.
- **compiled-replay** spawns the compiled Playwright script with the app session
  injected as Playwright `storage_state`; **any failure cleanly falls back to
  the LLM loop** (never worse than before).

## Consequences
- Every advertised tier now actually runs and is verified end-to-end.
- Honest `/health` on both services — no fabricated capabilities.
- `browser_harness` fake tier removed; `harness` alias maps to the real DOM agent.
- Stability: changes are additive with guaranteed fallbacks; the accounting
  engine (the target app) is never driven by an unvalidated compiled script without a
  fallback path. All work tracked in git on a feature branch.

## Verified (2026-06-11)
- in-process a11y → correct live extraction (example.com link + coords)
- browser-use tier → `/run` + `/solve` success end-to-end vs Bedrock EU
- compiled-runner → success (session-injected) + failure (fallback signal)
- computer-use `/task` → completed post-restart
- all 4 services healthy

## Open / next (P2)
- Merge agent-loop.ts and persistent-agent.ts into one engine (still ~80% dup).
- Validate the compiled login script against the live app (needs creds).
- Wire upstream API/MCP/CLI/A2A detection so the ladder is entered only when
  structured access is truly absent.
