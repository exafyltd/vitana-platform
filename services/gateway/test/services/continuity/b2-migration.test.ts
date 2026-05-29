/**
 * VTID-02932 (B2) — continuity tables migration shape guard.
 *
 * Asserts the migration:
 *   - Creates user_open_threads + assistant_promises with the
 *     documented columns + status CHECK constraints.
 *   - Tenant-scopes both via RLS through user_tenants.
 *   - Indexes both for the hot-path queries the fetcher runs
 *     (last_mentioned_at DESC for open threads, due_at NULLS LAST
 *     for owed promises).
 *   - Has touch triggers on updated_at for both tables.
 *   - Does NOT contain any state-advancement RPC. State advancement
 *     ships in a follow-up slice with its own dedicated event endpoint
 *     (B2 wall).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_PATH = join(
  __dirname,
  '../../../../../supabase/migrations/20260520000000_VTID_02932_continuity_tables.sql',
);

describe('B2 — continuity tables migration', () => {
  let sql: string;
  beforeAll(() => {
    sql = readFileSync(MIGRATION_PATH, 'utf8');
  });

  describe('user_open_threads table', () => {
    it('creates the table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS user_open_threads/);
    });

    it('keys on thread_id UUID PRIMARY KEY', () => {
      expect(sql).toMatch(/thread_id\s+UUID[\s\S]*?PRIMARY KEY/);
    });

    it('has the 3-state status CHECK constraint locked', () => {
      const states = ['open', 'resolved', 'abandoned'];
      for (const s of states) {
        expect(sql).toContain(`'${s}'`);
      }
    });

    it('tracks session_id_first + session_id_last for cross-session linkage', () => {
      expect(sql).toContain('session_id_first');
      expect(sql).toContain('session_id_last');
    });

    it('tracks last_mentioned_at for recency ordering', () => {
      expect(sql).toContain('last_mentioned_at');
    });

    it('enables RLS with tenant isolation via user_tenants', () => {
      expect(sql).toMatch(/ALTER TABLE user_open_threads ENABLE ROW LEVEL SECURITY/);
      expect(sql).toMatch(/user_open_threads_tenant_isolation/);
      expect(sql).toMatch(/user_tenants/);
    });

    it('indexes (tenant_id, user_id, last_mentioned_at DESC) for recency reads', () => {
      expect(sql).toMatch(/user_open_threads_user_idx/);
      expect(sql).toMatch(/last_mentioned_at\s+DESC/);
    });

    it('has a partial index WHERE status = open for hot-path lookups', () => {
      expect(sql).toMatch(/WHERE\s+status\s*=\s*'open'/);
    });

    it('has a touch trigger on updated_at', () => {
      expect(sql).toMatch(/CREATE TRIGGER user_open_threads_updated_at_trigger/);
    });
  });

  describe('assistant_promises table', () => {
    it('creates the table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS assistant_promises/);
    });

    it('keys on promise_id UUID PRIMARY KEY', () => {
      expect(sql).toMatch(/promise_id\s+UUID[\s\S]*?PRIMARY KEY/);
    });

    it('has the 4-state status CHECK constraint locked', () => {
      const states = ['owed', 'kept', 'broken', 'cancelled'];
      for (const s of states) {
        expect(sql).toContain(`'${s}'`);
      }
    });

    it('references user_open_threads via FK ON DELETE SET NULL (not CASCADE)', () => {
      expect(sql).toMatch(
        /REFERENCES user_open_threads\(thread_id\)\s+ON DELETE SET NULL/,
      );
    });

    it('tracks decision_id for ranker-trace linkage', () => {
      expect(sql).toContain('decision_id');
    });

    it('tracks kept_at for credit-acknowledgement window', () => {
      expect(sql).toContain('kept_at');
    });

    it('enables RLS with tenant isolation via user_tenants', () => {
      expect(sql).toMatch(/ALTER TABLE assistant_promises ENABLE ROW LEVEL SECURITY/);
      expect(sql).toMatch(/assistant_promises_tenant_isolation/);
      expect(sql).toMatch(/user_tenants/);
    });

    it('has a partial index WHERE status = owed for due-soonest reads', () => {
      expect(sql).toMatch(/WHERE\s+status\s*=\s*'owed'/);
    });

    it('has a touch trigger on updated_at', () => {
      expect(sql).toMatch(/CREATE TRIGGER assistant_promises_updated_at_trigger/);
    });
  });

  describe('B2 wall — no state advancement in this migration', () => {
    it('does NOT introduce any state-advancement RPC (mutation lives in a follow-up slice)', () => {
      // Any RPC starting with create_thread / mark_promise / advance_*
      // would violate B2's read-only wall.
      expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION\s+(?:public\.)?create_open_thread/i);
      expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION\s+(?:public\.)?mark_promise/i);
      expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION\s+(?:public\.)?advance_/i);
    });
  });
});
