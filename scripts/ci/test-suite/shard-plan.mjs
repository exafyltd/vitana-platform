#!/usr/bin/env node
// Gateway Jest shard planner (TEST-SUITE.yml, job `gateway`, and the `gateway-shard-union` check).
//
//   node scripts/ci/test-suite/shard-plan.mjs --list <file> --shards 4 --shard <n> --root <dir> [--weights <json>]
//       Prints the absolute paths of the test files shard <n> runs, one per line (stdout only).
//   node scripts/ci/test-suite/shard-plan.mjs --list <file> --shards 4 --verify --root <dir> [--weights <json>]
//       Plans every shard from the list and proves each listed file lands in exactly one shard. Exit 1 otherwise.
//   node scripts/ci/test-suite/shard-plan.mjs --from-jest-json <file> --root <dir> --write-weights <json>
//       Rebuilds the weights table from a `jest --json` run (per-file wall time in ms).
//
// Why: `jest --shard=n/4` assigns each file by the SHA-1 hash of its path. That gives every shard about the same
// number of files, not the same time. Main run 43244803673: shard 1 took 153 s, shard 4 took 64 s.
// This planner uses the per-file durations in shard-weights.json: the slowest file goes first to the currently
// lightest shard (longest-processing-time-first). Files missing from the table get the median duration. The plan is
// deterministic, and it never drops or duplicates a file: `--verify` and the gateway-shard-union job check that.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseList } from './shard-union.mjs';

export const WEIGHTS_SCHEMA = 'vitana.gateway-shard-weights/v1';
const DEFAULT_WEIGHTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shard-weights.json');

const slash = (p) => String(p).trim().replace(/\\/g, '/');

/** A test file as a path relative to the gateway root (the key of the weights table). */
export function relKey(file, root) {
  const base = path.resolve(root);
  return slash(path.relative(base, path.resolve(base, slash(file))));
}

function median(values) {
  if (!values.length) return 1;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Turns a weights document into a Map of relative path -> duration in ms. */
export function weightsFromDoc(doc) {
  if (!doc || doc.schema !== WEIGHTS_SCHEMA || !doc.weights || typeof doc.weights !== 'object') {
    throw new Error(`weights table is not a ${WEIGHTS_SCHEMA} document`);
  }
  return new Map(Object.entries(doc.weights).map(([k, v]) => [slash(k), Number(v)]));
}

/**
 * Splits the test files into `shards` buckets by duration (longest first, each to the lightest bucket so far).
 * Returns the relative paths per bucket, the total duration per bucket and the files that had no weight.
 */
export function planShards(files, { shards, weights, root }) {
  if (!Number.isInteger(shards) || shards < 1) throw new Error(`shards must be a positive integer, got ${shards}`);
  const keys = [...new Set(files.map((f) => relKey(f, root)))].sort();
  const fallback = median(keys.filter((k) => weights.has(k)).map((k) => weights.get(k)));
  const items = keys.map((k) => ({ k, w: weights.has(k) ? weights.get(k) : fallback, defaulted: !weights.has(k) }));
  items.sort((a, b) => b.w - a.w || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const buckets = Array.from({ length: shards }, () => []);
  const loads = new Array(shards).fill(0);
  for (const it of items) {
    let best = 0;
    for (let i = 1; i < shards; i++) if (loads[i] < loads[best]) best = i;
    buckets[best].push(it.k);
    loads[best] += it.w;
  }
  return {
    buckets: buckets.map((b) => b.sort()),
    loads,
    fallback,
    defaulted: items.filter((i) => i.defaulted).map((i) => i.k),
  };
}

/** Proves the plan runs every listed file in exactly one shard and nothing else. */
export function verifyCoverage(files, { shards, weights, root }) {
  const full = [...new Set(files.map((f) => relKey(f, root)))].sort();
  const plan = planShards(files, { shards, weights, root });
  const seen = new Map();
  for (const bucket of plan.buckets) for (const k of bucket) seen.set(k, (seen.get(k) || 0) + 1);
  const known = new Set(full);
  const missing = full.filter((k) => !seen.has(k));
  const duplicated = [...seen.entries()].filter(([, c]) => c > 1).map(([k]) => k).sort();
  const extra = [...seen.keys()].filter((k) => !known.has(k)).sort();
  const placed = [...seen.values()].reduce((a, b) => a + b, 0);
  const ok = full.length > 0 && missing.length === 0 && duplicated.length === 0 && extra.length === 0 && placed === full.length;
  return {
    ok,
    total: full.length,
    perShard: plan.buckets.map((b) => b.length),
    loads: plan.loads,
    defaulted: plan.defaulted.length,
    missing,
    duplicated,
    extra,
  };
}

/** Builds a weights document from a `jest --json` report. */
export function weightsFromJestJson(report, root) {
  const weights = {};
  for (const r of report.testResults || []) {
    if (!r || !r.name) continue;
    const ms = Number(r.endTime) - Number(r.startTime);
    if (!Number.isFinite(ms)) continue;
    weights[relKey(r.name, root)] = Math.max(1, Math.round(ms));
  }
  const sorted = Object.fromEntries(Object.entries(weights).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { schema: WEIGHTS_SCHEMA, unit: 'ms', source: 'jest --json per-file endTime - startTime', weights: sorted };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) throw new Error(`unexpected argument: ${t}`);
    const key = t.slice(2);
    if (key === 'verify') { args.verify = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    args[key] = value;
    i++;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const root = path.resolve(args.root || '.');

  if (args['from-jest-json']) {
    if (!args['write-weights']) throw new Error('--from-jest-json needs --write-weights <json>');
    const doc = weightsFromJestJson(JSON.parse(readFileSync(args['from-jest-json'], 'utf8')), root);
    writeFileSync(args['write-weights'], JSON.stringify(doc, null, 2) + '\n');
    console.error(`wrote ${Object.keys(doc.weights).length} durations to ${args['write-weights']}`);
    return 0;
  }

  if (!args.list) throw new Error('--list <file> is required');
  const weightsPath = args.weights || DEFAULT_WEIGHTS;
  if (!existsSync(weightsPath)) throw new Error(`weights table not found: ${weightsPath}`);
  const weights = weightsFromDoc(JSON.parse(readFileSync(weightsPath, 'utf8')));
  const files = parseList(readFileSync(args.list, 'utf8'));
  const shards = Number(args.shards || 4);

  if (args.verify) {
    const r = verifyCoverage(files, { shards, weights, root });
    console.log(`listed: ${r.total} test files, planned into ${shards} shards: ${r.perShard.join(' / ')} files`);
    console.log(`planned durations (ms): ${r.loads.map((x) => Math.round(x)).join(' / ')}; files without a weight: ${r.defaulted}`);
    for (const k of r.missing) console.log(`❌ missing from every shard: ${k}`);
    for (const k of r.duplicated) console.log(`❌ planned into more than one shard: ${k}`);
    for (const k of r.extra) console.log(`❌ planned but not listed: ${k}`);
    console.log(r.ok ? '✅ every listed test file runs in exactly one shard' : '❌ shard plan does not cover the list');
    return r.ok ? 0 : 1;
  }

  const n = Number(args.shard);
  if (!Number.isInteger(n) || n < 1 || n > shards) throw new Error(`--shard must be 1..${shards}, got ${args.shard}`);
  const plan = planShards(files, { shards, weights, root });
  if (plan.defaulted.length) console.error(`note: ${plan.defaulted.length} file(s) have no weight, using ${Math.round(plan.fallback)} ms`);
  for (const k of plan.buckets[n - 1]) console.log(path.resolve(root, k));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`shard-plan: ${e.message}`);
    process.exitCode = 2;
  }
}
