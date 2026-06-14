# Verification / Self-Healing Backbone — Design

## Principle
"Done" must be **proven by reading the world**, never **claimed by the model**.
Today the harness (`persistent-agent.ts`) accepts completion when the model emits
`AUFGABE ERLEDIGT`. That is the single biggest reliability gap. The backbone makes
completion a *checkable property* and makes failure *self-healing or escalated — never
silently passed*.

Backend-agnostic by design: identical for API (Nango), MCP, CLI, compiled replay,
browser-use, computer-use, desktop-use. Verification sits **above** the tier.

## Components
1. **Postcondition** (`verifier.ts`) — a declarative, checkable predicate about post-state:
   - `http`  → read JSON from an endpoint, assert on a dot-path (e.g. `report.unmatched eq 0`)
   - `dom`   → element present/absent/text on the live page (browser tiers)
   - `url`   → page URL contains X (browser tiers)
   (extensible: `db`, `api`, `file`)
2. **verify(postconditions, ctx)** → `{ passed, failures[], evidence[] }`. Reads live state.
3. **Healing policy** — on verify-fail, `nextHealingAction(attempt, gear, policy)`:
   `retry → recalibrate(if compiled drift) → downshift → escalate`. Bounded by
   `maxRetries` / `escalateAfter`. Escalate = flag to human, never pass.

## Declaration (in the app manifest, per task — reusable in the catalog)
```jsonc
"verify":  [ { "kind":"http", "url":".../preview", "jsonPath":"report.unmatched", "op":"eq", "value":0,
              "description":"Kein Umsatz ohne Zuordnung übrig" } ],
"healing": { "maxRetries":2, "allowDownshift":true, "allowRecalibrate":true, "escalateAfter":3 }
```

## Integration points (grounded in current code)
- **Harness** `persistent-agent.ts`: at the `completed` branch (~line 253/304), before
  accepting completion, run `verify(task.verify, {page})`. If `!passed` → apply
  `nextHealingAction` (reuse existing `downshift()`; add re-plan = feed failure back to the
  model; add escalate = mark `status:'needs_review'` + audit). The existing
  failure-counter downshift becomes one branch of the policy.
- **Per-mutation** (`booking_runner.py`): after each `ZUORDNEN`, verify a row-level
  postcondition (row gone from the "zuordnen" list / `restbetrag==0`) before marking
  `booked`. dry_run verifies the *would-be* selection; execute verifies the *actual* result.
- **Precision validator** `precision_validator.py`: a task is only `EXECUTABLE` if it also
  declares `verify` predicates. **No postconditions ⇒ no completion guarantee ⇒ BLOCKED.**
  This binds verification into the existing precision gate.
- **Drift detection**: when a compiled (gear-4) replay's verify fails, mark the app's
  calibration `drifted` → trigger recalibration + fall back to vision for this run.

## Why this makes "always works" enforceable (not hope)
- Completion is evidence-based, not self-reported.
- Failure self-heals within a bounded budget, then escalates — **fail-safe, never silent/destructive**.
- Verification is shared across all tiers and all tenants via the manifest/catalog.
- Each catalog app carries its postconditions = a built-in regression contract against vendor UI drift.
