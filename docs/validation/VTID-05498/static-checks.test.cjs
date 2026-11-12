// VTID-05498 static gate: migration shape, rollback, queue row and drift baseline. Run: node --test docs/validation/VTID-05498/static-checks.test.cjs
// ROOT=<dir> points it at another tree (used to record the red run against origin/main).
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const ROOT = process.env.ROOT || path.resolve(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MIG = 'supabase/migrations/20261102080000_mt_packs_knowledge_docs_tenant_id.sql';
const strip = (s) => s.replace(/--.*$/gm, '');

test('migration adds one nullable tenant_id column with a live-key FK and lock_timeout, nothing else', () => {
  const m = strip(read(MIG));
  assert.match(m, /ALTER TABLE public\.knowledge_docs\s+ADD COLUMN IF NOT EXISTS tenant_id uuid NULL REFERENCES public\.tenants\(tenant_id\);/);
  assert.match(m, /lock_timeout/);
  assert.doesNotMatch(m, /tenant_id uuid NOT NULL/); assert.doesNotMatch(m, /\bDEFAULT\b/i);
  assert.equal((m.match(/\bALTER TABLE\b/gi) || []).length, 1);
});
test('expand-only: no DML, no DROP, no index, no policy, no bare current_tenant_id()', () => {
  const m = strip(read(MIG));
  assert.doesNotMatch(m, /\b(DROP|TRUNCATE|DELETE FROM|INSERT INTO|UPDATE\s|CREATE INDEX|CREATE POLICY|CREATE TABLE)\b/i);
  assert.doesNotMatch(m, /current_tenant_id\(\)/);
});
test('rollback drops exactly the new column; pre/post checks are read-only', () => {
  const rb = strip(read('docs/validation/VTID-05498/rollback.sql'));
  assert.equal(rb.match(/\bDROP\b/g).length, 1); assert.match(rb, /DROP COLUMN IF EXISTS tenant_id;/);
  for (const f of ['pre-check.sql', 'post-check.sql']) assert.doesNotMatch(strip(read(`docs/validation/VTID-05498/${f}`)).replace(/'[^']*'/g, "''"), /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i);
});
test('MIGRATION-QUEUE has the row with rollback and checks, and the version is unique in the queue', () => {
  const rows = read('docs/multitenancy/MIGRATION-QUEUE.md').split('\n').filter((l) => l.startsWith('| '));
  const mine = rows.filter((l) => l.includes('20261102080000_mt_packs_knowledge_docs_tenant_id.sql'));
  assert.equal(mine.length, 1, 'exactly one row');
  for (const s of ['VTID-05498', 'docs/validation/VTID-05498/rollback.sql', 'pre-check.sql', 'post-check.sql', 'collaboration §7d']) assert.ok(mine[0].includes(s), s);
});
test('drift baseline: the column is noted without a bogus table entry (this lane leaves count and list alone)', () => {
  const b = JSON.parse(read('scripts/ci/migration-drift-baseline.json'));
  assert.equal(typeof b.count, 'number');
  assert.ok(!b.known_missing_tables.includes('knowledge_docs'));
  assert.ok(b._comment_vtid_05498 && b._comment_vtid_05498.includes('knowledge_docs.tenant_id'));
  assert.ok(!b.known_missing_tables.includes('knowledge_docs'));
});
test('the pgTAP file exists and plans the cases it runs', () => {
  const t = read('supabase/tests/mt/mt_packs_knowledge_docs_tenant_id.sql');
  const planned = Number(/SELECT plan\((\d+)\)/.exec(t)[1]);
  const asserts = (t.match(/^SELECT (has_column|is|throws_ok)\(/gm) || []).length;
  assert.equal(planned, asserts);
});
