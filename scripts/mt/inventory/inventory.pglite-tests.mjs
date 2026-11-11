// VTID-05445 (mt-guardrails-r2/generated-inventories): tests of the inventory generators over a tiny fixture schema,
// and the drift guard over the real repo. Run: node --test scripts/mt/inventory/inventory.pglite-tests.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStack } from '../stack/stack.mjs';
import { renderInventories, writeInventories, checkInventories, DATA_DIR, INVENTORY_FILES } from './generate.mjs';
import { fixtureInventories } from './fixture-inventories.mjs';
import { HEALTH_TABLES, isHealthTable } from './health-tables.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, 'fixtures');
const REPO = join(HERE, '..', '..', '..');

describe('fixture inventories', () => {
  let inv;
  before(async () => { inv = await fixtureInventories(); });

  test('six inventories are produced', () => {
    assert.deepEqual(Object.keys(inv).sort(), ['buckets', 'edge_functions', 'functions', 'realtime_tables', 'routes', 'tables']);
    assert.deepEqual(Object.values(INVENTORY_FILES).sort(),
      ['buckets.json', 'edge-functions.json', 'functions.json', 'realtime-tables.json', 'routes.json', 'tables.json']);
  });

  test('tables: tenant_id nullability, RLS flag and policies come from the catalog', () => {
    const by = Object.fromEntries(inv.tables.rows.map((r) => [r.name, r]));
    assert.equal(by.good_t.has_tenant_id, true);
    assert.equal(by.good_t.tenant_id_nullable, false);
    assert.equal(by.good_t.rls_enabled, true);
    assert.equal(by.good_t.policies.length, 1);
    assert.match(by.good_t.policies[0].using, /is_member/);
    assert.equal(by.nullable_t.tenant_id_nullable, true);
    assert.equal(by.no_rls_t.rls_enabled, false);
    assert.equal(by.no_policy_t.policies.length, 0);
    assert.equal(by.good_t.status, 'verified');
  });

  test('tables: rows are sorted by name', () => {
    const names = inv.tables.rows.map((r) => r.name);
    assert.deepEqual(names, [...names].sort());
  });

  test('functions: SECURITY DEFINER, who may execute, and the caller check', () => {
    const by = Object.fromEntries(inv.functions.rows.map((r) => [r.name, r]));
    assert.equal(by.definer_open.security_definer, true);
    assert.ok(by.definer_open.executable_by.includes('authenticated'));
    assert.equal(by.definer_open.caller_check, false);
    assert.deepEqual(by.definer_revoked.executable_by, []);
    assert.equal(by.definer_checked.caller_check, true);
    assert.equal(by.invoker_fn.security_definer, false);
  });

  test('functions: extension functions are not listed', () => {
    assert.ok(!inv.functions.rows.some((r) => /^(uuid_generate|gen_random_uuid|digest|similarity)/.test(r.name)));
  });

  test('routes: one row per route with its middleware; test files are skipped', () => {
    const rows = inv.routes.rows;
    assert.ok(!rows.some((r) => r.path === '/ignored-in-tests'));
    const open = rows.find((r) => r.path === '/open');
    assert.equal(open.method, 'GET');
    assert.equal(open.file, 'gateway/routes/a.ts');
    assert.deepEqual(open.middleware, []);
    assert.equal(open.auth_middleware, false);
    const secure = rows.find((r) => r.path === '/secure');
    assert.deepEqual(secure.middleware, ['requireAuth']);
    assert.equal(secure.auth_middleware, true);
    assert.deepEqual(rows.find((r) => r.path === '/admin/:id').middleware, ['requireAuth', 'requireTenantAdmin']);
    assert.ok(rows.find((r) => r.path === '/alive' && r.file === 'gateway/server.ts'));
    assert.equal(inv.routes.summary.total, 4);
    assert.equal(inv.routes.summary.without_auth_middleware, 2);
  });

  test('edge functions: directory, Authorization header, service role, verify_jwt from config.toml', () => {
    const by = Object.fromEntries(inv.edge_functions.rows.map((r) => [r.name, r]));
    assert.equal(by['fn-open'].reads_authorization_header, true);
    assert.equal(by['fn-open'].uses_service_role, true);
    assert.equal(by['fn-open'].verify_jwt, null);
    assert.equal(by['fn-quiet'].reads_authorization_header, false);
    assert.equal(by['fn-quiet'].verify_jwt, false);
    assert.equal(by['fn-open'].file, 'functions/fn-open/index.ts');
  });

  test('realtime tables: publication and migration text are merged, with the source of each', () => {
    const by = Object.fromEntries(inv.realtime_tables.rows.map((r) => [r.table, r]));
    assert.deepEqual(by.rt_bad.via, ['migrations', 'publication']);
    assert.deepEqual(by.rt_good.via, ['publication']);
    assert.deepEqual(by.rt_text_only.via, ['migrations']);
    assert.equal(by.rt_text_only.in_schema, false);
  });

  test('buckets and storage policies come from migration text, a later DROP removes a policy', () => {
    assert.deepEqual(inv.buckets.rows.map((b) => b.id), ['avatars', 'docs']);
    assert.equal(inv.buckets.rows[0].source, 'migrations');
    const names = inv.buckets.storage_policies.map((p) => p.name);
    assert.deepEqual(names, ['avatars_read', 'docs_own']);
    assert.equal(inv.buckets.storage_policies[0].cmd, 'SELECT');
    assert.match(inv.buckets.storage_policies[1].expression, /auth\.uid\(\)/);
  });
});

describe('unverified tables', () => {
  test('a not-replayable table is listed as unverified with its reason and lanes, never verified', async () => {
    const inv = await fixtureInventories();
    const row = inv.tables.rows.find((r) => r.name === 'data_sharing_consents');
    assert.equal(row.status, 'unverified');
    assert.match(row.reason, /no committed creator/);
    assert.deepEqual(row.lanes, ['isolation-suite', 'generated-inventories']);
    assert.equal(row.policies, undefined);
    assert.equal(inv.tables.summary.unverified, 1);
    assert.equal(inv.tables.summary.verified, inv.tables.rows.length - 1);
  });
});

describe('health table list', () => {
  test('is the five tables of docs/MULTI-TENANT-PLAN.md section 2', () => {
    assert.deepEqual([...HEALTH_TABLES].sort(), ['biomarker_results', 'data_sharing_consents', 'health_features_daily', 'partner_health_test_orders', 'wearable_samples']);
    assert.ok(isHealthTable('wearable_samples'));
    assert.ok(!isHealthTable('good_t'));
    const plan = readFileSync(join(REPO, 'docs', 'MULTI-TENANT-PLAN.md'), 'utf8');
    for (const t of HEALTH_TABLES) assert.ok(plan.includes(`\`${t}\``), `${t} is named in the plan`);
  });
});

describe('determinism', () => {
  test('two runs render byte-identical files; keys sorted, no timestamp, trailing newline', async () => {
    const a = renderInventories(await fixtureInventories());
    const b = renderInventories(await fixtureInventories());
    assert.deepEqual([...a.keys()], Object.values(INVENTORY_FILES));
    for (const [name, text] of a) {
      assert.equal(text, b.get(name), name);
      assert.ok(text.endsWith('}\n'), name);
      assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:/);
    }
  });

  test('writeInventories then checkInventories finds no drift; a changed file is named', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-inv-'));
    try {
      const inv = await fixtureInventories();
      writeInventories(dir, inv);
      assert.deepEqual(checkInventories(dir, inv), []);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(dir, 'routes.json'), '{}\n');
      assert.deepEqual(checkInventories(dir, inv), ['routes.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('drift guard', () => {
  test('the committed inventories regenerate byte-identically from the repo (node scripts/mt/inventory/generate.mjs)', async () => {
    const { db } = await createStack({ fixtures: false, shim: false });
    try {
      const { buildRepoInventories } = await import('./generate.mjs');
      const inv = await buildRepoInventories(db);
      assert.deepEqual(checkInventories(DATA_DIR, inv), [],
        'inventories drifted: run `node scripts/mt/inventory/generate.mjs` and commit scripts/mt/inventory/data/');
    } finally { await db.close(); }
  });
});
