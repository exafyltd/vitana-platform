// VTID-05552 (agentic-delivery/verify-on-gitlab) — the `.record` job's environment (plan agentic-delivery §3.6 step 4).
// Run: node --test scripts/eng/verify/record-env.test.mjs (UNIT.yml runs it on every PR: Node 20, no install).
//
// GitHub's STAGING-VERIFY.yml runs scripts/ci/staging-verify/record-oasis.sh with SUPABASE_URL, SUPABASE_SVC, RESULTS,
// RUN_URL, SERVICE and SHA. On GitLab the `.record` job maps its variables, the `vitana/ci/oasis-recorder` secret and the
// `.staging-verify` artifact to the same inputs, plus WORKFLOW = gitlab:<project>/staging-verify (the input lane
// prerequisites adds, VTID-05551). The integration tests run the real, unchanged record-oasis.sh with a fake curl first
// on PATH and compare the body it sends from both environments for the same results.json: only metadata.workflow may
// differ. Until lane prerequisites (#4690) is on main, record-oasis.sh ignores WORKFLOW, so those cases are red.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORD_SCRIPT = join(HERE, '..', '..', 'ci', 'staging-verify', 'record-oasis.sh');
const WRAPPER = join(HERE, 'record-env.mjs');
const load = () => import(pathToFileURL(WRAPPER).href);

const SHA = '1d2c3b4a59687766554433221100ffeeddccbbaa';
const PIPELINE_URL = 'https://gitlab.vitanaland.com/vitana/vitana-v1/-/pipelines/4711';
const SECRET = { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE: 'test-service-key' };
const CI = {
  CI_PROJECT_PATH: 'vitana/vitana-v1',
  CI_PIPELINE_URL: PIPELINE_URL,
  CI_COMMIT_SHA: SHA,
  VERIFY_SERVICE: 'community-app',
};

const PASSED = {
  service: 'community-app', sha: SHA, outcome: 'passed', vtid: 'VTID-05552', vtids: ['VTID-05552'],
  staging_stamp: '1d2c3b4a5968', production_stamp: '0ca24febdb16', run_url: null, full: false,
  superseded_by: null, attribution_cutoff: null, chain: 0,
  results: [{ suite: 'smoke', name: 'app shell loads with a version stamp', kind: 'http', ok: true, problems: [], ms: 41, started_at: '2026-11-05T12:00:00.000Z', ended_at: '2026-11-05T12:00:00.041Z' }],
  plan: { suites: [], missing: [], invalid: [], legacy_count: 0, lockfile_only: [] },
  shipping: [{ sha: SHA, subject: 'VTID-05552 (agentic-delivery/verify-on-gitlab): x', author: 'kiro-agent[bot]', date: '2026-11-05T11:55:00Z', branch_commits: 0 }],
  message: '**Staging verified** community-app at 1d2c3b4a5968: 1 of 1 passed.',
};
const SUPERSEDED = {
  ...PASSED, outcome: 'superseded', full: true, superseded_by: 'aa00bb11cc22dd33ee44ff5566778899aabbccdd',
  attribution_cutoff: '2026-11-05T12:10:00.000Z', chain: 1,
  results: [
    { suite: 'smoke', name: 'app shell loads with a version stamp', ok: true, problems: [], attributed: true },
    { suite: 'VTID-05552', name: 'late result', ok: false, problems: ['fetch failed'], attributed: false },
  ],
  message: '**Staging verification superseded** for community-app.',
};

test('GitLab variables and the oasis-recorder secret map to every input of record-oasis.sh', async () => {
  const m = await load();
  const out = '/builds/vitana/vitana-v1/staging-verify-out/community-app';
  assert.deepEqual(m.recordEnv({ ci: CI, secret: SECRET, outDir: out, target: { service: 'community-app', sha: SHA } }), {
    SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SVC: 'test-service-key',
    RESULTS: `${out}/results.json`,
    RUN_URL: PIPELINE_URL,
    SERVICE: 'community-app',
    SHA,
    WORKFLOW: 'gitlab:vitana/vitana-v1/staging-verify',
  });
});

test('WORKFLOW names the GitLab project of the job; DATA_REST_URL overrides the secret URL as on GitHub', async () => {
  const m = await load();
  assert.equal(m.gitlabWorkflow('vitana/vitana-platform'), 'gitlab:vitana/vitana-platform/staging-verify');
  const env = m.recordEnv({ ci: { ...CI, CI_PROJECT_PATH: 'vitana/vitana-platform', DATA_REST_URL: 'https://data.example.invalid', VERIFY_SERVICE: 'gateway' }, secret: SECRET, outDir: '/o', target: null });
  assert.equal(env.WORKFLOW, 'gitlab:vitana/vitana-platform/staging-verify');
  assert.equal(env.SUPABASE_URL, 'https://data.example.invalid');
  assert.equal(env.SERVICE, 'gateway');
  assert.equal(env.SHA, SHA, 'without target.json the commit is the pipeline commit');
});

test('the commit and service the verify job wrote in target.json win over the pipeline commit (the nightly run)', async () => {
  const m = await load();
  const env = m.recordEnv({ ci: CI, secret: SECRET, outDir: '/o', target: { service: 'community-app', sha: 'b'.repeat(40) } });
  assert.equal(env.SHA, 'b'.repeat(40));
});

test('without the secret the Supabase inputs are empty, so record-oasis.sh itself refuses (job red)', async () => {
  const m = await load();
  const env = m.recordEnv({ ci: CI, secret: null, outDir: '/o', target: null });
  assert.equal(env.SUPABASE_URL, '');
  assert.equal(env.SUPABASE_SVC, '');
});

// ── record-oasis.sh end to end: GitHub's environment vs the mapped GitLab environment ─────────────────────────────
const FAKE_CURL = `#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in @*) cp "\${a#@}" "$FAKE_CURL_OUT/body" ;; esac
done
echo called >> "$FAKE_CURL_OUT/calls"
exit 0
`;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'record-env-'));
  const bin = join(dir, 'bin');
  const out = join(dir, 'curl-out');
  mkdirSync(bin);
  mkdirSync(out);
  writeFileSync(join(bin, 'curl'), FAKE_CURL, { mode: 0o755 });
  return { dir, bin, out };
}
const bodyOf = (s) => (existsSync(join(s.out, 'body')) ? JSON.parse(readFileSync(join(s.out, 'body'), 'utf8')) : null);
const curlCalls = (s) => (existsSync(join(s.out, 'calls')) ? readFileSync(join(s.out, 'calls'), 'utf8').trim().split('\n').length : 0);

/** record-oasis.sh with the environment STAGING-VERIFY.yml gives it (no WORKFLOW). */
function githubRecord(results) {
  const s = scratch();
  try {
    const verifyOut = join(s.dir, 'staging-verify');
    mkdirSync(verifyOut);
    if (results) writeFileSync(join(verifyOut, 'results.json'), JSON.stringify(results, null, 2));
    const r = spawnSync('bash', [RECORD_SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: `${s.bin}:${process.env.PATH}`, FAKE_CURL_OUT: s.out, RUNNER_TEMP: s.dir,
        SUPABASE_URL: SECRET.SUPABASE_URL, SUPABASE_SVC: SECRET.SUPABASE_SERVICE_ROLE,
        RESULTS: join(verifyOut, 'results.json'), RUN_URL: PIPELINE_URL, SERVICE: 'community-app', SHA,
      },
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}`, body: bodyOf(s) };
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
}

/** `record-env.mjs run` as the `.record` job runs it: GitLab variables, the secret file, the verify job's artifact. */
function gitlabRecord(results, opts = {}) {
  // `mode: undefined` means DELIVERY_MODE is not set at all (a destructuring default would turn it into 'live').
  const mode = 'mode' in opts ? opts.mode : 'live';
  const secret = 'secret' in opts ? opts.secret : SECRET;
  const target = 'target' in opts ? opts.target : { service: 'community-app', sha: SHA };
  const s = scratch();
  try {
    const verifyOut = join(s.dir, 'staging-verify-out', 'community-app');
    mkdirSync(verifyOut, { recursive: true });
    if (results) writeFileSync(join(verifyOut, 'results.json'), JSON.stringify(results, null, 2));
    if (target) writeFileSync(join(verifyOut, 'target.json'), JSON.stringify(target));
    const secretFile = join(s.dir, 'oasis-recorder.json');
    if (secret) writeFileSync(secretFile, JSON.stringify(secret));
    const r = spawnSync(process.execPath, [WRAPPER, 'run', '--record-script', RECORD_SCRIPT, '--out', verifyOut, '--secret-file', secretFile], {
      encoding: 'utf8',
      env: {
        PATH: `${s.bin}:${process.env.PATH}`, FAKE_CURL_OUT: s.out, RUNNER_TEMP: s.dir,
        ...CI, ...(mode === undefined ? {} : { DELIVERY_MODE: mode }),
      },
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}`, body: bodyOf(s), calls: curlCalls(s), results: existsSync(join(verifyOut, 'results.json')) };
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
}

for (const [name, results] of [['a passed run', PASSED], ['a superseded full run with attribution', SUPERSEDED], ['the crashed runner (target.json, no results.json)', null]]) {
  test(`integration, ${name}: the same body as on GitHub except metadata.workflow, which names the GitLab job`, () => {
    const gh = githubRecord(results);
    const gl = gitlabRecord(results);
    assert.equal(gh.status, 0, gh.output);
    assert.equal(gl.status, 0, gl.output);
    assert.ok(gh.body && gl.body, 'both runs sent a body');
    assert.equal(gh.body.metadata.workflow, 'STAGING-VERIFY.yml');
    assert.equal(gl.body.metadata.workflow, 'gitlab:vitana/vitana-v1/staging-verify', 'the GitLab row names its job (needs record-oasis.sh WORKFLOW, lane prerequisites #4690)');
    const a = structuredClone(gh.body);
    const b = structuredClone(gl.body);
    delete a.metadata.workflow;
    delete b.metadata.workflow;
    assert.deepEqual(b, a, 'every other field is the same');
  });
}

test('the fields the PUBLISH gate filters on (topic, metadata.service, metadata.commit) are the same on both hosts', () => {
  const gh = githubRecord(PASSED);
  const gl = gitlabRecord(PASSED);
  for (const k of ['topic', 'vtid', 'service', 'status']) assert.equal(gl.body[k], gh.body[k], k);
  for (const k of ['service', 'commit', 'outcome', 'env']) assert.equal(gl.body.metadata[k], gh.body.metadata[k], `metadata.${k}`);
  assert.equal(gl.body.topic, 'staging.verify.passed');
});

test('record without its secret: the job is red, nothing is sent, the result stays in the artifact', () => {
  const gl = gitlabRecord(PASSED, { secret: null });
  assert.notEqual(gl.status, 0, gl.output);
  assert.match(gl.output, /SUPABASE_URL \/ SUPABASE_SERVICE_ROLE not set/);
  assert.equal(gl.calls, 0);
  assert.equal(gl.results, true, 'results.json is untouched');
});

test('shadow mode, or DELIVERY_MODE unset: nothing is recorded (GitHub stays the only writer of verification rows)', () => {
  for (const mode of ['shadow', '', undefined]) {
    const gl = gitlabRecord(PASSED, { mode });
    assert.notEqual(gl.status, 0, `DELIVERY_MODE=${mode}: refused`);
    assert.match(gl.output, /shadow/i);
    assert.equal(gl.calls, 0, `DELIVERY_MODE=${mode}: no curl call`);
  }
});

test('the verify job never started (no target.json, no results.json): nothing is recorded and the log says why', () => {
  const gl = gitlabRecord(null, { target: null });
  assert.equal(gl.status, 0, gl.output);
  assert.match(gl.output, /target\.json/);
  assert.equal(gl.calls, 0);
});
