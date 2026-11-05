#!/usr/bin/env node
// Replays the `existing` suites of STAGING-VERIFY manifests exactly as
// scripts/ci/staging-verify/run.mjs `runExisting` (run.mjs:300-316) runs them:
//   cwdAbs = inside(repoRoot, t.cwd || '.'); ensureDeps(cwdAbs);
//   spawnSync(bin, argv, { cwd: cwdAbs, env: { PATH, HOME, CI: '1', NODE_ENV: 'test', ...lib.existingEnv(t) } })
// Only the `existing` kind runs: the manifests' `http` tests call staging, which a builder session never does.
// ensureDeps differs in one way: where run.mjs would `npm ci`, this harness stops (the local stand-in for the
// gateway install is the hard-linked dependency cache; the repository root carries a tracked node_modules, so
// run.mjs runs no `npm ci` there either, as STAGING-VERIFY run 42078889519 shows).
//
//   node replay-existing.mjs --repo <checkout> --vtids VTID-05515,VTID-05516,VTID-05518
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep, relative } from 'node:path';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
const repoRoot = resolve(args.repo);
const vtids = String(args.vtids || '').split(',').filter(Boolean);
const require = createRequire(import.meta.url);
const lib = require(join(repoRoot, 'scripts/ci/staging-verify/lib.cjs'));

// run.mjs:213-216
function inside(root, p) {
  const abs = resolve(root, p);
  return abs === resolve(root) || abs.startsWith(resolve(root) + sep) ? abs : null;
}

// run.mjs:228-235, without the install.
function ensureDeps(cwdAbs) {
  if (!existsSync(join(cwdAbs, 'package.json'))) return 'no package.json, nothing to install';
  if (existsSync(join(cwdAbs, 'node_modules'))) return 'node_modules present, no npm ci (as run.mjs)';
  throw new Error(`node_modules missing in ${cwdAbs}: run.mjs would run npm ci here; this harness does not`);
}

let pass = 0;
let fail = 0;
for (const vtid of vtids) {
  const file = join(repoRoot, 'docs/validation', vtid, 'staging-tests.json');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  const v = lib.validateManifest(m, { vtid, service: 'gateway' });
  console.log(`[replay] ${vtid} lib.validateManifest: ok=${v.ok} errors=${JSON.stringify(v.errors)}`);
  for (const t of m.tests.filter((x) => x.kind === 'existing')) {
    const cwdAbs = inside(repoRoot, t.cwd || '.');
    const cwdRel = relative(repoRoot, cwdAbs) || '.';
    console.log(`[replay] ${vtid} › existing ${t.ref} (manifest cwd ${JSON.stringify(t.cwd)}, runs in ${cwdRel}; ${ensureDeps(cwdAbs)})`);
    const [bin, ...rest] = t.ref.split(' ');
    const r = spawnSync(bin, rest, {
      cwd: cwdAbs,
      encoding: 'utf8',
      timeout: 20 * 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1', NODE_ENV: 'test', ...lib.existingEnv(t) },
    });
    const output = `${r.stdout || ''}${r.stderr || ''}`;
    const keep = output
      .split('\n')
      .filter((l) => /^(PASS|FAIL) |Test suite failed to run|Jest failed to parse|SyntaxError|Must use import to load ES Module|^Test Suites:|^Tests:|^Ran all test suites|not found and will be installed/.test(l.trim()));
    for (const l of keep) console.log(`    ${l.trimEnd()}`);
    if (r.status === 0) {
      pass++;
      console.log(`[replay] PASS ${vtid} › existing ${t.ref} (exit 0)`);
    } else {
      fail++;
      console.log(`[replay] FAIL ${vtid} › existing ${t.ref} (exit ${r.status}) — ${lib.summarizeFailure(output)}`);
    }
  }
}
console.log(`[replay] existing suites: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
