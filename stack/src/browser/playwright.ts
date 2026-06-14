import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { saveSession, loadSession } from './session-manager.js';

const WIDTH = Number(process.env.SCREENSHOT_WIDTH) || 1024;
const HEIGHT = Number(process.env.SCREENSHOT_HEIGHT) || 768;

// ============================================================
// FIX 1: PERSISTENT BROWSER — one browser for ALL tasks
// No more re-login per task. Browser stays open.
// ============================================================
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

export async function launchBrowser(): Promise<Page> {
  // Reuse existing page if still open
  if (page && !page.isClosed()) return page;

  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: process.env.BROWSER_HEADLESS !== 'false',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', `--window-size=${WIDTH},${HEIGHT}`],
    });
    console.log('[browser] Chromium launched (PERSISTENT)');
  }

  if (!context) {
    context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      acceptDownloads: true,
    });
  }

  if (!page || page.isClosed()) {
    page = await context.newPage();
  }

  return page;
}

export async function takeScreenshot(): Promise<Buffer> {
  const p = await launchBrowser();
  return await p.screenshot({ type: 'png', fullPage: false });
}

// ============================================================
// FIX 2: SPA-NAVIGATION — page.goto() statt Menü-Klicks
// Funktioniert zuverlässig für alle SPAs
// ============================================================
export async function navigateTo(url: string): Promise<void> {
  const p = await launchBrowser();
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    // Fallback: networkidle for slow SPAs
    await p.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  }
  // Extra wait for SPA hydration
  await p.waitForTimeout(1500);
}

export async function executeAction(action: ComputerAction): Promise<void> {
  const p = await launchBrowser();

  // Key mapping: Claude → Playwright
  const keyMap: Record<string, string> = {
    'Return': 'Enter', 'return': 'Enter',
    'space': ' ', 'Space': ' ',
    'BackSpace': 'Backspace', 'backspace': 'Backspace',
    'super': 'Meta', 'Super': 'Meta',
    'ctrl': 'Control', 'Ctrl': 'Control', 'Control_L': 'Control',
    'alt': 'Alt', 'Alt_L': 'Alt',
    'shift': 'Shift', 'Shift_L': 'Shift',
    'Tab': 'Tab', 'tab': 'Tab',
    'Escape': 'Escape', 'escape': 'Escape', 'Esc': 'Escape',
    'Delete': 'Delete', 'delete': 'Delete',
    'Up': 'ArrowUp', 'Down': 'ArrowDown', 'Left': 'ArrowLeft', 'Right': 'ArrowRight',
    'Page_Up': 'PageUp', 'Page_Down': 'PageDown',
  };

  switch (action.action) {
    case 'screenshot':
      break;
    case 'mouse_move':
      await p.mouse.move(action.coordinate![0], action.coordinate![1]);
      break;
    case 'left_click':
      await p.mouse.click(action.coordinate![0], action.coordinate![1]);
      break;
    case 'left_click_drag':
      await p.mouse.move(action.startCoordinate![0], action.startCoordinate![1]);
      await p.mouse.down();
      await p.mouse.move(action.coordinate![0], action.coordinate![1]);
      await p.mouse.up();
      break;
    case 'right_click':
      await p.mouse.click(action.coordinate![0], action.coordinate![1], { button: 'right' });
      break;
    case 'double_click':
      await p.mouse.dblclick(action.coordinate![0], action.coordinate![1]);
      break;
    case 'triple_click':
      await p.mouse.click(action.coordinate![0], action.coordinate![1], { clickCount: 3 });
      break;
    case 'type':
      await p.keyboard.type(action.text!, { delay: 30 });
      break;
    case 'key': {
      let keyToPress = action.text!;
      if (keyToPress.includes('+')) {
        keyToPress = keyToPress.split('+').map(k => keyMap[k.trim()] || k.trim()).join('+');
      } else {
        keyToPress = keyMap[keyToPress] || keyToPress;
      }
      await p.keyboard.press(keyToPress);
      break;
    }
    case 'scroll':
      await p.mouse.move(action.coordinate![0], action.coordinate![1]);
      const delta = action.direction === 'down' ? 300 : action.direction === 'up' ? -300 : 0;
      await p.mouse.wheel(0, delta);
      break;
    case 'wait':
      await p.waitForTimeout((action.duration || 1) * 1000);
      break;
  }

  // Wait for page to settle after action
  await p.waitForTimeout(300);
}

export async function getPageInfo(): Promise<{ url: string; title: string }> {
  const p = await launchBrowser();
  return { url: p.url(), title: await p.title() };
}

// ============================================================
// IN-PROCESS A11Y TREE — reads the LIVE persistent page.
// Replaces the old cold-launch HTTP service (18805) for the agent
// path: same auth/SPA state, same 1024x768 viewport => coords match.
// ============================================================
export interface A11yTree { treeText: string; tokenEstimate: number; elementCount: number; url: string; title: string; }

export async function extractAccessibilityTree(): Promise<A11yTree | null> {
  const p = await launchBrowser();
  try {
    const elements = await p.evaluate(() => {
      const results: any[] = [];
      const sel = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick], [href]';
      document.querySelectorAll(sel).forEach((el: any, idx: number) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.top > window.innerHeight || rect.bottom < 0) return;
        const text = (el.textContent || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 80);
        if (!text && el.tagName !== 'INPUT' && el.tagName !== 'SELECT') return;
        results.push({
          idx, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '',
          text, role: el.getAttribute('role') || '',
          x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2),
        });
      });
      return results;
    });
    const title = await p.title();
    const url = p.url();
    let treeText = `Page: ${title}\nURL: ${url}\n\nInteractive Elements:\n`;
    for (const el of elements) {
      let tagStr = el.tag;
      if (el.type) tagStr += `[${el.type}]`;
      if (el.role) tagStr += `(${el.role})`;
      treeText += `  [${el.idx}] <${tagStr}> "${el.text}" @ (${el.x},${el.y})\n`;
    }
    return { treeText, tokenEstimate: Math.ceil(treeText.length / 4), elementCount: elements.length, url, title };
  } catch {
    return null;
  }
}

export async function closeBrowser(): Promise<void> {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  page = null;
  // DON'T close browser/context — keep persistent!
}

// ---- Session Persistence ----
export async function saveCurrentSession(appName: string): Promise<void> {
  if (!context) return;
  const p = await launchBrowser();
  const cookies = await context.cookies();
  const ls = await p.evaluate(() => {
    const items: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) items[key] = localStorage.getItem(key) || '';
    }
    return items;
  }).catch(() => ({}));

  saveSession(appName, { appName, cookies, localStorage: ls, url: p.url() });
}

export async function restoreSession(appName: string): Promise<boolean> {
  const session = loadSession(appName);
  if (!session) return false;
  if (!context) await launchBrowser();
  if (session.cookies.length > 0 && context) {
    await context.addCookies(session.cookies);
  }
  console.log('[browser] Session restored for', appName, '(' + session.cookies.length + ' cookies)');
  return true;
}

export interface ComputerAction {
  action: string;
  coordinate?: [number, number];
  startCoordinate?: [number, number];
  text?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  duration?: number;
}
