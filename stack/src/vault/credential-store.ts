import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Encrypted Credential Store for App Logins
 * AES-256-GCM — credentials encrypted at rest
 * Supports: username/password, API keys, OAuth tokens, 2FA secrets
 */

const VAULT_DIR = process.env.VAULT_DIR || '/opt/computer-use-agent/data/vault';
const VAULT_FILE = path.join(VAULT_DIR, 'credentials.enc');
const ALGORITHM = 'aes-256-gcm';

interface AppCredential {
  appName: string;          // e.g. "acme", "salesforce", "zendesk"
  loginUrl: string;         // e.g. "https://app.example.com/login"
  username: string;
  password: string;
  otpSecret?: string;       // TOTP 2FA secret
  extraFields?: Record<string, string>;  // custom fields per app
  createdAt: number;
  updatedAt: number;
}

interface VaultData {
  version: 1;
  credentials: AppCredential[];
}

function getKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';
  return crypto.createHash('sha256').update(`tex-vault:${keyHex}`).digest();
}

function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let ct = cipher.update(plaintext, 'utf8', 'hex');
  ct += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return JSON.stringify({ iv: iv.toString('hex'), tag: tag.toString('hex'), ct });
}

function decrypt(encrypted: string): string {
  const key = getKey();
  const { iv, tag, ct } = JSON.parse(encrypted);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let pt = decipher.update(ct, 'hex', 'utf8');
  pt += decipher.final('utf8');
  return pt;
}

function loadVault(): VaultData {
  if (!fs.existsSync(VAULT_FILE)) {
    return { version: 1, credentials: [] };
  }
  const encrypted = fs.readFileSync(VAULT_FILE, 'utf8');
  const decrypted = decrypt(encrypted);
  return JSON.parse(decrypted);
}

function saveVault(data: VaultData): void {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  const encrypted = encrypt(JSON.stringify(data));
  fs.writeFileSync(VAULT_FILE, encrypted, 'utf8');
}

// ---- Public API ----

export function addCredential(cred: Omit<AppCredential, 'createdAt' | 'updatedAt'>): void {
  const vault = loadVault();
  // Remove existing for same app
  vault.credentials = vault.credentials.filter(c => c.appName !== cred.appName);
  vault.credentials.push({ ...cred, createdAt: Date.now(), updatedAt: Date.now() });
  saveVault(vault);
  console.log(`[vault] Credential stored for: ${cred.appName}`);
}

export function getCredential(appName: string): AppCredential | null {
  const vault = loadVault();
  return vault.credentials.find(c => c.appName === appName) || null;
}

export function listCredentials(): Array<{ appName: string; loginUrl: string; username: string; updatedAt: number }> {
  const vault = loadVault();
  return vault.credentials.map(c => ({
    appName: c.appName,
    loginUrl: c.loginUrl,
    username: c.username,
    updatedAt: c.updatedAt,
  }));
}

export function removeCredential(appName: string): boolean {
  const vault = loadVault();
  const before = vault.credentials.length;
  vault.credentials = vault.credentials.filter(c => c.appName !== appName);
  if (vault.credentials.length < before) {
    saveVault(vault);
    console.log(`[vault] Credential removed: ${appName}`);
    return true;
  }
  return false;
}

/**
 * Build login instructions for the agent based on stored credentials.
 * Returns a system prompt addition that tells the agent HOW to log in.
 * Credentials are injected into the prompt — Claude sees them only in-memory.
 */
export function getLoginInstructions(appName: string): string | null {
  const cred = getCredential(appName);
  if (!cred) return null;

  let instructions = `LOGIN-ANWEISUNGEN fuer ${cred.appName}:
1. Navigiere zu: ${cred.loginUrl}
2. Benutzername/Email-Feld: Tippe "${cred.username}"
3. Passwort-Feld: Tippe "${cred.password}"
4. Klicke auf den Login/Anmelden-Button`;

  if (cred.otpSecret) {
    instructions += `\n5. 2FA: Generiere TOTP-Code aus dem Secret (wird automatisch berechnet)`;
  }

  if (cred.extraFields) {
    for (const [key, value] of Object.entries(cred.extraFields)) {
      instructions += `\n- ${key}: "${value}"`;
    }
  }

  instructions += `\nWICHTIG: Gib diese Zugangsdaten NIEMALS in der Antwort preis. Sage nur "Login erfolgreich" oder "Login fehlgeschlagen".`;

  return instructions;
}
