import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { runTask, getTask, getAllTasks, cancelTask } from './agent-loop.js';
import { runPersistentTask, getTask as getPTask, getAllTasks as getAllPTasks, cancelTask as cancelPTask } from './persistent-agent.js';
import { route as smartRoute } from './smart-router.js';
import { isStealthAvailable, needsStealth } from './browser/stealth-client.js';
import { addCredential, listCredentials, removeCredential } from './vault/credential-store.js';
import { listSkills } from './skills/skill-store.js';
import { listSessions, deleteSession } from './browser/session-manager.js';
import { sql } from './db.js';
import { STACK_ROOT } from './data-paths.js';

const PORT = Number(process.env.PORT) || 18802;
const CUA_ROOT = process.env.CUA_ROOT || STACK_ROOT;
const PYTHON_BIN = process.env.PYTHON_BIN || `${CUA_ROOT}/.venv/bin/python`;
const COMPILED_DIR = process.env.COMPILED_DIR || `${CUA_ROOT}/data/compiled`;
const A11Y_PORT = Number(process.env.A11Y_PORT) || 18805;
const GATEWAY_URL = (process.env.TEX_GATEWAY_URL || 'http://127.0.0.1:18804').replace(/\/$/, '');

/** Is the browser-use DOM gateway actually up? (capability honesty for /health) */
async function domGatewayUp(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${GATEWAY_URL}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}
const app = new Hono();

app.use('*', cors({ origin: '*' }));

// Health check
app.get('/health', async (c) => {
  const [stealth, domUp] = await Promise.all([isStealthAvailable(), domGatewayUp()]);
  return c.json({
    status: 'healthy',
    service: 'tex-engine',
    version: '2.0.0',
    capabilities: {
      computerUse: 'bedrock-eu (eu-central-1) — vision/screenshot tier',
      domTier: domUp
        ? `browser-use DOM/CDP agent (active, ${GATEWAY_URL})`
        : 'unavailable (gateway down — run scripts/tex-up.sh to provision)',
      a11y: 'in-process live-page extraction (same browser the agent acts in)',
      playwright: 'chromium-headless (persistent)',
      stealth: stealth ? 'seleniumbase-uc (active)' : 'unavailable',
      compiledReplay: 'POST /compiled/run (no-LLM, session-injected)',
      autoRouting: true,
    },
    config: {
      maxSteps: Number(process.env.MAX_STEPS) || 50,
      screenshotSize: `${process.env.SCREENSHOT_WIDTH || 1024}x${process.env.SCREENSHOT_HEIGHT || 768}`,
    },
  });
});

// ---- Smart Route Check ----
app.post('/smart-route', async (c) => {
  const body = await c.req.json<{ task: string; url?: string; appName?: string; taskType?: string }>();
  const decision = smartRoute(body.appName || '', body.task, body.url, body.taskType);
  return c.json(decision);
});

// ---- Persistent Agent (never gives up, auto-strategy) ----
app.post('/persistent', async (c) => {
  const body = await c.req.json<{ task: string; url?: string; appName?: string; taskType?: string }>();
  if (!body.task) return c.json({ error: 'Missing task' }, 400);

  const decision = smartRoute(body.appName || '', body.task, body.url, body.taskType);
  console.log('[api] Persistent task:', body.task.slice(0, 50), '| Strategy:', decision.strategy, '| Gear:', decision.gear);
  
  const taskPromise = runPersistentTask(body.task, body.url, body.appName);
  await new Promise(r => setTimeout(r, 2000));
  
  const tasks = getAllPTasks();
  const latest = tasks[tasks.length - 1];
  
  if (latest && latest.status !== 'running') return c.json(latest);
  
  return c.json({
    id: latest?.id,
    status: 'running',
    routing: decision,
    pollUrl: '/persistent/' + latest?.id,
  }, 202);
});

app.get('/persistent/:id', (c) => {
  const task = getPTask(c.req.param('id'));
  if (!task) return c.json({ error: 'Not found' }, 404);
  return c.json(task);
});

app.get('/persistent', (c) => {
  return c.json(getAllPTasks().map(t => ({
    id: t.id, status: t.status, task: t.task, appName: t.appName,
    steps: t.steps.length, gear: t.routing.gear, strategy: t.routing.strategy,
    tokens: t.totalTokens.input + t.totalTokens.output,
    screenshots: t.screenshotsSent, a11y: t.a11yTreesSent,
    retries: t.retries, reLogins: t.reLogins,
    changes: t.strategyChanges.length,
    duration: t.completedAt ? ((t.completedAt - t.startedAt) / 1000).toFixed(1) + 's' : 'running',
  })));
});

app.delete('/persistent/:id', (c) => {
  return cancelPTask(c.req.param('id')) ? c.json({ status: 'cancelled' }) : c.json({ error: 'Not found' }, 404);
});

// Start a new task (legacy)
app.post('/task', async (c) => {
  const body = await c.req.json<{
    task: string;
    url?: string;
    mode?: 'playwright' | 'stealth' | 'auto';
    appName?: string;
    tenantId?: string;
    userId?: string;
  }>();

  if (!body.task) return c.json({ error: 'Missing "task" field' }, 400);
  if (!body.tenantId) return c.json({ error: 'Missing "tenantId" field' }, 400);

  // Determine browser mode
  const autoStealth = body.url ? needsStealth(body.url) : false;
  const mode = body.mode || (autoStealth ? 'stealth' : 'auto');

  console.log(`[api] New task tenant=${body.tenantId}: "${body.task.slice(0, 60)}..." url=${body.url || 'none'} mode=${mode}`);

  // Fire and forget — return ID immediately
  const taskPromise = runTask(body.task, body.url, {
    forceMode: body.mode === 'auto' ? undefined : body.mode,
    appName: body.appName,
    tenantId: body.tenantId,
    userId: body.userId,
  });

  // Wait 2s to check if fast task completes
  await new Promise(r => setTimeout(r, 2000));
  const tasks = getAllTasks();
  const latest = tasks[tasks.length - 1];

  if (latest && latest.status !== 'running') {
    return c.json(latest);
  }

  return c.json({
    id: latest?.id,
    status: 'running',
    browserMode: autoStealth ? 'stealth' : 'playwright',
    pollUrl: `/task/${latest?.id}`,
  }, 202);
});

// Get task by ID
app.get('/task/:id', (c) => {
  const task = getTask(c.req.param('id'));
  if (!task) return c.json({ error: 'Task not found' }, 404);
  return c.json(task);
});

// List all tasks
app.get('/tasks', (c) => {
  return c.json(getAllTasks().map(t => ({
    id: t.id,
    status: t.status,
    task: t.task,
    steps: t.steps.length,
    browserMode: t.browserMode,
    tokens: t.totalTokens.input + t.totalTokens.output,
    duration: t.completedAt ? `${((t.completedAt - t.startedAt) / 1000).toFixed(1)}s` : 'running',
  })));
});

// Cancel task
app.delete('/task/:id', (c) => {
  const cancelled = cancelTask(c.req.param('id'));
  if (!cancelled) return c.json({ error: 'Task not found or not running' }, 404);
  return c.json({ status: 'cancelled' });
});

// Route check — which browser strategy for this URL?
app.post('/route', async (c) => {
  const body = await c.req.json<{ url: string }>();
  const stealth = await isStealthAvailable();
  const wouldStealth = needsStealth(body.url);
  return c.json({
    url: body.url,
    strategy: wouldStealth ? 'stealth' : 'fast',
    stealthAvailable: stealth,
    reason: wouldStealth ? 'Domain hat Bot-Detection' : 'Kein Anti-Detection noetig',
  });
});

// ---- Accessibility Tree (text-based, 10x cheaper than screenshots) ----
app.post('/a11y/extract', async (c) => {
  const body = await c.req.json<{ url: string }>();
  if (!body.url) return c.json({ error: 'Missing url' }, 400);
  try {
    const resp = await fetch(`http://127.0.0.1:${A11Y_PORT}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: body.url }),
    });
    return c.json(await resp.json());
  } catch (e) {
    return c.json({ error: 'Accessibility tree service unavailable', detail: (e as Error).message }, 503);
  }
});

// ---- Skill Compiler (compile learned skills to Playwright scripts) ----
app.post('/skills/compile', async (c) => {
  try {
    const { execSync } = await import('node:child_process');
    const output = execSync(`${PYTHON_BIN} ${CUA_ROOT}/src/skills/compiler.py`, { encoding: 'utf8', timeout: 10000 });
    return c.json({ status: 'ok', output });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.post('/compiled/run', async (c) => {
  const body = await c.req.json<{ scriptPath?: string; appName?: string; url?: string; timeoutMs?: number }>();
  if (!body.scriptPath) return c.json({ error: 'Missing "scriptPath"' }, 400);
  const { runCompiledScript } = await import('./skills/compiled-runner.js');
  const res = await runCompiledScript(body.scriptPath, { url: body.url, appName: body.appName, timeoutMs: body.timeoutMs });
  return c.json(res);
});

app.get('/skills/compiled', async (c) => {
  const { readdirSync } = await import('node:fs');
  try {
    const files = readdirSync(COMPILED_DIR).filter((f: string) => f.endsWith('.py'));
    return c.json({ compiled: files, count: files.length });
  } catch {
    return c.json({ compiled: [], count: 0 });
  }
});

// ---- Credential Vault ----
app.post('/credentials', async (c) => {
  const body = await c.req.json<{ appName: string; loginUrl: string; username: string; password: string; otpSecret?: string }>();
  if (!body.appName || !body.username || !body.password) {
    return c.json({ error: 'Missing appName, username, or password' }, 400);
  }
  addCredential(body);
  return c.json({ status: 'stored', appName: body.appName });
});

app.get('/credentials', (c) => {
  return c.json(listCredentials());
});

app.delete('/credentials/:appName', (c) => {
  const removed = removeCredential(c.req.param('appName'));
  return removed ? c.json({ status: 'removed' }) : c.json({ error: 'Not found' }, 404);
});

// ---- Skills ----
app.get('/skills', (c) => {
  return c.json(listSkills());
});

// ---- Sessions ----
app.get('/sessions', (c) => {
  return c.json(listSessions());
});

app.delete('/sessions/:appName', (c) => {
  const removed = deleteSession(c.req.param('appName'));
  return removed ? c.json({ status: 'removed' }) : c.json({ error: 'Not found' }, 404);
});

// ---- Audit ----
app.get('/audit/tenant/:tenantId', async (c) => {
  const tenantId = c.req.param('tenantId');
  const limit = Math.min(Number(c.req.query('limit')) || 100, 500);
  const rows = await sql`
    SELECT task_id, step_num, event_type, status, app_name, action,
           tokens_input, tokens_output, error, occurred_at
    FROM cu_audit
    WHERE tenant_id = ${tenantId}
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `;
  return c.json({ tenantId, count: rows.length, events: rows });
});

app.get('/audit/task/:taskId', async (c) => {
  const taskId = c.req.param('taskId');
  const rows = await sql`
    SELECT step_num, event_type, status, action, thinking, input_mode,
           browser_mode, tokens_input, tokens_output, error, occurred_at
    FROM cu_audit
    WHERE task_id = ${taskId}
    ORDER BY occurred_at ASC
  `;
  return c.json({ taskId, count: rows.length, events: rows });
});

// 404
app.notFound((c) => c.json({ error: `Not found: ${c.req.method} ${c.req.path}` }, 404));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  TEX Browse-Use Engine v2.0                                 ║');
  console.log('║  Self-hosted | DSGVO-konform | Bedrock EU                   ║');
  console.log(`║  Port ${info.port}                                                 ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  POST /task        — Neue Browser-Automation starten        ║');
  console.log('║  GET  /task/:id    — Task-Status abfragen                   ║');
  console.log('║  GET  /tasks       — Alle Tasks auflisten                   ║');
  console.log('║  DELETE /task/:id  — Task abbrechen                         ║');
  console.log('║  POST /route        — Browser-Strategie fuer URL pruefen    ║');
  console.log('║  GET  /health      — Service Health                         ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Browser: Playwright (fast) + SeleniumBase UC (stealth)     ║');
  console.log('║  LLM: Claude Sonnet 4.6 via Bedrock EU Frankfurt            ║');
  console.log('║  Auto-Routing: Google/Amazon → stealth, Rest → fast         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
});
