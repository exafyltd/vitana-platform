// VTID-05445 (G1, G4, G5): tests of the scanners, the renderer and the health-table list. They need no PGlite and no install,
// so the required `unit` check (UNIT.yml: every scripts/**/*.test.mjs on Node 20) runs them. The catalog tests are in
// inventory.pglite-tests.mjs. Run: node --test scripts/mt/inventory/extract.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executableBy, middlewareOf, scanRoutes, scanEdgeFunctions, scanMigrationText, parseVerifyJwt } from './extract.mjs';
import { renderInventories, writeInventories, checkInventories, serialize, INVENTORY_FILES, DATA_DIR } from './render.mjs';
import { HEALTH_TABLES, isHealthTable } from './health-tables.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, 'fixtures');
const REPO = join(HERE, '..', '..', '..');

describe('executableBy', () => {
  test('a null ACL means PUBLIC may execute; revoked means nobody we lint', () => {
    assert.deepEqual(executableBy(null), ['public']);
    assert.deepEqual(executableBy(['postgres=X/postgres', 'service_role=X/postgres']), []);
    assert.deepEqual(executableBy(['=X/postgres', 'anon=X/postgres', 'authenticated=X/postgres']), ['anon', 'authenticated', 'public']);
  });
});

describe('routes', () => {
  test('middlewareOf reads names between the path and the handler on one line', () => {
    assert.deepEqual(middlewareOf(', requireAuth, async (req, res) => {'), ['requireAuth']);
    assert.deepEqual(middlewareOf(', requireAuth, requireTenantAdmin, handler);'), ['requireAuth', 'requireTenantAdmin']);
    assert.deepEqual(middlewareOf(', async (req, res) => {'), []);
    assert.deepEqual(middlewareOf(''), []);
  });

  test('scanRoutes lists one row per route, skips test files, and flags auth middleware', () => {
    const rows = scanRoutes(join(FX, 'gateway'), FX);
    assert.deepEqual(rows.map((r) => `${r.method} ${r.path}`).sort(), ['DELETE /admin/:id', 'GET /alive', 'GET /open', 'POST /secure']);
    assert.equal(rows.length, 4);
    assert.ok(!rows.some((r) => r.path === '/ignored-in-tests'));
    assert.equal(rows.find((r) => r.path === '/open').auth_middleware, false);
    assert.equal(rows.find((r) => r.path === '/secure').auth_middleware, true);
    assert.equal(rows.find((r) => r.path === '/alive').file, 'gateway/server.ts');
    assert.deepEqual(rows, scanRoutes(join(FX, 'gateway'), FX), 'deterministic');
  });
});

describe('edge functions', () => {
  test('directory, Authorization header, service role and verify_jwt from config.toml', () => {
    const rows = scanEdgeFunctions(join(FX, 'functions'), FX);
    assert.deepEqual(rows.map((r) => r.name), ['fn-open', 'fn-quiet']);
    assert.equal(rows[0].reads_authorization_header, true);
    assert.equal(rows[0].uses_service_role, true);
    assert.equal(rows[0].verify_jwt, null);
    assert.equal(rows[1].verify_jwt, false);
  });

  test('parseVerifyJwt reads per-function settings', () => {
    const m = parseVerifyJwt('[functions.a]\nverify_jwt = true\n\n[functions.b]\nverify_jwt = false\n[auth]\nenabled = true\n');
    assert.equal(m.get('a'), true);
    assert.equal(m.get('b'), false);
    assert.equal(m.size, 2);
  });
});

describe('migration text', () => {
  test('realtime tables, buckets and storage policies; a later DROP removes a policy', () => {
    const t = scanMigrationText(join(FX, 'migrations'));
    assert.deepEqual(t.realtime, ['rt_bad', 'rt_text_only']);
    assert.deepEqual(t.buckets.map((b) => [b.id, b.public, b.source]), [['avatars', true, 'migrations'], ['docs', false, 'migrations']]);
    assert.deepEqual(t.storage_policies.map((p) => [p.name, p.cmd]), [['avatars_read', 'SELECT'], ['docs_own', 'SELECT']]);
    assert.match(t.storage_policies[1].expression, /auth\.uid\(\)/);
  });

  test('comments are ignored and a missing directory gives empty lists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-mig-'));
    try {
      writeFileSync(join(dir, '1.sql'), "-- ALTER PUBLICATION supabase_realtime ADD TABLE public.in_comment;\n/* CREATE POLICY \"c\" ON storage.objects FOR ALL USING (true); */\nALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.real_one, other_one;\n");
      const t = scanMigrationText(dir);
      assert.deepEqual(t.realtime, ['other_one', 'real_one']);
      assert.deepEqual(t.storage_policies, []);
      assert.deepEqual(scanMigrationText(join(dir, 'nope')), { realtime: [], buckets: [], storage_policies: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

describe('rendering', () => {
  const inv = Object.fromEntries(Object.keys(INVENTORY_FILES).map((k) => [k, { inventory: k, z: 1, a: [{ y: 2, b: 1 }] }]));

  test('keys are sorted, the file ends with a newline, there is no timestamp', () => {
    assert.equal(serialize({ b: 1, a: { d: 1, c: 2 } }), '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n');
    const out = renderInventories(inv);
    assert.deepEqual([...out.keys()], Object.values(INVENTORY_FILES));
    for (const text of out.values()) assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/);
  });

  test('checkInventories names the files that differ and is empty after writeInventories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-inv-'));
    try {
      writeInventories(dir, inv);
      assert.deepEqual(checkInventories(dir, inv), []);
      writeFileSync(join(dir, 'routes.json'), '{}\n');
      assert.deepEqual(checkInventories(dir, inv), ['routes.json']);
      assert.deepEqual(checkInventories(join(dir, 'missing'), inv).length, 6);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the committed inventories are rendered in the canonical form (re-serialising them changes nothing)', () => {
    for (const file of Object.values(INVENTORY_FILES)) {
      const text = readFileSync(join(DATA_DIR, file), 'utf8');
      assert.equal(serialize(JSON.parse(text)), text, file);
    }
  });
});
