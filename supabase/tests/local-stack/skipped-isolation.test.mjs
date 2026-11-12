// VTID-05520 (mt-guardrails-r2/local-test-stack-pglite): the isolation gap on the PRESENT required tables.
// A skipped migration that redefines tenant resolution (current_tenant_id, membership writers) or a policy on a present
// required table is not applied, so isolation claims on that table run on non-production resolution and policies.
// LOCAL-STACK.md must list exactly those migrations and mark the claims that depend on them unverified.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, PATHS, loadRequired, loadNotReplayable, loadSkips } from '../../../scripts/mt/stack/stack.mjs';
import { isolationReasons, findIsolationGaps } from '../../../scripts/mt/stack/skipped-isolation.mjs';

const doc = () => readFileSync(join(REPO_ROOT, 'docs/multitenancy/LOCAL-STACK.md'), 'utf8');
const present = () => {
  const missing = new Set(loadNotReplayable().map((e) => e.table));
  return loadRequired().filter((t) => !missing.has(t));
};
const gaps = () => findIsolationGaps(loadSkips(), present(), (f) => readFileSync(join(PATHS.migrations, f), 'utf8'));

describe('isolationReasons (scanner)', () => {
  const P = ['user_tenants', 'community_groups'];
  test('a policy on a present table is a reason; on another table it is not', () => {
    assert.deepEqual(isolationReasons('CREATE POLICY "p" ON public.community_groups FOR SELECT USING (true);', P), ['policy on community_groups']);
    assert.deepEqual(isolationReasons('DROP POLICY IF EXISTS p ON other_table;', P), []);
  });
  test('a tenant helper function is a reason, a function reading user_tenants is a reason, an unrelated one is not', () => {
    assert.deepEqual(isolationReasons('CREATE OR REPLACE FUNCTION public.current_tenant_id() RETURNS uuid AS $$ SELECT 1 $$ LANGUAGE sql;', P), ['function current_tenant_id']);
    assert.deepEqual(isolationReasons('CREATE FUNCTION public.f() RETURNS void AS $b$ BEGIN INSERT INTO user_tenants VALUES (1); END $b$ LANGUAGE plpgsql;', P), ['function f (reads or writes tenant membership)']);
    assert.deepEqual(isolationReasons('CREATE FUNCTION public.g() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;', P), []);
  });
  test('comments are ignored', () => {
    assert.deepEqual(isolationReasons('-- CREATE POLICY p ON community_groups\n/* CREATE FUNCTION current_tenant_id() */ SELECT 1;', P), []);
  });
});

describe('LOCAL-STACK.md isolation gap', () => {
  test('the section lists exactly the skipped migrations the scanner finds', () => {
    const d = doc();
    assert.ok(d.includes('## Isolation gap on the present tables'), 'section missing');
    const section = d.slice(d.indexOf('## Isolation gap on the present tables'));
    const rows = [...section.matchAll(/^\| `(\d{14}_[^`]+\.sql)` \|/gm)].map((m) => m[1]).sort();
    assert.deepEqual(rows, gaps().map((g) => g.file).sort());
  });
  test('the four migrations the reviewer named are found and listed', () => {
    const files = gaps().map((g) => g.file);
    for (const f of [
      '20260218000000_fix_maxina_signup_tenant_association.sql',
      '20261102030100_vtid_05465_bare_policy_rewrite.sql',
      '20261102031000_vtid_05466_user_tenants_canonical.sql',
      '20261014000200_vtid_05149_signup_default_tenant.sql',
    ]) assert.ok(files.includes(f), f);
  });
  test('each row carries the reasons, and the doc marks claims on the present tables unverified', () => {
    const d = doc();
    for (const g of gaps()) assert.ok(d.includes(g.reasons[0]), `${g.file}: reason "${g.reasons[0]}" not in the doc`);
    assert.match(d, /current_tenant_id\(\)/);
    assert.match(d, /claims? on (?:the )?present tables[^\n]*unverified|unverified[^\n]*present tables/i);
  });
  test('every present required table is named in the section', () => {
    const d = doc();
    const section = d.slice(d.indexOf('## Isolation gap on the present tables'));
    for (const t of present()) assert.ok(section.includes(`\`${t}\``), t);
  });
});
