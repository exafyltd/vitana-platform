// Awareness Registry (BOOTSTRAP-AWARENESS-REGISTRY) — unit tests
//
// Scope:
//   1. Manifest accessors — getManifest() / getSignal() integrity.
//   2. getAwarenessConfig() snapshot building — manifest defaults, DB
//      override merge (including the locked-signal invariant and param
//      merge-not-replace), the 60s cache + invalidateAwarenessConfigCache(),
//      and in-flight request de-duplication.
//   3. fetchOverrides() error handling (silent on missing-table, warns
//      otherwise).
//   4. getAwarenessConfigSync() — cache-hit passthrough vs. defaults-only
//      fallback when nothing is warm.
//
// Mocking strategy: this file calls `createClient` from `@supabase/supabase-js`
// directly (not the shared lib/supabase helper), so we mock that module at
// the boundary. `test/__mocks__/setup-tests.ts` sets SUPABASE_URL /
// SUPABASE_SERVICE_ROLE globally, so the "no client available" cases must
// explicitly delete those env vars for the duration of the test.

const mockSelect = jest.fn();
const mockFrom = jest.fn(() => ({ select: mockSelect }));
const mockCreateClient = jest.fn(() => ({ from: mockFrom }));

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: any[]) => mockCreateClient(...args),
}));

import {
  getManifest,
  getSignal,
  getAwarenessConfig,
  invalidateAwarenessConfigCache,
  getAwarenessConfigSync,
} from '../../src/services/awareness-registry';

const ORIGINAL_ENV = { ...process.env };

function setOverrideRows(rows: Array<{ key: string; enabled: boolean; params?: Record<string, unknown> }>) {
  mockSelect.mockResolvedValue({ data: rows, error: null });
}

function setOverrideError(message: string) {
  mockSelect.mockResolvedValue({ data: null, error: { message } });
}

function removeSupabaseEnv() {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE;
}

function restoreSupabaseEnv() {
  process.env.SUPABASE_URL = ORIGINAL_ENV.SUPABASE_URL ?? 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE = ORIGINAL_ENV.SUPABASE_SERVICE_ROLE ?? 'test-service-role-key-mock';
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  invalidateAwarenessConfigCache();
  restoreSupabaseEnv();
  setOverrideRows([]); // default: no overrides configured
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// 1. Manifest accessors
// ---------------------------------------------------------------------------

describe('getManifest / getSignal', () => {
  it('returns a non-empty manifest with no duplicate keys', () => {
    const manifest = getManifest();
    expect(manifest.length).toBeGreaterThan(50);
    const keys = manifest.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every signal declares a key, tier, subcategory, and default_on', () => {
    for (const sig of getManifest()) {
      expect(typeof sig.key).toBe('string');
      expect(sig.key.length).toBeGreaterThan(0);
      expect(typeof sig.tier).toBe('string');
      expect(typeof sig.subcategory).toBe('string');
      expect(typeof sig.default_on).toBe('boolean');
    }
  });

  it('getSignal returns the exact manifest entry for a known locked identity signal', () => {
    const sig = getSignal('identity.user_id');
    expect(sig).toBeDefined();
    expect(sig?.tier).toBe('identity');
    expect(sig?.locked).toBe(true);
    expect(sig?.default_on).toBe(true);
  });

  it('getSignal returns undefined for a key not in the manifest', () => {
    expect(getSignal('not.a.real.signal.key')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. getAwarenessConfig() — manifest defaults (no DB overrides)
// ---------------------------------------------------------------------------

describe('getAwarenessConfig — defaults only', () => {
  it('isEnabled reflects default_on for a signal defaulted on', async () => {
    const cfg = await getAwarenessConfig();
    expect(cfg.isEnabled('identity.user_id')).toBe(true);
  });

  it('isEnabled reflects default_on=false for a signal defaulted off', async () => {
    const cfg = await getAwarenessConfig();
    // activity.nav.include_page_view is default_on: false in the manifest.
    expect(cfg.isEnabled('activity.nav.include_page_view')).toBe(false);
  });

  it('getParam returns the manifest param default when no override exists', async () => {
    const cfg = await getAwarenessConfig();
    expect(cfg.getParam('memory.items.enabled', 'max_age_hours', -1)).toBe(168);
    expect(cfg.getParam('memory.items.enabled', 'max_count', -1)).toBe(50);
  });

  it('getParam returns the fallback for an unknown signal key', async () => {
    const cfg = await getAwarenessConfig();
    expect(cfg.getParam('not.a.real.signal', 'x', 'fallback-value')).toBe('fallback-value');
  });

  it('getParam returns the fallback for a known signal but unknown param key', async () => {
    const cfg = await getAwarenessConfig();
    expect(cfg.getParam('memory.items.enabled', 'not_a_real_param', 'fallback')).toBe('fallback');
  });

  it('isEnabled treats an unknown signal key as enabled and logs a warning', async () => {
    const cfg = await getAwarenessConfig();
    expect(cfg.isEnabled('totally.unknown.key')).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('totally.unknown.key'));
  });

  it('every manifest key has a resolved entry sourced as "default"', async () => {
    const cfg = await getAwarenessConfig();
    for (const sig of getManifest()) {
      expect(cfg.resolved[sig.key]).toBeDefined();
      expect(cfg.resolved[sig.key].source).toBe('default');
      expect(cfg.resolved[sig.key].enabled).toBe(sig.default_on);
    }
  });

  it('built_at is a parseable ISO timestamp', async () => {
    const cfg = await getAwarenessConfig();
    expect(new Date(cfg.built_at).toString()).not.toBe('Invalid Date');
  });
});

// ---------------------------------------------------------------------------
// 2b. getAwarenessConfig() — DB override merge
// ---------------------------------------------------------------------------

describe('getAwarenessConfig — DB override merge', () => {
  it('a non-locked signal is disabled by an override row', async () => {
    setOverrideRows([{ key: 'preferences.explicit.enabled', enabled: false, params: {} }]);
    const cfg = await getAwarenessConfig();
    expect(cfg.isEnabled('preferences.explicit.enabled')).toBe(false);
    expect(cfg.resolved['preferences.explicit.enabled'].source).toBe('override');
  });

  it('a LOCKED signal stays enabled even when the override says disabled', async () => {
    // memory.facts.enabled is locked: true, default_on: true.
    setOverrideRows([{ key: 'memory.facts.enabled', enabled: false, params: {} }]);
    const cfg = await getAwarenessConfig();
    expect(cfg.isEnabled('memory.facts.enabled')).toBe(true);
    expect(cfg.resolved['memory.facts.enabled'].source).toBe('override');
  });

  it('override params merge over defaults rather than replacing the whole param set', async () => {
    setOverrideRows([
      { key: 'memory.items.enabled', enabled: true, params: { max_count: 10 } },
    ]);
    const cfg = await getAwarenessConfig();
    // Overridden param takes the new value...
    expect(cfg.getParam('memory.items.enabled', 'max_count', -1)).toBe(10);
    // ...but the untouched default param is preserved, not dropped.
    expect(cfg.getParam('memory.items.enabled', 'max_age_hours', -1)).toBe(168);
  });

  it('a signal with no matching override row still resolves from manifest defaults', async () => {
    setOverrideRows([{ key: 'preferences.explicit.enabled', enabled: false, params: {} }]);
    const cfg = await getAwarenessConfig();
    expect(cfg.resolved['identity.user_id'].source).toBe('default');
    expect(cfg.isEnabled('identity.user_id')).toBe(true);
  });

  it('serviceClient() is not built and defaults are used when SUPABASE env vars are absent', async () => {
    removeSupabaseEnv();
    invalidateAwarenessConfigCache();
    const cfg = await getAwarenessConfig();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(cfg.resolved['identity.user_id'].source).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// 2c. fetchOverrides() error handling
// ---------------------------------------------------------------------------

describe('getAwarenessConfig — fetchOverrides error handling', () => {
  it('a missing-table error is swallowed silently (no console.warn) and falls back to defaults', async () => {
    setOverrideError('relation "public.awareness_config" does not exist');
    const cfg = await getAwarenessConfig();
    expect(cfg.resolved['identity.user_id'].source).toBe('default');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a non-missing-table error is logged via console.warn and falls back to defaults', async () => {
    setOverrideError('connection refused');
    const cfg = await getAwarenessConfig();
    expect(cfg.resolved['identity.user_id'].source).toBe('default');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
  });
});

// ---------------------------------------------------------------------------
// 3. Caching + invalidation + in-flight dedupe
// ---------------------------------------------------------------------------

describe('getAwarenessConfig — caching behavior', () => {
  it('returns the identical cached snapshot object on a second call within the TTL', async () => {
    const first = await getAwarenessConfig();
    const second = await getAwarenessConfig();
    expect(second).toBe(first);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('invalidateAwarenessConfigCache() forces a fresh snapshot + a fresh DB read', async () => {
    const first = await getAwarenessConfig();
    invalidateAwarenessConfigCache();
    const second = await getAwarenessConfig();
    expect(second).not.toBe(first);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it('concurrent calls before the first resolves share a single in-flight fetch', async () => {
    let resolveSelect: (v: any) => void;
    mockSelect.mockReturnValue(
      new Promise((resolve) => {
        resolveSelect = resolve;
      }),
    );

    const p1 = getAwarenessConfig();
    const p2 = getAwarenessConfig();

    resolveSelect!({ data: [], error: null });
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toBe(b);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. getAwarenessConfigSync()
// ---------------------------------------------------------------------------

describe('getAwarenessConfigSync', () => {
  it('returns the exact warm cached snapshot when one exists', async () => {
    const warmed = await getAwarenessConfig();
    const sync = getAwarenessConfigSync();
    expect(sync).toBe(warmed);
  });

  it('returns a manifest-defaults-only snapshot (ignoring any DB overrides) when nothing is cached', () => {
    // Configure an override that would flip a non-locked signal off — but
    // since getAwarenessConfigSync() never awaits the DB, it must not see it.
    setOverrideRows([{ key: 'preferences.explicit.enabled', enabled: false, params: {} }]);
    invalidateAwarenessConfigCache();

    const sync = getAwarenessConfigSync();
    expect(sync.isEnabled('preferences.explicit.enabled')).toBe(true);
    expect(sync.resolved['preferences.explicit.enabled'].source).toBe('default');
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
