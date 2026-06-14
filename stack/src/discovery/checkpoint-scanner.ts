/**
 * CHECKPOINT SCANNER — Externes Fortschritts-Tracking
 * 
 * Problem: Sliding Window löscht alte Steps → Agent vergisst wo er war
 * Lösung: Fortschritt wird in einer Datei gespeichert, nicht im Kontext
 * 
 * Workflow:
 * 1. Lade Checkliste (was noch zu tun ist)
 * 2. Starte Task für den NÄCHSTEN offenen Punkt
 * 3. Ergebnis speichern + Punkt abhaken
 * 4. Nächsten Punkt starten
 * 5. Wiederholen bis alles abgehakt
 * 
 * Jeder Task ist KURZ (1-3 Steps) → kein Token-Explosion
 * Fortschritt überlebt beliebig viele Tasks
 */

import fs from 'node:fs';
import path from 'node:path';

const CHECKPOINT_DIR = process.env.CHECKPOINT_DIR
  || path.join(process.env.CUA_ROOT || '/opt/computer-use-agent', 'data/checkpoints');

export interface ScanItem {
  id: string;
  name: string;           // "Buchhaltung > BWA"
  menuPath: string[];     // ["Buchhaltung", "Betriebswirtschaftliche Auswertung"]
  status: 'pending' | 'scanning' | 'done' | 'failed';
  result?: PageScanResult;
  error?: string;
  attempts: number;
}

export interface PageScanResult {
  url: string;
  title: string;
  buttons: string[];
  inputs: string[];
  tabs: string[];
  description: string;    // Claude's Beschreibung
  scannedAt: number;
}

export interface ScanCheckpoint {
  appName: string;
  version: number;
  items: ScanItem[];
  startedAt: number;
  updatedAt: number;
  completedItems: number;
  totalItems: number;
}

function ensureDir() { fs.mkdirSync(CHECKPOINT_DIR, { recursive: true }); }

export function createCheckpoint(appName: string, items: Omit<ScanItem, 'status' | 'attempts'>[]): ScanCheckpoint {
  ensureDir();
  const checkpoint: ScanCheckpoint = {
    appName,
    version: 1,
    items: items.map(item => ({ ...item, status: 'pending' as const, attempts: 0 })),
    startedAt: Date.now(),
    updatedAt: Date.now(),
    completedItems: 0,
    totalItems: items.length,
  };
  saveCheckpoint(checkpoint);
  return checkpoint;
}

export function loadCheckpoint(appName: string): ScanCheckpoint | null {
  const file = path.join(CHECKPOINT_DIR, `${appName}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveCheckpoint(cp: ScanCheckpoint): void {
  ensureDir();
  cp.updatedAt = Date.now();
  cp.completedItems = cp.items.filter(i => i.status === 'done').length;
  fs.writeFileSync(path.join(CHECKPOINT_DIR, `${cp.appName}.json`), JSON.stringify(cp, null, 2));
}

export function getNextItem(cp: ScanCheckpoint): ScanItem | null {
  return cp.items.find(i => i.status === 'pending' || (i.status === 'failed' && i.attempts < 3)) || null;
}

export function markDone(cp: ScanCheckpoint, itemId: string, result: PageScanResult): void {
  const item = cp.items.find(i => i.id === itemId);
  if (item) {
    item.status = 'done';
    item.result = result;
    item.attempts++;
  }
  saveCheckpoint(cp);
}

export function markFailed(cp: ScanCheckpoint, itemId: string, error: string): void {
  const item = cp.items.find(i => i.id === itemId);
  if (item) {
    item.status = 'failed';
    item.error = error;
    item.attempts++;
  }
  saveCheckpoint(cp);
}

export function getProgress(cp: ScanCheckpoint): string {
  const done = cp.items.filter(i => i.status === 'done').length;
  const failed = cp.items.filter(i => i.status === 'failed').length;
  const pending = cp.items.filter(i => i.status === 'pending').length;
  return `${done}/${cp.totalItems} done, ${failed} failed, ${pending} pending`;
}

/**
 * Build task prompt that includes ONLY the current item + progress summary.
 * This keeps the prompt small regardless of how many items exist.
 */
export function buildScanPrompt(cp: ScanCheckpoint, item: ScanItem): string {
  const done = cp.items.filter(i => i.status === 'done').map(i => i.name);
  const remaining = cp.items.filter(i => i.status !== 'done').map(i => i.name);
  
  let prompt = `SCAN-AUFGABE: ${item.name}\n\n`;
  prompt += `BEREITS ERLEDIGT (${done.length}/${cp.totalItems}):\n`;
  for (const d of done) prompt += `  ✅ ${d}\n`;
  prompt += `\nNOCH OFFEN (${remaining.length}):\n`;
  for (const r of remaining) prompt += `  ⬜ ${r}\n`;
  prompt += `\nAKTUELLER PUNKT: ${item.name}\n`;
  prompt += `NAVIGATION: ${item.menuPath.join(' → ')}\n\n`;
  prompt += `ANWEISUNGEN:\n`;
  prompt += `1. Klicke im Menü auf: ${item.menuPath.join(' → ')}\n`;
  prompt += `2. Beschreibe die Seite: Welche Buttons, Felder, Tabs, Tabellen siehst du?\n`;
  prompt += `3. Liste ALLE interaktiven Elemente auf\n`;
  prompt += `4. ÄNDERE NICHTS — nur lesen und beschreiben\n`;
  prompt += `\nANTWORTE mit einer strukturierten Beschreibung der Seite.`;
  
  return prompt;
}
