/**
 * VTID-02970 (PR-L5): Unit tests for the repair pattern store.
 *
 * Pure helpers tested directly. The networked record/find/markPatternOutcome
 * paths are tested with a mocked fetch since they're tiny REST wrappers.
 */

import {
  shouldQuarantineAfter,
  matchesSignature,
  recordPattern,
  findPatternBySignature,
  markPatternOutcome,
} from '../src/services/repair-pattern-store';

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

// =============================================================================
// shouldQuarantineAfter
// =============================================================================

describe('shouldQuarantineAfter', () => {
  it('does NOT quarantine on the first failure (single flake = pattern still trusted)', () => {
    expect(shouldQuarantineAfter(1)).toBe(false);
  });

  it('quarantines on the SECOND consecutive failure', () => {
    expect(shouldQuarantineAfter(2)).toBe(true);
  });

  it('stays quarantined for higher counts (idempotent threshold check)', () => {
    expect(shouldQuarantineAfter(3)).toBe(true);
    expect(shouldQuarantineAfter(99)).toBe(true);
  });

  it('returns false for zero failures (fresh / just-recorded pattern)', () => {
    expect(shouldQuarantineAfter(0)).toBe(false);
  });
});

// =============================================================================
// matchesSignature — exact match in v1
// =============================================================================

describe('matchesSignature', () => {
  const sig = 'gateway.alive:status_mismatch: got 500, expected 200';

  it('matches identical strings', () => {
    expect(matchesSignature(sig, sig)).toBe(true);
  });

  it('does NOT match if any character differs (v1 is exact-equality only)', () => {
    expect(matchesSignature(sig, sig + ' ')).toBe(false);
    expect(matchesSignature(sig, 'gateway.alive:status_mismatch: got 503, expected 200')).toBe(false);
  });

  it('case-sensitive (different command_keys are different signatures)', () => {
    expect(matchesSignature('Gateway.alive:err', 'gateway.alive:err')).toBe(false);
  });
});

// =============================================================================
// recordPattern — upsert semantics
// =============================================================================

describe('recordPattern', () => {
  function mockSupabase(opts: {
    existing?: Array<{ id: string; success_count: number; failure_count: number }>;
    failPatch?: boolean;
    failInsert?: boolean;
  } = {}) {
    const captured: Array<{ url: string; method: string; body: any }> = [];
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
      captured.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null });
      // Lookup query
      if (url.includes('fault_signature=eq.') && url.includes('capability=eq.') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify(opts.existing ?? []), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // PATCH (existing path bump)
      if (url.includes('/repair_patterns?id=eq.') && init?.method === 'PATCH') {
        if (opts.failPatch) return new Response('boom', { status: 500 });
        const merged = { id: 'p-1', success_count: (opts.existing?.[0]?.success_count ?? 0) + 1, failure_count: 0, quarantined: false };
        return new Response(JSON.stringify([merged]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // INSERT (new pattern)
      if (url.endsWith('/rest/v1/repair_patterns') && init?.method === 'POST') {
        if (opts.failInsert) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify([{ id: 'p-new', success_count: 1, failure_count: 0, quarantined: false, fault_signature: 'x', capability: 'y', fix_diff: 'z' }]), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    return captured;
  }

  it('INSERTs a new row when no existing pattern matches (capability, fault_signature)', async () => {
    const captured = mockSupabase({ existing: [] });
    const out = await recordPattern({
      fault_signature: 'gateway.alive:status_mismatch: got 500, expected 200',
      capability: 'gateway_alive',
      fix_diff: '+console.log("ok")',
    });
    expect(out).not.toBeNull();
    expect(out!.success_count).toBe(1);
    const inserts = captured.filter((c) => c.method === 'POST' && !c.url.includes('id=eq.'));
    expect(inserts).toHaveLength(1);
  });

  it('PATCHes an existing row, BUMPING success_count and CLEARING failure_count', async () => {
    const captured = mockSupabase({ existing: [{ id: 'p-1', success_count: 2, failure_count: 1 }] });
    const out = await recordPattern({
      fault_signature: 'sig',
      capability: 'gateway_alive',
      fix_diff: 'updated diff',
    });
    expect(out).not.toBeNull();
    expect(out!.success_count).toBe(3);
    const patchCall = captured.find((c) => c.method === 'PATCH');
    expect(patchCall).toBeDefined();
    expect(patchCall!.body.success_count).toBe(3);
    expect(patchCall!.body.failure_count).toBe(0);
    expect(patchCall!.body.quarantined).toBe(false);
    // The new fix_diff replaces the old (most-recent verified is canonical)
    expect(patchCall!.body.fix_diff).toBe('updated diff');
  });

  it('returns null on Supabase PATCH failure (caller treats as "did not record")', async () => {
    mockSupabase({ existing: [{ id: 'p-1', success_count: 1, failure_count: 0 }], failPatch: true });
    const out = await recordPattern({ fault_signature: 'sig', capability: 'cap', fix_diff: 'd' });
    expect(out).toBeNull();
  });

  it('returns null on Supabase INSERT failure', async () => {
    mockSupabase({ existing: [], failInsert: true });
    const out = await recordPattern({ fault_signature: 'sig', capability: 'cap', fix_diff: 'd' });
    expect(out).toBeNull();
  });
});

// =============================================================================
// findPatternBySignature
// =============================================================================

describe('findPatternBySignature', () => {
  it('returns the highest-success_count NON-QUARANTINED match for the signature', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      // Verify the query EXCLUDES quarantined and orders by success_count desc
      expect(url).toContain('quarantined=eq.false');
      expect(url).toContain('order=success_count.desc');
      const row = { id: 'best', fault_signature: 'sig', capability: 'gateway_alive', fix_diff: 'd', success_count: 5, failure_count: 0, quarantined: false, target_file: null, source_pr_url: null, source_repair_vtid: null, last_used_at: null, created_at: '', updated_at: '' };
      return new Response(JSON.stringify([row]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const out = await findPatternBySignature('sig');
    expect(out!.id).toBe('best');
    expect(out!.success_count).toBe(5);
  });

  it('returns null when no pattern matches', async () => {
    global.fetch = jest.fn().mockImplementation(async () => {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    expect(await findPatternBySignature('unknown_sig')).toBeNull();
  });
});

// =============================================================================
// markPatternOutcome
// =============================================================================

describe('markPatternOutcome', () => {
  function mockOutcome(initial: { success_count: number; failure_count: number }) {
    let patchBody: any = null;
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
      if (url.includes('id=eq.') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify([initial]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('id=eq.') && init?.method === 'PATCH') {
        patchBody = JSON.parse(init.body);
        return new Response(JSON.stringify([{ ...initial, ...patchBody, id: 'p-1' }]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    return () => patchBody;
  }

  it('ok=true: bumps success_count, RESETS failure_count, clears quarantine', async () => {
    const getBody = mockOutcome({ success_count: 4, failure_count: 1 });
    const out = await markPatternOutcome('p-1', true);
    expect(out).not.toBeNull();
    const body = getBody();
    expect(body.success_count).toBe(5);
    expect(body.failure_count).toBe(0);
    expect(body.quarantined).toBe(false);
  });

  it('ok=false: bumps failure_count; first failure does NOT quarantine', async () => {
    const getBody = mockOutcome({ success_count: 3, failure_count: 0 });
    await markPatternOutcome('p-1', false);
    const body = getBody();
    expect(body.failure_count).toBe(1);
    expect(body.quarantined).toBe(false);
  });

  it('ok=false: SECOND consecutive failure auto-quarantines', async () => {
    const getBody = mockOutcome({ success_count: 3, failure_count: 1 });
    await markPatternOutcome('p-1', false);
    const body = getBody();
    expect(body.failure_count).toBe(2);
    expect(body.quarantined).toBe(true);
  });
});
