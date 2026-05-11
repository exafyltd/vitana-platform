/**
 * VTID-02923 (B0e.3) — Supabase-backed CapabilityFetcher tests.
 *
 * Verifies:
 *   - Read-only interface — no mutator methods exposed.
 *   - Empty/missing DB → empty arrays (provider then suppresses).
 *   - Row mapping handles missing / wrong-type columns defensively.
 *   - 60s awareness cache + 5min catalog cache.
 *   - Cache key is tenant+user (no cross-tenant bleed).
 */

import {
  createSupabaseCapabilityFetcher,
  resetSupabaseCapabilityFetcherCache,
  rowToCapability,
  rowToAwareness,
} from '../../../src/services/capability-awareness/supabase-capability-fetcher';

function makeFakeClient(behavior: {
  capabilities?: unknown[];
  awareness?: unknown[];
  capabilitiesError?: unknown;
  awarenessError?: unknown;
}) {
  let capabilityCalls = 0;
  let awarenessCalls = 0;
  const client = {
    from(table: string) {
      const isCap = table === 'system_capabilities';
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        async then(resolve: (v: unknown) => void) {
          if (isCap) {
            capabilityCalls++;
            resolve({
              data: behavior.capabilitiesError ? null : (behavior.capabilities ?? []),
              error: behavior.capabilitiesError ?? null,
            });
          } else {
            awarenessCalls++;
            resolve({
              data: behavior.awarenessError ? null : (behavior.awareness ?? []),
              error: behavior.awarenessError ?? null,
            });
          }
        },
      };
      return builder;
    },
  };
  return {
    client,
    counters: {
      get capability() { return capabilityCalls; },
      get awareness() { return awarenessCalls; },
    },
  };
}

describe('B0e.3 — Supabase-backed CapabilityFetcher', () => {
  beforeEach(() => resetSupabaseCapabilityFetcherCache());

  describe('read-only contract', () => {
    it('CapabilityFetcher interface exposes ONLY listCapabilities + listAwareness', () => {
      const fetcher = createSupabaseCapabilityFetcher({ getDb: () => null });
      const keys = Object.keys(fetcher).sort();
      expect(keys).toEqual(['listAwareness', 'listCapabilities']);
    });
  });

  describe('DB unavailable', () => {
    it('returns empty array when getSupabase returns null', async () => {
      const fetcher = createSupabaseCapabilityFetcher({ getDb: () => null });
      expect(await fetcher.listCapabilities()).toEqual([]);
      expect(await fetcher.listAwareness({ tenantId: 't', userId: 'u' })).toEqual([]);
    });

    it('returns empty array on Supabase error', async () => {
      const fake = makeFakeClient({
        capabilitiesError: { message: 'boom' },
        awarenessError: { message: 'boom' },
      });
      const fetcher = createSupabaseCapabilityFetcher({ getDb: () => fake.client as any });
      expect(await fetcher.listCapabilities()).toEqual([]);
      expect(await fetcher.listAwareness({ tenantId: 't', userId: 'u' })).toEqual([]);
    });
  });

  describe('row mapping', () => {
    it('rowToCapability handles missing fields gracefully', () => {
      const r = rowToCapability({});
      expect(r).toEqual({
        capability_key: '',
        display_name: '',
        description: '',
        required_role: null,
        required_tenant_features: null,
        required_integrations: null,
        helpful_for_intents: null,
        enabled: true,
      });
    });

    it('rowToCapability preserves arrays', () => {
      const r = rowToCapability({
        capability_key: 'x',
        display_name: 'X',
        description: 'D',
        required_role: 'community',
        required_integrations: ['google_calendar'],
        helpful_for_intents: ['log_meal'],
        enabled: true,
      });
      expect(r.required_integrations).toEqual(['google_calendar']);
      expect(r.helpful_for_intents).toEqual(['log_meal']);
    });

    it('rowToAwareness coerces unknown awareness_state to "unknown"', () => {
      const r = rowToAwareness({ capability_key: 'x', awareness_state: 'made_up' });
      expect(r.awareness_state).toBe('unknown');
    });

    it('rowToAwareness accepts every valid ladder state', () => {
      const states = ['unknown', 'introduced', 'seen', 'tried', 'completed', 'dismissed', 'mastered'];
      for (const s of states) {
        const r = rowToAwareness({ capability_key: 'x', awareness_state: s });
        expect(r.awareness_state).toBe(s);
      }
    });
  });

  describe('caching', () => {
    it('catalog read is cached (second call does not hit DB)', async () => {
      const fake = makeFakeClient({ capabilities: [{ capability_key: 'a', display_name: 'A', description: 'A' }] });
      const fetcher = createSupabaseCapabilityFetcher({
        getDb: () => fake.client as any,
        now: () => 1000,
      });
      await fetcher.listCapabilities();
      await fetcher.listCapabilities();
      expect(fake.counters.capability).toBe(1);
    });

    it('catalog cache expires after 5 minutes', async () => {
      const fake = makeFakeClient({ capabilities: [{ capability_key: 'a', display_name: 'A', description: 'A' }] });
      let nowMs = 1000;
      const fetcher = createSupabaseCapabilityFetcher({
        getDb: () => fake.client as any,
        now: () => nowMs,
      });
      await fetcher.listCapabilities();
      nowMs += 5 * 60 * 1000 + 1;
      await fetcher.listCapabilities();
      expect(fake.counters.capability).toBe(2);
    });

    it('awareness cache key is tenant+user (no cross-tenant bleed)', async () => {
      const fake = makeFakeClient({ awareness: [] });
      const fetcher = createSupabaseCapabilityFetcher({
        getDb: () => fake.client as any,
        now: () => 1000,
      });
      await fetcher.listAwareness({ tenantId: 'A', userId: 'u' });
      await fetcher.listAwareness({ tenantId: 'B', userId: 'u' });
      // Different tenant → fresh DB read.
      expect(fake.counters.awareness).toBe(2);
    });

    it('awareness cache expires after 60s', async () => {
      const fake = makeFakeClient({ awareness: [] });
      let nowMs = 1000;
      const fetcher = createSupabaseCapabilityFetcher({
        getDb: () => fake.client as any,
        now: () => nowMs,
      });
      await fetcher.listAwareness({ tenantId: 't', userId: 'u' });
      nowMs += 60 * 1000 + 1;
      await fetcher.listAwareness({ tenantId: 't', userId: 'u' });
      expect(fake.counters.awareness).toBe(2);
    });
  });
});
