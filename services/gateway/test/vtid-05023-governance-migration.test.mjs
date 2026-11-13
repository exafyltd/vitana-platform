/**
 * VTID-05023: 20251120000001 (add_migration_governance_rules) fails when governance_categories
 * has no unique (tenant_id, name). The fix is 20251120000003_fix_migration_governance_seed.sql.
 *
 * Run: node --test test/vtid-05023-governance-migration.test.mjs   (from services/gateway)
 *
 * Runs on an in-memory PGlite database. Nothing touches staging or production.
 * This is plain Node ESM, not Jest: PGlite's Emscripten bootstrap uses a dynamic import that
 * Jest's CJS runner rejects without --experimental-vm-modules.
 *
 * The table shape below is the rehearsal shape: governance_categories already exists without the
 * UNIQUE (tenant_id, name) that 20251120000000 declares (CREATE TABLE IF NOT EXISTS skips it).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = (name) =>
  readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const ORIGINAL = migration('20251120000001_add_migration_governance_rules.sql');
const FIX = migration('20251120000003_fix_migration_governance_seed.sql');

const REHEARSAL_SHAPE = `
  CREATE TABLE governance_categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id text NOT NULL,
    name text NOT NULL,
    description text,
    severity integer DEFAULT 1,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE governance_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id text NOT NULL,
    category_id uuid REFERENCES governance_categories(id) ON DELETE SET NULL,
    name text NOT NULL,
    description text,
    logic jsonb NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now()
  );
`;

const CATEGORY_COUNT = `SELECT count(*)::int AS n FROM governance_categories WHERE tenant_id = 'SYSTEM' AND name = 'MIGRATION_GOVERNANCE'`;
const RULE_COUNT = `SELECT count(*)::int AS n FROM governance_rules WHERE tenant_id = 'SYSTEM' AND logic->>'rule_code' LIKE 'MG-%'`;
// Unique indexes (and so unique constraints) on governance_categories with two key columns.
const UNIQUE_COUNT = `
  SELECT count(*)::int AS n FROM pg_index i
  WHERE i.indrelid = 'governance_categories'::regclass AND i.indisunique AND i.indnkeyatts = 2`;

async function scalar(db, sql) {
  const r = await db.query(sql);
  return r.rows[0].n;
}

async function state(db) {
  return [await scalar(db, CATEGORY_COUNT), await scalar(db, RULE_COUNT), await scalar(db, UNIQUE_COUNT)];
}

describe('VTID-05023: 20251120000001 governance seed on a table without the unique constraint', () => {
  test('the original statement fails on the rehearsal shape', async () => {
    const db = new PGlite();
    await db.exec(REHEARSAL_SHAPE);
    await assert.rejects(() => db.exec(ORIGINAL), /unique or exclusion constraint/);
  });

  test('(a) the fix applies on the rehearsal shape; the category and seven rules exist', async () => {
    const db = new PGlite();
    await db.exec(REHEARSAL_SHAPE);
    await db.exec(FIX);

    assert.equal(await scalar(db, UNIQUE_COUNT), 1);
    assert.equal(await scalar(db, CATEGORY_COUNT), 1);
    const cat = await db.query(
      `SELECT name FROM governance_categories WHERE tenant_id = 'SYSTEM' AND name = 'MIGRATION_GOVERNANCE'`,
    );
    assert.equal(cat.rows[0].name, 'MIGRATION_GOVERNANCE');
    assert.equal(await scalar(db, RULE_COUNT), 7);
  });

  test('(b) re-running the fix changes nothing', async () => {
    const db = new PGlite();
    await db.exec(REHEARSAL_SHAPE);
    await db.exec(FIX);
    const before = await state(db);

    await db.exec(FIX);

    assert.deepEqual(await state(db), before);
    assert.deepEqual(before, [1, 7, 1]);
  });

  test('(c) duplicate category rows keep the earliest row and repoint its rules', async () => {
    const db = new PGlite();
    await db.exec(REHEARSAL_SHAPE);
    await db.exec(`
      INSERT INTO governance_categories (id, tenant_id, name, description, created_at) VALUES
        ('00000000-0000-4000-8000-00000000000a', 'SYSTEM', 'MIGRATION_GOVERNANCE', 'old', '2025-01-01'),
        ('00000000-0000-4000-8000-00000000000b', 'SYSTEM', 'MIGRATION_GOVERNANCE', 'new', '2025-06-01');
      INSERT INTO governance_rules (tenant_id, category_id, name, logic) VALUES
        ('SYSTEM', '00000000-0000-4000-8000-00000000000b', 'pre-existing rule', '{"rule_code": "X-1"}');
    `);

    await db.exec(FIX);

    assert.equal(await scalar(db, CATEGORY_COUNT), 1);
    const kept = await db.query(
      `SELECT id FROM governance_categories WHERE name = 'MIGRATION_GOVERNANCE'`,
    );
    assert.equal(kept.rows[0].id, '00000000-0000-4000-8000-00000000000a');
    const linked = await db.query(
      `SELECT count(*)::int AS n FROM governance_rules WHERE name = 'pre-existing rule' AND category_id = $1`,
      ['00000000-0000-4000-8000-00000000000a'],
    );
    assert.equal(linked.rows[0].n, 1);
  });
});
