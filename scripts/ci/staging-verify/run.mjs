#!/usr/bin/env node
// VTID-04613 — STAGING-VERIFY runner.
//
//   node run.mjs verify    --service gateway|community-app --sha <full sha> --repo-root <dir> --out <dir>
//   node run.mjs check-pr  --service gateway|community-app --repo-root <dir> --base <sha> --head <sha> --title "<PR title>"
//
// verify   — after a staging deploy: confirm staging serves <sha>, run the
//            service smoke suite plus every change suite for the commits
//            between production and <sha>, re-confirm the commit, and write
//            results.json / message.md for the OASIS step and the session.
// check-pr — before merge: a PR that touches a service's deploy paths must
//            carry a valid docs/validation/<VTID>/staging-tests.json.
//
// Read-only by construction (CLAUDE.md rule 48): http tests are GET/HEAD or
// an auth-rejected probe, browser tests run behind staging-guard.ts, and no
// target may be a production host. Process: docs/DEPLOYMENT-PIPELINE.md.

import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, appendFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('./lib.cjs');
const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const args = { cmd };
  for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, '')] = rest[i + 1];
  return args;
}

const log = (...a) => console.log('[staging-verify]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function git(repoRoot, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

function isAncestor(repoRoot, a, b) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function httpGet(url, init = {}) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000), ...init });
  const body = (await res.text()).slice(0, 1_000_000);
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  return { status: res.status, contentType: res.headers.get('content-type') || '', body, json };
}

// ── Version stamps ───────────────────────────────────────────────────────
async function stagingStamp(service) {
  if (service === 'gateway') {
    const r = await httpGet(`${lib.STAGING_TARGETS.gateway}/api/v1/admin/build-info`);
    return r.json?.env === 'staging' ? r.json.git_commit || null : null;
  }
  const r = await httpGet(`${lib.STAGING_TARGETS.frontend}/?staging-verify=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  return lib.parseFrontendVersion(r.body);
}

// The ONLY production request STAGING-VERIFY makes: the public version stamp,
// to list what a PUBLISH would ship. It is the same read as the documented
// deploy check, never a test.
async function productionStamp(service) {
  try {
    const r = await httpGet(`${lib.PRODUCTION_VERSION_SOURCES[service]}${service === 'gateway' ? '' : `?staging-verify=${Date.now()}`}`);
    return service === 'gateway' ? r.json?.git_commit || null : lib.parseFrontendVersion(r.body);
  } catch (e) {
    log(`production version unreadable: ${e.message}`);
    return null;
  }
}

// Staging must serve <sha> on several consecutive samples (an ECS rollout
// serves old and new side by side for a minute or two). Returns
// { state: 'match' | 'superseded' | 'mismatch', stamp }.
async function confirmLive(service, sha, repoRoot, { attempts = 8, samples = 5 } = {}) {
  let last = null;
  for (let a = 1; a <= attempts; a++) {
    const stamps = [];
    for (let s = 0; s < samples; s++) {
      try {
        stamps.push(await stagingStamp(service));
      } catch (e) {
        stamps.push(null);
      }
    }
    last = stamps.find(Boolean) || null;
    if (stamps.every((st) => lib.commitMatches(service, st, sha))) return { state: 'match', stamp: last };
    const other = stamps.find((st) => st && !lib.commitMatches(service, st, sha));
    if (other) {
      const full = git(repoRoot, ['rev-parse', '--verify', `${other}^{commit}`], { allowFail: true });
      if (full && full !== sha && isAncestor(repoRoot, sha, full)) return { state: 'superseded', stamp: other };
    }
    log(`attempt ${a}/${attempts}: staging stamps ${JSON.stringify(stamps)} — want ${sha.slice(0, 12)}; retry in 15s`);
    if (a < attempts) await sleep(15_000);
  }
  return { state: 'mismatch', stamp: last };
}

// ── Range ────────────────────────────────────────────────────────────────
function commitsBetween(repoRoot, fromSha, toSha) {
  const range = fromSha ? `${fromSha}..${toSha}` : `${toSha}~1..${toSha}`;
  const out = git(repoRoot, ['log', '--reverse', '--format=%H%x1f%cI%x1f%an%x1f%s', range], { allowFail: true }) || '';
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date, author, subject] = line.split('\x1f');
      const files = (git(repoRoot, ['show', '--name-only', '--format=', sha], { allowFail: true }) || '').split('\n').filter(Boolean);
      return { sha, date, author, subject, files };
    });
}

function loadManifest(repoRoot, vtid) {
  const p = join(repoRoot, 'docs', 'validation', vtid, 'staging-tests.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return { __parseError: e.message };
  }
}

// ── Test execution ───────────────────────────────────────────────────────
function inside(root, p) {
  const abs = resolve(root, p);
  return abs === resolve(root) || abs.startsWith(resolve(root) + sep) ? abs : null;
}

async function runHttp(service, t) {
  const base = lib.assertStagingTarget(lib.STAGING_TARGETS[t.target || lib.SERVICES[service].target]);
  const method = String(t.method || 'GET').toUpperCase();
  const init = { method, headers: { accept: 'application/json, text/html;q=0.9' } };
  if (t.rejected_probe) {
    // Deliberately invalid credentials: the probe must be rejected by the
    // auth gate before any handler runs. evaluateHttp flags a 2xx loudly.
    init.headers.authorization = 'Bearer staging-verify.invalid.probe';
    init.headers['content-type'] = 'application/json';
    init.body = '{}';
  }
  const res = await httpGet(`${base}${t.path}`, init);
  return lib.evaluateHttp(t, res);
}

const installed = new Set();
function ensureDeps(cwdAbs) {
  if (installed.has(cwdAbs) || !existsSync(join(cwdAbs, 'package.json'))) return;
  if (!existsSync(join(cwdAbs, 'node_modules'))) {
    log(`npm ci in ${cwdAbs}`);
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: cwdAbs, stdio: 'inherit' });
  }
  installed.add(cwdAbs);
}

function passthrough(names) {
  return Object.fromEntries(names.filter((n) => process.env[n]).map((n) => [n, process.env[n]]));
}

let browsersInstalled = false;
function runPlaywright(service, repoRoot, t, outDir) {
  const cwdAbs = inside(repoRoot, t.cwd || '.');
  const specAbs = inside(repoRoot, t.spec);
  if (!cwdAbs || !specAbs || !specAbs.startsWith(cwdAbs)) return { ok: false, problems: ['spec must live under cwd inside the repo'] };
  if (!existsSync(specAbs)) return { ok: false, problems: [`spec not found: ${t.spec}`] };
  if (!/from ['"]\.\/staging-guard['"]/.test(readFileSync(specAbs, 'utf8'))) {
    return { ok: false, problems: ["spec must import { test, expect } from './staging-guard' (read-only network guard, rule 48)"] };
  }
  // The canonical guard is copied next to the spec on every run, so no repo
  // can carry a stale or weakened copy.
  copyFileSync(join(HERE, 'staging-guard.ts'), join(dirname(specAbs), 'staging-guard.ts'));
  ensureDeps(cwdAbs);
  if (!browsersInstalled && !(process.env.STAGING_VERIFY_SKIP_BROWSER_INSTALL ?? '')) {
    execFileSync('npx', ['playwright', 'install', 'chromium', '--with-deps'], { cwd: cwdAbs, stdio: 'inherit' });
    browsersInstalled = true;
  }
  const cfg = join(cwdAbs, '.staging-verify.playwright.config.mjs');
  writeFileSync(
    cfg,
    `import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.', timeout: 90_000, retries: 0, workers: 1, reporter: [['list']],
  use: {
    baseURL: process.env.STAGING_BASE_URL ?? '', ...devices['Desktop Chrome'], screenshot: 'only-on-failure',
    // Local-sandbox escape hatches only (a pinned browser binary, a
    // TLS-intercepting proxy). CI sets neither.
    ...((process.env.STAGING_VERIFY_CHROMIUM_PATH ?? '') ? { launchOptions: { executablePath: process.env.STAGING_VERIFY_CHROMIUM_PATH ?? '' } } : {}),
    ...((process.env.STAGING_VERIFY_IGNORE_HTTPS_ERRORS ?? '') === '1' ? { ignoreHTTPSErrors: true } : {}),
  },
  outputDir: ${JSON.stringify(join(outDir, 'playwright'))},
});
`,
  );
  const base = lib.assertStagingTarget(lib.STAGING_TARGETS[t.target || lib.SERVICES[service].target]);
  const r = spawnSync('npx', ['playwright', 'test', relative(cwdAbs, specAbs), `--config=${cfg}`], {
    cwd: cwdAbs,
    encoding: 'utf8',
    timeout: 15 * 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CI: '1',
      ...((process.env.PLAYWRIGHT_BROWSERS_PATH ?? '') ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '' } : {}),
      ...passthrough(['STAGING_VERIFY_CHROMIUM_PATH', 'STAGING_VERIFY_IGNORE_HTTPS_ERRORS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']),
      STAGING_BASE_URL: base,
      STAGING_GATEWAY_URL: lib.STAGING_TARGETS.gateway,
      STAGING_FRONTEND_URL: lib.STAGING_TARGETS.frontend,
      TEST_USER_EMAIL: process.env.TEST_USER_EMAIL || '',
      TEST_USER_PASSWORD: process.env.TEST_USER_PASSWORD || '',
    },
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  process.stdout.write(output);
  return r.status === 0 ? { ok: true, problems: [] } : { ok: false, problems: [summarizeFailure(output)] };
}

// The few lines that say what broke, not the whole reporter output (which is
// already in the job log above).
function summarizeFailure(output) {
  const lines = output.split('\n').map((l) => l.replace(/[║╔╗╚╝═]/g, '').trim()).filter(Boolean);
  const key = lines.filter((l) => /(✘|Error:|expect\(|Expected|Received|FAIL|failed)/.test(l));
  return (key.length ? key : lines.slice(-6)).slice(0, 8).join(' | ').slice(0, 1500);
}

function runExisting(repoRoot, t) {
  const cwdAbs = inside(repoRoot, t.cwd || '.');
  if (!cwdAbs) return { ok: false, problems: ['cwd outside repo'] };
  ensureDeps(cwdAbs);
  const [bin, ...argv] = t.ref.split(' ');
  // No secrets: CI-level suites never need staging or test-user credentials.
  const r = spawnSync(bin, argv, {
    cwd: cwdAbs,
    encoding: 'utf8',
    timeout: 20 * 60_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1', NODE_ENV: 'test' },
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  process.stdout.write(output);
  return r.status === 0 ? { ok: true, problems: [] } : { ok: false, problems: [summarizeFailure(output)] };
}

async function runSuite(service, repoRoot, outDir, suite, tests) {
  const results = [];
  for (const [i, t] of tests.entries()) {
    const name = t.name || `${t.kind} ${t.path || t.spec || t.ref || i}`;
    const started = Date.now();
    let r;
    try {
      if (t.kind === 'http') r = await runHttp(service, t);
      else if (t.kind === 'playwright') r = runPlaywright(service, repoRoot, t, outDir);
      else r = runExisting(repoRoot, t);
    } catch (e) {
      r = { ok: false, problems: [e.message] };
    }
    const row = { suite, name, kind: t.kind, ok: r.ok, problems: r.problems, ms: Date.now() - started };
    log(`${row.ok ? 'PASS' : 'FAIL'} ${suite} › ${name}${row.ok ? '' : ` — ${row.problems.join('; ')}`}`);
    results.push(row);
  }
  return results;
}

// ── Commands ─────────────────────────────────────────────────────────────
async function verify(args) {
  const service = args.service;
  const sha = args.sha;
  const repoRoot = resolve(args['repo-root']);
  const outDir = resolve(args.out || 'staging-verify-out');
  mkdirSync(outDir, { recursive: true });
  if (!lib.SERVICES[service]) throw new Error(`unknown service ${service}`);
  if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('--sha must be a full commit sha');
  Object.values(lib.STAGING_TARGETS).forEach(lib.assertStagingTarget);

  log(`service=${service} sha=${sha}`);
  const before = await confirmLive(service, sha, repoRoot);

  const prodStamp = await productionStamp(service);
  const prodSha = prodStamp ? git(repoRoot, ['rev-parse', '--verify', `${prodStamp}^{commit}`], { allowFail: true }) : null;
  const rangeFrom = prodSha && prodSha !== sha && isAncestor(repoRoot, prodSha, sha) ? prodSha : null;
  const commits = prodSha === sha ? [] : commitsBetween(repoRoot, rangeFrom, sha);
  const manifests = {};
  for (const c of commits) for (const v of lib.extractVtids(c.subject)) if (!(v in manifests)) manifests[v] = loadManifest(repoRoot, v);
  const plan = lib.planRange({ service, commits, manifests });
  const shipping = commits.filter((c) => lib.touchesService(c.files, service));
  log(`production=${prodStamp || 'unknown'} range=${commits.length} commits, ${shipping.length} touch ${service}; suites=${plan.suites.map((s) => s.vtid).join(',') || '(none)'} missing=${plan.missing.length}`);

  let results = [];
  let superseded = before.state === 'superseded';
  if (before.state === 'mismatch') {
    results.push({ suite: 'deploy', name: 'staging serves the deployed commit', kind: 'http', ok: false, problems: [`staging reports ${before.stamp || 'nothing'}, not ${sha}`], ms: 0 });
  } else if (!superseded) {
    const smoke = JSON.parse(readFileSync(join(HERE, 'smoke', `${service}.json`), 'utf8'));
    const v = lib.validateManifest(smoke, { service });
    if (!v.ok) throw new Error(`smoke/${service}.json invalid: ${v.errors.join('; ')}`);
    results.push(...(await runSuite(service, repoRoot, outDir, 'smoke', smoke.tests)));
    for (const s of plan.suites) results.push(...(await runSuite(service, repoRoot, outDir, s.vtid, s.tests)));
    const after = await confirmLive(service, sha, repoRoot, { attempts: 1, samples: 5 });
    if (after.state !== 'match') {
      superseded = after.state === 'superseded';
      if (!superseded) results.push({ suite: 'deploy', name: 'staging still serves the commit after the run', kind: 'http', ok: false, problems: [`staging now reports ${after.stamp || 'nothing'}`], ms: 0 });
    }
  }

  const outcome = lib.decideOutcome({ superseded, results, plan });
  const serverUrl = process.env.GITHUB_SERVER_URL ?? '';
  const runUrl = serverUrl && process.env.GITHUB_RUN_ID
    ? `${serverUrl}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;
  const message = lib.buildReadyMessage({ service, sha, outcome, results, plan, shipping, prodStamp, runUrl });
  const headSubject = git(repoRoot, ['log', '-1', '--format=%s', sha], { allowFail: true }) || '';
  const record = {
    service,
    sha,
    outcome,
    vtid: lib.extractVtids(headSubject)[0] || null,
    vtids: [...new Set(shipping.flatMap((c) => lib.extractVtids(c.subject)))],
    staging_stamp: before.stamp,
    production_stamp: prodStamp,
    run_url: runUrl,
    results,
    plan: { suites: plan.suites.map((s) => s.vtid), missing: plan.missing, invalid: plan.invalid, legacy_count: plan.legacy.length },
    shipping: shipping.map(({ sha: s, subject, author, date }) => ({ sha: s, subject, author, date })),
    message,
  };
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(record, null, 2));
  writeFileSync(join(outDir, 'message.md'), message + '\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `outcome=${outcome}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const table = ['', '| Suite | Test | Result | ms |', '|---|---|---|---|', ...results.map((r) => `| ${r.suite} | ${r.name} | ${r.ok ? 'PASS' : 'FAIL: ' + r.problems.join('; ').replace(/\|/g, '/')} | ${r.ms} |`)];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## STAGING-VERIFY — ${service}\n\n${message}\n${table.join('\n')}\n`);
  }
  console.log('\n' + message);
  process.exit(outcome === 'failed' ? 1 : 0);
}

function checkPr(args) {
  const service = args.service;
  const repoRoot = resolve(args['repo-root']);
  const files = (git(repoRoot, ['diff', '--name-only', `${args.base}...${args.head}`]) || '').split('\n').filter(Boolean);
  if (!lib.touchesService(files, service)) {
    log(`PR touches no ${service} deploy path — nothing deploys, no staging suite needed.`);
    return;
  }
  const vtids = lib.extractVtids(args.title);
  const fail = (msg) => {
    console.error(`::error::${msg}`);
    process.exit(1);
  };
  if (vtids.length === 0) fail(`PR changes ${service} deploy paths but its title names no VTID — the change suite lives at docs/validation/<VTID>/staging-tests.json (CLAUDE.md rule 47).`);
  const errors = [];
  let found = 0;
  for (const vtid of vtids) {
    const m = loadManifest(repoRoot, vtid);
    if (!m) continue;
    found++;
    if (m.__parseError) {
      errors.push(`${vtid}: staging-tests.json is not valid JSON (${m.__parseError})`);
      continue;
    }
    const v = lib.validateManifest(m, { vtid, service });
    if (!v.ok) errors.push(...v.errors.map((e) => `${vtid}: ${e}`));
  }
  if (found === 0) {
    fail(`PR changes ${service} deploy paths but has no docs/validation/${vtids[0]}/staging-tests.json — no suite, no merge (CLAUDE.md rule 47, docs/DEPLOYMENT-PIPELINE.md §3.2).`);
  }
  if (errors.length) fail(`staging-tests.json invalid:\n  ${errors.join('\n  ')}`);
  log(`✓ change suite present and valid for ${vtids.join(', ')}`);
}

const args = parseArgs(process.argv.slice(2));
if (args.cmd === 'verify') {
  verify(args).catch((e) => {
    console.error(`::error::STAGING-VERIFY crashed: ${e.stack || e.message}`);
    process.exit(1);
  });
} else if (args.cmd === 'check-pr') {
  checkPr(args);
} else {
  console.error('usage: run.mjs verify|check-pr …');
  process.exit(2);
}
