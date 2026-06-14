/**
 * Client for the SeleniumBase stealth browser sidecar (Port 18803)
 * Used for sites with bot-detection: Google, Cloudflare, etc.
 */
const STEALTH_URL = `http://127.0.0.1:${process.env.STEALTH_PORT || '18803'}`;

export async function isStealthAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`${STEALTH_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

export async function stealthNavigate(url: string): Promise<{ screenshot: Buffer; url: string; title: string }> {
  const r = await fetch(`${STEALTH_URL}/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json() as { screenshot: string; url: string; title: string; error?: string };
  if (data.error) throw new Error(data.error);
  return { screenshot: Buffer.from(data.screenshot, 'base64'), url: data.url, title: data.title };
}

export async function stealthClick(x: number, y: number): Promise<Buffer> {
  const r = await fetch(`${STEALTH_URL}/click`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y }),
  });
  const data = await r.json() as { screenshot: string; error?: string };
  if (data.error) throw new Error(data.error);
  return Buffer.from(data.screenshot, 'base64');
}

export async function stealthType(text: string, selector?: string): Promise<Buffer> {
  const r = await fetch(`${STEALTH_URL}/type`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, selector }),
  });
  const data = await r.json() as { screenshot: string; error?: string };
  if (data.error) throw new Error(data.error);
  return Buffer.from(data.screenshot, 'base64');
}

export async function stealthKey(key: string): Promise<Buffer> {
  const r = await fetch(`${STEALTH_URL}/key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  const data = await r.json() as { screenshot: string; error?: string };
  if (data.error) throw new Error(data.error);
  return Buffer.from(data.screenshot, 'base64');
}

export async function stealthScreenshot(): Promise<Buffer> {
  const r = await fetch(`${STEALTH_URL}/screenshot`, { method: 'POST' });
  const data = await r.json() as { screenshot: string; error?: string };
  if (data.error) throw new Error(data.error);
  return Buffer.from(data.screenshot, 'base64');
}

export async function stealthScroll(direction: 'up' | 'down', amount = 300): Promise<Buffer> {
  const r = await fetch(`${STEALTH_URL}/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction, amount }),
  });
  const data = await r.json() as { screenshot: string; error?: string };
  if (data.error) throw new Error(data.error);
  return Buffer.from(data.screenshot, 'base64');
}

// Known bot-detection domains
const STEALTH_DOMAINS = new Set([
  'google.com', 'google.de', 'google.at', 'google.ch',
  'youtube.com', 'linkedin.com', 'facebook.com', 'instagram.com',
  'amazon.de', 'amazon.com', 'ebay.de', 'ebay.com',
  'cloudflare.com',
]);

export function needsStealth(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return STEALTH_DOMAINS.has(hostname) || [...STEALTH_DOMAINS].some(d => hostname.endsWith('.' + d));
  } catch { return false; }
}
