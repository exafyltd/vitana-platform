#!/usr/bin/env node
// VTID-05272 (plan kiro-autonomy-fallback §5 H) — the four gateway Jest shards together ran exactly the full suite.
//
//   node scripts/ci/test-suite/shard-union.mjs --dir <artifacts dir> --shards 4 [--summary <file>]
//
// Each shard job (TEST-SUITE.yml `gateway`) uploads `list-<n>.txt` (`npx jest --listTests`, the full list) and
// `shard-<n>.json` (`jest --shard=<n>/4 --json`). The union of every shard's `testResults[].name` must equal the list:
// a file missing from every shard, a file run by two shards, a file no list knows, a missing shard result or two
// lists that disagree all fail the job. Nothing is skipped here that Jest itself does not skip.
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const norm = (p) => String(p).trim().replace(/\\/g, '/');

/** Compare the full list with the per-shard result names. */
export function checkUnion(list, shards) {
  const full = [...new Set((list || []).map(norm).filter(Boolean))].sort();
  const seen = new Map();
  for (const names of shards) for (const n of names.map(norm)) seen.set(n, (seen.get(n) || 0) + 1);
  const missing = full.filter((f) => !seen.has(f));
  const duplicated = [...seen.entries()].filter(([, c]) => c > 1).map(([f]) => f).sort();
  const known = new Set(full);
  const extra = [...seen.keys()].filter((f) => !known.has(f)).sort();
  return { ok: missing.length === 0 && duplicated.length === 0 && extra.length === 0 && full.length > 0, total: full.length, ran: seen.size, missing, duplicated, extra };
}

export const parseList = (text) => String(text || '').split(/\r?\n/).map(norm).filter((l) => l.startsWith('/') || /^[A-Za-z]:\//.test(l));
export const resultNames = (json) => (json && Array.isArray(json.testResults) ? json.testResults.map((r) => r.name || r.testFilePath).filter(Boolean) : []);

/** Read the artifacts of `shards` shards from `dir`; problems (missing files, lists that disagree) come back as errors. */
export function loadArtifacts(dir, shards) {
  const errors = [];
  const lists = [];
  const results = [];
  for (let n = 1; n <= shards; n++) {
    const lf = path.join(dir, `list-${n}.txt`);
    const rf = path.join(dir, `shard-${n}.json`);
    if (existsSync(lf)) lists.push(parseList(readFileSync(lf, 'utf8'))); else errors.push(`list-${n}.txt missing (shard ${n} did not list its tests)`);
    if (!existsSync(rf)) { errors.push(`shard-${n}.json missing (shard ${n} wrote no Jest result)`); continue; }
    try { results.push(resultNames(JSON.parse(readFileSync(rf, 'utf8')))); } catch (e) { errors.push(`shard-${n}.json unreadable: ${e.message}`); }
  }
  const key = (l) => [...l].sort().join('\n');
  if (lists.length > 1 && lists.some((l) => key(l) !== key(lists[0]))) errors.push('the shards listed different test files (npx jest --listTests disagrees)');
  return { list: lists[0] || [], results, errors };
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  const shards = Number(args.shards || 4);
  const { list, results, errors } = loadArtifacts(path.resolve(args.dir || '.'), shards);
  const r = checkUnion(list, results);
  const lines = [`## Gateway Jest shard union (${shards} shards)`, '', `- listed: ${r.total} test files`, `- ran: ${r.ran} distinct files`];
  for (const e of errors) lines.push(`- ❌ ${e}`);
  if (r.missing.length) lines.push(`- ❌ missing from every shard (${r.missing.length}):`, ...r.missing.slice(0, 50).map((f) => `  - ${f}`));
  if (r.duplicated.length) lines.push(`- ❌ run by more than one shard (${r.duplicated.length}):`, ...r.duplicated.slice(0, 50).map((f) => `  - ${f}`));
  if (r.extra.length) lines.push(`- ❌ ran but not listed (${r.extra.length}):`, ...r.extra.slice(0, 50).map((f) => `  - ${f}`));
  const ok = r.ok && errors.length === 0;
  lines.push('', ok ? '✅ union = full list' : '❌ union ≠ full list');
  const out = lines.join('\n') + '\n';
  if (args.summary) appendFileSync(args.summary, out);
  console.log(out);
  return ok ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
