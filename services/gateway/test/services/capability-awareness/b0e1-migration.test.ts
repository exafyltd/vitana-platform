/**
 * VTID-02920 (B0e.1) — capability awareness migration shape guard.
 *
 * Asserts the migration:
 *   - Creates both tables with the documented columns + types.
 *   - Enables RLS (system_capabilities = read-only authenticated;
 *     user_capability_awareness = tenant-scoped).
 *   - Has the 7-state awareness ladder CHECK constraint locked.
 *   - Seeds the canonical 14 capabilities (NOT the deferred
 *     match-journey ones).
 *   - Indexes both tables for the documented access patterns.
 *   - Has touch triggers on updated_at for both tables.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_PATH = join(
  __dirname,
  '../../../../../supabase/migrations/20260518000000_VTID_02920_capability_awareness.sql',
);

describe('B0e.1 — capability awareness migration', () => {
  let sql: string;
  beforeAll(() => {
    sql = readFileSync(MIGRATION_PATH, 'utf8');
  });

  describe('system_capabilities table', () => {
    it('creates the table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS system_capabilities/);
    });

    it('keys on capability_key TEXT', () => {
      expect(sql).toMatch(/capability_key\s+TEXT PRIMARY KEY/);
    });

    it('has required_integrations as TEXT array', () => {
      expect(sql).toMatch(/required_integrations\s+TEXT\[\]/);
    });

    it('has helpful_for_intents as TEXT array', () => {
      expect(sql).toMatch(/helpful_for_intents\s+TEXT\[\]/);
    });

    it('enables RLS as read-only for authenticated users', () => {
      expect(sql).toMatch(/ALTER TABLE system_capabilities ENABLE ROW LEVEL SECURITY/);
      expect(sql).toMatch(
        /CREATE POLICY system_capabilities_authenticated_read[\s\S]+?FOR SELECT/,
      );
    });

    it('has a touch trigger', () => {
      expect(sql).toMatch(/CREATE TRIGGER system_capabilities_updated_at_trigger/);
    });
  });

  describe('user_capability_awareness table', () => {
    it('creates the table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS user_capability_awareness/);
    });

    it('has the 7-state awareness_state CHECK constraint locked', () => {
      const states = [
        'unknown',
        'introduced',
        'seen',
        'tried',
        'completed',
        'dismissed',
        'mastered',
      ];
      for (const s of states) {
        expect(sql).toContain(`'${s}'`);
      }
    });

    it('has composite primary key (tenant_id, user_id, capability_key)', () => {
      expect(sql).toMatch(/PRIMARY KEY \(tenant_id, user_id, capability_key\)/);
    });

    it('references system_capabilities via FK with ON DELETE CASCADE', () => {
      expect(sql).toMatch(/REFERENCES system_capabilities\(capability_key\)\s+ON DELETE CASCADE/);
    });

    it('tracks all 4 timestamp fields the ranker needs', () => {
      const fields = [
        'first_introduced_at',
        'last_introduced_at',
        'first_used_at',
        'last_used_at',
      ];
      for (const f of fields) expect(sql).toContain(f);
    });

    it('tracks use_count + dismiss_count (ranker dampening inputs)', () => {
      expect(sql).toMatch(/use_count\s+INT NOT NULL DEFAULT 0/);
      expect(sql).toMatch(/dismiss_count\s+INT NOT NULL DEFAULT 0/);
    });

    it('has mastery_confidence numeric(4,3)', () => {
      expect(sql).toMatch(/mastery_confidence\s+NUMERIC\(4,3\)/);
    });

    it('enables RLS with tenant isolation via user_tenants', () => {
      expect(sql).toMatch(/ALTER TABLE user_capability_awareness ENABLE ROW LEVEL SECURITY/);
      expect(sql).toMatch(/user_capability_awareness_tenant_isolation/);
      expect(sql).toMatch(/user_tenants/);
    });

    it('indexes (tenant_id, user_id) for per-user ranker reads', () => {
      expect(sql).toMatch(/user_capability_awareness_user_idx/);
      expect(sql).toMatch(/\(tenant_id, user_id\)/);
    });

    it('indexes awareness_state for operator histogram queries', () => {
      expect(sql).toMatch(/user_capability_awareness_state_idx/);
      expect(sql).toMatch(/\(awareness_state\)/);
    });
  });

  describe('seed data', () => {
    const expectedSeedKeys = [
      'life_compass',
      'vitana_index',
      'diary_entry',
      'community_post',
      'reminders',
      'calendar_connect',
      'activity_match',
      'live_room',
      'community_intent',
      'invite_contact',
      'autopilot',
      'memory_garden',
      'marketplace',
      'scheduling',
    ];

    it.each(expectedSeedKeys)('seeds capability_key=%s', (key) => {
      expect(sql).toContain(`'${key}'`);
    });

    it('uses ON CONFLICT DO UPDATE so the seed is idempotent', () => {
      expect(sql).toMatch(/ON CONFLICT \(capability_key\) DO UPDATE/);
    });

    it('does NOT seed the deferred match-journey capabilities', () => {
      const matchJourneyDeferred = [
        'pre_match_whois',
        'should_i_show_interest',
        'draft_opener',
        'activity_plan_card',
        'match_chat_assist',
        'post_activity_reflection',
        'next_rep_suggestion',
      ];
      for (const key of matchJourneyDeferred) {
        // Each could legitimately appear in a comment, but never as a
        // seeded capability_key (which lives inside a VALUES tuple).
        const seedPattern = new RegExp(`\\('${key}'`);
        expect(sql).not.toMatch(seedPattern);
      }
    });
  });

  describe('documentation', () => {
    it('has COMMENT ON the awareness_state column with the full ladder', () => {
      expect(sql).toMatch(/COMMENT ON COLUMN user_capability_awareness\.awareness_state/);
      expect(sql).toMatch(/unknown.*introduced.*seen.*tried.*completed.*dismissed.*mastered/s);
    });

    it('documents the marketing-dump forbidden rule', () => {
      expect(sql).toMatch(/marketing-dump/i);
    });
  });
});
