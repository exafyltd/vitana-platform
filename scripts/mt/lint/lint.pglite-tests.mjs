// VTID-05445 (mt-guardrails-r2/generated-inventories): tests of the five DB lints, the allowlist and the bare-policy counter.
// Run: node --test scripts/mt/lint/lint.pglite-tests.mjs
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { runLints, validateAllowlist, LINTS } from './lints.mjs';
import { countBarePolicies } from './bare-policy.mjs';
import { fixtureInventories } from '../inventory/fixture-inventories.mjs';

const NO_ALLOW = { schema_version: 1, entries: [] };
const subjects = (r, lint) => r.findings.filter((f) => f.lint === lint).map((f) => f.subject).sort();

describe('db lints', () => {
  let inv;
  before(async () => { inv = await fixtureInventories(); });

  test('the five lints are named', () => {
    assert.deepEqual([...LINTS], ['nullable-tenant-id', 'missing-tenant-policy', 'definer-without-guard', 'realtime-without-tenant-rls', 'storage-policy']);
  });

  test('nullable tenant_id flags the nullable column only', () => {
    assert.deepEqual(subjects(runLints(inv, NO_ALLOW), 'nullable-tenant-id'), ['nullable_t']);
  });

  test('missing tenant policy flags RLS off and RLS on with no tenant policy, not a membership policy', () => {
    const s = subjects(runLints(inv, NO_ALLOW), 'missing-tenant-policy');
    for (const t of ['no_rls_t', 'no_policy_t', 'rt_bad', 'biomarker_results']) assert.ok(s.includes(t), t);
    for (const t of ['good_t', 'nullable_t', 'rt_good']) assert.ok(!s.includes(t), t);
  });

  test('DEFINER without revoke or caller check flags the open one, passes revoked, checked and invoker functions', () => {
    const s = subjects(runLints(inv, NO_ALLOW), 'definer-without-guard');
    assert.ok(s.some((x) => x.startsWith('definer_open(')));
    assert.ok(!s.some((x) => /^(definer_revoked|definer_checked|invoker_fn)\(/.test(x)));
    assert.ok(!s.some((x) => x.startsWith('is_member(')), 'is_member checks auth.uid()');
  });

  test('realtime table without tenant RLS flags rt_bad, passes rt_good, and marks a table that is not in the schema unverified', () => {
    const r = runLints(inv, NO_ALLOW);
    assert.deepEqual(subjects(r, 'realtime-without-tenant-rls'), ['rt_bad']);
    assert.ok(r.unverified.some((u) => u.lint === 'realtime-without-tenant-rls' && u.subject === 'rt_text_only'));
  });

  test('storage policy flags a policy with no user or tenant scoping, passes a scoped one', () => {
    assert.deepEqual(subjects(runLints(inv, NO_ALLOW), 'storage-policy'), ['avatars_read']);
  });

  test('a clean fixture of one good table has no finding', () => {
    const clean = {
      tables: { rows: [inv.tables.rows.find((t) => t.name === 'good_t')] },
      functions: { rows: [] }, realtime_tables: { rows: [] }, buckets: { storage_policies: [] },
    };
    const r = runLints(clean, NO_ALLOW);
    assert.deepEqual(r.findings, []);
    assert.equal(r.summary.findings, 0);
  });
});

describe('unverified tables', () => {
  test('a not-replayable table is never passing: it is unverified in every table lint and counted apart', async () => {
    const inv = await fixtureInventories();
    const r = runLints(inv, NO_ALLOW);
    const mine = r.unverified.filter((u) => u.subject === 'data_sharing_consents').map((u) => u.lint).sort();
    assert.deepEqual(mine, ['missing-tenant-policy', 'nullable-tenant-id']);
    assert.ok(!r.findings.some((f) => f.subject === 'data_sharing_consents'));
    assert.ok(r.unverified.every((u) => u.status === 'unverified' && u.reason));
    assert.equal(r.summary.unverified, r.unverified.length);
    assert.ok(r.summary.unverified >= 2);
  });

  test('an allowlist entry cannot turn an unverified table into a pass', async () => {
    const inv = await fixtureInventories();
    const allow = { schema_version: 1, entries: [{ lint: 'missing-tenant-policy', subject: 'data_sharing_consents', owner: 'exafy-platform', reason: 'test' }] };
    const r = runLints(inv, allow);
    assert.ok(r.unverified.some((u) => u.subject === 'data_sharing_consents' && u.lint === 'missing-tenant-policy'));
    assert.ok(!r.allowed.some((a) => a.subject === 'data_sharing_consents'));
  });
});

describe('allowlist', () => {
  test('entries need lint, subject, owner and reason; the lint must be known', () => {
    assert.throws(() => validateAllowlist({ schema_version: 1, entries: [{ lint: 'storage-policy', subject: 'x', reason: 'r' }] }), /owner/);
    assert.throws(() => validateAllowlist({ schema_version: 1, entries: [{ lint: 'storage-policy', subject: 'x', owner: 'o' }] }), /reason/);
    assert.throws(() => validateAllowlist({ schema_version: 1, entries: [{ lint: 'nope', subject: 'x', owner: 'o', reason: 'r' }] }), /unknown lint/);
    assert.throws(() => validateAllowlist({ schema_version: 1, entries: [{ lint: 'storage-policy', subject: 'x', owner: ' ', reason: 'r' }] }), /owner/);
    assert.doesNotThrow(() => validateAllowlist(NO_ALLOW));
  });

  test('an allowlisted finding moves to allowed with its owner; a stale entry is reported', async () => {
    const inv = await fixtureInventories();
    const allow = { schema_version: 1, entries: [
      { lint: 'storage-policy', subject: 'avatars_read', owner: 'community-team', reason: 'public avatars' },
      { lint: 'nullable-tenant-id', subject: 'gone_table', owner: 'community-team', reason: 'stale' },
    ] };
    const r = runLints(inv, allow);
    assert.deepEqual(subjects(r, 'storage-policy'), []);
    assert.deepEqual(r.allowed.map((a) => [a.lint, a.subject, a.owner]), [['storage-policy', 'avatars_read', 'community-team']]);
    assert.deepEqual(r.stale_allowlist.map((e) => e.subject), ['gone_table']);
  });

  test('the committed allowlist is valid', async () => {
    const { loadAllowlist } = await import('./lints.mjs');
    const a = loadAllowlist();
    assert.equal(a.schema_version, 1);
    assert.ok(Array.isArray(a.entries));
  });
});

describe('bare-policy counter', () => {
  test('counts current_tenant_id() policies without auth.uid(), current_user_id(), is_member or is_tenant_admin', async () => {
    const inv = await fixtureInventories();
    const r = countBarePolicies(inv.tables, NO_ALLOW);
    assert.equal(r.count, 2);
    assert.deepEqual(r.policies.map((p) => `${p.table}.${p.policy}`), ['bare_shared_t.bare_shared_t_sel', 'bare_t.bare_t_sel']);
  });

  test('the allowlist (by table) takes a policy out of the count; the number is reported, never asserted 0', async () => {
    const inv = await fixtureInventories();
    const allow = { schema_version: 1, entries: [{ lint: 'bare-policy', subject: 'bare_shared_t', owner: 'community-team', reason: 'tenant-shared' }] };
    const r = countBarePolicies(inv.tables, allow);
    assert.equal(r.count, 1);
    assert.equal(r.allowed, 1);
    const full = runLints(inv, allow);
    assert.equal(full.bare_policies.count, 1);
    assert.equal(full.summary.bare_policies, 1);
    assert.equal(full.bare_policies.asserted, false);
  });

  test('a policy that adds is_tenant_admin or current_user_id is not bare', () => {
    const tables = { rows: [
      { name: 'a', status: 'verified', policies: [{ name: 'p1', using: '(tenant_id = current_tenant_id()) AND is_tenant_admin(tenant_id)', with_check: null }] },
      { name: 'b', status: 'verified', policies: [{ name: 'p2', using: null, with_check: '(tenant_id = current_tenant_id() AND user_id = current_user_id())' }] },
      { name: 'c', status: 'verified', policies: [{ name: 'p3', using: null, with_check: '(tenant_id = current_tenant_id())' }] },
    ] };
    assert.deepEqual(countBarePolicies(tables, NO_ALLOW).policies.map((p) => p.table), ['c']);
  });

  test('a policy on an unverified table is not counted and the count says so', async () => {
    const inv = await fixtureInventories();
    const r = countBarePolicies(inv.tables, NO_ALLOW);
    assert.equal(r.unverified_tables, 1);
  });
});

describe('committed inventories', () => {
  test('every table of not-replayable.txt is unverified in the committed data and in the lint report, never passing', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { DATA_DIR, INVENTORY_FILES } = await import('../inventory/generate.mjs');
    const { loadNotReplayable } = await import('../stack/stack.mjs');
    const { loadAllowlist } = await import('./lints.mjs');
    const inv = Object.fromEntries(Object.entries(INVENTORY_FILES).map(([k, f]) => [k, JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'))]));
    const listed = loadNotReplayable().map((e) => e.table);
    assert.ok(listed.length > 0);
    const report = runLints(inv, loadAllowlist());
    for (const t of listed) {
      assert.equal(inv.tables.rows.find((r) => r.name === t).status, 'unverified', t);
      assert.ok(report.unverified.some((u) => u.subject === t && u.lint === 'missing-tenant-policy'), t);
      assert.ok(!report.findings.some((f) => f.subject === t), `${t} is neither a finding nor a pass`);
    }
    assert.equal(typeof report.bare_policies.count, 'number');
    assert.equal(report.bare_policies.asserted, false);
  });
});
