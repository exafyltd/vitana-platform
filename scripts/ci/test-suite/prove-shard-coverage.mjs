#!/usr/bin/env node
// Proves that the gateway Jest shards, taken together, are the full test list: every test file runs in exactly one
// shard. It uses the same commands as TEST-SUITE.yml: `npx jest --listTests` for the full list, then
// `shard-plan.mjs --shard <n>` for each shard (the CLI output, not an in-memory plan).
//
//   node scripts/ci/test-suite/prove-shard-coverage.mjs [--gateway services/gateway] [--shards 4] [--list <file>]
//
// Exit 0 when the union of the shard outputs equals the list with no file twice and none missing. Exit 1 otherwise.
// --list reuses a saved `jest --listTests` output instead of running Jest (for example in a review).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseList } from './shard-union.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAN = path.join(HERE, 'shard-plan.mjs');
const norm = (p) => String(p).replace(/\\/g, '/');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument near ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

/** Pure check: `shardLines[i]` is the file list shard i+1 printed. */
export function proveUnion(list, shardLines) {
  const full = [...new Set(list.map(norm))].sort();
  const counts = new Map();
  for (const lines of shardLines) for (const l of lines.map(norm)) counts.set(l, (counts.get(l) || 0) + 1);
  const known = new Set(full);
  const missing = full.filter((f) => !counts.has(f));
  const twice = [...counts].filter(([, c]) => c > 1).map(([f]) => f).sort();
  const extra = [...counts.keys()].filter((f) => !known.has(f)).sort();
  const ok = full.length > 0 && missing.length === 0 && twice.length === 0 && extra.length === 0;
  return { ok, total: full.length, perShard: shardLines.map((l) => l.length), missing, twice, extra };
}

function main(argv) {
  const args = parseArgs(argv);
  const gateway = path.resolve(args.gateway || 'services/gateway');
  const shards = Number(args.shards || 4);
  const listText = args.list
    ? readFileSync(args.list, 'utf8')
    : execFileSync('npx', ['jest', '--listTests'], { cwd: gateway, env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const list = parseList(listText);
  const dir = mkdtempSync(path.join(tmpdir(), 'shard-proof-'));
  try {
    const listFile = path.join(dir, 'list.txt');
    writeFileSync(listFile, list.join('\n') + '\n');
    const shardLines = [];
    for (let n = 1; n <= shards; n++) {
      const out = execFileSync(process.execPath, [PLAN, '--list', listFile, '--shards', String(shards), '--shard', String(n), '--root', gateway], { encoding: 'utf8' });
      shardLines.push(out.split('\n').filter(Boolean));
    }
    const r = proveUnion(list, shardLines);
    console.log(`listed: ${r.total} test files; shards run: ${r.perShard.join(' / ')} files`);
    for (const f of r.missing) console.log(`❌ in no shard: ${f}`);
    for (const f of r.twice) console.log(`❌ in more than one shard: ${f}`);
    for (const f of r.extra) console.log(`❌ run but not listed: ${f}`);
    console.log(r.ok ? `✅ union of ${shards} shards = full list (${r.total} files, each in exactly one shard)` : '❌ union of shards ≠ full list');
    return r.ok ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`prove-shard-coverage: ${e.message}`);
    process.exitCode = 2;
  }
}
