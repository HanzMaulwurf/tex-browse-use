import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSession } from '../browser/session-manager.js';

const PYTHON = process.env.PYTHON_BIN || '/opt/computer-use-agent/.venv/bin/python';

// Convert our saved SessionState -> Playwright storage_state JSON file.
// Returns a temp file path the caller must let the runner clean up.
function sessionToStorageState(appName: string): string | null {
  const s = loadSession(appName);
  if (!s) return null;
  const origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> = [];
  if (s.localStorage && Object.keys(s.localStorage).length && s.url) {
    try {
      const origin = new URL(s.url).origin;
      origins.push({ origin, localStorage: Object.entries(s.localStorage).map(([name, value]) => ({ name, value })) });
    } catch { /* bad url, skip localStorage */ }
  }
  const storageState = { cookies: s.cookies || [], origins };
  const tmp = path.join(os.tmpdir(), `storage-${appName}-${process.pid}-${origins.length}.json`);
  fs.writeFileSync(tmp, JSON.stringify(storageState));
  return tmp;
}

export interface CompiledResult { ok: boolean; durationMs: number; error?: string; stdoutTail?: string; }

/**
 * Spawn a compiled Playwright replay script (no LLM). The app's saved session
 * is injected as Playwright storage_state so the replay runs authenticated.
 * Never throws — always resolves with {ok}.
 */
export function runCompiledScript(
  scriptPath: string,
  opts: { url?: string; appName?: string; timeoutMs?: number } = {},
): Promise<CompiledResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    if (!fs.existsSync(scriptPath)) { resolve({ ok: false, durationMs: 0, error: `script not found: ${scriptPath}` }); return; }
    const args = [scriptPath];
    if (opts.url) args.push('--url', opts.url);
    let storagePath: string | null = null;
    if (opts.appName) {
      storagePath = sessionToStorageState(opts.appName);
      if (storagePath) args.push('--storage-state', storagePath);
    }
    const child = spawn(PYTHON, args, { env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const killer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs || 120000);
    const cleanup = () => { if (storagePath) { try { fs.unlinkSync(storagePath); } catch { /* ignore */ } } };
    child.on('close', (code) => {
      clearTimeout(killer); cleanup();
      const durationMs = Date.now() - start;
      if (code === 0) resolve({ ok: true, durationMs, stdoutTail: stdout.slice(-200) });
      else resolve({ ok: false, durationMs, error: (stderr || `exit ${code}`).slice(-400) });
    });
    child.on('error', (e) => { clearTimeout(killer); cleanup(); resolve({ ok: false, durationMs: Date.now() - start, error: e.message }); });
  });
}
