#!/usr/bin/env node
// VTID-05698 — check every `path:line` citation in the gateway write-route inventory.
//
// Usage (from the repository root):
//   node docs/validation/VTID-05698/check-citations.mjs [doc] [--v1 <vitana-v1 checkout>]
//
// Dependency-free. A citation is `<path>:<n>` with optional ranges and lists
// (`:12-30`, `:12,15`, `:12-14,20`). Resolution rules (the same ones the report states):
//   1. `hub:<n>`        -> services/gateway/src/frontend/command-hub/app.js
//   2. `vitana-v1/<p>`  -> <p> inside the vitana-v1 checkout (default ../vitana-v1, or --v1)
//   3. any other path   -> repository root first, then services/gateway/src/
// Short continuations such as `(:40)` that repeat the previous file carry no path and are
// not checked. A citation passes when the file exists and has at least the highest cited line.
// Exit code 1 when any citation fails.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
let doc = join(repoRoot, 'docs/programs/security/gateway-write-route-inventory.md');
let v1Root = resolve(repoRoot, '..', 'vitana-v1');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--v1') v1Root = resolve(args[++i]);
  else doc = resolve(args[i]);
}

const text = readFileSync(doc, 'utf8');
const LINES = String.raw`\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*`;
const PATH = String.raw`(?:hub|[A-Za-z0-9_.@-]*[A-Za-z0-9_@-]+(?:/[A-Za-z0-9_.@-]+)*\.[A-Za-z0-9]+)`;
const re = new RegExp(String.raw`(?<![A-Za-z0-9_/.@-])(${PATH}):(${LINES})(?![0-9])`, 'g');

const lineCountCache = new Map();
function lineCount(file) {
  if (!lineCountCache.has(file)) {
    const body = readFileSync(file, 'utf8');
    lineCountCache.set(file, body.endsWith('\n') ? body.split('\n').length - 1 : body.split('\n').length);
  }
  return lineCountCache.get(file);
}
function resolvePath(p) {
  if (p === 'hub') return join(repoRoot, 'services/gateway/src/frontend/command-hub/app.js');
  if (p.startsWith('vitana-v1/')) return join(v1Root, p.slice('vitana-v1/'.length));
  for (const base of [repoRoot, join(repoRoot, 'services/gateway/src')]) {
    const f = join(base, p);
    if (existsSync(f) && statSync(f).isFile()) return f;
  }
  return null;
}

const seen = new Map();
let m;
while ((m = re.exec(text))) {
  const [, p, spec] = m;
  if (!/\//.test(p) && p !== 'hub' && !/\.(ts|tsx|js|mjs|cjs|py|sh|ya?ml|md|json|sql)$/.test(p)) continue;
  const max = Math.max(...spec.split(/[,-]/).map(Number));
  const key = `${p}:${spec}`;
  if (!seen.has(key)) seen.set(key, { p, spec, max, count: 0 });
  seen.get(key).count++;
}

const failures = [];
const files = new Set();
let total = 0;
for (const c of seen.values()) {
  total += c.count;
  const f = resolvePath(c.p);
  if (!f) { failures.push(`${c.p}:${c.spec} — file not found`); continue; }
  files.add(f);
  const n = lineCount(f);
  if (c.max < 1 || c.max > n) failures.push(`${c.p}:${c.spec} — file has ${n} lines`);
}

console.log(`doc: ${doc}`);
console.log(`vitana-v1 root: ${v1Root}${existsSync(v1Root) ? '' : ' (missing)'}`);
console.log(`citations: ${total} occurrences, ${seen.size} distinct, ${files.size} files`);
console.log(`ok: ${seen.size - failures.length}, failed: ${failures.length}`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
