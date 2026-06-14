import { takeScreenshot, executeAction, navigateTo, getPageInfo, closeBrowser, launchBrowser, saveCurrentSession, restoreSession, extractAccessibilityTree, type ComputerAction } from './browser/playwright.js';
import { computerUseCall, type ContentBlock } from './providers/index.js';
import { SmartBrowser } from './browser/controller.js';
import { getCredential, getLoginInstructions } from './vault/credential-store.js';
import { learnSkillFromTask, getSkillContext } from './skills/skill-store.js';
import { recordTaskStart, recordStep, recordTaskEnd } from './audit-log.js';

const MAX_STEPS = Number(process.env.MAX_STEPS) || 50;
const MAX_RETRIES = 3;
const SLIDING_WINDOW_SIZE = 9; // Tighter window: 1 initial + 4 exchanges

// ============================================================
// OPTIMIZATION 1: Accessibility Tree (26 tokens vs 3500)
// Fetch text-based page state — 100x cheaper than screenshot
// ============================================================
async function getAccessibilityTree(useStealth = false): Promise<{ text: string; tokens: number } | null> {
  if (useStealth) return null; // live page is in SeleniumBase; in-process Playwright tree would be wrong
  const tree = await extractAccessibilityTree();
  if (!tree || tree.elementCount < 2) return null; // Page too empty, need screenshot
  return { text: tree.treeText, tokens: tree.tokenEstimate };
}

// ============================================================
// OPTIMIZATION 2: Smart Screenshot Strategy
// - Only take screenshot when VISUALLY needed
// - Use compressed quality for routine steps
// - Never send more than 1 screenshot per message
// ============================================================
function needsScreenshot(step: number, lastAction?: string, thinking?: string): boolean {
  // Always screenshot on first step (need to see the page)
  if (step <= 1) return true;
  // After login actions (need to verify it worked)
  if (thinking?.toLowerCase().includes('login') || thinking?.toLowerCase().includes('anmeld')) return true;
  // After navigation (need to see new page)
  if (lastAction === 'navigate' || thinking?.toLowerCase().includes('navigier')) return true;
  // If Claude requested a screenshot explicitly
  if (lastAction === 'screenshot') return true;
  // After clicking (might open modal/dialog)
  if (lastAction === 'left_click' || lastAction === 'right_click') return true;
  // After scroll (page content changed)
  if (lastAction === 'scroll') return true;
  // Type/key actions: a11y tree is enough
  if (lastAction === 'type' || lastAction === 'key') return false;
  // Default: screenshot
  return true;
}

export interface TaskResult {
  id: string;
  tenantId: string;
  userId?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  task: string;
  steps: StepRecord[];
  totalTokens: { input: number; output: number };
  startedAt: number;
  completedAt?: number;
  error?: string;
  finalUrl?: string;
  finalTitle?: string;
  browserMode: string;
  appName?: string;
  retries: number;
  screenshotsSent: number;
  a11yTreesSent: number;
}

interface StepRecord {
  step: number;
  timestamp: number;
  action?: ComputerAction;
  thinking?: string;
  browserMode?: string;
  retried?: boolean;
  inputMode?: 'screenshot' | 'a11y-tree';
}

const tasks = new Map<string, TaskResult>();
const cancelTokens = new Map<string, boolean>();

export function getTask(id: string): TaskResult | undefined { return tasks.get(id); }
export function getAllTasks(): TaskResult[] { return [...tasks.values()]; }
export function cancelTask(id: string): boolean {
  if (cancelTokens.has(id)) { cancelTokens.set(id, true); return true; }
  return false;
}
// ============================================================
// OPTIMIZED AGENT LOOP
// ============================================================
export async function runTask(
  taskDescription: string,
  startUrl?: string,
  options?: { forceMode?: 'playwright' | 'stealth'; appName?: string; tenantId: string; userId?: string },
): Promise<TaskResult> {
  if (!options?.tenantId) throw new Error('tenantId is required');
  const id = crypto.randomUUID();
  const tenantId = options.tenantId;
  const userId = options.userId;
  const result: TaskResult = {
    id, tenantId, userId, status: 'running', task: taskDescription, steps: [],
    totalTokens: { input: 0, output: 0 }, startedAt: Date.now(),
    browserMode: 'auto', retries: 0, screenshotsSent: 0, a11yTreesSent: 0,
  };
  tasks.set(id, result);
  cancelTokens.set(id, false);
  recordTaskStart({ taskId: id, tenantId, userId, appName: options.appName, taskDescription, browserMode: 'auto' }).catch(e => console.error('[audit] task_start:', e.message));

  const browser = new SmartBrowser();
  const appName = options?.appName || '';

  // System prompt
  let systemPrompt = `Du bist ein Computer-Automatisierungs-Agent.
Regeln:
- Fuehre die Aufgabe Schritt fuer Schritt aus
- Du bekommst entweder einen SCREENSHOT oder eine TEXT-BESCHREIBUNG der Seite
- Bei Text-Beschreibung: Elemente haben [idx] Nummern und (x,y) Koordinaten — nutze die Koordinaten zum Klicken
- Wenn die Aufgabe erledigt ist: antworte NUR mit Text, KEIN tool_use, sage AUFGABE ERLEDIGT
- Cookie-Banner: ablehnen
- NIEMALS Passwoerter preisgeben
- Wenn BLOCKED/CAPTCHA: sage BLOCKED`;

  if (appName) {
    const loginInstr = getLoginInstructions(appName);
    if (loginInstr) { systemPrompt += '\n\n' + loginInstr; }
    const skillCtx = getSkillContext(appName, taskDescription);
    if (skillCtx) { systemPrompt += '\n' + skillCtx; }
  }

  result.appName = appName;
  result.browserMode = browser.mode;
  const messages: Array<{ role: string; content: any[] }> = [];

  try {
    await browser.init(startUrl, options.forceMode === 'stealth' ? true : options.forceMode === 'playwright' ? false : undefined);
    if (appName && !browser.useStealth) await restoreSession(appName);
    if (startUrl) {
      await browser.navigate(startUrl);
      console.log(`[agent] Navigated to ${startUrl} (${browser.mode})`);
    }

    // OPTIMIZATION: First message always gets a screenshot (need to see the page)
    const firstScreenshot = await browser.screenshot();
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: `Aufgabe: ${taskDescription}` },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: firstScreenshot.toString('base64') } },
      ],
    });
    result.screenshotsSent++;

    let lastAction: string | undefined;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (cancelTokens.get(id)) { result.status = 'cancelled'; break; }

      // OPTIMIZATION 3: Sliding window — tighter (9 messages)
      if (messages.length > SLIDING_WINDOW_SIZE) {
        const first = messages[0];
        const recent = messages.slice(-(SLIDING_WINDOW_SIZE - 1));
        messages.length = 0;
        messages.push(first, ...recent);
      }

      console.log(`[agent] Step ${step + 1}: Bedrock EU (${browser.mode})...`);
      const response = await computerUseCall(messages, systemPrompt);
      result.totalTokens.input += response.usage.inputTokens;
      result.totalTokens.output += response.usage.outputTokens;

      const stepRecord: StepRecord = { step: step + 1, timestamp: Date.now(), browserMode: browser.mode };

      let thinking = '';
      let toolUseBlock: ContentBlock | null = null;
      for (const block of response.content) {
        if (block.type === 'text' && block.text) thinking += block.text;
        if (block.type === 'tool_use' && block.name === 'computer') toolUseBlock = block;
      }
      stepRecord.thinking = thinking;
      if (thinking) console.log(`[agent] Step ${step + 1}:`, thinking.slice(0, 80));

      if (thinking.includes('BLOCKED') || thinking.includes('CAPTCHA')) {
        result.status = 'failed'; result.error = 'BLOCKED/CAPTCHA'; result.steps.push(stepRecord); break;
      }
      if (!toolUseBlock) {
        result.status = 'completed'; result.steps.push(stepRecord); break;
      }

      const action = toolUseBlock.input as ComputerAction;
      stepRecord.action = action;
      lastAction = action.action;

      const { success, retried } = await browser.executeWithRetry(action);
      stepRecord.retried = retried;
      if (retried) result.retries++;

      await new Promise(r => setTimeout(r, 400));

      // ============================================================
      // OPTIMIZATION 4: Smart Input — A11y Tree OR Screenshot
      // Only send screenshot when visually needed
      // Otherwise send text (10-100x cheaper)
      // ============================================================
      const useScreenshot = needsScreenshot(step + 1, action.action, thinking);
      let toolResultContent: any[];

      if (useScreenshot) {
        const screenshot = await browser.screenshot();
        toolResultContent = [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: screenshot.toString('base64') },
        }];
        stepRecord.inputMode = 'screenshot';
        result.screenshotsSent++;
        console.log(`[agent] Step ${step + 1}: Sending SCREENSHOT`);
      } else {
        // Try accessibility tree first
        const tree = await getAccessibilityTree(browser.useStealth);
        if (tree && tree.tokens > 10) {
          toolResultContent = [{ type: 'text', text: `[Seiten-Status nach Aktion]\n${tree.text}` }];
          stepRecord.inputMode = 'a11y-tree';
          result.a11yTreesSent++;
          console.log(`[agent] Step ${step + 1}: Sending A11Y TREE (${tree.tokens} tokens vs ~3500 screenshot)`);
        } else {
          // Fallback to screenshot
          const screenshot = await browser.screenshot();
          toolResultContent = [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: screenshot.toString('base64') },
          }];
          stepRecord.inputMode = 'screenshot';
          result.screenshotsSent++;
          console.log(`[agent] Step ${step + 1}: A11y tree empty, sending SCREENSHOT`);
        }
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
      recordStep({
        taskId: id, tenantId, stepNum: stepRecord.step,
        action: stepRecord.action?.action, thinking: stepRecord.thinking,
        inputMode: stepRecord.inputMode, browserMode: stepRecord.browserMode,
        tokensInput: response.usage.inputTokens, tokensOutput: response.usage.outputTokens,
      }).catch(e => console.error('[audit] step:', e.message));
      if (response.stopReason === 'end_turn') { result.status = 'completed'; break; }
    }

    if (result.status === 'running') {
      result.status = 'failed'; result.error = `Max steps (${MAX_STEPS}) reached`;
    }

    try { const pi = await getPageInfo(); result.finalUrl = pi.url; result.finalTitle = pi.title; } catch {}

    if (result.status === 'completed' && appName) {
      try { await saveCurrentSession(appName); } catch {}
      try { learnSkillFromTask(appName, taskDescription, result.steps as any); } catch {}
    }

  } catch (err) {
    result.status = 'failed';
    result.error = err instanceof Error ? err.message : String(err);
  }

  result.completedAt = Date.now();
  cancelTokens.delete(id);
  const dur = ((result.completedAt - result.startedAt) / 1000).toFixed(1);
  const tok = result.totalTokens.input + result.totalTokens.output;
  console.log(`[agent] Task ${id.slice(0,8)} ${result.status} in ${dur}s | ${result.steps.length} steps | ${tok} tokens | ${result.screenshotsSent} screenshots + ${result.a11yTreesSent} a11y trees | ${result.retries} retries`);
  recordTaskEnd({
    taskId: id, tenantId, stepNum: result.steps.length,
    status: result.status === 'running' ? 'failed' : result.status,
    totalTokensInput: result.totalTokens.input, totalTokensOutput: result.totalTokens.output,
    error: result.error,
  }).catch(e => console.error('[audit] task_end:', e.message));
  return result;
}
