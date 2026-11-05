// VTID-05551 (agentic-delivery/prerequisites) — record-oasis.sh takes WORKFLOW (plan agentic-delivery §3.6 step 4).
// Run: node --test scripts/ci/staging-verify/record-oasis-workflow.test.mjs
// (UNIT.yml runs it on every PR: Node 20, no install.)
//
// Every STAGING-VERIFY row in OASIS says which host verified it (metadata.workflow). GitHub's STAGING-VERIFY.yml
// sets no WORKFLOW, so its rows must stay byte for byte what they are today; the GitLab `.record` job passes
// gitlab:<project>/staging-verify. The GOLDEN_* bodies below are the exact bytes that the script on origin/main
// 0ca24febdb (before this change) sent for these fixtures. They were recorded once with
// docs/validation/VTID-05551/outputs/golden-bodies.mjs and are the same with jq 1.7.1 (the CI runner's) and jq 1.8.1.
// A change that alters the GitHub body on purpose updates these bytes in the same PR and says so.
// Each test runs the real script with a fake curl first on PATH that saves the body file it is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'record-oasis.sh');
const STAGING_VERIFY_YML = path.join(HERE, '..', '..', '..', '.github', 'workflows', 'STAGING-VERIFY.yml');
const GITLAB_WORKFLOW = 'gitlab:vitana/vitana-v1/staging-verify';
const DEFAULT_FIELD = '"workflow":"STAGING-VERIFY.yml"';
const SERVICE_KEY = 'test-service-key';

// ── Fixtures (the same objects as outputs/golden-bodies.mjs) ─────────────
const SHA = '1d2c3b4a59687766554433221100ffeeddccbbaa';
const RUN_URL = 'https://github.com/exafyltd/vitana-platform/actions/runs/19000000001';

// The results.json shape run.mjs writes today.
const PASSED = {
  service: 'gateway',
  sha: SHA,
  outcome: 'passed',
  vtid: 'VTID-05551',
  vtids: ['VTID-05551'],
  staging_stamp: '1d2c3b4a5968',
  production_stamp: '0ca24febdb16',
  run_url: RUN_URL,
  full: false,
  superseded_by: null,
  attribution_cutoff: null,
  chain: 0,
  results: [
    { suite: 'smoke', name: 'gateway alive', kind: 'http', ok: true, problems: [], ms: 38, started_at: '2026-11-05T03:00:00.000Z', ended_at: '2026-11-05T03:00:00.038Z' },
    { suite: 'VTID-05551', name: 'atlas claims', kind: 'existing', ok: true, problems: [], ms: 5100, started_at: '2026-11-05T03:00:01.000Z', ended_at: '2026-11-05T03:00:06.100Z' },
  ],
  plan: { suites: ['VTID-05551'], missing: [], invalid: [], legacy_count: 0, lockfile_only: [] },
  shipping: [{ sha: SHA, subject: 'VTID-05551 (agentic-delivery/prerequisites): atlas claims', author: 'kiro-agent[bot]', date: '2026-11-05T02:55:00Z', branch_commits: 0 }],
  message: '**Staging verified** gateway at 1d2c3b4a5968: 2 of 2 passed.',
};

// An older results.json shape: no full, superseded_by, attribution_cutoff or chain, and no VTID in the head subject.
const FAILED = {
  service: 'gateway',
  sha: SHA,
  outcome: 'failed',
  vtid: null,
  vtids: ['VTID-05537', 'VTID-05551'],
  production_stamp: '0ca24febdb16',
  results: [
    { suite: 'smoke', name: 'gateway alive', ok: true, problems: [] },
    { suite: 'VTID-05537', name: 'gitlab client suite', ok: false, problems: ['exit 1: 1 failed'] },
  ],
  plan: {
    missing: [{ sha: 'b0b1b2b3b4b5b6b7b8b9c0c1c2c3c4c5c6c7c8c9', subject: 'chore: a commit with no VTID', vtid: null }],
    invalid: [{ vtid: 'VTID-05550', errors: ['tests must be a non-empty array'] }],
  },
  shipping: [],
  message: '**Staging verification failed** for gateway: 1 failed, 1 suite missing, 1 invalid.',
};

const SUPERSEDED = {
  service: 'gateway',
  sha: SHA,
  outcome: 'superseded',
  vtid: 'VTID-05551',
  vtids: ['VTID-05551'],
  production_stamp: '0ca24febdb16',
  full: true,
  superseded_by: 'aa00bb11cc22dd33ee44ff5566778899aabbccdd',
  attribution_cutoff: '2026-11-05T03:10:00.000Z',
  chain: 1,
  results: [
    { suite: 'smoke', name: 'gateway alive', ok: true, problems: [], attributed: true },
    { suite: 'VTID-05551', name: 'late result', ok: false, problems: ['fetch failed'], attributed: false },
  ],
  plan: { missing: [], invalid: [] },
  shipping: [],
  message: '**Staging verification superseded** for gateway: staging moved to aa00bb11cc22.',
};

// ── Today's bodies (recorded from the base script, see the header) ───────
const GOLDEN_PASSED =
  '{"vtid":"VTID-05551","topic":"staging.verify.passed","service":"staging-verify-gateway","role":"CICD","model":"staging-verify","status":"success","message":"**Staging verified** gateway at 1d2c3b4a5968: 2 of 2 passed.","metadata":{"env":"staging","service":"gateway","commit":"1d2c3b4a59687766554433221100ffeeddccbbaa","outcome":"passed","vtids":["VTID-05551"],"run_url":"https://github.com/exafyltd/vitana-platform/actions/runs/19000000001","production_commit":"0ca24febdb16","results":[{"suite":"smoke","name":"gateway alive","ok":true,"problems":[]},{"suite":"VTID-05551","name":"atlas claims","ok":true,"problems":[]}],"missing_suites":[],"invalid_suites":[],"shipping":[{"sha":"1d2c3b4a59687766554433221100ffeeddccbbaa","subject":"VTID-05551 (agentic-delivery/prerequisites): atlas claims","author":"kiro-agent[bot]","date":"2026-11-05T02:55:00Z","branch_commits":0}],"full":false,"workflow":"STAGING-VERIFY.yml","superseded_by":null,"attribution_cutoff":null,"chain":0}}\n';
const GOLDEN_FAILED =
  '{"vtid":"BOOTSTRAP-STAGING-VERIFY","topic":"staging.verify.failed","service":"staging-verify-gateway","role":"CICD","model":"staging-verify","status":"error","message":"**Staging verification failed** for gateway: 1 failed, 1 suite missing, 1 invalid.","metadata":{"env":"staging","service":"gateway","commit":"1d2c3b4a59687766554433221100ffeeddccbbaa","outcome":"failed","vtids":["VTID-05537","VTID-05551"],"run_url":"https://github.com/exafyltd/vitana-platform/actions/runs/19000000001","production_commit":"0ca24febdb16","results":[{"suite":"smoke","name":"gateway alive","ok":true,"problems":[]},{"suite":"VTID-05537","name":"gitlab client suite","ok":false,"problems":["exit 1: 1 failed"]}],"missing_suites":[{"sha":"b0b1b2b3b4b5b6b7b8b9c0c1c2c3c4c5c6c7c8c9","subject":"chore: a commit with no VTID","vtid":null}],"invalid_suites":[{"vtid":"VTID-05550","errors":["tests must be a non-empty array"]}],"shipping":[],"full":false,"workflow":"STAGING-VERIFY.yml","superseded_by":null,"attribution_cutoff":null,"chain":0}}\n';
const GOLDEN_SUPERSEDED =
  '{"vtid":"VTID-05551","topic":"staging.verify.superseded","service":"staging-verify-gateway","role":"CICD","model":"staging-verify","status":"info","message":"**Staging verification superseded** for gateway: staging moved to aa00bb11cc22.","metadata":{"env":"staging","service":"gateway","commit":"1d2c3b4a59687766554433221100ffeeddccbbaa","outcome":"superseded","vtids":["VTID-05551"],"run_url":"https://github.com/exafyltd/vitana-platform/actions/runs/19000000001","production_commit":"0ca24febdb16","results":[{"suite":"smoke","name":"gateway alive","ok":true,"problems":[],"attributed":true},{"suite":"VTID-05551","name":"late result","ok":false,"problems":["fetch failed"],"attributed":false}],"missing_suites":[],"invalid_suites":[],"shipping":[],"full":true,"workflow":"STAGING-VERIFY.yml","superseded_by":"aa00bb11cc22dd33ee44ff5566778899aabbccdd","attribution_cutoff":"2026-11-05T03:10:00.000Z","chain":1}}\n';
const GOLDEN_CRASHED =
  '{"vtid":"BOOTSTRAP-STAGING-VERIFY","topic":"staging.verify.failed","service":"staging-verify-gateway","role":"CICD","model":"staging-verify","status":"error","message":"**Staging verification FAILED — the runner crashed before producing a result.** Not ready for production. Run: https://github.com/exafyltd/vitana-platform/actions/runs/19000000001","metadata":{"env":"staging","service":"gateway","commit":"1d2c3b4a59687766554433221100ffeeddccbbaa","outcome":"failed","run_url":"https://github.com/exafyltd/vitana-platform/actions/runs/19000000001","crashed":true,"workflow":"STAGING-VERIFY.yml"}}\n';

const CASES = [
  { name: 'a passed run', results: PASSED, golden: GOLDEN_PASSED },
  { name: 'a failed run in the older results.json shape', results: FAILED, golden: GOLDEN_FAILED },
  { name: 'a superseded full run with attribution', results: SUPERSEDED, golden: GOLDEN_SUPERSEDED },
  { name: 'the crashed runner (no results.json)', results: null, golden: GOLDEN_CRASHED },
];

// A fake curl, first on PATH: saves the file it is sent with --data-binary @file, byte for byte.
const FAKE_CURL = `#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in @*) cp "\${a#@}" "$FAKE_CURL_OUT/body" ;; esac
done
exit 0
`;

/** Runs record-oasis.sh in a scratch directory; `workflow` undefined = WORKFLOW not in the environment at all. */
function runScript(results, workflow) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-oasis-workflow-'));
  try {
    const bin = path.join(dir, 'bin');
    const out = path.join(dir, 'out');
    fs.mkdirSync(bin);
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(bin, 'curl'), FAKE_CURL, { mode: 0o755 });
    const resultsFile = path.join(dir, 'results.json');
    if (results) fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
    // An explicit environment: nothing (WORKFLOW included) leaks in from the machine running the test.
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_CURL_OUT: out,
      RUNNER_TEMP: dir,
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SVC: SERVICE_KEY,
      RESULTS: resultsFile,
      RUN_URL,
      SERVICE: 'gateway',
      SHA,
    };
    if (workflow !== undefined) env.WORKFLOW = workflow;
    const r = spawnSync('bash', [SCRIPT], { cwd: dir, encoding: 'utf8', env });
    const bodyFile = path.join(out, 'body');
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      body: fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile) : null,
      entries: fs.readdirSync(dir).sort(),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The body is exactly these bytes: a readable diff first, then the byte comparison. */
function assertBytes(body, expected, label) {
  assert.ok(Buffer.isBuffer(body), `${label}: the fake curl received no body`);
  assert.equal(body.toString('utf8'), expected, label);
  assert.ok(body.equals(Buffer.from(expected, 'utf8')), `${label}: the bytes differ`);
}

const withWorkflow = (golden, value) => golden.replace(DEFAULT_FIELD, `"workflow":${JSON.stringify(value)}`);

test('each recorded body names the GitHub workflow exactly once', () => {
  for (const c of CASES) assert.equal(c.golden.split(DEFAULT_FIELD).length - 1, 1, c.name);
});

for (const c of CASES) {
  test(`${c.name}: without WORKFLOW the body is byte-identical to today's`, () => {
    const r = runScript(c.results, undefined);
    assert.equal(r.status, 0, r.stderr);
    assertBytes(r.body, c.golden, c.name);
    assert.equal(JSON.parse(r.body.toString('utf8')).metadata.workflow, 'STAGING-VERIFY.yml');
  });

  test(`${c.name}: an empty WORKFLOW behaves as unset`, () => {
    const r = runScript(c.results, '');
    assert.equal(r.status, 0, r.stderr);
    assertBytes(r.body, c.golden, c.name);
  });

  test(`${c.name}: with WORKFLOW=${GITLAB_WORKFLOW} the body differs only in metadata.workflow`, () => {
    const unset = runScript(c.results, undefined);
    const r = runScript(c.results, GITLAB_WORKFLOW);
    assert.equal(r.status, 0, r.stderr);
    assertBytes(r.body, withWorkflow(c.golden, GITLAB_WORKFLOW), c.name);
    const got = JSON.parse(r.body.toString('utf8'));
    const today = JSON.parse(c.golden);
    assert.equal(got.metadata.workflow, GITLAB_WORKFLOW);
    delete got.metadata.workflow;
    delete today.metadata.workflow;
    assert.deepEqual(got, today);
    // Same exit status and log line as without WORKFLOW.
    assert.equal(r.stdout, unset.stdout);
  });
}

test('WORKFLOW reaches jq as data, never as program or shell text', () => {
  const values = [
    'gitlab:\\(env.SUPABASE_SVC)', // jq string interpolation if the value were spliced into the program
    'gitlab:x", "vtid": "VTID-00000', // a quote that would end a jq string literal
    'gitlab:$(touch pwned) `touch pwned` ${SHA}', // shell syntax, never expanded
  ];
  for (const v of values) {
    const r = runScript(PASSED, v);
    assert.equal(r.status, 0, `${v}: ${r.stderr}`);
    assertBytes(r.body, withWorkflow(GOLDEN_PASSED, v), v);
    assert.equal(JSON.parse(r.body.toString('utf8')).metadata.workflow, v);
    assert.equal(r.body.toString('utf8').includes(SERVICE_KEY), false, `${v}: the service key reached the body`);
    assert.equal(r.entries.includes('pwned'), false, `${v}: a shell command ran`);
  }
});

test('GitHub STAGING-VERIFY.yml sets no WORKFLOW, so its rows keep the default', () => {
  const wf = fs.readFileSync(STAGING_VERIFY_YML, 'utf8');
  assert.doesNotMatch(wf, /\bWORKFLOW\b/, 'STAGING-VERIFY.yml must not set WORKFLOW: GitHub rows stay byte-identical');
  assert.match(wf, /run: bash runner\/scripts\/ci\/staging-verify\/record-oasis\.sh/);
});
