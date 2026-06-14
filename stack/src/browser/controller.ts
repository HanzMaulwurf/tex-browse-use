import { launchBrowser, navigateTo, takeScreenshot, executeAction, type ComputerAction } from './playwright.js';
import {
  isStealthAvailable, stealthNavigate, stealthClick, stealthType,
  stealthKey, stealthScreenshot, stealthScroll, needsStealth,
} from './stealth-client.js';

const MAX_RETRIES = 3;

/**
 * Shared browser controller for both the computer-use loop (agent-loop.ts) and
 * the smart/persistent engine (persistent-agent.ts). Transparently switches
 * between the persistent Playwright browser and the SeleniumBase UC stealth
 * browser based on the target domain.
 *
 * Behaviour is the union of the two previously-duplicated classes:
 *  - executeWithRetry() returns {success, retried}  (computer-use loop)
 *  - execute() returns a plain boolean              (persistent engine)
 *  - navigate() re-evaluates stealth per navigation (mid-task domain switch)
 */
export class SmartBrowser {
  public useStealth = false;
  private stealthAvailable = false;
  private forcedStealth: boolean | null = null;

  async init(url?: string, forceStealth?: boolean): Promise<void> {
    this.stealthAvailable = await isStealthAvailable();
    this.forcedStealth = forceStealth === undefined ? null : forceStealth;
    if (this.forcedStealth !== null) this.useStealth = this.forcedStealth && this.stealthAvailable;
    else this.useStealth = this.stealthAvailable && url ? needsStealth(url) : false;
    if (!this.useStealth) await launchBrowser();
    console.log(`[browser] Mode: ${this.useStealth ? 'STEALTH' : 'PERSISTENT'}${this.forcedStealth !== null ? ' (forced)' : ''}`);
  }

  async navigate(url: string): Promise<void> {
    if (this.forcedStealth === null) {
      const shouldStealth = this.stealthAvailable && needsStealth(url);
      if (shouldStealth !== this.useStealth) {
        this.useStealth = shouldStealth;
        if (!shouldStealth) await launchBrowser();
      }
    }
    if (this.useStealth) await stealthNavigate(url);
    else await navigateTo(url);
  }

  async screenshot(): Promise<Buffer> {
    return this.useStealth ? await stealthScreenshot() : await takeScreenshot();
  }

  async executeWithRetry(action: ComputerAction): Promise<{ success: boolean; retried: boolean }> {
    if (action.action === 'screenshot') return { success: true, retried: false };
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (this.useStealth) {
          switch (action.action) {
            case 'left_click': case 'right_click': case 'double_click':
              await stealthClick(action.coordinate![0], action.coordinate![1]); break;
            case 'type': await stealthType(action.text!); break;
            case 'key': await stealthKey(action.text!); break;
            case 'scroll': await stealthScroll(action.direction || 'down', 300); break;
            default: await executeAction(action);
          }
        } else {
          await executeAction(action);
        }
        return { success: true, retried: attempt > 1 };
      } catch (err) {
        console.warn(`[agent] Action failed (attempt ${attempt}/${MAX_RETRIES}):`, (err as Error).message?.slice(0, 60));
        if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    return { success: false, retried: true };
  }

  /** Convenience wrapper for callers that only need success/failure. */
  async execute(action: ComputerAction): Promise<boolean> {
    return (await this.executeWithRetry(action)).success;
  }

  get mode(): string { return this.useStealth ? 'stealth' : 'playwright'; }
}
