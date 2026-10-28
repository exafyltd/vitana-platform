/**
 * duplicate-route-registration
 *
 * Walk every route handler in the PR's HEAD state (not just the diff) and
 * flag any (HTTP method, full path) that appears in two or more files.
 * Duplicate registrations cause Express's "which handler wins" behavior to
 * be version-dependent — a silent correctness bug.
 *
 * Full-path resolution:
 *   - Each file under services/gateway/src/routes/<name>.ts is typically
 *     mounted at some sub-prefix in services/gateway/src/index.ts via
 *     app.use('/api/v1/<name>', <name>Router).
 *   - We don't attempt to recover that mount prefix; we compare routes
 *     as `<file_stem> METHOD <path_arg>` tuples, which is sufficient:
 *     if two different route files both register `GET /` that's a
 *     mount-side collision; if one file registers `POST /foo` twice
 *     that's an intra-file collision — both are bugs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readFileAtRepo } from './_shared.mjs';

export const meta = {
  rule: 'duplicate-route-registration',
  category: 'conflict',
  severity: 'blocker',
};

const HANDLER_RE = /router\.(get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]/g;

function collectRoutes(repoRoot, rel) {
  const src = readFileAtRepo(repoRoot, rel);
  if (!src) return [];
  const out = [];
  let m;
  HANDLER_RE.lastIndex = 0;
  while ((m = HANDLER_RE.exec(src)) !== null) {
    const method = m[1].toUpperCase();
    const routePath = m[2];
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ method, path: routePath, file: rel, line });
  }
  return out;
}

export async function check({ changedFiles, repoRoot }) {
  const routesDir = path.join(repoRoot, 'services', 'gateway', 'src', 'routes');
  if (!fs.existsSync(routesDir)) return [];

  // Walk the full routes directory in HEAD state.
  const handlers = [];
  const stack = [routesDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      if (/\.(test|spec)\.(ts|tsx)$/.test(e.name)) continue;
      const rel = path.relative(repoRoot, full).split(path.sep).join('/');
      handlers.push(...collectRoutes(repoRoot, rel));
    }
  }

  // Group by file-stem + method + path — stem captures the likely mount prefix.
  const byKey = new Map();
  for (const h of handlers) {
    const stem = path.basename(h.file, path.extname(h.file));
    const key = `${stem}|${h.method}|${h.path}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(h);
  }

  // Only report collisions that the current PR may have caused or aggravated:
  // at least one duplicate must be in a file touched by this PR.
  const changedSet = new Set(changedFiles.map(f => f.path));
  const findings = [];
  for (const [key, hs] of byKey) {
    if (hs.length < 2) continue;
    const prTouched = hs.some(h => changedSet.has(h.file));
    if (!prTouched) continue;
    const [, method, routePath] = key.split('|');
    findings.push({
      rule: meta.rule,
      severity: meta.severity,
      file_path: hs[0].file,
      line_number: hs[0].line,
      message: `${method} ${routePath} is registered in multiple locations: ${hs.map(h => `${h.file}:${h.line}`).join(' and ')}.`,
      suggested_action: `Keep exactly one registration of this (method, path) pair. Either remove the duplicate or rename one of them to a distinct route.`,
      raw: { method, path: routePath, registrations: hs },
    });
  }
  return findings;
}
