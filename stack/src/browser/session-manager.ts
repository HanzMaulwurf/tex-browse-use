import fs from 'node:fs';
import path from 'node:path';

/**
 * Persistent Browser Sessions
 * Speichert Cookies + LocalStorage nach Login.
 * Nächster Task für dieselbe App: kein erneutes Einloggen nötig.
 */

const SESSION_DIR = process.env.SESSION_DIR || '/opt/computer-use-agent/data/sessions';

export interface SessionState {
  appName: string;
  cookies: any[];
  localStorage: Record<string, string>;
  url: string;
  savedAt: number;
  expiresAt: number;  // Auto-expire nach 24h
}

export function saveSession(appName: string, state: Omit<SessionState, 'savedAt' | 'expiresAt'>): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const session: SessionState = {
    ...state,
    savedAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24h TTL
  };
  const filePath = path.join(SESSION_DIR, `${appName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  console.log(`[session] Saved session for ${appName} (${state.cookies.length} cookies)`);
}

export function loadSession(appName: string): SessionState | null {
  const filePath = path.join(SESSION_DIR, `${appName}.json`);
  if (!fs.existsSync(filePath)) return null;

  const session: SessionState = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // Check expiry
  if (Date.now() > session.expiresAt) {
    fs.unlinkSync(filePath);
    console.log(`[session] Session for ${appName} expired — deleted`);
    return null;
  }

  console.log(`[session] Loaded session for ${appName} (${session.cookies.length} cookies)`);
  return session;
}

export function listSessions(): Array<{ appName: string; savedAt: number; expiresIn: string }> {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs.readdirSync(SESSION_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const session: SessionState = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8'));
      const expiresIn = Math.max(0, Math.round((session.expiresAt - Date.now()) / 3600000));
      return { appName: session.appName, savedAt: session.savedAt, expiresIn: `${expiresIn}h` };
    });
}

export function deleteSession(appName: string): boolean {
  const filePath = path.join(SESSION_DIR, `${appName}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}
