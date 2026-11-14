#!/usr/bin/env node
// Citation check for a strategy-execution discovery doc (read-only, offline).
// Every backticked `path:line` citation in the doc must name a file that exists in the pinned
// commit of its repository and have at least as many lines as the highest line cited.
// Repo prefix: `vitana-v1/…`, `vitana-platform/…` or `vitanaland-strategy/…`; no prefix = vitana-platform.
// Usage: node check-citations.mjs <doc.md> [--root <sandbox dir>]
// Exit 0 = every citation resolves; exit 1 = at least one failure (each one is printed).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const doc = args[0];
const rootIdx = args.indexOf('--root');
const sandbox = rootIdx >= 0 ? args[rootIdx + 1] : '/projects/sandbox';
if (!doc) { console.error('usage: check-citations.mjs <doc.md> [--root <dir>]'); process.exit(2); }

const PINS = {
  'vitana-platform': { dir: path.join(sandbox, 'vitana-platform'), sha: '6dc6e1ba0c18252ec2f3fbf5651d245e200f9835' },
  'vitana-v1': { dir: path.join(sandbox, 'vitana-v1'), sha: 'e31bf4627ff3c705c20f8e6b718ce4dd03353b7f' },
  'vitanaland-strategy': { dir: path.join(sandbox, 'vitanaland-strategy'), sha: 'fb77090e1ffc7d1ef3c250b0aa721768c3df9425' },
};

const text = readFileSync(doc, 'utf8');
// `[repo/]path.ext:spec` where spec = 12 | 12-30 | 12,15,20-22
const RE = /`(?:(vitana-v1|vitana-platform|vitanaland-strategy)\/)?([A-Za-z0-9_.@\-][A-Za-z0-9_.@\-\/]*\.[A-Za-z0-9]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)`/g;

const cache = new Map();
function lineCount(repo, file) {
  const key = `${repo}:${file}`;
  if (cache.has(key)) return cache.get(key);
  const { dir, sha } = PINS[repo];
  let n = -1;
  try {
    const out = execFileSync('git', ['-C', dir, 'show', `${sha}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    n = out.split('\n').length - (out.endsWith('\n') ? 1 : 0);
  } catch { n = -1; }
  cache.set(key, n);
  return n;
}

let total = 0;
const failures = [];
for (const m of text.matchAll(RE)) {
  const repo = m[1] || 'vitana-platform';
  const file = m[2];
  const spec = m[3];
  const max = Math.max(...spec.split(',').flatMap((s) => s.split('-').map(Number)));
  total += 1;
  const n = lineCount(repo, file);
  if (n < 0) failures.push(`MISSING  ${repo}/${file}:${spec} (not in ${PINS[repo].sha.slice(0, 10)})`);
  else if (n < max) failures.push(`TOO-SHORT ${repo}/${file}:${spec} (file has ${n} lines)`);
}

for (const f of failures) console.log(f);
console.log(`citations: ${total}, failures: ${failures.length}`);
process.exit(failures.length === 0 && total > 0 ? 0 : 1);
