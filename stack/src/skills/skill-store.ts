import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../data-paths.js';

/**
 * Domain Skills — Self-Improving App Knowledge
 * 
 * Browser-Harness Pattern: Wenn der Agent eine App bedient,
 * lernt er die Navigation und speichert sie als Skill.
 * Nächstes Mal: Agent bekommt den Skill als Kontext → schneller + genauer.
 * 
 * Beispiel:
 *   Skill "acme-create-invoice":
 *     1. Login → Dashboard
 *     2. Klick auf "Buchhaltung" → "Rechnungen"
 *     3. Klick auf "Neue Rechnung"
 *     4. Kunde auswählen (Dropdown)
 *     5. Positionen eintragen
 *     6. "Rechnung erstellen" klicken
 */

const SKILLS_DIR = process.env.SKILLS_DIR || dataDir('skills');

export interface DomainSkill {
  id: string;
  appName: string;              // "acme", "salesforce", "zendesk"
  taskPattern: string;          // "rechnung erstellen", "termin buchen"
  steps: SkillStep[];
  successCount: number;         // Wie oft hat der Skill funktioniert?
  failCount: number;
  lastUsed: number;
  lastUpdated: number;
  createdAt: number;
  version: number;
}

interface SkillStep {
  description: string;          // "Klicke auf Buchhaltung im Hauptmenü"
  action: string;               // "click", "type", "navigate", "wait"
  selector?: string;            // CSS/XPath Selector (wenn bekannt)
  coordinate?: [number, number]; // Fallback-Position
  text?: string;                // Text zum Tippen
  url?: string;                 // URL zum Navigieren
  waitFor?: string;             // Worauf warten? "Rechnungsliste geladen"
}

function ensureDir(): void {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

function skillPath(appName: string, taskPattern: string): string {
  const slug = `${appName}--${taskPattern}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return path.join(SKILLS_DIR, `${slug}.json`);
}

// ---- Public API ----

export function saveSkill(skill: DomainSkill): void {
  ensureDir();
  fs.writeFileSync(skillPath(skill.appName, skill.taskPattern), JSON.stringify(skill, null, 2));
  console.log(`[skills] Saved: ${skill.appName}/${skill.taskPattern} (v${skill.version}, ${skill.steps.length} steps)`);
}

export function findSkill(appName: string, taskDescription: string): DomainSkill | null {
  ensureDir();
  const files = fs.readdirSync(SKILLS_DIR).filter(f => f.startsWith(appName.toLowerCase()));

  for (const file of files) {
    const skill: DomainSkill = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, file), 'utf8'));
    // Fuzzy match: task description contains the skill pattern
    if (taskDescription.toLowerCase().includes(skill.taskPattern.toLowerCase()) ||
        skill.taskPattern.toLowerCase().includes(taskDescription.toLowerCase().split(' ').slice(0, 3).join(' '))) {
      return skill;
    }
  }
  return null;
}

export function listSkills(): Array<{ appName: string; taskPattern: string; steps: number; successRate: string }> {
  ensureDir();
  return fs.readdirSync(SKILLS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const skill: DomainSkill = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8'));
      const total = skill.successCount + skill.failCount;
      const rate = total > 0 ? `${Math.round(skill.successCount / total * 100)}%` : 'new';
      return { appName: skill.appName, taskPattern: skill.taskPattern, steps: skill.steps.length, successRate: rate };
    });
}

export function recordOutcome(appName: string, taskPattern: string, success: boolean): void {
  const skill = findSkill(appName, taskPattern);
  if (!skill) return;
  if (success) skill.successCount++;
  else skill.failCount++;
  skill.lastUsed = Date.now();
  saveSkill(skill);
}

/**
 * Extrahiert einen Skill aus abgeschlossenen Task-Steps.
 * Wird am Ende eines erfolgreichen Tasks aufgerufen.
 */
export function learnSkillFromTask(
  appName: string,
  taskDescription: string,
  steps: Array<{ thinking?: string; action?: { action: string; coordinate?: [number, number]; text?: string } }>
): DomainSkill {
  const existing = findSkill(appName, taskDescription);

  const skillSteps: SkillStep[] = steps
    .filter(s => s.action)
    .map(s => ({
      description: s.thinking?.slice(0, 100) || '',
      action: s.action!.action,
      coordinate: s.action!.coordinate,
      text: s.action!.text,
    }));

  // Fix Skill-Friedhof: reuse existing taskPattern (same filename) und behalte
  // die längere Step-Sequenz als kanonisch (kürzer = oft Session-Skip, nicht besser).
  const finalTaskPattern = existing?.taskPattern || taskDescription.slice(0, 80);
  const finalSteps = existing && existing.steps.length > skillSteps.length ? existing.steps : skillSteps;

  const skill: DomainSkill = {
    id: existing?.id || crypto.randomUUID(),
    appName,
    taskPattern: finalTaskPattern,
    steps: finalSteps,
    successCount: (existing?.successCount || 0) + 1,
    failCount: existing?.failCount || 0,
    lastUsed: Date.now(),
    lastUpdated: Date.now(),
    createdAt: existing?.createdAt || Date.now(),
    version: (existing?.version || 0) + 1,
  };

  saveSkill(skill);
  return skill;
}

/**
 * Generiert Kontext für den Agent-Prompt basierend auf bekannten Skills.
 */
export function getSkillContext(appName: string, taskDescription: string): string | null {
  const skill = findSkill(appName, taskDescription);
  if (!skill || skill.steps.length === 0) return null;

  let context = `\nBEKANNTER WORKFLOW fuer "${skill.appName}" - "${skill.taskPattern}" (${skill.successCount}x erfolgreich):\n`;
  context += `Letzte erfolgreiche Schritte:\n`;

  for (let i = 0; i < skill.steps.length; i++) {
    const s = skill.steps[i];
    context += `  ${i + 1}. ${s.description || s.action}`;
    if (s.text) context += ` → "${s.text}"`;
    if (s.coordinate) context += ` @ [${s.coordinate}]`;
    context += '\n';
  }

  context += `\nNutze diesen Workflow als Orientierung, passe aber an wenn sich das UI geaendert hat.\n`;
  return context;
}
