import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVerdict } from './verdict.ts';

const HEAD = 'a'.repeat(40);
const good = (over: Record<string, unknown> = {}) => ({
  decision: 'CHANGES_REQUESTED',
  head_sha: HEAD,
  findings: [{ id: 'F1', severity: 'blocking', file: 'src/x.ts', line: 3, claim: 'wrong branch', evidence: 'x.ts:3 returns null' }],
  ...over,
});

test('a well-formed CHANGES_REQUESTED for the exact head passes', () => {
  const r = validateVerdict(good(), HEAD);
  assert.equal(r.ok, true);
});

test('a verdict for another head is rejected', () => {
  const r = validateVerdict(good({ head_sha: 'b'.repeat(40) }), HEAD);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /not the reviewed head/);
});

test('a malformed expected head is rejected before anything else', () => {
  assert.equal(validateVerdict(good(), 'short').ok, false);
});

test('ACCEPT with a blocking finding is contradictory and rejected', () => {
  const r = validateVerdict(good({ decision: 'ACCEPT' }), HEAD);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /ACCEPT cannot carry blocking/);
});

test('ACCEPT with no findings passes', () => {
  assert.equal(validateVerdict({ decision: 'ACCEPT', head_sha: HEAD, findings: [] }, HEAD).ok, true);
});

test('CHANGES_REQUESTED with no findings is rejected', () => {
  const r = validateVerdict({ decision: 'CHANGES_REQUESTED', head_sha: HEAD, findings: [] }, HEAD);
  assert.equal(r.ok, false);
});

test('CHANGES_REQUESTED with only minor findings is rejected', () => {
  const f = [{ id: 'M1', severity: 'minor', file: 'a.ts', line: 1, claim: 'nit', evidence: 'a.ts:1' }];
  const r = validateVerdict({ decision: 'CHANGES_REQUESTED', head_sha: HEAD, findings: f }, HEAD);
  assert.equal(r.ok, false);
});

test('unknown top-level and finding fields are rejected', () => {
  assert.equal(validateVerdict(good({ approved_by: 'someone' }), HEAD).ok, false);
  const bad = good();
  (bad.findings[0] as Record<string, unknown>).score = 9;
  assert.equal(validateVerdict(bad, HEAD).ok, false);
});

test('line must be a positive integer and claim/evidence must be non-empty', () => {
  const f = (x: Record<string, unknown>) => validateVerdict(good({ findings: [{ id: 'F1', severity: 'major', file: 'a.ts', line: 1, claim: 'c', evidence: 'e', ...x }] }), HEAD);
  assert.equal(f({ line: 0 }).ok, false);
  assert.equal(f({ line: 1.5 }).ok, false);
  assert.equal(f({ claim: '   ' }).ok, false);
  assert.equal(f({ evidence: '' }).ok, false);
  assert.equal(f({}).ok, true);
});

test('duplicate finding ids are rejected', () => {
  const two = [
    { id: 'F1', severity: 'major', file: 'a.ts', line: 1, claim: 'c', evidence: 'e' },
    { id: 'F1', severity: 'major', file: 'b.ts', line: 2, claim: 'c', evidence: 'e' },
  ];
  assert.equal(validateVerdict({ decision: 'CHANGES_REQUESTED', head_sha: HEAD, findings: two }, HEAD).ok, false);
});

test('a non-object or wrong decision is rejected', () => {
  assert.equal(validateVerdict(null, HEAD).ok, false);
  assert.equal(validateVerdict(good({ decision: 'LGTM' }), HEAD).ok, false);
});
