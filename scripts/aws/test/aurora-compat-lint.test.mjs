// VTID-05023 Phase B1 tests: the Aurora-compatibility lint must pass a clean fixture and flag a Supabase-only one.
// Run: node --test scripts/aws/test/aurora-compat-lint.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lintSql, stripComments } from '../aurora-compat-lint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = name => readFileSync(join(here, 'fixtures', 'aurora-compat', name), 'utf8');

test('passing fixture has no findings (comments and string literals are ignored)', () => {
  assert.deepEqual(lintSql(fixture('pass.sql')), []);
});

test('failing fixture is flagged for auth, role and extension', () => {
  const rules = new Set(lintSql(fixture('fail.sql')).map(f => f.rule));
  assert.ok(rules.has('auth-schema'), 'auth.users and auth.uid() must be flagged');
  assert.ok(rules.has('supabase-role'), 'TO authenticated and GRANT ... TO service_role must be flagged');
  assert.ok(rules.has('supabase-extension'), 'pg_graphql must be flagged');
});

test('each finding reports the line of the offending statement', () => {
  const findings = lintSql(fixture('fail.sql'));
  const auth = findings.find(f => f.rule === 'auth-schema');
  assert.equal(auth.line, 4, 'auth.users is on line 4 of fail.sql');
});

test('stripComments keeps line count so reported line numbers stay right', () => {
  const src = '-- one\n/* two\nthree */\nSELECT 1;\n';
  assert.equal(stripComments(src).split('\n').length, src.split('\n').length);
  assert.equal(lintSql('/* auth.uid() */ SELECT 1;').length, 0);
});
