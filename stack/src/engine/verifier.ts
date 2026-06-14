/**
 * VERIFICATION / SELF-HEALING BACKBONE — core verifier.
 *
 * Principle: "done" must be PROVEN by reading the world, never claimed by the model.
 * A task declares postconditions (checkable predicates). After an action (or when the
 * agent claims completion), verify() evaluates them against live state. Only if they
 * pass is the work accepted. On failure the healing policy decides: retry / downshift /
 * recalibrate / escalate — but it NEVER silently passes.
 *
 * This module is backend-agnostic: it works the same whether the action was executed via
 * API (Nango), MCP, CLI, compiled replay, browser-use, or computer-use.
 */

export type CompareOp = "eq" | "neq" | "lte" | "gte" | "lt" | "gt" | "absent" | "present" | "contains";

/** A single checkable predicate about the post-action world state. */
export type Postcondition =
  | {
      kind: "http"; // read JSON from an endpoint and assert on a path
      method?: "GET" | "POST";
      url: string;
      body?: unknown;
      jsonPath: string; // dot path, e.g. "report.unmatched"
      op: CompareOp;
      value?: unknown;
      description: string;
    }
  | {
      kind: "dom"; // assert on the live page (browser tiers)
      locator: string; // text or selector
      state: "present" | "absent" | "text";
      value?: string;
      description: string;
    }
  | {
      kind: "url"; // assert the page URL (browser tiers)
      contains: string;
      description: string;
    };

export interface VerifyContext {
  /** Playwright-like page for dom/url checks (browser tiers). Optional for http checks. */
  page?: any;
  /** Fetch JSON helper for http checks; defaults to global fetch. */
  fetchJson?: (url: string, method: string, body?: unknown) => Promise<any>;
}

export interface VerifyFailure {
  postcondition: Postcondition;
  got: unknown;
  reason: string;
}

export interface VerifyResult {
  passed: boolean;
  total: number;
  failures: VerifyFailure[];
  evidence: Array<{ description: string; got: unknown; ok: boolean }>;
}

function getPath(obj: any, path: string): unknown {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function compare(op: CompareOp, got: unknown, want: unknown): boolean {
  switch (op) {
    case "eq": return got === want;
    case "neq": return got !== want;
    case "lte": return Number(got) <= Number(want);
    case "gte": return Number(got) >= Number(want);
    case "lt": return Number(got) < Number(want);
    case "gt": return Number(got) > Number(want);
    case "absent": return got === undefined || got === null;
    case "present": return got !== undefined && got !== null;
    case "contains": return String(got).includes(String(want));
    default: return false;
  }
}

async function defaultFetchJson(url: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

async function checkOne(pc: Postcondition, ctx: VerifyContext): Promise<{ ok: boolean; got: unknown; reason: string }> {
  try {
    if (pc.kind === "http") {
      const fj = ctx.fetchJson || defaultFetchJson;
      const data = await fj(pc.url, pc.method || "GET", pc.body);
      const got = getPath(data, pc.jsonPath);
      const ok = compare(pc.op, got, pc.value);
      return { ok, got, reason: ok ? "ok" : `${pc.jsonPath}=${JSON.stringify(got)} fails ${pc.op} ${JSON.stringify(pc.value)}` };
    }
    if (pc.kind === "dom") {
      if (!ctx.page) return { ok: false, got: null, reason: "no page in context for dom check" };
      const loc = ctx.page.locator ? ctx.page.locator(pc.locator) : ctx.page.getByText(pc.locator);
      const count = await loc.count();
      if (pc.state === "present") return { ok: count > 0, got: count, reason: count > 0 ? "ok" : "element absent" };
      if (pc.state === "absent") return { ok: count === 0, got: count, reason: count === 0 ? "ok" : "element still present" };
      const txt = count > 0 ? await loc.first().innerText() : "";
      return { ok: txt.includes(pc.value || ""), got: txt.slice(0, 60), reason: "text check" };
    }
    if (pc.kind === "url") {
      const u = ctx.page?.url?.() || "";
      const ok = String(u).includes(pc.contains);
      return { ok, got: u, reason: ok ? "ok" : `url lacks '${pc.contains}'` };
    }
    return { ok: false, got: null, reason: "unknown postcondition kind" };
  } catch (e) {
    return { ok: false, got: null, reason: `check threw: ${(e as Error).message}` };
  }
}

/** Evaluate all postconditions against live state. */
export async function verify(postconditions: Postcondition[], ctx: VerifyContext = {}): Promise<VerifyResult> {
  const evidence: VerifyResult["evidence"] = [];
  const failures: VerifyFailure[] = [];
  for (const pc of postconditions) {
    const r = await checkOne(pc, ctx);
    evidence.push({ description: pc.description, got: r.got, ok: r.ok });
    if (!r.ok) failures.push({ postcondition: pc, got: r.got, reason: r.reason });
  }
  return { passed: failures.length === 0, total: postconditions.length, failures, evidence };
}

// ─── Self-healing policy ────────────────────────────────────────────────────

export interface HealingPolicy {
  maxRetries: number;       // same-tier retries on transient failure
  allowDownshift: boolean;  // fall to a lower (more general) tier on verify-fail
  allowRecalibrate: boolean;// trigger app recalibration when compiled-tier drift detected
  escalateAfter: number;    // after this many failed heal attempts → human
}

export const DEFAULT_HEALING: HealingPolicy = {
  maxRetries: 2,
  allowDownshift: true,
  allowRecalibrate: true,
  escalateAfter: 3,
};

export type HealingAction = "retry" | "downshift" | "recalibrate" | "escalate" | "give_up";

/** Decide the next healing action given attempt count, current gear, and verify result. */
export function nextHealingAction(
  attempt: number,
  gear: number,
  policy: HealingPolicy = DEFAULT_HEALING,
): HealingAction {
  if (attempt >= policy.escalateAfter) return "escalate";
  if (attempt <= policy.maxRetries) return "retry";
  if (gear >= 4 && policy.allowRecalibrate) return "recalibrate"; // compiled drift → relearn
  if (policy.allowDownshift) return "downshift";
  return "escalate";
}
