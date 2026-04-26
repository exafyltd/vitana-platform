/**
 * VTID-01966 — memory_audit_log unit tests
 *
 * Verifies the graceful no-op contract when SUPABASE_URL/SUPABASE_SERVICE_ROLE
 * are unset (e.g. CI). The live audit-write path is exercised against the
 * deployed Supabase RPC after migration.
 */

import {
  appendMemoryAuditRow,
  auditMemoryRead,
  auditMemoryWrite,
  type MemoryAuditOp,
} from '../src/services/memory-audit';

describe('memory_audit_log (no Supabase env — graceful no-op)', () => {
  const origUrl = process.env.SUPABASE_URL;
  const origSr = process.env.SUPABASE_SERVICE_ROLE;

  beforeAll(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
  });

  afterAll(() => {
    if (origUrl) process.env.SUPABASE_URL = origUrl;
    if (origSr) process.env.SUPABASE_SERVICE_ROLE = origSr;
  });

  it('appendMemoryAuditRow does not throw when Supabase env is unset', async () => {
    await expect(
      appendMemoryAuditRow({
        tenant_id: 't',
        user_id: '00000000-0000-0000-0000-000000000000',
        op: 'read',
        tier: 'tier0',
        actor_id: 'orb-live',
      })
    ).resolves.toBeUndefined();
  });

  it('auditMemoryRead does not throw with full payload', async () => {
    await expect(
      auditMemoryRead({
        tenant_id: 't',
        user_id: '00000000-0000-0000-0000-000000000000',
        tier: 'context-pack-builder',
        actor_id: 'conversation-orb',
        source_engine: 'context-pack-builder',
        source_event_id: 'pack-123',
        health_scope: true,
        details: {
          intent: 'recall_recent',
          blocks_returned: ['MEMORY', 'CALENDAR'],
          item_counts: { memory_garden: 5, knowledge_hub: 0, web_search: 0 },
          latency_ms: 42,
          cache_hit: true,
          tokens_used: 1234,
        },
      })
    ).resolves.toBeUndefined();
  });

  it('auditMemoryWrite does not throw with full payload', async () => {
    await expect(
      auditMemoryWrite({
        tenant_id: 't',
        user_id: '00000000-0000-0000-0000-000000000000',
        tier: 'memory_facts',
        actor_id: 'cognee-extractor',
        source_engine: 'cognee-extractor',
        confidence: 0.85,
        health_scope: true,
        identity_scope: false,
        details: { fact_key: 'sleep_avg_hours', fact_value: '7.2' },
      })
    ).resolves.toBeUndefined();
  });

  it('accepts all four op types', async () => {
    const ops: MemoryAuditOp[] = ['read', 'write', 'delete', 'consolidate'];
    for (const op of ops) {
      await expect(
        appendMemoryAuditRow({
          tenant_id: 't',
          user_id: '00000000-0000-0000-0000-000000000000',
          op,
          tier: 'test',
          actor_id: 'test',
        })
      ).resolves.toBeUndefined();
    }
  });
});
