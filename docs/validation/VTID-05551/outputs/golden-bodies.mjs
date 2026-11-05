// VTID-05551 evidence — how the expected bodies (GOLDEN_*) of
// scripts/ci/staging-verify/record-oasis-workflow.test.mjs were produced.
//
// Runs a given record-oasis.sh (the base copy from origin/main 0ca24febdb, extracted with `git show`) with a fake
// curl first on PATH, for the same four fixtures the test uses, and prints each body the script would send as a
// JS string literal. The test's red-on-base run (outputs/red-on-base-record-oasis.txt) proves that these fixtures
// and bodies are the ones the test uses: against the base script, every "without WORKFLOW" case passes.
//
// Usage: git show 0ca24febdb:scripts/ci/staging-verify/record-oasis.sh > /tmp/record-oasis.base.sh
//        node docs/validation/VTID-05551/outputs/golden-bodies.mjs /tmp/record-oasis.base.sh
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = process.argv[2];
if (!SCRIPT || !fs.existsSync(SCRIPT)) {
  console.error('usage: golden-bodies.mjs <path to record-oasis.sh>');
  process.exit(2);
}

// ── Fixtures: identical to the test file ────────────────────────────────
const SHA = '1d2c3b4a59687766554433221100ffeeddccbbaa';
const RUN_URL = 'https://github.com/exafyltd/vitana-platform/actions/runs/19000000001';

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

const CASES = [
  { key: 'PASSED', results: PASSED },
  { key: 'FAILED', results: FAILED },
  { key: 'SUPERSEDED', results: SUPERSEDED },
  { key: 'CRASHED', results: null },
];

const FAKE_CURL = `#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in @*) cp "\${a#@}" "$FAKE_CURL_OUT/body" ;; esac
done
exit 0
`;

for (const c of CASES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-oasis-golden-'));
  const bin = path.join(dir, 'bin');
  const out = path.join(dir, 'out');
  fs.mkdirSync(bin);
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(bin, 'curl'), FAKE_CURL, { mode: 0o755 });
  const resultsFile = path.join(dir, 'results.json');
  if (c.results) fs.writeFileSync(resultsFile, JSON.stringify(c.results, null, 2));
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_CURL_OUT: out,
      RUNNER_TEMP: dir,
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SVC: 'test-service-key',
      RESULTS: resultsFile,
      RUN_URL,
      SERVICE: 'gateway',
      SHA,
    },
  });
  if (r.status !== 0) {
    console.error(`${c.key}: exit ${r.status}\n${r.stdout}${r.stderr}`);
    process.exit(1);
  }
  const body = fs.readFileSync(path.join(out, 'body'), 'utf8');
  console.log(`const GOLDEN_${c.key} = ${JSON.stringify(body)};`);
  console.log(`// ${c.key}: ${Buffer.byteLength(body)} bytes, stdout ${JSON.stringify(r.stdout)}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
