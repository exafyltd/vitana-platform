#!/usr/bin/env node
// VTID-05552 (agentic-delivery/verify-on-gitlab) — the `.staging-verify` job (plan agentic-delivery §3.6 steps 3 and 8).
//
//   node shadow-wait.mjs --run-mjs <platform main run.mjs> --service gateway|community-app
//                        (--sha <full sha> | --sha-from-staging) --repo-root <checkout> --out <dir>
//                        --deploy-runs-file <file> --full true|false [--test-user-file <file>]
//
// Live mode (DELIVERY_MODE=live): runs platform main's run.mjs verify at once; the deploy job already checked the
// served build stamp. Shadow mode (anything else, unset included, before the cutover): GitHub still deploys staging, so
// this waits up to 60 minutes for staging to serve the commit (run.mjs confirmLive, polled every 30 s), then runs
// run.mjs verify and keeps the result in the job artifact (shadow.json says it was not recorded). If staging never
// serves the commit, or moves past it to a descendant (so it never will), the result is `not_comparable`, run.mjs does
// not run and no results.json exists for a record step to pick up. run.mjs always gets --deploy-runs-file, never the
// GitHub API. --sha-from-staging (the nightly run) verifies the commit staging serves now, checked out first.
// target.json ({service, sha, mode, full}) is written before anything else; the `.record` job reads it.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SHADOW_WAIT_MS = 60 * 60_000;
export const SHADOW_POLL_MS = 30_000;
const SERVICES = ['gateway', 'community-app'];
const SHA_RE = /^[0-9a-f]{40}$/;

/** Only the exact value `live` is live; everything else (unset included) is shadow, which never writes. */
export const deliveryMode = (value) => (value === 'live' ? 'live' : 'shadow');

/** The run.mjs argv for one verification. */
export function verifyArgs({ service, sha, repoRoot, out, deployRunsFile, full }) {
  return ['verify', '--service', service, '--sha', sha, '--repo-root', repoRoot, '--out', out, '--full', full ? 'true' : 'false', '--chain', '0', '--deploy-runs-file', deployRunsFile ?? ''];
}

/** Polls `confirm` (run.mjs confirmLive) until staging serves the commit, moves past it, or the window ends. */
export async function shadowWait({ confirm, sleep, now, timeoutMs = SHADOW_WAIT_MS, intervalMs = SHADOW_POLL_MS }) {
  const start = now();
  for (let polls = 1; ; polls++) {
    const c = await confirm();
    const waited = now() - start;
    if (c.state === 'match') return { served: true, polls, waited_ms: waited };
    if (c.state === 'superseded') {
      return { served: false, polls, waited_ms: waited, reason: `staging moved to ${String(c.full || c.stamp).slice(0, 12)}, a descendant, without serving the commit; it will not serve it` };
    }
    if (waited + intervalMs > timeoutMs) {
      return { served: false, polls, waited_ms: waited, reason: `staging did not serve the commit within ${Math.round(timeoutMs / 60_000)} minutes (last stamp ${c.stamp || 'unreadable'})` };
    }
    await sleep(intervalMs);
  }
}

/** The nightly run's commit: the one staging serves now (run.mjs stamp), checked out in the repo root. */
export async function stagingCommit({ readStamp, checkout }) {
  const sha = await readStamp();
  if (!SHA_RE.test(sha || '')) throw new Error(`could not resolve the commit staging serves (got ${JSON.stringify(sha)})`);
  await checkout(sha);
  return sha;
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** One `.staging-verify` job. Returns the exit code. */
export async function runStagingVerify({ mode, service, sha, repoRoot, out, deployRunsFile, full, confirm, runVerify, sleep, now }) {
  if (!SERVICES.includes(service)) throw new Error(`--service must be ${SERVICES.join(' or ')}, not "${service}"`);
  if (!SHA_RE.test(sha || '')) throw new Error(`--sha must be a full commit sha, not "${sha}"`);
  const m = deliveryMode(mode);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'target.json'), JSON.stringify({ service, sha, mode: m, full: Boolean(full) }));
  const argv = verifyArgs({ service, sha, repoRoot, out, deployRunsFile, full });
  if (m === 'live') return runVerify(argv);
  console.log(`[staging-verify] shadow mode: waiting up to ${SHADOW_WAIT_MS / 60_000} minutes for staging to serve ${service} @ ${sha.slice(0, 12)}`);
  const w = await shadowWait({ confirm, sleep, now });
  const shadow = { mode: 'shadow', service, sha, full: Boolean(full), waited_ms: w.waited_ms, polls: w.polls, recorded: false };
  if (!w.served) {
    writeFileSync(join(out, 'shadow.json'), JSON.stringify({ ...shadow, outcome: 'not_comparable', reason: w.reason }, null, 2));
    console.log(`[staging-verify] not_comparable: ${w.reason}. run.mjs did not run; nothing is recorded.`);
    return 0;
  }
  const code = await runVerify(argv);
  const results = readJson(join(out, 'results.json'));
  writeFileSync(join(out, 'shadow.json'), JSON.stringify({ ...shadow, outcome: (results && results.outcome) || 'failed' }, null, 2));
  console.log(`[staging-verify] shadow mode: ${(results && results.outcome) || 'no result'}; kept in the job artifact, not recorded (GitHub stays the writer until the cutover).`);
  return code;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!/^--[\w-]+$/.test(argv[i] || '')) throw new Error(`unexpected argument ${argv[i]}`);
    const k = argv[i].slice(2);
    if (k === 'sha-from-staging') out[k] = true;
    else out[k] = argv[++i];
  }
  return out;
}

async function main(argv) {
  const a = parseArgs(argv);
  for (const k of ['run-mjs', 'service', 'repo-root', 'out']) if (!a[k]) throw new Error(`--${k} is required`);
  if (!('deploy-runs-file' in a)) throw new Error('--deploy-runs-file is required (GitLab never lists deploy runs through GitHub)');
  const runMjs = resolve(a['run-mjs']);
  const repoRoot = resolve(a['repo-root']);
  const out = resolve(a.out);
  const full = a.full === 'true';
  // run.mjs gets the test user as GitHub gives it (env), never the job's ID tokens; the secret file is removed once read.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_ID_TOKEN$/.test(k)));
  if (a['test-user-file']) {
    const u = readJson(a['test-user-file']);
    rmSync(a['test-user-file'], { force: true });
    if (!u) console.error(`[staging-verify] ${a['test-user-file']} is missing or not JSON: browser tests that sign in will fail`);
    else Object.assign(env, { TEST_USER_EMAIL: u.TEST_USER_EMAIL || '', TEST_USER_PASSWORD: u.TEST_USER_PASSWORD || '' });
  }
  let sha = a.sha;
  if (a['sha-from-staging']) {
    sha = await stagingCommit({
      readStamp: async () => {
        const r = spawnSync(process.execPath, [runMjs, 'stamp', '--service', a.service, '--repo-root', repoRoot], { encoding: 'utf8' });
        process.stderr.write(r.stderr || '');
        return r.status === 0 ? r.stdout.trim() : null;
      },
      checkout: async (s) => execFileSync('git', ['-C', repoRoot, 'checkout', '--quiet', '--detach', s], { stdio: 'inherit' }),
    });
    console.log(`[staging-verify] staging serves ${a.service} @ ${sha}`);
  }
  const { confirmLive } = await import(pathToFileURL(runMjs).href);
  return runStagingVerify({
    mode: process.env.DELIVERY_MODE,
    service: a.service, sha, repoRoot, out, deployRunsFile: a['deploy-runs-file'], full,
    // The nightly commit is the one staging serves: nothing to wait for.
    confirm: a['sha-from-staging'] ? async () => ({ state: 'match' }) : () => confirmLive(a.service, sha, repoRoot, { attempts: 1, samples: 5, retryMs: 0 }),
    runVerify: async (args) => {
      const r = spawnSync(process.execPath, [runMjs, ...args], { stdio: 'inherit', env });
      return r.status === null ? 1 : r.status;
    },
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: Date.now,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`[staging-verify] ${e.message}`);
    process.exit(1);
  });
}
