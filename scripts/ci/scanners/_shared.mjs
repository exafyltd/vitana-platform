/**
 * Shared helpers for dev-autopilot scanners.
 *
 * Each scanner module exports:
 *   - `meta`:   registry metadata (kept in-sync with
 *               scripts/ci/scanners/registry.mjs)
 *   - `run(args)`: returns DevAutopilotSignal[] given { files, repoRoot }.
 *
 * Kept zero-dep so GitHub Actions can run scans without an npm install.
 */

import fs from 'node:fs';
import path from 'node:path';

export const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

export const SKIP_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', '.next', 'coverage', '__tests__',
  '.git', '.turbo', '.cache', 'vendor', '.venv', 'venv',
]);

export function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (SKIP_SEGMENTS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile()) acc.push(full);
  }
  return acc;
}

export function readFileSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return null; }
}

export function relFromRepo(repoRoot, p) {
  return path.relative(repoRoot, p).split(path.sep).join('/');
}
