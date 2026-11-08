// VTID-05520: the synthetic fixtures (tenants T_A/T_B, five members, CANARY_A markers), seeded idempotently.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createStack, loadFixtures, PATHS } from '../../../scripts/mt/stack/stack.mjs';
import { T_A, T_B, USERS, CANARY_A_RE } from '../../../scripts/mt/stack/fixture-ids.mjs';

describe('fixtures', () => {
  let db;
  before(async () => { ({ db } = await createStack()); });
  after(async () => { await db.close(); });
  const count = async (sql, p = []) => (await db.query(sql, p)).rows[0].c;

  test('tenants T_A and T_B exist with synthetic slugs', async () => {
    const r = await db.query('SELECT id, slug FROM public.tenants WHERE id IN ($1, $2) ORDER BY slug', [T_A, T_B]);
    assert.deepEqual(r.rows.map((x) => x.slug), ['mt-fixture-a', 'mt-fixture-b']);
  });

  test('the five users are in the stub auth.users', async () => {
    const ids = Object.values(USERS);
    assert.equal(ids.length, 5);
    assert.equal(await count('SELECT count(*)::int AS c FROM auth.users WHERE id = ANY($1::uuid[])', [ids]), 5);
    assert.deepEqual(Object.keys(USERS).sort(), ['a_admin', 'a_member', 'ab_dual', 'b_admin', 'b_member']);
  });

  test('memberships: a_* in T_A, b_* in T_B, ab_dual in both; admins carry the admin role', async () => {
    const m = await db.query('SELECT user_id, tenant_id, active_role FROM public.user_tenants WHERE user_id = ANY($1::uuid[])', [Object.values(USERS)]);
    const has = (u, t) => m.rows.some((r) => r.user_id === u && r.tenant_id === t);
    assert.ok(has(USERS.a_member, T_A) && has(USERS.a_admin, T_A));
    assert.ok(has(USERS.b_member, T_B) && has(USERS.b_admin, T_B));
    assert.ok(has(USERS.ab_dual, T_A) && has(USERS.ab_dual, T_B));
    assert.ok(!has(USERS.a_member, T_B) && !has(USERS.b_member, T_A));
    assert.equal(m.rows.find((r) => r.user_id === USERS.a_admin).active_role, 'admin');
    assert.equal(m.rows.find((r) => r.user_id === USERS.b_admin).active_role, 'admin');
    assert.equal(m.rows.length, 6);
  });

  test('CANARY_A_<uuid> markers sit in representative T_A rows (at least three tables, one a health table) and never in T_B', async () => {
    const tables = [
      ['community_groups', 'name'],
      ['community_meetups', 'title'],
      ['services_catalog', 'name'],
      ['health_features_daily', 'feature_key'],
    ];
    for (const [t, col] of tables) {
      const a = await db.query(`SELECT ${col} AS v, tenant_id FROM public.${t} WHERE ${col} LIKE 'CANARY\\_A\\_%'`);
      assert.ok(a.rows.length >= 1, `${t}: no canary row`);
      for (const r of a.rows) {
        assert.match(r.v, CANARY_A_RE);
        assert.equal(r.tenant_id, T_A, `${t}: canary outside T_A`);
      }
      assert.equal(await count(`SELECT count(*)::int AS c FROM public.${t} WHERE tenant_id = $1 AND ${col} LIKE 'CANARY\\_A\\_%'`, [T_B]), 0);
    }
  });

  test('T_B has its own rows in the same tables, marked CANARY_B_', async () => {
    assert.ok(await count(`SELECT count(*)::int AS c FROM public.community_groups WHERE tenant_id = $1 AND name LIKE 'CANARY\\_B\\_%'`, [T_B]) >= 1);
  });

  test('loading the fixtures again changes nothing', async () => {
    const snap = async () => (await db.query(`SELECT
      (SELECT count(*) FROM public.tenants)::int t, (SELECT count(*) FROM auth.users)::int u,
      (SELECT count(*) FROM public.user_tenants)::int m, (SELECT count(*) FROM public.community_groups)::int g,
      (SELECT count(*) FROM public.community_meetups)::int mt, (SELECT count(*) FROM public.services_catalog)::int s,
      (SELECT count(*) FROM public.health_features_daily)::int h`)).rows[0];
    const before1 = await snap();
    await loadFixtures(db, PATHS.fixtures);
    assert.deepEqual(await snap(), before1);
  });
});
