// VTID-05445 (G2, G3): tests of the lints, the allowlist and the bare-policy counter over hand-built inventories and the
// committed ones. They need no PGlite and no install, so the required `unit` check runs them. The lints over a fixture
// schema are in lint.pglite-tests.mjs. Run: node --test scripts/mt/lint/lint.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLints, validateAllowlist, loadAllowlist, LINTS } from './lints.mjs';
import { countBarePolicies, isBarePolicy } from './bare-policy.mjs';
import { DATA_DIR, INVENTORY_FILES } from '../inventory/render.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NO_ALLOW = { schema_version: 1, entries: [] };
const table = (name, o = {}) => ({ name, status: 'verified', rls_enabled: true, rls_forced: false, has_tenant_id: true, tenant_id_nullable: false, health: false, policies: [], ...o });
const pol = (name, using, with_check = null) => ({ name, cmd: 'SELECT', permissive: true, roles: ['public'], using, with_check });
const member = [pol('p', 'is_member(tenant_id)')];
const fn = (name, o = {}) => ({ name, args: '', kind: 'function', security_definer: true, search_path_set: true, executable_by: ['authenticated'], caller_check: false, ...o });
const base = (o = {}) => ({
  tables: { rows: [] }, functions: { rows: [] }, realtime_tables: { rows: [] }, buckets: { storage_policies: [] }, ...o,
});
const subjects = (r, lint) => r.findings.filter((f) => f.lint === lint).map((f) => f.subject).sort();

describe('db lints', () => {
  test('the five lints are named', () => {
    assert.deepEqual([...LINTS], ['nullable-tenant-id', 'missing-tenant-policy', 'definer-without-guard', 'realtime-without-tenant-rls', 'storage-policy']);
  });

  test('nullable tenant_id flags the nullable column only', () => {
    const inv = base({ tables: { rows: [table('ok', { policies: member }), table('bad', { tenant_id_nullable: true, policies: member }), table('no_col', { has_tenant_id: false, tenant_id_nullable: null })] } });
    assert.deepEqual(subjects(runLints(inv, NO_ALLOW), 'nullable-tenant-id'), ['bad']);
  });

  test('missing tenant policy: RLS off, RLS on with no policy, a policy that ignores the tenant; a membership policy passes', () => {
    const inv = base({ tables: { rows: [
      table('good', { policies: member }),
      table('rls_off', { rls_enabled: false, policies: member }),
      table('no_policy'),
      table('user_only', { policies: [pol('p', 'user_id = auth.uid()')] }),
      table('no_tenant_col', { has_tenant_id: false, tenant_id_nullable: null }),
    ] } });
    assert.deepEqual(subjects(runLints(inv, NO_ALLOW), 'missing-tenant-policy'), ['no_policy', 'rls_off', 'user_only']);
  });

  test('DEFINER without revoke or caller check: flags the open one, passes revoked, checked and invoker functions', () => {
    const inv = base({ functions: { rows: [
      fn('open'), fn('revoked', { executable_by: [] }), fn('checked', { caller_check: true }), fn('invoker', { security_definer: false }),
    ] } });
    assert.deepEqual(subjects(runLints(inv, NO_ALLOW), 'definer-without-guard'), ['open()']);
  });

  test('realtime table without tenant RLS flags a bad table, passes a good one, marks a missing table unverified', () => {
    const inv = base({
      tables: { rows: [table('rt_good', { policies: member }), table('rt_bad', { rls_enabled: false })] },
      realtime_tables: { rows: [{ table: 'rt_good', via: ['publication'], in_schema: true, status: 'verified' }, { table: 'rt_bad', via: ['publication'], in_schema: true, status: 'verified' },
        { table: 'rt_gone', via: ['migrations'], in_schema: false, status: 'unverified', reason: 'not in the schema' }] },
    });
    const r = runLints(inv, NO_ALLOW);
    assert.deepEqual(subjects(r, 'realtime-without-tenant-rls'), ['rt_bad']);
    assert.ok(r.unverified.some((u) => u.lint === 'realtime-without-tenant-rls' && u.subject === 'rt_gone'));
  });

  test('storage policy flags a policy with no user or tenant scoping, passes a scoped one', () => {
    const inv = base({ buckets: { storage_policies: [
      { name: 'open', cmd: 'SELECT', expression: "FOR SELECT USING (bucket_id = 'avatars')", source: 'migrations', file: 'a.sql' },
      { name: 'own', cmd: 'SELECT', expression: "FOR SELECT USING ((storage.foldername(name))[1] = auth.uid()::text)", source: 'migrations', file: 'a.sql' },
      { name: 'tenant', cmd: 'SELECT', expression: 'FOR SELECT USING (is_member(tenant_id))', source: 'migrations', file: 'a.sql' },
    ] } });
    assert.deepEqual(subjects(runLints(inv, NO_ALLOW), 'storage-policy'), ['open']);
  });

  test('a clean inventory has no finding', () => {
    const r = runLints(base({ tables: { rows: [table('good', { policies: member })] } }), NO_ALLOW);
    assert.deepEqual(r.findings, []);
    assert.equal(r.summary.findings, 0);
  });
});

describe('unverified tables', () => {
  const inv = base({ tables: { rows: [table('good', { policies: member }), { name: 'ghost', health: true, status: 'unverified', reason: 'no committed creator', lanes: ['isolation-suite'] }] } });

  test('an unverified table is never passing: listed unverified in the table lints, counted apart, no finding', () => {
    const r = runLints(inv, NO_ALLOW);
    assert.deepEqual(r.unverified.filter((u) => u.subject === 'ghost').map((u) => u.lint), ['missing-tenant-policy', 'nullable-tenant-id']);
    assert.deepEqual(r.findings, []);
    assert.equal(r.summary.unverified, 2);
    assert.ok(r.unverified.every((u) => u.status === 'unverified' && u.reason));
  });

  test('an allowlist entry cannot turn an unverified table into a pass', () => {
    const allow = { schema_version: 1, entries: [{ lint: 'missing-tenant-policy', subject: 'ghost', owner: 'exafy-platform', reason: 'test' }] };
    const r = runLints(inv, allow);
    assert.ok(r.unverified.some((u) => u.subject === 'ghost' && u.lint === 'missing-tenant-policy'));
    assert.deepEqual(r.allowed, []);
  });

  test('every table of not-replayable.txt is unverified in the committed data and the report, never a finding or a pass', () => {
    const listed = readFileSync(join(REPO, 'supabase', 'tests', 'local-stack', 'not-replayable.txt'), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split('|')[0].trim());
    assert.ok(listed.length > 0);
    const data = Object.fromEntries(Object.entries(INVENTORY_FILES).map(([k, f]) => [k, JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'))]));
    const report = runLints(data, loadAllowlist());
    for (const t of listed) {
      assert.equal(data.tables.rows.find((r) => r.name === t).status, 'unverified', t);
      assert.ok(report.unverified.some((u) => u.subject === t && u.lint === 'missing-tenant-policy'), t);
      assert.ok(!report.findings.some((f) => f.subject === t), `${t} is neither a finding nor a pass`);
    }
    assert.equal(typeof report.bare_policies.count, 'number');
    assert.equal(report.bare_policies.asserted, false);
  });
});

describe('allowlist', () => {
  test('entries need lint, subject, owner and reason; the lint must be known', () => {
    assert.throws(() => validateAllowlist({ schema_version: 1, entries: [{ lint: 'storage-policy', subject: 'x', reason: 'r' }] }), /owner/);
    assert.throws(() => validateAllowlist({ schema_version: 1, entries: [{ lint: 'storage-policy', subject: 'x', owner: 'o' }] }), /reason/);
    assert.throws(() => validateAllowlist({ schema_version: 1, entries: [{ lint: 'nope', subject: 'x', owner: 'o', reason: 'r' }] }), /unknown lint/);
    assert.throws(() => validateAllowlist({ schema_version: 1, entries: [{ lint: 'storage-policy', subject: 'x', owner: ' ', reason: 'r' }] }), /owner/);
    assert.throws(() => validateAllowlist({ entries: [] }), /schema_version/);
    assert.doesNotThrow(() => validateAllowlist(NO_ALLOW));
  });

  test('an allowlisted finding moves to allowed with its owner; a stale entry is reported', () => {
    const inv = base({ buckets: { storage_policies: [{ name: 'open', cmd: 'SELECT', expression: 'USING (true)', source: 'migrations', file: 'a.sql' }] } });
    const allow = { schema_version: 1, entries: [
      { lint: 'storage-policy', subject: 'open', owner: 'community-team', reason: 'public avatars' },
      { lint: 'nullable-tenant-id', subject: 'gone_table', owner: 'community-team', reason: 'stale' },
    ] };
    const r = runLints(inv, allow);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.allowed.map((a) => [a.lint, a.subject, a.owner]), [['storage-policy', 'open', 'community-team']]);
    assert.deepEqual(r.stale_allowlist.map((e) => e.subject), ['gone_table']);
  });

  test('the committed allowlist is valid', () => {
    const a = loadAllowlist();
    assert.equal(a.schema_version, 1);
    assert.ok(Array.isArray(a.entries));
  });
});

describe('bare-policy counter', () => {
  const tables = { rows: [
    table('a', { policies: [pol('p1', '((tenant_id = current_tenant_id()) AND is_tenant_admin(tenant_id))')] }),
    table('b', { policies: [pol('p2', null, '((tenant_id = current_tenant_id()) AND (user_id = current_user_id()))')] }),
    table('c', { policies: [pol('p3', null, '(tenant_id = current_tenant_id())')] }),
    table('d', { policies: [pol('p4', '(tenant_id = current_tenant_id())'), pol('p5', '(tenant_id = current_tenant_id() AND user_id = auth.uid())')] }),
    table('e', { policies: [pol('p6', 'is_member(tenant_id)')] }),
    { name: 'ghost', status: 'unverified', reason: 'x', lanes: [] },
  ] };

  test('counts current_tenant_id() policies without auth.uid(), current_user_id(), is_member or is_tenant_admin', () => {
    assert.equal(isBarePolicy(pol('x', 'tenant_id = current_tenant_id()')), true);
    assert.equal(isBarePolicy(pol('x', 'is_member(tenant_id)')), false);
    const r = countBarePolicies(tables, NO_ALLOW);
    assert.deepEqual(r.policies.map((p) => `${p.table}.${p.policy}`), ['c.p3', 'd.p4']);
    assert.equal(r.count, 2);
    assert.equal(r.unverified_tables, 1);
  });

  test('the allowlist (by table) takes a policy out of the count; the number is reported, never asserted 0', () => {
    const allow = { schema_version: 1, entries: [{ lint: 'bare-policy', subject: 'c', owner: 'community-team', reason: 'tenant-shared' }] };
    const r = countBarePolicies(tables, allow);
    assert.equal(r.count, 1);
    assert.equal(r.allowed, 1);
    assert.equal(r.asserted, false);
    const full = runLints(base({ tables }), allow);
    assert.equal(full.bare_policies.count, 1);
    assert.equal(full.summary.bare_policies, 1);
    assert.equal(full.stale_allowlist.length, 0, 'a bare-policy entry is not a stale lint entry');
  });
});
