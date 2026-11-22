// Docker behavior suite for the PostgREST-Aurora proxy route profiles (route isolation, cases B1 to B6). It runs
// route-isolation.sh once and checks the result line of each case. Nothing is skipped: without a reachable Docker
// daemon every case fails with the reason.
//   node --test services/postgrest-aurora-proxy/test-route-isolation/behavior.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, 'route-isolation.sh');

const TITLES = {
  B1: 'production profile forwards /auth/v1 to the mock Supabase',
  B2: 'staging profile refuses every production-bound probe with 403 and no upstream request',
  B3: 'staging profile serves /alive and /rest and sends nothing else upstream',
  B4: 'rollback drill: candidate, production with the alias, production with 127.0.0.1, candidate',
  B5: 'startup and /alive on both profiles',
  B6: 'production profile without SUPABASE_AUTH_HOST does not start',
};

let outcome = null;

// Runs the harness once and caches the outcome for every case.
function runHarness() {
  if (outcome) return outcome;
  // Plain `docker info` exits non-zero when the daemon is unreachable. A --format template does not: it exits 0.
  const info = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 120_000 });
  if (info.error || info.status !== 0) {
    const why = info.error ? info.error.message : (info.stderr || '').trim().split('\n')[0];
    outcome = { error: `Docker daemon unreachable (${why}). This suite does not skip; run it on a host with a working Docker daemon.` };
    return outcome;
  }
  const res = spawnSync('bash', [HARNESS], { encoding: 'utf8', timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
  outcome = {
    status: res.status,
    error: res.error ? res.error.message : null,
    lines: (res.stdout || '').split('\n').filter((l) => l.startsWith('CASE ')),
    stderr: (res.stderr || '').slice(-1500),
  };
  return outcome;
}

function checkCase(id) {
  const r = runHarness();
  if (r.error) assert.fail(r.error);
  const mine = r.lines.filter((l) => l.startsWith(`CASE ${id} `));
  for (const line of mine) console.log(line);
  assert.ok(mine.length > 0, `${id}: no result line from route-isolation.sh (exit ${r.status}). stderr tail:\n${r.stderr}`);
  const failed = mine.filter((l) => l.startsWith(`CASE ${id} FAIL `));
  assert.deepEqual(failed, [], `${id} failed (harness exit ${r.status}):\n${failed.join('\n')}`);
  assert.equal(r.status, 0, `route-isolation.sh exit status ${r.status}`);
}

for (const id of Object.keys(TITLES)) {
  test(`${id} ${TITLES[id]} (Docker)`, () => checkCase(id));
}
