// VTID-05495 static gate: migration shape, rollback, queue position and drift baseline. Run: node --test docs/validation/VTID-05495/static-checks.test.cjs
// ROOT=<dir> points it at another tree (used to record the red run against origin/main).
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const ROOT = process.env.ROOT || path.resolve(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MIG = 'supabase/migrations/20261101100000_mt_packs_tenant_content_overrides.sql';
const strip = (s) => s.replace(/--.*$/gm, '');

test('migration creates the table with the plan columns, PK, locale CHECK and a live-key FK', () => {
  const m = strip(read(MIG));
  assert.match(m, /CREATE TABLE IF NOT EXISTS public\.tenant_content_overrides/);
  assert.match(m, /tenant_id\s+uuid\s+NOT NULL REFERENCES public\.tenants\(tenant_id\)/);
  assert.match(m, /PRIMARY KEY \(tenant_id, locale, key\)/);
  assert.match(m, /CHECK \(locale ~ '\^\[a-z\]\{2\}\(-\[A-Z\]\{2\}\)\?\$'\)/);
  assert.match(m, /value\s+text\s+NOT NULL/); assert.match(m, /updated_by\s+uuid\s+NULL/);
  assert.match(m, /updated_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/);
  assert.match(m, /lock_timeout/);
});
test('service-role-only: RLS on, client privileges revoked, service_role policy, no bare current_tenant_id()', () => {
  const m = strip(read(MIG));
  assert.match(m, /ENABLE ROW LEVEL SECURITY/);
  assert.match(m, /REVOKE ALL ON TABLE public\.tenant_content_overrides FROM PUBLIC, anon, authenticated/);
  assert.match(m, /GRANT ALL ON TABLE public\.tenant_content_overrides TO service_role/);
  assert.match(m, /auth\.role\(\) = 'service_role'/);
  assert.doesNotMatch(m, /current_tenant_id\(\)/);
  assert.doesNotMatch(m, /\b(DROP TABLE|TRUNCATE|DELETE FROM|INSERT INTO|UPDATE\s)/i);
});
test('rollback drops exactly the new table; pre/post checks are read-only', () => {
  const rb = strip(read('docs/validation/VTID-05495/rollback.sql'));
  assert.equal(rb.match(/\bDROP\b/g).length, 1); assert.match(rb, /DROP TABLE IF EXISTS public\.tenant_content_overrides;/);
  for (const f of ['pre-check.sql', 'post-check.sql']) assert.doesNotMatch(strip(read(`docs/validation/VTID-05495/${f}`)).replace(/'[^']*'/g, "''"), /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i);
});
test('MIGRATION-QUEUE row sits directly before the mt-launch rows with rollback and checks', () => {
  const rows = read('docs/multitenancy/MIGRATION-QUEUE.md').split('\n').filter((l) => l.startsWith('| '));
  const i = rows.findIndex((l) => l.includes('20261101100000_mt_packs_tenant_content_overrides.sql'));
  assert.ok(i > 0, 'row present');
  assert.ok(rows[i + 1].includes('20261101110000_mt_launch_tenant_pack_intake.sql'), 'directly before the mt-launch intake row');
  for (const s of ['VTID-05495', 'docs/validation/VTID-05495/rollback.sql', 'pre-check.sql', 'post-check.sql']) assert.ok(rows[i].includes(s), s);
});
test('drift baseline lists the not-yet-live table and its count matches', () => {
  const b = JSON.parse(read('scripts/ci/migration-drift-baseline.json'));
  assert.ok(b.known_missing_tables.includes('tenant_content_overrides'));
  assert.equal(b.count, b.known_missing_tables.length);
});
test('the migration version sorts before mt-launch 20261101110000', () => {
  assert.ok(path.basename(MIG) < '20261101110000_mt_launch_tenant_pack_intake.sql');
});
