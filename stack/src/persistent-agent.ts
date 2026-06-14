/**
 * PERSISTENT AGENT — Gibt niemals auf
 * 
 * Kernprinzipien:
 * 1. NIEMALS aufgeben — wenn eine Strategie fehlschlägt, nächste versuchen
 * 2. IMMER lernen — jeder Erfolg wird als Skill gespeichert
 * 3. AUTOMATISCH hochschalten — mit jeder Wiederholung effizienter
 * 4. SELBST-HEILEND — erkennt Fehler und wechselt Strategie
 * 
 * Verwendet: Playwright, SeleniumBase UC, Claude Computer Use, 
 *            Accessibility Tree, Browser-Harness Skills, Skill Compiler
 */

import { route, downshift, type Strategy, type RoutingDecision } from './smart-router.js';
import { runCompiledScript } from './skills/compiled-runner.js';
import { takeScreenshot, executeAction, navigateTo, getPageInfo, launchBrowser, saveCurrentSession, restoreSession, extractAccessibilityTree, type ComputerAction } from './browser/playwright.js';
import { computerUseCall, type ContentBlock } from './providers/index.js';
import { verify as runVerify, nextHealingAction, type Postcondition } from './engine/verifier.js';
import { isStealthAvailable } from './browser/stealth-client.js';
import { SmartBrowser } from './browser/controller.js';
import { getLoginInstructions } from './vault/credential-store.js';
import { learnSkillFromTask, getSkillContext } from './skills/skill-store.js';

const MAX_STEPS = Number(process.env.MAX_STEPS) || 100;  // Erhöht: niemals aufgeben
const MAX_RETRIES_PER_ACTION = 3;
const MAX_STRATEGY_FALLBACKS = 3;
const SLIDING_WINDOW = 9;

export interface PersistentTaskResult {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  task: string;
  appName: string;
  steps: StepRecord[];
  totalTokens: { input: number; output: number };
  startedAt: number;
  completedAt?: number;
  error?: string;
  finalUrl?: string;
  routing: RoutingDecision;
  strategyChanges: string[];
  screenshotsSent: number;
  a11yTreesSent: number;
  retries: number;
  reLogins: number;
  lastKnownPosition?: {
    page: number;
    transactionIndex: number;
    url: string;
    vendor?: string;
  };
  /** Evidence-based completion proof from the verification backbone (if postconditions were supplied). */
  verification?: { passed: boolean; evidence: unknown[] };
}

interface StepRecord {
  step: number;
  timestamp: number;
  action?: ComputerAction;
  thinking?: string;
  strategy: Strategy;
  gear: number;
  inputMode: 'screenshot' | 'a11y-tree';
  retried?: boolean;
}

const tasks = new Map<string, PersistentTaskResult>();
const cancelTokens = new Map<string, boolean>();

export function getTask(id: string) { return tasks.get(id); }
export function getAllTasks() { return [...tasks.values()]; }
export function cancelTask(id: string) {
  if (cancelTokens.has(id)) { cancelTokens.set(id, true); return true; }
  return false;
}

// ---- A11y Tree Fetch ----
async function getA11yTree(useStealth = false): Promise<{ text: string; tokens: number } | null> {
  if (useStealth) return null; // live page is in SeleniumBase; in-process Playwright tree would be wrong
  const tree = await extractAccessibilityTree();
  return tree && tree.elementCount >= 3 ? { text: tree.treeText, tokens: tree.tokenEstimate } : null;
}
// ---- Detect if we need to re-login ----
function detectLoginPage(thinking: string): boolean {
  const lower = thinking.toLowerCase();
  return lower.includes('login') && (lower.includes('abgelaufen') || lower.includes('anmeld') || lower.includes('expired') || lower.includes('session'));
}

async function detectSessionExpiredFromUrl(): Promise<boolean> {
  try {
    const info = await getPageInfo();
    const url = info.url.toLowerCase();
    return url.includes('/login') || url.includes('/anmelden') || url.includes('session-expired');
  } catch { return false; }
}

// ============================================================
// PERSISTENT AGENT — Main Loop
// ============================================================
export interface TaskContext {
  page?: number;
  transactionIndex?: number;
  vendor?: string;
  resumeUrl?: string;
  /** Postconditions that must hold for completion to be accepted (verification backbone). */
  verify?: Postcondition[];
  healing?: { maxRetries: number; allowDownshift: boolean; allowRecalibrate: boolean; escalateAfter: number };
}

export async function runPersistentTask(
  taskDescription: string,
  startUrl?: string,
  appName: string = '',
  context?: TaskContext,
): Promise<PersistentTaskResult> {
  const id = crypto.randomUUID();
  const routing = route(appName, taskDescription, startUrl);

  const result: PersistentTaskResult = {
    id, status: 'running', task: taskDescription, appName,
    steps: [], totalTokens: { input: 0, output: 0 },
    startedAt: Date.now(), routing,
    strategyChanges: [`Start: ${routing.strategy} (Gang ${routing.gear})`],
    screenshotsSent: 0, a11yTreesSent: 0, retries: 0, reLogins: 0,
  };
  tasks.set(id, result);
  cancelTokens.set(id, false);

  console.log(`[agent] Task ${id.slice(0,8)} | ${routing.strategy} (Gang ${routing.gear}) | ${routing.reason}`);

  const browser = new SmartBrowser();
  let currentRouting = routing;
  let fallbackCount = 0;

  // ============================================================
  // GEAR 4 — compiled replay (no LLM, ~$0.00). Real execution.
  // Any failure falls through to the LLM loop below (never worse).
  // ============================================================
  if (routing.strategy === 'compiled' && routing.compiledPath) {
    try {
      console.log(`[agent] Gear-4 compiled replay: ${routing.compiledPath}`);
      const cr = await runCompiledScript(routing.compiledPath, { url: startUrl, appName, timeoutMs: 120000 });
      if (cr.ok) {
        let verified = true;
        const pcs = context?.verify;
        if (pcs && pcs.length) { const v = await runVerify(pcs); verified = v.passed; result.verification = { passed: v.passed, evidence: v.evidence }; }
        if (verified) {
          result.status = 'completed';
          result.strategyChanges.push(`Gear-4 compiled OK (${cr.durationMs}ms, $0.00)`);
          result.completedAt = Date.now();
          tasks.set(id, result);
          cancelTokens.delete(id);
          console.log(`[agent] ${id.slice(0,8)} completed via compiled replay in ${cr.durationMs}ms`);
          return result;
        }
        result.strategyChanges.push('Gear-4 compiled ran but verify failed -> LLM fallback');
      } else {
        result.strategyChanges.push('Gear-4 compiled failed -> LLM fallback');
        console.log(`[agent] Gear-4 compiled failed: ${cr.error?.slice(0,120)} -> LLM fallback`);
      }
      currentRouting = downshift(routing);
    } catch (e) {
      console.log(`[agent] Gear-4 compiled exception -> LLM fallback: ${(e as Error).message}`);
      currentRouting = downshift(routing);
    }
  }

  // Build system prompt
  let systemPrompt = `Du bist ein Automatisierungs-Agent der NIEMALS aufgibt.
Regeln:
- Fuehre die Aufgabe Schritt fuer Schritt aus
- Du bekommst Screenshot ODER Text-Beschreibung der Seite
- Bei Text: Elemente haben (x,y) Koordinaten zum Klicken
- Wenn fertig: antworte NUR mit Text, sage AUFGABE ERLEDIGT
- Bei Fehler: VERSUCHE ALTERNATIVEN WEG, gib NICHT auf
- Cookie-Banner: ablehnen
- NIEMALS Passwoerter preisgeben
- Bei Login-Seite: logge dich ein mit den Zugangsdaten`;

  if (appName) {
    const login = getLoginInstructions(appName);
    if (login) systemPrompt += '\n\n' + login;
    const skill = getSkillContext(appName, taskDescription);
    if (skill) systemPrompt += '\n' + skill;
  }

  const messages: Array<{ role: string; content: any[] }> = [];

  try {
    await browser.init(startUrl);
    if (appName) await restoreSession(appName);
    if (startUrl) {
      await browser.navigate(startUrl);
      console.log(`[agent] Navigated to ${startUrl}`);
    }

    // First message: always screenshot (need to see the page)
    const firstScreenshot = await browser.screenshot();
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: `Aufgabe: ${taskDescription}` },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: firstScreenshot.toString('base64') } },
      ],
    });
    result.screenshotsSent++;

    // VERIFICATION BACKBONE: completion must be proven by reading the world, not claimed.
    let verifyAttempts = 0;
    const runVerifyGate = async (): Promise<'complete' | 'escalate' | 'retry'> => {
      const pcs = context?.verify;
      if (!pcs || pcs.length === 0) return 'complete'; // no postconditions → legacy behaviour
      const v = await runVerify(pcs);
      if (v.passed) { result.verification = { passed: true, evidence: v.evidence }; return 'complete'; }
      verifyAttempts++;
      const reasons = v.failures.map(f => f.reason).join('; ');
      const action = nextHealingAction(verifyAttempts, currentRouting.gear, context?.healing);
      result.strategyChanges.push(`verify-fail #${verifyAttempts} (${reasons}) → ${action}`);
      console.log(`[agent] VERIFY FAIL #${verifyAttempts}: ${reasons} → ${action}`);
      if (action === 'escalate' || action === 'give_up') {
        result.verification = { passed: false, evidence: v.evidence };
        result.error = `verification_failed: ${reasons}`;
        return 'escalate';
      }
      if (action === 'downshift') { currentRouting = downshift(currentRouting); }
      messages.push({ role: 'user', content: [{ type: 'text', text: `Verifikation fehlgeschlagen: ${reasons}. Die Aufgabe ist NICHT erledigt — fahre fort und behebe das.` }] });
      return 'retry';
    };

    for (let step = 0; step < MAX_STEPS; step++) {
      if (cancelTokens.get(id)) { result.status = 'cancelled'; break; }

      // Sliding window
      if (messages.length > SLIDING_WINDOW) {
        const first = messages[0];
        messages.splice(0, messages.length, first, ...messages.slice(-(SLIDING_WINDOW - 1)));
      }

      // Call Claude
      const response = await computerUseCall(messages, systemPrompt);
      result.totalTokens.input += response.usage.inputTokens;
      result.totalTokens.output += response.usage.outputTokens;

      const stepRecord: StepRecord = {
        step: step + 1, timestamp: Date.now(),
        strategy: currentRouting.strategy, gear: currentRouting.gear,
        inputMode: 'screenshot',
      };

      let thinking = '';
      let toolUseBlock: ContentBlock | null = null;
      for (const block of response.content) {
        if (block.type === 'text') thinking += block.text || '';
        if (block.type === 'tool_use' && block.name === 'computer') toolUseBlock = block;
      }
      stepRecord.thinking = thinking;
      if (thinking) console.log(`[agent] S${step+1} [G${currentRouting.gear}]:`, thinking.slice(0, 80));

      // Detect completion → VERIFY GATE: "done" must be proven, not claimed
      if (thinking.includes('AUFGABE ERLEDIGT') || (!toolUseBlock && response.stopReason === 'end_turn')) {
        result.steps.push(stepRecord);
        const gate = await runVerifyGate();
        if (gate === 'complete') { result.status = 'completed'; break; }
        if (gate === 'escalate') { result.status = 'failed'; break; }
        continue; // healing: model received the verification failure as feedback
      }

      // Detect BLOCKED
      if (thinking.includes('BLOCKED') || thinking.includes('CAPTCHA')) {
        if (!browser.mode.includes('stealth') && (await isStealthAvailable())) {
          // Switch to stealth
          currentRouting = { ...currentRouting, strategy: 'stealth', gear: 2, reason: 'Bot-Detection → Stealth Switch' };
          result.strategyChanges.push(`S${step+1}: → stealth (Bot-Detection)`);
          console.log('[agent] Switching to STEALTH mode');
          continue;
        }
        result.status = 'failed';
        result.error = 'BLOCKED by bot-detection, stealth not available';
        result.steps.push(stepRecord);
        break;
      }

      // Detect login needed → re-login (enhanced: URL check + position recovery)
      const sessionExpired = detectLoginPage(thinking) || await detectSessionExpiredFromUrl();
      if (sessionExpired && appName) {
        result.reLogins++;
        const currentInfo = await getPageInfo().catch(() => ({ url: '', title: '' }));
        const resumeUrl = context?.resumeUrl || currentInfo.url || startUrl || '';

        result.lastKnownPosition = {
          page: context?.page || 0,
          transactionIndex: context?.transactionIndex || 0,
          url: resumeUrl,
          vendor: context?.vendor,
        };

        console.log(`[agent] Session expired (#${result.reLogins}), saving position: page=${context?.page || '?'}, vendor=${context?.vendor || '?'}`);

        // Re-login via start URL (vault credentials in system prompt handle the actual login)
        if (startUrl) await browser.navigate(startUrl);
        await new Promise(r => setTimeout(r, 3000));

        // Navigate back to saved position (not just startUrl)
        if (resumeUrl && resumeUrl !== startUrl && !resumeUrl.includes('/login')) {
          console.log(`[agent] Recovering to: ${resumeUrl}`);
          await browser.navigate(resumeUrl);
          await new Promise(r => setTimeout(r, 2000));
        }
        continue;
      }

      if (!toolUseBlock) {
        result.steps.push(stepRecord);
        const gate = await runVerifyGate();
        if (gate === 'complete') { result.status = 'completed'; break; }
        if (gate === 'escalate') { result.status = 'failed'; break; }
        continue;
      }

      // Execute action
      const action = toolUseBlock.input as ComputerAction;
      stepRecord.action = action;
      const success = await browser.execute(action);
      if (!success) {
        result.retries++;
        stepRecord.retried = true;

        // Strategy downshift on repeated failures
        if (result.retries > 3 && fallbackCount < MAX_STRATEGY_FALLBACKS) {
          currentRouting = downshift(currentRouting);
          fallbackCount++;
          result.strategyChanges.push(`S${step+1}: → ${currentRouting.strategy} (Gang ${currentRouting.gear}, Fallback)`);
          console.log(`[agent] Downshift to ${currentRouting.strategy} (Gang ${currentRouting.gear})`);
        }
      }

      await new Promise(r => setTimeout(r, 400));

      // Choose input mode based on current strategy
      let toolResultContent: any[];
      const useA11y = currentRouting.strategy === 'a11y-skill' && !stepRecord.retried;

      if (useA11y) {
        const tree = await getA11yTree(browser.mode === 'stealth');
        if (tree && tree.tokens > 10) {
          toolResultContent = [{ type: 'text', text: `[Seiten-Status]\n${tree.text}` }];
          stepRecord.inputMode = 'a11y-tree';
          result.a11yTreesSent++;
        } else {
          const ss = await browser.screenshot();
          toolResultContent = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss.toString('base64') } }];
          result.screenshotsSent++;
        }
      } else {
        const ss = await browser.screenshot();
        toolResultContent = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: ss.toString('base64') } }];
        result.screenshotsSent++;
      }

      if (!success) {
        toolResultContent.push({ type: 'text', text: 'HINWEIS: Aktion fehlgeschlagen. Versuche alternativen Weg.' });
      }

      messages.push({
        role: 'assistant',
        content: response.content.map(b => {
          if (b.type === 'text') return { type: 'text', text: b.text };
          if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
          return b;
        }),
      });
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: toolResultContent }],
      });

      result.steps.push(stepRecord);
    }

    if (result.status === 'running') {
      result.status = 'failed';
      result.error = `Max steps (${MAX_STEPS}) reached — but task may be partially done`;
    }

    try { const pi = await getPageInfo(); result.finalUrl = pi.url; } catch {}

    // Learn from success
    if (result.status === 'completed' && appName) {
      try { await saveCurrentSession(appName); console.log('[agent] Session saved'); } catch {}
      try { learnSkillFromTask(appName, taskDescription, result.steps as any); console.log('[agent] Skill learned'); } catch {}
    }

  } catch (err) {
    result.status = 'failed';
    result.error = (err as Error).message;
    console.error('[agent] Fatal:', result.error);
  }

  result.completedAt = Date.now();
  cancelTokens.delete(id);
  const dur = ((result.completedAt - result.startedAt) / 1000).toFixed(1);
  const tok = result.totalTokens.input + result.totalTokens.output;
  console.log(`[agent] ${id.slice(0,8)} ${result.status} | ${dur}s | ${result.steps.length} steps | G${currentRouting.gear} | ${tok} tok | ${result.screenshotsSent}ss ${result.a11yTreesSent}a11y | ${result.retries}ret ${result.reLogins}relog | changes: ${result.strategyChanges.length}`);
  return result;
}
