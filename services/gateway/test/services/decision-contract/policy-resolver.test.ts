// VTID-03116 (Phase B.3) — PolicyResolver tests.
//
// The resolver itself is the unit under test. Tests prime the in-memory
// cache via `configurePolicyResolverForTests` so no Supabase or network
// roundtrip is involved — the cache shape is the contract.

import {
  POLICY_KEYS,
  RENDER_BLOCK_KEYS,
  configurePolicyResolverForTests,
  __resetPolicyResolverForTests,
  getPolicyResolver,
} from '../../../src/services/decision-contract';

const TENANT_A = '00000000-0000-0000-0000-000000000aaa';
const TENANT_B = '00000000-0000-0000-0000-000000000bbb';

const RECENT_PAST = new Date(Date.now() - 60_000).toISOString();
const FAR_PAST = new Date(Date.now() - 86_400_000).toISOString();
const FAR_FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const RECENT_FUTURE = new Date(Date.now() + 60_000).toISOString();

beforeEach(() => {
  __resetPolicyResolverForTests();
});

afterAll(() => {
  __resetPolicyResolverForTests();
});

describe('PolicyResolver — getValue', () => {
  it('returns the unwrapped value when one effective row exists', () => {
    configurePolicyResolverForTests({
      decisionPolicy: [
        {
          policy_key: POLICY_KEYS.SESSION_RECENCY_RECONNECT_MAX_SECONDS,
          tenant_id: null,
          version: 1,
          value_json: 120,
          effective_from: RECENT_PAST,
          effective_until: null,
        },
      ],
    });
    const v = getPolicyResolver().getValue<number>(
      POLICY_KEYS.SESSION_RECENCY_RECONNECT_MAX_SECONDS,
    );
    expect(v).toBe(120);
  });

  it('picks the highest version among effective candidates', () => {
    configurePolicyResolverForTests({
      decisionPolicy: [
        {
          policy_key: POLICY_KEYS.SESSION_RECENCY_RECENT_MAX_MINUTES,
          tenant_id: null,
          version: 1,
          value_json: 15,
          effective_from: FAR_PAST,
          effective_until: null,
        },
        {
          policy_key: POLICY_KEYS.SESSION_RECENCY_RECENT_MAX_MINUTES,
          tenant_id: null,
          version: 2,
          value_json: 20,
          effective_from: RECENT_PAST,
          effective_until: null,
        },
      ],
    });
    expect(
      getPolicyResolver().getValue<number>(
        POLICY_KEYS.SESSION_RECENCY_RECENT_MAX_MINUTES,
      ),
    ).toBe(20);
  });

  it('skips rows whose effective_from is in the future', () => {
    configurePolicyResolverForTests({
      decisionPolicy: [
        {
          policy_key: POLICY_KEYS.SESSION_RECENCY_RECENT_MAX_MINUTES,
          tenant_id: null,
          version: 1,
          value_json: 15,
          effective_from: RECENT_PAST,
          effective_until: null,
        },
        {
          policy_key: POLICY_KEYS.SESSION_RECENCY_RECENT_MAX_MINUTES,
          tenant_id: null,
          version: 2,
          value_json: 99,
          effective_from: RECENT_FUTURE,
          effective_until: null,
        },
      ],
    });
    expect(
      getPolicyResolver().getValue<number>(
        POLICY_KEYS.SESSION_RECENCY_RECENT_MAX_MINUTES,
      ),
    ).toBe(15);
  });

  it('skips rows whose effective_until has passed', () => {
    configurePolicyResolverForTests({
      decisionPolicy: [
        {
          policy_key: POLICY_KEYS.SESSION_RECENCY_RECENT_MAX_MINUTES,
          tenant_id: null,
          version: 2,
          value_json: 99,
          effective_from: FAR_PAST,
          effective_until: RECENT_PAST,
        },
        {
          policy_key: POLICY_KEYS.SESSION_RECENCY_RECENT_MAX_MINUTES,
          tenant_id: null,
          version: 1,
          value_json: 15,
          effective_from: FAR_PAST,
          effective_until: null,
        },
      ],
    });
    expect(
      getPolicyResolver().getValue<number>(
        POLICY_KEYS.SESSION_RECENCY_RECENT_MAX_MINUTES,
      ),
    ).toBe(15);
  });

  it('prefers a tenant-specific row over a global default', () => {
    configurePolicyResolverForTests({
      decisionPolicy: [
        {
          policy_key: POLICY_KEYS.SESSION_RECENCY_TODAY_MAX_HOURS,
          tenant_id: null,
          version: 1,
          value_json: 24,
          effective_from: RECENT_PAST,
          effective_until: null,
        },
        {
          policy_key: POLICY_KEYS.SESSION_RECENCY_TODAY_MAX_HOURS,
          tenant_id: TENANT_A,
          version: 1,
          value_json: 12,
          effective_from: RECENT_PAST,
          effective_until: null,
        },
      ],
    });
    expect(
      getPolicyResolver().getValue<number>(
        POLICY_KEYS.SESSION_RECENCY_TODAY_MAX_HOURS,
        { tenantId: TENANT_A },
      ),
    ).toBe(12);
    // No tenant filter still returns the global default.
    expect(
      getPolicyResolver().getValue<number>(
        POLICY_KEYS.SESSION_RECENCY_TODAY_MAX_HOURS,
      ),
    ).toBe(24);
    // Caller for a different tenant gets the global default.
    expect(
      getPolicyResolver().getValue<number>(
        POLICY_KEYS.SESSION_RECENCY_TODAY_MAX_HOURS,
        { tenantId: TENANT_B },
      ),
    ).toBe(24);
  });

  it('returns the supplied defaultValue on cache miss (never throws)', () => {
    configurePolicyResolverForTests({});
    expect(
      getPolicyResolver().getValue<number>('session.never_seeded', {
        defaultValue: 7,
      }),
    ).toBe(7);
  });

  it('returns the supplied defaultValue when all candidates are expired', () => {
    configurePolicyResolverForTests({
      decisionPolicy: [
        {
          policy_key: 'session.expired',
          tenant_id: null,
          version: 1,
          value_json: 42,
          effective_from: FAR_PAST,
          effective_until: RECENT_PAST,
        },
      ],
    });
    expect(
      getPolicyResolver().getValue<number>('session.expired', {
        defaultValue: -1,
      }),
    ).toBe(-1);
  });
});

describe('PolicyResolver — getRenderBlock', () => {
  it('returns the content for a matching (block_key, language) row', () => {
    configurePolicyResolverForTests({
      policyRenderBlock: [
        {
          block_key: RENDER_BLOCK_KEYS.GREETING_BUCKET_RECONNECT,
          language: 'en',
          tenant_id: null,
          version: 1,
          content: 'EN content',
          effective_from: RECENT_PAST,
          effective_until: null,
        },
      ],
    });
    expect(
      getPolicyResolver().getRenderBlock(
        RENDER_BLOCK_KEYS.GREETING_BUCKET_RECONNECT,
        'en',
      ),
    ).toBe('EN content');
  });

  it('falls back to en when the requested language has no row', () => {
    configurePolicyResolverForTests({
      policyRenderBlock: [
        {
          block_key: RENDER_BLOCK_KEYS.GREETING_BUCKET_RECENT,
          language: 'en',
          tenant_id: null,
          version: 1,
          content: 'EN fallback',
          effective_from: RECENT_PAST,
          effective_until: null,
        },
      ],
    });
    expect(
      getPolicyResolver().getRenderBlock(
        RENDER_BLOCK_KEYS.GREETING_BUCKET_RECENT,
        'de',
      ),
    ).toBe('EN fallback');
  });

  it('returns defaultValue when neither requested language nor en exists', () => {
    configurePolicyResolverForTests({});
    expect(
      getPolicyResolver().getRenderBlock(
        RENDER_BLOCK_KEYS.GREETING_BUCKET_LONG,
        'fr',
        { defaultValue: 'safe-default' },
      ),
    ).toBe('safe-default');
  });

  it('prefers a tenant-specific row over global for the same (block_key, language)', () => {
    configurePolicyResolverForTests({
      policyRenderBlock: [
        {
          block_key: RENDER_BLOCK_KEYS.GREETING_BUCKET_TODAY,
          language: 'en',
          tenant_id: null,
          version: 1,
          content: 'GLOBAL',
          effective_from: RECENT_PAST,
          effective_until: null,
        },
        {
          block_key: RENDER_BLOCK_KEYS.GREETING_BUCKET_TODAY,
          language: 'en',
          tenant_id: TENANT_A,
          version: 1,
          content: 'TENANT_A',
          effective_from: RECENT_PAST,
          effective_until: null,
        },
      ],
    });
    expect(
      getPolicyResolver().getRenderBlock(
        RENDER_BLOCK_KEYS.GREETING_BUCKET_TODAY,
        'en',
        { tenantId: TENANT_A },
      ),
    ).toBe('TENANT_A');
    expect(
      getPolicyResolver().getRenderBlock(
        RENDER_BLOCK_KEYS.GREETING_BUCKET_TODAY,
        'en',
      ),
    ).toBe('GLOBAL');
  });
});

describe('PolicyResolver — resilience', () => {
  it('never throws when the cache is empty', () => {
    __resetPolicyResolverForTests();
    expect(() =>
      getPolicyResolver().getValue<number>('any.key', { defaultValue: 0 }),
    ).not.toThrow();
    expect(() =>
      getPolicyResolver().getRenderBlock('any.block', 'en', {
        defaultValue: '',
      }),
    ).not.toThrow();
  });

  it('warm-up against a missing Supabase env is non-fatal', async () => {
    // Tests are run without SUPABASE_URL, so getSupabase() returns null
    // (see services/gateway/src/lib/supabase.ts). `refresh()` should
    // resolve with empty caches and not throw.
    __resetPolicyResolverForTests();
    await expect(getPolicyResolver().refresh()).resolves.toBeUndefined();
  });
});
