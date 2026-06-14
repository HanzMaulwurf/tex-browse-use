/**
 * SMART ROUTER — Entscheidet automatisch welche Strategie für jede Aktion
 * 
 * Gang 1: Claude + Screenshot     (neue App, visuell)
 * Gang 2: Claude + A11y Tree      (bekannte App, Text reicht)
 * Gang 3: Claude + Skill-Kontext  (optimierter Workflow)
 * Gang 4: Playwright Script       (kompiliert, kein LLM)
 * 
 * Wählt automatisch den höchsten Gang der möglich ist.
 * Fällt bei Fehler einen Gang zurück (Self-Healing).
 */

import fs from 'node:fs';
import path from 'node:path';

const CUA_ROOT = process.env.CUA_ROOT || '/opt/computer-use-agent';
const COMPILED_DIR = process.env.COMPILED_DIR || path.join(CUA_ROOT, 'data/compiled');
const SKILLS_DIR = process.env.SKILLS_DIR || path.join(CUA_ROOT, 'data/skills');

export type Strategy = 'compiled' | 'a11y-skill' | 'screenshot-skill' | 'screenshot-new' | 'stealth';

export interface RoutingDecision {
  strategy: Strategy;
  gear: number;        // 1-4
  reason: string;
  hasSkill: boolean;
  hasCompiled: boolean;
  compiledPath?: string;
  needsStealth: boolean;
  estimatedCost: string;
  estimatedSpeed: string;
}

// Domains that need stealth browser
const STEALTH_DOMAINS = new Set([
  'google.com', 'google.de', 'youtube.com', 'linkedin.com',
  'facebook.com', 'instagram.com', 'amazon.de', 'amazon.com',
  'ebay.de', 'ebay.com', 'x.com', 'twitter.com', 'tiktok.com',
]);

function needsStealth(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return STEALTH_DOMAINS.has(hostname) || [...STEALTH_DOMAINS].some(d => hostname.endsWith('.' + d));
  } catch { return false; }
}

function hasCompiledScript(appName: string, task: string, taskType?: string): string | null {
  if (!fs.existsSync(COMPILED_DIR)) return null;
  const files = fs.readdirSync(COMPILED_DIR).filter(f => f.endsWith('.py'));
  // Prefer a stable taskType key (e.g. "zuordne-umsaetze") over the free-text prompt.
  // The old prompt-slug match broke whenever the caller passed a long instruction
  // prompt instead of the short task name, so the compiled gear was never selected.
  if (taskType) {
    const stable = `${appName}--${taskType}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    const m = files.find(f => f.startsWith(stable) || f.includes(`--${taskType.toLowerCase()}`));
    if (m) return path.join(COMPILED_DIR, m);
  }
  const slug = `${appName}--${task.slice(0, 50)}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const match = files.find(f => f.startsWith(slug.slice(0, 20)));
  return match ? path.join(COMPILED_DIR, match) : null;
}

function hasSkill(appName: string, task: string): { found: boolean; successCount: number; steps: number } {
  if (!fs.existsSync(SKILLS_DIR)) return { found: false, successCount: 0, steps: 0 };
  const files = fs.readdirSync(SKILLS_DIR).filter(f => f.startsWith(appName.toLowerCase()));
  for (const file of files) {
    try {
      const skill = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, file), 'utf8'));
      const pattern = skill.taskPattern?.toLowerCase() || '';
      const taskLower = task.toLowerCase();
      if (taskLower.includes(pattern.slice(0, 30)) || pattern.includes(taskLower.slice(0, 30))) {
        return { found: true, successCount: skill.successCount || 0, steps: skill.steps?.length || 0 };
      }
    } catch {}
  }
  return { found: false, successCount: 0, steps: 0 };
}

export function route(appName: string, task: string, url?: string, taskType?: string): RoutingDecision {
  const stealth = url ? needsStealth(url) : false;
  
  // Stealth overrides everything
  if (stealth) {
    return {
      strategy: 'stealth',
      gear: 2,
      reason: `Domain hat Bot-Detection → SeleniumBase UC + Claude`,
      hasSkill: false, hasCompiled: false, needsStealth: true,
      estimatedCost: '$0.05/step', estimatedSpeed: '10-15s/step',
    };
  }
  
  // Check for compiled Playwright script (Gang 4)
  const compiled = hasCompiledScript(appName, task, taskType);
  if (compiled) {
    return {
      strategy: 'compiled',
      gear: 4,
      reason: `Kompiliertes Script gefunden: ${path.basename(compiled)}`,
      hasSkill: true, hasCompiled: true, compiledPath: compiled, needsStealth: false,
      estimatedCost: '$0.00', estimatedSpeed: '0.5-2s total',
    };
  }
  
  // Check for learned skill
  const skill = hasSkill(appName, task);
  
  if (skill.found && skill.successCount >= 3) {
    // Gang 3: A11y Tree + Skill (billig)
    return {
      strategy: 'a11y-skill',
      gear: 3,
      reason: `Skill geladen (${skill.successCount}x erfolgreich, ${skill.steps} Steps) → A11y Tree Mode`,
      hasSkill: true, hasCompiled: false, needsStealth: false,
      estimatedCost: '$0.01/step', estimatedSpeed: '2-3s/step',
    };
  }
  
  if (skill.found) {
    // Gang 2: Screenshot + Skill (Skill als Orientierung)
    return {
      strategy: 'screenshot-skill',
      gear: 2,
      reason: `Skill geladen (${skill.successCount}x, noch nicht optimiert) → Screenshot + Skill`,
      hasSkill: true, hasCompiled: false, needsStealth: false,
      estimatedCost: '$0.03/step', estimatedSpeed: '5-8s/step',
    };
  }
  
  // Gang 1: Screenshot + Claude (neue App)
  return {
    strategy: 'screenshot-new',
    gear: 1,
    reason: `App/Task unbekannt → Claude lernt via Screenshot`,
    hasSkill: false, hasCompiled: false, needsStealth: false,
    estimatedCost: '$0.05/step', estimatedSpeed: '8-10s/step',
  };
}

export function downshift(current: RoutingDecision): RoutingDecision {
  // Fallback: einen Gang runter
  switch (current.strategy) {
    case 'compiled':
      return { ...current, strategy: 'a11y-skill', gear: 3, reason: 'Script fehlgeschlagen → Fallback A11y + Skill' };
    case 'a11y-skill':
      return { ...current, strategy: 'screenshot-skill', gear: 2, reason: 'A11y unzureichend → Fallback Screenshot + Skill' };
    case 'screenshot-skill':
      return { ...current, strategy: 'screenshot-new', gear: 1, reason: 'Skill passt nicht → Claude lernt neu' };
    default:
      return current; // Kann nicht weiter runter
  }
}
