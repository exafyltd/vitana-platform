// VTID-04948 — unit tests for the PR-GATE decision logic. Run: node --test scripts/ci/pr-gate/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../lib.mjs';

test('vtidsFromTitle finds every VTID once', () => {
  assert.deepEqual(L.vtidsFromTitle('VTID-04946, VTID-04947: x (VTID-04946)'), ['VTID-04946', 'VTID-04947']);
  assert.deepEqual(L.vtidsFromTitle('fix: no id'), []);
});

test('globToRegExp: ** spans dirs, * stays in a segment', () => {
  assert.ok(L.matchesAny('src/components/a/b.tsx', ['src/components/**']));
  assert.ok(L.matchesAny('src/a.ts', ['src/**/*.ts']));
  assert.ok(!L.matchesAny('src/components/a/b.tsx', ['src/components/*']));
  assert.ok(L.matchesAny('src/components/a.tsx', ['src/components/*']));
  assert.ok(!L.matchesAny('src/componentsX/a.tsx', ['src/components/**']));
  assert.ok(L.matchesAny('docs/validation/VTID-1/scope.json', ['docs/validation/VTID-1/**']));
});

test('scope: outside file fails, bot-only and always-allowed files pass, no VTID skips', () => {
  const scopes = { 'VTID-1': { vtid: 'VTID-1', kind: 'fix', paths: ['src/components/liverooms/**'] } };
  const changed = ['src/components/liverooms/A.tsx', 'package-lock.json', 'docs/validation/VTID-1/scope.json', 'services/gateway/dist/x.js', 'src/styles.css', 'src/pages/Wallet.tsx'];
  const r = L.evaluateScope({ vtids: ['VTID-1'], scopes, changed, botOnly: ['src/pages/Wallet.tsx'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.outside, ['src/styles.css']);
  assert.equal(L.evaluateScope({ vtids: [], scopes: {}, changed }).skipped, 'no VTID in the PR title');
  assert.deepEqual(L.evaluateScope({ vtids: ['VTID-2'], scopes: {}, changed }).missing, ['VTID-2']);
});

test('validateScope rejects bad shapes', () => {
  assert.deepEqual(L.validateScope({ vtid: 'VTID-1', kind: 'fix', paths: ['a/**'] }, 'VTID-1'), []);
  assert.ok(L.validateScope({ vtid: 'VTID-1', kind: 'oops', paths: [] }, 'VTID-1').length >= 2);
  assert.ok(L.validateScope({ vtid: 'VTID-1', kind: 'fix', paths: ['a'], weakens_tests: [{ file: 'x', reason: 'short' }] }, 'VTID-1').length === 1);
});

test('ratchet: worse fails, new erroring file fails, improvements pass', () => {
  assert.equal(L.compareRatchet({ a: 2 }, { a: 2 }).ok, true);
  assert.equal(L.compareRatchet({ a: 2 }, { a: 3 }).ok, false);
  assert.equal(L.compareRatchet({}, { b: 1 }).ok, false);
  const r = L.compareRatchet({ a: 2, c: 1 }, { a: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.better.length, 2);
});

test('countTsc parses compiler output per file', () => {
  const out = 'src/a.ts(1,2): error TS2322: x\nsrc/a.ts(3,4): error TS2345: y\nsrc/b.tsx(1,1): error TS1005: z\n  continuation line\n';
  assert.deepEqual(L.countTsc(out), { 'src/a.ts': 2, 'src/b.tsx': 1 });
});

test('countEslint strips the root and keeps only files with errors', () => {
  const res = [{ filePath: '/r/src/a.ts', errorCount: 2 }, { filePath: '/r/src/b.ts', errorCount: 0 }];
  assert.deepEqual(L.countEslint(res, '/r'), { 'src/a.ts': 2 });
});

test('weakening: deletion, skip, fewer cases, fewer assertions; declared ones do not block', () => {
  const base = "it('a', () => { expect(1).toBe(1); expect(2).toBe(2); });\nit('b', () => {});";
  const files = [
    { file: 'del.test.ts', base, head: null },
    { file: 'skip.test.ts', base, head: base.replace("it('b'", "it.skip('b'") },
    { file: 'cases.test.ts', base, head: "it('a', () => { expect(1).toBe(1); expect(2).toBe(2); });" },
    { file: 'asserts.test.ts', base, head: base.replace('expect(2).toBe(2);', '') },
    { file: 'new.test.ts', base: null, head: base },
    { file: 'same.test.ts', base, head: base },
  ];
  const r = L.evaluateWeakening({ files, exempt: [{ file: 'cases.test.ts', reason: 'merged two cases into one' }] });
  assert.deepEqual(r.findings.map((f) => f.file).sort(), ['asserts.test.ts', 'cases.test.ts', 'del.test.ts', 'skip.test.ts']);
  assert.deepEqual(r.blocking.map((f) => f.file).sort(), ['asserts.test.ts', 'del.test.ts', 'skip.test.ts']);
  assert.equal(r.ok, false);
});

test('testStats does not count method calls like foo.it( or .test( on regexes', () => {
  assert.equal(L.testStats("/x/.test(s); obj.it(1); it('real', () => {});").cases, 1);
});

test('sparring record needs verdict, owner approval and plan hash', () => {
  assert.deepEqual(L.evaluateSparringRecord('Plan hash: abc\nverdict **CONVERGED**\n**Owner approval (Gate 1): yes'), []);
  assert.equal(L.evaluateSparringRecord('CONVERGED').length, 2);
});

test('migration lint: wrapper, idempotency, non-transactional declaration', () => {
  const good = 'BEGIN;\nCREATE TABLE IF NOT EXISTS t (id int);\nCREATE OR REPLACE FUNCTION f() RETURNS int AS $$ BEGIN CREATE TABLE inner_t(x int); RETURN 1; END $$ LANGUAGE plpgsql;\nALTER TABLE t ADD COLUMN IF NOT EXISTS c int;\nCOMMIT;';
  assert.deepEqual(L.lintMigration(good), []);
  assert.ok(L.lintMigration('CREATE TABLE IF NOT EXISTS t(x int);').some((p) => p.includes('BEGIN')));
  assert.ok(L.lintMigration('BEGIN; CREATE TABLE t(x int); COMMIT;').some((p) => p.includes('not idempotent')));
  assert.ok(L.lintMigration('BEGIN; DROP TABLE t; COMMIT;').some((p) => p.includes('not idempotent')));
  const conc = 'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t(x);';
  assert.ok(L.lintMigration(conc).some((p) => p.includes('non-transactional')));
  assert.deepEqual(L.lintMigration(conc, { nonTransactional: true }), []);
  assert.ok(L.lintMigration(`BEGIN; ${conc} COMMIT;`, { nonTransactional: true }).some((p) => p.includes('remove the wrapper')));
  // comments never trigger a finding
  assert.deepEqual(L.lintMigration('-- CREATE TABLE x(y int);\nBEGIN; SELECT 1; COMMIT;'), []);
});

test('regex edge cases: extra whitespace cannot sneak past the idempotency check', () => {
  assert.deepEqual(L.lintMigration('BEGIN; CREATE TABLE   IF NOT EXISTS t(x int); COMMIT;'), []);
  assert.ok(L.lintMigration('BEGIN; CREATE  TABLE  t(x int); COMMIT;').some((p) => p.includes('not idempotent')));
  assert.deepEqual(L.lintMigration('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS i ON t(x);', { nonTransactional: true }), []);
});

test('a skipped test counts once as a skip, not also as a dropped case', () => {
  const base = "it('a', () => {}); it('b', () => {});";
  const r = L.evaluateWeakening({ files: [{ file: 's.test.ts', base, head: base.replace("it('b'", "it.skip('b'") }] });
  assert.equal(r.findings.length, 1);
});

test('dry run: own BEGIN/COMMIT replaced by an always-rollback wrapper', () => {
  const s = L.dryRunScript('BEGIN;\nCREATE TABLE IF NOT EXISTS t(x int);\nCOMMIT;\n');
  assert.ok(s.trimEnd().endsWith('ROLLBACK;'));
  assert.equal((s.match(/COMMIT/g) || []).length, 0);
  assert.equal((s.match(/BEGIN;/g) || []).length, 1);
});

test('dry run classification: missing objects are unverifiable, real errors fail', () => {
  assert.equal(L.classifyDryRun('ERROR:  42P01: relation "public.user_notifications" does not exist').verdict, 'unverifiable');
  assert.equal(L.classifyDryRun('ERROR:  42883: function public.x() does not exist').verdict, 'unverifiable');
  assert.equal(L.classifyDryRun('ERROR:  42601: syntax error at or near "TABL"').verdict, 'failed');
  assert.equal(L.classifyDryRun('ERROR:  42804: column "a" is of type integer but expression is of type text').verdict, 'failed');
  assert.equal(L.classifyDryRun('psql: connection refused').verdict, 'failed');
});
