'use strict';
// VTID-05128 — STAGING-VERIFY's "Record result in OASIS" step (record-oasis.sh).
// Run: node --test scripts/ci/staging-verify/record-oasis.test.cjs (UNIT.yml runs it on every PR)
//
// A full run (~1,060 results) used to fail with "Argument list too long": the
// event body was passed to curl as one argv argument, over Linux's 128 KiB
// per-argument limit. The script now sends the body from a file. These tests
// run the real script against a stub curl that records its argv and payload.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'record-oasis.sh');
const WORKFLOW = path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'STAGING-VERIFY.yml');
const MAX_ARG = 128 * 1024;

const STUB_CURL = `#!/usr/bin/env bash
# records argv length and the @file payload
max=0
for a in "$@"; do
  [ \${#a} -gt $max ] && max=\${#a}
  case "$a" in @*) cp "\${a#@}" "$STUB_OUT/payload.json" ;; esac
done
echo "$max" > "$STUB_OUT/max_arg"
printf '%s\\n' "$@" > "$STUB_OUT/argv"
exit "\${STUB_CURL_EXIT:-0}"
`;

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-oasis-'));
  const bin = path.join(dir, 'bin');
  const out = path.join(dir, 'out');
  fs.mkdirSync(bin);
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(bin, 'curl'), STUB_CURL, { mode: 0o755 });
  return { dir, bin, out };
}

function run(h, env) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${h.bin}:${process.env.PATH}`,
      STUB_OUT: h.out,
      RUNNER_TEMP: h.dir,
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SVC: 'test-key',
      RUN_URL: 'https://github.com/exafyltd/vitana-platform/actions/runs/1',
      SERVICE: 'gateway',
      SHA: 'abcdef0123456789abcdef0123456789abcdef01',
      ...env,
    },
  });
}

function writeResults(h, { n, outcome = 'failed', full = true }) {
  const results = Array.from({ length: n }, (_, i) => ({
    suite: `VTID-0${4000 + (i % 90)}`,
    name: `test ${i} — a realistic name describing what the check proves on staging`,
    ok: i % 500 !== 0,
    problems: i % 500 === 0 ? ['fetch failed'] : [],
    extra: 'not copied into the event',
  }));
  const file = path.join(h.dir, 'results.json');
  fs.writeFileSync(file, JSON.stringify({
    vtid: 'VTID-04613', outcome, service: 'gateway', sha: 'abcdef0123456789abcdef0123456789abcdef01',
    message: `**Staging verification ${outcome}**`, vtids: ['VTID-05099'], production_stamp: '98ebdab1',
    results, plan: { missing: [], invalid: [] }, shipping: [], full,
  }));
  return file;
}

test('a full run (1,100 results, body over 128 KiB) is recorded from a file, not argv', () => {
  const h = harness();
  const RESULTS = writeResults(h, { n: 1100 });
  const r = run(h, { RESULTS });
  assert.equal(r.status, 0, r.stderr);
  const payloadText = fs.readFileSync(path.join(h.out, 'payload.json'), 'utf8');
  assert.ok(payloadText.length > MAX_ARG, `body should exceed 128 KiB, was ${payloadText.length}`);
  assert.ok(Number(fs.readFileSync(path.join(h.out, 'max_arg'), 'utf8')) < 4096, 'no large argv argument');
  assert.ok(fs.readFileSync(path.join(h.out, 'argv'), 'utf8').includes('--data-binary'));
  const body = JSON.parse(payloadText);
  assert.equal(body.topic, 'staging.verify.failed');
  assert.equal(body.status, 'error');
  assert.equal(body.metadata.full, true);
  assert.equal(body.metadata.results.length, 1100);
  assert.deepEqual(Object.keys(body.metadata.results[0]).sort(), ['name', 'ok', 'problems', 'suite']);
  assert.equal(body.metadata.run_url, 'https://github.com/exafyltd/vitana-platform/actions/runs/1');
  assert.equal(body.metadata.workflow, 'STAGING-VERIFY.yml');
  assert.match(r.stdout, /recorded staging\.verify\.failed for gateway @ abcdef012345/);
});

test('a passed run is recorded as passed / success', () => {
  const h = harness();
  const RESULTS = writeResults(h, { n: 20, outcome: 'passed', full: false });
  const r = run(h, { RESULTS });
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(fs.readFileSync(path.join(h.out, 'payload.json'), 'utf8'));
  assert.equal(body.topic, 'staging.verify.passed');
  assert.equal(body.status, 'success');
  assert.equal(body.metadata.full, false);
  assert.equal(body.vtid, 'VTID-04613');
});

// VTID-05144: a full run superseded by a mid-run redeploy carries where staging
// moved to, the attribution cutoff, the re-dispatch chain and per-result attribution.
test('VTID-05144: superseded_by, attribution_cutoff, chain and per-result attributed reach the body', () => {
  const h = harness();
  const file = path.join(h.dir, 'results.json');
  fs.writeFileSync(file, JSON.stringify({
    vtid: 'VTID-05144', outcome: 'superseded', service: 'gateway', sha: 'abcdef0123456789abcdef0123456789abcdef01',
    message: '**Staging verification superseded**', vtids: [], production_stamp: '98ebdab1',
    superseded_by: '1234567890abcdef1234567890abcdef12345678', attribution_cutoff: '2026-10-13T07:17:30.000Z', chain: 2,
    results: [
      { suite: 'smoke', name: 'alive', ok: true, problems: [], attributed: true, started_at: 'x', ended_at: 'y' },
      { suite: 'VTID-04999', name: 'late', ok: false, problems: ['fetch failed'], attributed: false },
    ],
    plan: { missing: [], invalid: [] }, shipping: [], full: true,
  }));
  const r = run(h, { RESULTS: file });
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(fs.readFileSync(path.join(h.out, 'payload.json'), 'utf8'));
  assert.equal(body.topic, 'staging.verify.superseded');
  assert.equal(body.status, 'info');
  assert.equal(body.metadata.superseded_by, '1234567890abcdef1234567890abcdef12345678');
  assert.equal(body.metadata.attribution_cutoff, '2026-10-13T07:17:30.000Z');
  assert.equal(body.metadata.chain, 2);
  assert.deepEqual(body.metadata.results.map((x) => x.attributed), [true, false]);
  assert.deepEqual(Object.keys(body.metadata.results[1]).sort(), ['attributed', 'name', 'ok', 'problems', 'suite']);
});

test('VTID-05144: a run without the new fields records null/0 and no attributed key', () => {
  const h = harness();
  const r = run(h, { RESULTS: writeResults(h, { n: 3, outcome: 'passed', full: false }) });
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(fs.readFileSync(path.join(h.out, 'payload.json'), 'utf8'));
  assert.equal(body.metadata.superseded_by, null);
  assert.equal(body.metadata.attribution_cutoff, null);
  assert.equal(body.metadata.chain, 0);
  assert.equal('attributed' in body.metadata.results[0], false);
});

test('runner crashed (no results.json) → recorded as a failed, crashed verification', () => {
  const h = harness();
  const r = run(h, { RESULTS: path.join(h.dir, 'missing.json') });
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(fs.readFileSync(path.join(h.out, 'payload.json'), 'utf8'));
  assert.equal(body.topic, 'staging.verify.failed');
  assert.equal(body.vtid, 'BOOTSTRAP-STAGING-VERIFY');
  assert.equal(body.metadata.crashed, true);
  assert.equal(body.metadata.commit, 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(body.service, 'staging-verify-gateway');
});

test('missing Supabase credentials fail loudly before anything is sent', () => {
  const h = harness();
  const r = run(h, { RESULTS: writeResults(h, { n: 5 }), SUPABASE_SVC: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /SUPABASE_URL \/ SUPABASE_SERVICE_ROLE not set/);
  assert.equal(fs.existsSync(path.join(h.out, 'payload.json')), false);
});

test('a failed POST fails the step (no silent success)', () => {
  const h = harness();
  const r = run(h, { RESULTS: writeResults(h, { n: 5 }), STUB_CURL_EXIT: '22' });
  assert.equal(r.status, 22);
  assert.doesNotMatch(r.stdout, /recorded/);
});

test('the body file is removed after the step', () => {
  const h = harness();
  run(h, { RESULTS: writeResults(h, { n: 5 }) });
  assert.deepEqual(fs.readdirSync(h.dir).filter((f) => f.startsWith('oasis-event.')), []);
});

test('the workflow step calls the script and never passes the body as an argument', () => {
  const wf = fs.readFileSync(WORKFLOW, 'utf8');
  const step = wf.slice(wf.indexOf('- name: Record result in OASIS'), wf.indexOf('- name: Keep the evidence'));
  assert.match(step, /run: bash runner\/scripts\/ci\/staging-verify\/record-oasis\.sh/);
  assert.doesNotMatch(wf, /-d "\$BODY"/);
  assert.match(wf, /sparse-checkout: scripts\/ci\/staging-verify/, 'the runner checkout must still include the script');
});
