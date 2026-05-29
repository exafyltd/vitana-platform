// VTID-03161 — D39 PR 5a schema migration shape guard.
//
// Asserts the migration that introduces `decision_compatibility_score`:
//   - Creates the table with the documented columns + check constraints.
//   - Uses NULLS NOT DISTINCT on the unique constraint so global-tenant
//     (tenant_id IS NULL) rows collide on the constraint instead of
//     admitting duplicates.
//   - Indexes the hot-path lookup (dimension, tenant_id, profile_value,
//     effective_from DESC).
//   - Enables RLS with the same tenant-isolation policy decision_policy
//     and decision_conflict_pair use.
//   - Does NOT contain seeds, a resolver, or any code wiring — those
//     ship in PR 5b / 5c / 5d-g.

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_PATH = join(
  __dirname,
  '../../../../../supabase/migrations/' +
    '20260604000000_VTID_03161_decision_compatibility_score.sql',
);

describe('VTID-03161 D39 PR 5a — decision_compatibility_score schema migration', () => {
  let sql: string;
  beforeAll(() => {
    sql = readFileSync(MIGRATION_PATH, 'utf8');
  });

  describe('table creation', () => {
    it('creates the table idempotently', () => {
      expect(sql).toMatch(
        /CREATE TABLE IF NOT EXISTS decision_compatibility_score/,
      );
    });

    it('keys on id UUID PRIMARY KEY with gen_random_uuid default', () => {
      expect(sql).toMatch(
        /id\s+UUID\s+PRIMARY KEY\s+DEFAULT\s+gen_random_uuid\(\)/,
      );
    });

    it('declares the four scoring columns: dimension, profile_value, candidate_value, score', () => {
      expect(sql).toMatch(/dimension\s+TEXT\s+NOT NULL/);
      expect(sql).toMatch(/profile_value\s+TEXT\s+NOT NULL/);
      expect(sql).toMatch(/candidate_value\s+TEXT\s+NOT NULL/);
      expect(sql).toMatch(/score\s+NUMERIC\(3,2\)\s+NOT NULL/);
    });

    it('constrains score to [0, 1]', () => {
      expect(sql).toMatch(/CHECK\s*\(\s*score\s*>=\s*0\s+AND\s+score\s*<=\s*1\s*\)/);
    });

    it('has the versioned / tenant-aware / time-bounded columns', () => {
      expect(sql).toMatch(/tenant_id\s+UUID(?!\s+NOT NULL)/);
      expect(sql).toMatch(/version\s+INTEGER\s+NOT NULL\s+DEFAULT\s+1/);
      expect(sql).toMatch(/effective_from\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s+now\(\)/);
      expect(sql).toMatch(/effective_until\s+TIMESTAMPTZ(?!\s+NOT NULL)/);
    });

    it('locks the source CHECK to the canonical four values', () => {
      expect(sql).toMatch(
        /source\s+TEXT\s+NOT NULL\s+DEFAULT\s+'seed'[\s\S]*?CHECK\s*\(\s*source\s+IN\s*\(\s*'seed'\s*,\s*'admin_ui'\s*,\s*'autopilot'\s*,\s*'experiment'\s*\)\s*\)/,
      );
    });

    it('carries the audit columns: rationale, notes, created_at, created_by', () => {
      expect(sql).toMatch(/rationale\s+TEXT/);
      expect(sql).toMatch(/notes\s+TEXT/);
      expect(sql).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s+now\(\)/);
      expect(sql).toMatch(/created_by\s+TEXT/);
    });
  });

  describe('uniqueness — Postgres-safe global-tenant handling', () => {
    it('uses NULLS NOT DISTINCT so global (tenant_id IS NULL) rows collide on the constraint', () => {
      // The whole point of PR 5a's correction over decision_conflict_pair:
      // plain UNIQUE(...tenant_id...) would let two rows with NULL
      // tenant_id coexist for the same (dimension, profile, candidate, version).
      expect(sql).toMatch(/UNIQUE\s+NULLS\s+NOT\s+DISTINCT/);
    });

    it('uniqueness covers (dimension, profile_value, candidate_value, tenant_id, version)', () => {
      expect(sql).toMatch(
        /UNIQUE\s+NULLS\s+NOT\s+DISTINCT[\s\S]*?\(\s*dimension\s*,\s*profile_value\s*,\s*candidate_value\s*,\s*tenant_id\s*,\s*version\s*\)/,
      );
    });

    it('does not declare a plain nullable-tenant UNIQUE that admits duplicate global rows', () => {
      // Defensive: catch a future "fix" that drops NULLS NOT DISTINCT.
      // A plain UNIQUE(..., tenant_id, version) without the NULLS NOT
      // DISTINCT clause is forbidden by the audit. Scan only SQL lines
      // (strip `--` line comments and `/* … */` block comments first)
      // so the test doesn't false-positive on its own prose.
      const sqlOnly = sql
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map(line => line.replace(/--.*$/, ''))
        .join('\n');
      const matches = sqlOnly.match(/UNIQUE[^\(]*\([^)]*tenant_id[^)]*\)/g) ?? [];
      for (const m of matches) {
        expect(m).toMatch(/NULLS\s+NOT\s+DISTINCT/);
      }
    });
  });

  describe('hot-path lookup index', () => {
    it('indexes (dimension, tenant_id, profile_value, effective_from DESC)', () => {
      expect(sql).toMatch(
        /CREATE INDEX IF NOT EXISTS decision_compatibility_score_lookup_idx\s+ON\s+decision_compatibility_score\s*\(\s*dimension\s*,\s*tenant_id\s*,\s*profile_value\s*,\s*effective_from\s+DESC\s*\)/,
      );
    });
  });

  describe('row-level security', () => {
    it('enables RLS on the table', () => {
      expect(sql).toMatch(
        /ALTER TABLE decision_compatibility_score ENABLE ROW LEVEL SECURITY/,
      );
    });

    it('drops any pre-existing policy before recreating it (idempotent re-apply)', () => {
      expect(sql).toMatch(
        /DROP POLICY IF EXISTS decision_compatibility_score_tenant_read/,
      );
    });

    it('creates the tenant-read policy mirroring decision_policy / decision_conflict_pair', () => {
      expect(sql).toMatch(
        /CREATE POLICY decision_compatibility_score_tenant_read[\s\S]*?ON decision_compatibility_score[\s\S]*?FOR SELECT[\s\S]*?TO authenticated/,
      );
    });

    it('USING clause admits global defaults (tenant_id IS NULL) + caller tenant via user_tenants', () => {
      expect(sql).toMatch(/tenant_id\s+IS\s+NULL/);
      expect(sql).toMatch(/user_tenants\s+WHERE\s+user_id\s*=\s*auth\.uid\(\)/);
    });

    it('does NOT grant authenticated INSERT/UPDATE/DELETE policies (service-role writes only)', () => {
      // Mirrors decision_policy/decision_conflict_pair: SELECT-only for
      // authenticated; service-role bypasses RLS for the seed pass +
      // future admin-UI writes.
      expect(sql).not.toMatch(/FOR\s+INSERT[\s\S]*?TO\s+authenticated/);
      expect(sql).not.toMatch(/FOR\s+UPDATE[\s\S]*?TO\s+authenticated/);
      expect(sql).not.toMatch(/FOR\s+DELETE[\s\S]*?TO\s+authenticated/);
    });
  });

  describe('scope discipline — PR 5a is schema only', () => {
    it('contains NO INSERT statements (seeds ship in PR 5b)', () => {
      // The migration must NOT carry any seed rows — those land in a
      // dedicated 5b migration so the schema can be reviewed in
      // isolation and a future seed bump doesn't reshape the table.
      expect(sql).not.toMatch(/INSERT\s+INTO\s+decision_compatibility_score/i);
    });

    it('contains NO references to D39 service code or resolver imports', () => {
      // PR 5a is pure SQL — no application code wiring. Catches a
      // future migration that tries to combine schema + code
      // touchpoints into one PR.
      expect(sql).not.toMatch(/d39-taste-alignment-service/);
      expect(sql).not.toMatch(/compatibility-resolver/);
    });

    it('contains a COMMENT ON TABLE documenting the boundary intent', () => {
      expect(sql).toMatch(/COMMENT ON TABLE decision_compatibility_score IS/);
    });
  });
});
