import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

/**
 * File Handling — Upload & Download für Browser-Automation
 * Belege hochladen, PDFs runterladen, Dateien transferieren
 */

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/opt/computer-use-agent/data/downloads';
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/opt/computer-use-agent/data/uploads';

export function ensureDirs(): void {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * Setup download handling for a Playwright page.
 * Returns path of downloaded file when download completes.
 */
export async function setupDownloadHandler(page: Page): Promise<void> {
  ensureDirs();
  // Playwright handles downloads via the 'download' event
  page.on('download', async (download) => {
    const filename = download.suggestedFilename();
    const savePath = path.join(DOWNLOAD_DIR, `${Date.now()}-${filename}`);
    await download.saveAs(savePath);
    console.log(`[files] Downloaded: ${savePath} (${filename})`);
  });
}

/**
 * Upload a file via file input element.
 */
export async function uploadFile(page: Page, filePath: string, selector?: string): Promise<boolean> {
  try {
    if (!fs.existsSync(filePath)) {
      console.error(`[files] File not found: ${filePath}`);
      return false;
    }

    // Find file input (visible or hidden)
    const fileInput = await page.locator(selector || 'input[type="file"]').first();
    await fileInput.setInputFiles(filePath);
    console.log(`[files] Uploaded: ${filePath}`);
    return true;
  } catch (err) {
    console.error(`[files] Upload failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * List downloaded files.
 */
export function listDownloads(): string[] {
  ensureDirs();
  return fs.readdirSync(DOWNLOAD_DIR)
    .map(f => path.join(DOWNLOAD_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/**
 * Get the most recent download.
 */
export function getLatestDownload(): string | null {
  const files = listDownloads();
  return files.length > 0 ? files[0] : null;
}
