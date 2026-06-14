#!/usr/bin/env node
/**
 * TEX — browse-use MCP server.
 *
 * Exposes the local TEX engine (universal "operate any web app" agent) to
 * Claude Code as MCP tools. The engine drives a real browser (Playwright +
 * optional stealth) and an LLM (Anthropic API or AWS Bedrock) to complete a
 * natural-language task on a web page — for apps with no usable API.
 *
 * This server is a thin HTTP client of the engine; the engine must be running
 * (start it with `scripts/tex-up.sh`). Configure the engine URL via
 * TEX_ENGINE_URL (default http://127.0.0.1:18802).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ENGINE = (process.env.TEX_ENGINE_URL || 'http://127.0.0.1:18802').replace(/\/$/, '');
// DOM tier (browser-use gateway). Cheaper/faster than the screenshot tier for
// public, no-login tasks; it escalates to the screenshot tier internally on failure.
const GATEWAY = (process.env.TEX_GATEWAY_URL || 'http://127.0.0.1:18804').replace(/\/$/, '');
const POLL_INTERVAL_MS = Number(process.env.TEX_POLL_INTERVAL_MS) || 3000;
const MAX_POLLS = Number(process.env.TEX_MAX_POLLS) || 120; // ~6 min at 3s
const SOLVE_TIMEOUT_MS = Number(process.env.TEX_SOLVE_TIMEOUT_MS) || 6 * 60 * 1000;

/** Is the DOM gateway reachable right now? */
async function gatewayUp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${GATEWAY}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

const text = (s) => ({ content: [{ type: 'text', text: s }], isError: false });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

async function engineDownMessage(e) {
  return fail(
    `TEX engine is not reachable at ${ENGINE} (${e?.message || e}).\n\n` +
    `Start it first:  scripts/tex-up.sh\n` +
    `Or set TEX_ENGINE_URL to a running engine.`,
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pull the human-readable answer + a compact run summary out of a finished task. */
function summarize(task) {
  const steps = task.steps || [];
  const lastText = [...steps].reverse().map((s) => s.thinking).find((t) => t && t.trim());
  const tok = task.totalTokens || {};
  const lines = [];
  lines.push(`status: ${task.status}`);
  if (task.routing) lines.push(`route: gear ${task.routing.gear} (${task.routing.strategy})`);
  lines.push(`steps: ${steps.length} | tokens: ${(tok.input || 0) + (tok.output || 0)}`);
  if (task.finalUrl) lines.push(`final url: ${task.finalUrl}`);
  if (task.verification) lines.push(`verified: ${task.verification.passed}`);
  if (task.error) lines.push(`error: ${task.error}`);
  lines.push('');
  lines.push(lastText ? lastText.trim() : '(no text output — see status above)');
  return lines.join('\n');
}

/** Summarize a DOM-tier /solve response into the human answer + a run line. */
function summarizeSolve(data) {
  const attempts = data.attempts || [];
  const last = attempts[attempts.length - 1] || {};
  const lines = [];
  lines.push(`status: ${last.success ? 'completed' : 'failed'}`);
  lines.push(`route: ${data.chosen || last.tier || 'dom'}`);
  const steps = attempts.map((a) => `${a.tier}:${a.steps ?? '?'}`).join(' → ');
  if (steps) lines.push(`steps: ${steps}`);
  if (last.finalUrl) lines.push(`final url: ${last.finalUrl}`);
  if (last.error) lines.push(`error: ${last.error}`);
  lines.push('');
  lines.push((last.result && String(last.result).trim()) || last.status || '(no text output — see status above)');
  return lines.join('\n');
}

/** DOM tier: blocking call to the gateway /solve (DOM-first, escalates to vision internally). */
async function runDomTier(task, url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(`${GATEWAY}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, url }),
      signal: ctrl.signal,
    });
    if (!res.ok) return fail(`DOM gateway rejected the task (HTTP ${res.status}): ${await res.text()}`);
    return text(summarizeSolve(await res.json()));
  } finally {
    clearTimeout(timer);
  }
}

/** Vision/screenshot tier: the engine's persistent agent (session-aware via app). */
async function runVisionTier(task, url, app) {
  let res;
  try {
    res = await fetch(`${ENGINE}/persistent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, url, appName: app }),
    });
  } catch (e) {
    return engineDownMessage(e);
  }
  if (!res.ok) return fail(`Engine rejected the task (HTTP ${res.status}): ${await res.text()}`);

  const body = await res.json();
  if (body.status && body.status !== 'running') return text(summarize(body));

  const id = body.id;
  if (!id) return fail(`Engine did not return a task id: ${JSON.stringify(body)}`);

  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    let poll;
    try {
      poll = await fetch(`${ENGINE}/persistent/${id}`);
    } catch (e) {
      return engineDownMessage(e);
    }
    if (!poll.ok) continue;
    const t = await poll.json();
    if (t.status && t.status !== 'running') return text(summarize(t));
  }
  return fail(`Task ${id} still running after ${(POLL_INTERVAL_MS * MAX_POLLS) / 1000}s. ` +
    `Poll GET ${ENGINE}/persistent/${id} or cancel via DELETE.`);
}

const server = new McpServer({ name: 'tex-browse-use', version: '1.0.0' });

server.registerTool(
  'browse_use',
  {
    title: 'Browse-use (operate any web app)',
    description:
      'Drive a real browser to complete a natural-language task on a web page, for apps that have no usable API/MCP/CLI. ' +
      'The TEX agent navigates, reads, clicks, types, and reports back. Use for: "log into X and read Y", ' +
      '"extract the table from this dashboard", "fill this form", "check if this page shows Z". ' +
      'Provide a clear task and optionally a start URL. Two tiers run under the hood: a fast/cheap DOM tier ' +
      '(browser-use) for public no-login tasks, and a screenshot/vision tier for logged-in apps (pass "app" to ' +
      'reuse a saved session). Routing is automatic; override with "tier" if needed. ' +
      'Returns the agent\'s findings plus a run summary. Blocks until the task finishes (up to several minutes).',
    inputSchema: {
      task: z.string().describe('What to do, in plain language. Be specific about the goal and what to report back.'),
      url: z.string().optional().describe('Optional start URL to open before beginning the task.'),
      app: z.string().optional().describe('Optional app name (e.g. "acme-crm") to reuse a saved login session, learned skills, and credentials. Forces the session-aware screenshot tier.'),
      tier: z.enum(['auto', 'dom', 'vision']).optional().describe('Routing override. "auto" (default): DOM tier for public no-login tasks, screenshot tier when "app" is set. "dom": force the fast browser-use DOM tier. "vision": force the screenshot tier.'),
    },
  },
  async ({ task, url, app, tier }) => {
    const mode = tier || 'auto';

    // Anything that needs a saved login session goes to the session-aware screenshot tier.
    if (mode === 'vision' || app) return runVisionTier(task, url, app);

    // DOM tier: explicitly requested, or auto when the gateway is up.
    if (mode === 'dom' || (mode === 'auto' && (await gatewayUp()))) {
      try {
        return await runDomTier(task, url);
      } catch (e) {
        if (mode === 'dom') {
          return fail(`DOM gateway not reachable at ${GATEWAY} (${e?.message || e}).\n` +
            `Start it with scripts/tex-up.sh, or use tier:"vision".`);
        }
        // auto: degrade gracefully to the screenshot tier.
      }
    }
    return runVisionTier(task, url, app);
  },
);

server.registerTool(
  'tex_health',
  {
    title: 'TEX engine health',
    description: 'Check whether the TEX browse-use engine is running and which capabilities (vision, DOM, stealth, compiled replay) are available.',
    inputSchema: {},
  },
  async () => {
    try {
      const res = await fetch(`${ENGINE}/health`);
      const h = await res.json();
      return text(`engine: ${ENGINE}\nstatus: ${h.status}\ncapabilities:\n${JSON.stringify(h.capabilities, null, 2)}`);
    } catch (e) {
      return engineDownMessage(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
