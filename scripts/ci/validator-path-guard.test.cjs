'use strict';

// VTID-05305 — node --test unit tests for the PR-body-declaration check added
// to validator-path-guard.cjs.
//
// Red on base: `prBodyRequirements` and the `--pr-body-check` CLI did not exist
// before this lane, so these tests cannot pass against origin/main. Green on
// head once the clear, all-at-once message replaces the bare `exit 11`.
//
// The existing jest suite for this module lives at
// services/gateway/test/scripts/validator-path-guard.test.ts and covers the
// path-ownership / CSP / route-evidence behaviour. These node:test cases cover
// only the new PR-body behaviour and run under UNIT.yml, which executes every
// scripts/**/*.test.{cjs,mjs} with `node --test`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const guard = require('./validator-path-guard.cjs');

const GUARD_PATH = join(__dirname, 'validator-path-guard.cjs');

// A PR body that uses the shipped template — every required declaration present.
const COMPLETE_BODY = [
  '## Summary',
  'A change.',
  '',
  'VALIDATION_PROFILE: gateway_backend',
  'SCOPE_ALLOWLIST: services/gateway/src/**',
  'ACCEPTANCE: docs/validation/VTID-05305/acceptance.md',
  'MERGE_PAYLOAD_PREVIEW: none (CI-only change)',
  'OASIS_IMPACT: no',
].join('\n');

test('a complete PR body (from the template) passes with code 0', () => {
  const r = guard.prBodyRequirements(COMPLETE_BODY);
  assert.equal(r.code, 0);
  assert.deepEqual(r.missing, []);
});

test('a missing profile fails with the historic exit 11, not a bare message', () => {
  const body = COMPLETE_BODY.replace(/VALIDATION_PROFILE:.*\n/, '');
  const r = guard.prBodyRequirements(body);
  assert.equal(r.code, 11);
  assert.deepEqual(r.missing, ['VALIDATION_PROFILE']);
  const joined = r.messages.join('\n');
  // The actionable part the old bare `exit 11` never had: it names the known
  // profiles and the exact line to add.
  assert.match(joined, /VALIDATION_PROFILE/);
  assert.match(joined, /gateway_backend/);
});

test('an empty body reports ALL five missing declarations at once', () => {
  const r = guard.prBodyRequirements('');
  // The whole point of VTID-05305: not one-per-push. Every missing marker is
  // listed in a single failure.
  assert.deepEqual(r.missing, [
    'VALIDATION_PROFILE',
    'SCOPE_ALLOWLIST',
    'ACCEPTANCE',
    'MERGE_PAYLOAD_PREVIEW',
    'OASIS_IMPACT',
  ]);
  // The code is the FIRST missing item's historic code, preserving the
  // documented exit-code contract.
  assert.equal(r.code, 11);
  const joined = r.messages.join('\n');
  for (const marker of ['VALIDATION_PROFILE', 'SCOPE_ALLOWLIST', 'ACCEPTANCE', 'MERGE_PAYLOAD_PREVIEW', 'OASIS_IMPACT']) {
    assert.match(joined, new RegExp(marker));
  }
});

test('each marker keeps its own historic exit code when it is the first missing', () => {
  const cases = [
    ['SCOPE_ALLOWLIST', 12],
    ['ACCEPTANCE', 13],
    ['MERGE_PAYLOAD_PREVIEW', 14],
    ['OASIS_IMPACT', 15],
  ];
  for (const [marker, code] of cases) {
    const body = COMPLETE_BODY.replace(new RegExp(`${marker}:.*\\n?`), '');
    const r = guard.prBodyRequirements(body);
    assert.equal(r.code, code, `${marker} should map to exit ${code}`);
    assert.ok(r.missing.includes(marker));
  }
});

test('a non-string body is treated as empty, never throws', () => {
  assert.equal(guard.prBodyRequirements(undefined).code, 11);
  assert.equal(guard.prBodyRequirements(null).code, 11);
});

test('the CLI --pr-body-check exits 0 for a complete body and 11 for a missing profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vtid05305-'));
  const okPath = join(dir, 'ok.txt');
  const badPath = join(dir, 'bad.txt');
  writeFileSync(okPath, COMPLETE_BODY);
  writeFileSync(badPath, COMPLETE_BODY.replace(/VALIDATION_PROFILE:.*\n/, ''));

  // exit 0
  const out = execFileSync('node', [GUARD_PATH, '--pr-body-check', okPath], { encoding: 'utf8' });
  assert.match(out, /every required declaration/i);

  // exit 11 with an actionable message
  let threw = false;
  try {
    execFileSync('node', [GUARD_PATH, '--pr-body-check', badPath], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    threw = true;
    assert.equal(e.status, 11);
    assert.match(String(e.stdout), /VALIDATION_PROFILE/);
  }
  assert.ok(threw, 'a missing profile must exit non-zero');
});
