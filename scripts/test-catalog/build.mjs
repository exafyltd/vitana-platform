#!/usr/bin/env node
// VTID-04637 — build the test catalog from checkouts of both repositories.
//
//   node scripts/test-catalog/build.mjs \
//     --platform <dir> [--platform-sha <sha>] \
//     [--frontend <dir>] [--frontend-sha <sha>] \
//     --out <file.json>
//
// Pure logic lives in lib.cjs. This file only walks the trees and writes JSON.
// A missing --frontend checkout is allowed (the catalog then says so in
// `sources.frontend.missing`) so a token problem never blocks the platform leg.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const lib = require('./lib.cjs');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.repowise', 'graphify-out', '.next', 'vendor']);
const TEST_NAME = /(\.test\.(ts|tsx|js|mjs|cjs)|\.spec\.(ts|mjs)|_test\.ts|-regression\.mjs|^test_.+\.py|^e2e-.+\.cjs)$/;

function walk(root, rel = '', out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(root, rel ? `${rel}/${e.name}` : e.name, out);
    } else if (e.isFile()) {
      out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  }
  return out;
}

function headSha(dir) {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; }
}

function collect(repoKey, dir) {
  const all = walk(dir);
  const files = [];
  for (const p of all) {
    if (!TEST_NAME.test(path.basename(p)) && !/^tests\/[^/]+\.cjs$/.test(p) && !/^scripts\/e2e\/.+\.mjs$/.test(p)) continue;
    if (!lib.classifyTestFile(repoKey, p)) continue;
    files.push({ repo: repoKey, path: p, text: fs.readFileSync(path.join(dir, p), 'utf8') });
  }
  const workflows = all
    .filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))
    .map((p) => ({ repo: repoKey, file: path.basename(p), text: fs.readFileSync(path.join(dir, p), 'utf8') }));
  const packages = all
    .filter((p) => path.basename(p) === 'package.json' && p.split('/').length <= 3)
    .map((p) => ({ repo: repoKey, dir: path.dirname(p), text: fs.readFileSync(path.join(dir, p), 'utf8') }));
  return { files, workflows, packages };
}

const platformDir = arg('platform');
const frontendDir = arg('frontend');
const out = arg('out');
if (!platformDir || !out) {
  console.error('usage: build.mjs --platform <dir> [--frontend <dir>] --out <file.json>');
  process.exit(2);
}

const input = { generated_at: new Date().toISOString(), sources: {}, files: [], workflows: [], packages: [] };
const legs = [['platform', platformDir, arg('platform-sha')], ['frontend', frontendDir, arg('frontend-sha')]];
for (const [key, dir, sha] of legs) {
  if (!dir || !fs.existsSync(dir)) {
    input.sources[key] = { repo: lib.REPOS[key], sha: null, missing: true };
    continue;
  }
  const c = collect(key, dir);
  input.files.push(...c.files);
  input.workflows.push(...c.workflows);
  input.packages.push(...c.packages);
  input.sources[key] = { repo: lib.REPOS[key], sha: sha || headSha(dir), missing: false };
}

const catalog = lib.buildCatalog(input);
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify(catalog));
const s = catalog.summary;
console.log(`test catalog: ${s.files} files, ${s.cases} cases, ${s.suites} suites, ${s.workflows} workflows (${s.scheduled_workflows} scheduled, ~${s.scheduled_runs_per_day} runs/day)`);
console.log(`never run: ${s.never_run_suites.join(', ') || 'none'}`);
for (const w of s.flagged_workflows) console.log(`flag ${w.file}: ${w.flags.join(', ')}`);
