/**
 * VTID-02917 (B0d.3) — orb_wake_timelines migration shape guard.
 *
 * Mirrors the B0c migration test pattern. Asserts the migration:
 *   - Creates the table with the documented composite-ish key.
 *   - Has the right column set (events JSONB, aggregates JSONB, etc.).
 *   - Enables tenant-scoped RLS via user_tenants.
 *   - Indexes the most common access pattern.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_PATH = join(
  __dirname,
  '../../../../../supabase/migrations/20260517000000_VTID_02917_orb_wake_timelines.sql',
);

describe('B0d.3 — orb_wake_timelines migration', () => {
  let sql: string;
  beforeAll(() => {
    sql = readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('creates the orb_wake_timelines table', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS orb_wake_timelines/);
  });

  it('keys on session_id (TEXT, not UUID — live-session ids are strings)', () => {
    expect(sql).toMatch(/session_id\s+TEXT\s+PRIMARY KEY/);
  });

  it('declares events + aggregates as JSONB', () => {
    expect(sql).toMatch(/events\s+JSONB/);
    expect(sql).toMatch(/aggregates\s+JSONB/);
  });

  it('enables RLS with tenant isolation via user_tenants', () => {
    expect(sql).toMatch(/ALTER TABLE orb_wake_timelines ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/tenant_id IN/);
    expect(sql).toMatch(/user_tenants/);
  });

  it('has a touch trigger so updated_at advances on mutation', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION orb_wake_timelines_touch_updated_at/);
    expect(sql).toMatch(/BEFORE UPDATE ON orb_wake_timelines/);
  });

  it('indexes (tenant_id, user_id, started_at DESC) for per-user lookups', () => {
    expect(sql).toMatch(/orb_wake_timelines_user_started_idx/);
    expect(sql).toMatch(/tenant_id, user_id, started_at DESC/);
  });

  it('documents the measure-before-optimize discipline in a comment', () => {
    expect(sql).toMatch(/measure-before-optimize|emit \+ render only/i);
  });
});
