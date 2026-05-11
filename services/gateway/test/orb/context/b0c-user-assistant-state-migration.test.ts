/**
 * B0c — `user_assistant_state` migration shape guard.
 *
 * Hard rule from the plan: this table stores DURABLE signals only.
 * Ephemeral route / journey_surface / current match context must NOT
 * live here.
 *
 * This source-level test asserts the migration:
 *   - Creates the `user_assistant_state` table with the documented PK.
 *   - Documents the forbidden ephemeral signals so future maintainers
 *     understand the boundary (the comment is load-bearing).
 *   - Enables tenant-scoped RLS.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_PATH = join(
  __dirname,
  '../../../../../supabase/migrations/20260516000000_VTID_02909_user_assistant_state.sql',
);

describe('B0c — user_assistant_state migration', () => {
  let sql: string;
  beforeAll(() => {
    sql = readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('creates the user_assistant_state table', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS user_assistant_state/);
  });

  it('uses the documented composite primary key', () => {
    expect(sql).toMatch(/PRIMARY KEY \(tenant_id, user_id, signal_name\)/);
  });

  it('enables RLS for tenant isolation', () => {
    expect(sql).toMatch(/ALTER TABLE user_assistant_state ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/tenant_id IN/);
    expect(sql).toMatch(/user_tenants/);
  });

  it('documents the forbidden ephemeral signals', () => {
    // The migration's comment block is load-bearing — it tells future
    // maintainers that current_route / journey_surface / current_match_id
    // are NEVER persisted here. Without this, B0d/B0e maintainers may
    // accidentally store ephemeral session state long-term.
    expect(sql).toMatch(/Forbidden signals/);
    expect(sql).toMatch(/current_route/);
    expect(sql).toMatch(/journey_surface/);
    expect(sql).toMatch(/current_match_id/);
  });

  it('has a touch trigger so updated_at advances on mutation', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION user_assistant_state_touch_updated_at/);
    expect(sql).toMatch(/BEFORE UPDATE ON user_assistant_state/);
  });

  it('indexes expires_at for time-based sweeps', () => {
    expect(sql).toMatch(/user_assistant_state_expires_at_idx/);
  });
});
