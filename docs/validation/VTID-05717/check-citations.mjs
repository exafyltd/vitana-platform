#!/usr/bin/env node
// VTID-05717 (architecture-mt-alignment/mt-alignment): citation check.
// Dependency-free. Run from the worktree root:
//   node docs/validation/VTID-05717/check-citations.mjs [file.md ...]
// Default input: docs/programs/strategy-execution/multi-tenant-alignment.md
// and docs/validation/VTID-05717/acceptance.md.
//
// Every backticked `path:line` or `path:start-end` is resolved at a pin:
//   vitana-v1/<p>            -> git -C ../vitana-v1 show <V1_PIN>:<p>
//   vitanaland-strategy/<p>  -> git -C ../vitanaland-strategy show <STRATEGY_PIN>:<p>
//   draft-05689/<p>          -> git show <DRAFT_05689>:<p> (wave-1 destination identity, draft, not merged)
//   draft-05690/<p>          -> git show <DRAFT_05690>:<p> (wave-1 Healthy Million readiness, draft, not merged)
//   plan-mt-align/<p>        -> git show <PLAN_PIN>:<p> (plan branch of architecture-mt-alignment)
//   anything else            -> git show <PLATFORM_PIN>:<p> in this worktree
// A citation passes when the file exists at the pin and every cited line number is <= the file's line count.
// Prints ok/failed counts; exits 1 when any citation fails or none was found.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PLATFORM_PIN = '6dc6e1ba0c18252ec2f3fbf5651d245e200f9835';
const V1_PIN = 'e31bf4627ff3c705c20f8e6b718ce4dd03353b7f';
const STRATEGY_PIN = 'e5dd629d77a8e1032148e3c28688613924b6bd9c';
const DRAFT_05689 = 'b8f4cb7f5f327c6f408b2544bb20da17c3a0fe17';
const DRAFT_05690 = '4502288c182e8acd1d659d3cab184bc004927461';
const PLAN_PIN = '1723f77dd2960db4c689af4e6ae9f9dbe786ba83';

const PREFIXES = [
  { prefix: 'vitana-v1/', repo: '../vitana-v1', sha: V1_PIN },
  { prefix: 'vitanaland-strategy/', repo: '../vitanaland-strategy', sha: STRATEGY_PIN },
  { prefix: 'draft-05689/', repo: '.', sha: DRAFT_05689 },
  { prefix: 'draft-05690/', repo: '.', sha: DRAFT_05690 },
  { prefix: 'plan-mt-align/', repo: '.', sha: PLAN_PIN },
];

const inputs = process.argv.slice(2);
const files = inputs.length
  ? inputs
  : ['docs/programs/strategy-execution/multi-tenant-alignment.md', 'docs/validation/VTID-05717/acceptance.md'];

const CITE = /^([A-Za-z0-9_.\-\/()\[\]@+]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?$/;
const cache = new Map();

function lineCount(repo, sha, path) {
  const key = `${repo}|${sha}|${path}`;
  if (cache.has(key)) return cache.get(key);
  let n = -1;
  try {
    const out = execFileSync('git', ['-C', repo, 'show', `${sha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    n = out.length === 0 ? 0 : out.split('\n').length - (out.endsWith('\n') ? 1 : 0);
  } catch {
    n = -1;
  }
  cache.set(key, n);
  return n;
}

function resolve(path) {
  for (const p of PREFIXES) {
    if (path.startsWith(p.prefix)) return { repo: p.repo, sha: p.sha, path: path.slice(p.prefix.length) };
  }
  return { repo: '.', sha: PLATFORM_PIN, path };
}

let ok = 0;
const failed = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const tokens = text.match(/`[^`\n]+`/g) || [];
  for (const raw of tokens) {
    const tok = raw.slice(1, -1).trim();
    const m = CITE.exec(tok);
    if (!m) continue;
    const [, p, a, b] = m;
    if (p.includes('*')) continue;
    const r = resolve(p);
    const n = lineCount(r.repo, r.sha, r.path);
    const hi = b ? Number(b) : Number(a);
    const lo = Number(a);
    if (n < 0) failed.push(`${file}: ${tok} (file missing at ${r.sha.slice(0, 10)})`);
    else if (lo < 1 || hi < lo || hi > n) failed.push(`${file}: ${tok} (file has ${n} lines)`);
    else ok += 1;
  }
}

for (const f of failed) console.log(`FAILED ${f}`);
console.log(`citations ok=${ok} failed=${failed.length}`);
console.log(`pins platform=${PLATFORM_PIN} v1=${V1_PIN} strategy=${STRATEGY_PIN}`);
process.exit(failed.length > 0 || ok === 0 ? 1 : 0);
