import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Writable data root for the engine.
 *
 * Defaults to the repo's `stack/data` directory, derived from THIS file's own
 * location, so a fresh clone runs with zero config. Override the whole tree via
 * CUA_ROOT, or any single dir via its own *_DIR env var.
 *
 * Replaces the old hardcoded `/opt/computer-use-agent/...` defaults, which
 * crashed with EACCES (mkdir permission denied) for any non-root local user and
 * killed the engine on the first task.
 */
export const STACK_ROOT =
  process.env.CUA_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DATA_ROOT = path.join(STACK_ROOT, 'data');

/** Absolute path to a named subdir under the data root (e.g. dataDir('skills')). */
export function dataDir(name: string): string {
  return path.join(DATA_ROOT, name);
}
