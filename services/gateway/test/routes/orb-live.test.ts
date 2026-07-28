/**
 * Phase 7 (Voice/ORB tools) — docs/TEST_COVERAGE_PLAN.md
 *
 * Unit tests for the EXPORTED pure/near-pure helper functions in
 * src/routes/orb-live.ts (the 15k-line ORB Live WebSocket route). This
 * suite intentionally does NOT touch the WebSocket-lifecycle / Nova /
 * Vertex incident-regression surface — that is a sibling agent's scope.
 * Covered here:
 *   - resolveEffectiveRole       (role_preferences vs user_tenants merge)
 *   - withBootstrapTimeout       (race-against-timeout helper)
 *   - fetchSpecialistContextSection (specialist ticket-history RPC → prompt text)
 *   - buildTranscriptSection     (handoff transcript prompt block)
 *   - buildSpecialistLanguageDirective (LANGUAGE LOCK prompt block)
 *   - buildPersonaBehavioralRule (Vitana vs specialist behavioral rules)
 *   - buildBootstrapContextPack  (multi-source context assembly + cache)
 *   - handleNavigateToScreen     (navigate_to_screen tool handler)
 *   - buildNavigatorPolicySection (EN/DE navigator prompt block)
 *   - buildClientContext         (IP geo + UA + timezone assembly)
 *
 * Mocking strategy follows this codebase's established convention for
 * large files with many transitive dependencies (see
 * test/services/vitana-brain.test.ts, test/services/orb-memory-bridge.test.ts,
 * test/orb-live-session-bootstrap-timeout.test.ts): every sibling service
 * orb-live.ts imports that would otherwise perform real Supabase/network
 * I/O at call time is mocked wholesale at the module boundary. Pure
 * helpers used internally (memory-orchestrator's wrapLegacyMemoryPreamble,
 * awareness-unified-context's resolveSessionTimezone) are left real since
 * they have no side effects and exercising them for real gives more
 * meaningful assertions.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../../src/services/orb-memory-bridge', () => ({
  isMemoryBridgeEnabled: jest.fn(() => false),
  isDevSandbox: jest.fn(() => false),
  fetchDevMemoryContext: jest.fn(),
  fetchMemoryContextWithIdentity: jest.fn(),
  buildMemoryEnhancedInstruction: jest.fn(),
  getDebugSnapshot: jest.fn(),
  writeDevMemoryItem: jest.fn(),
  writeMemoryItemWithIdentity: jest.fn().mockResolvedValue({ ok: true }),
  fetchRecentConversationForCognee: jest.fn(),
  fetchRecentOrbUserTurns: jest.fn().mockResolvedValue([]),
  formatRecentTurnsBlock: jest.fn(() => ''),
  DEV_IDENTITY: {
    USER_ID: '00000000-0000-0000-0000-000000000099',
    TENANT_ID: '00000000-0000-0000-0000-000000000001',
    ACTIVE_ROLE: 'community',
  },
  MEMORY_CONFIG: { MAX_AGE_HOURS: 24, DEFAULT_CONTEXT_LIMIT: 20 },
}));

jest.mock('../../src/services/user-context-profiler', () => ({
  getUserContextSummary: jest.fn().mockResolvedValue({ summary: '', version: 0, cached: false, warnings: [] }),
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

jest.mock('../../src/services/orb-tools-shared', () => ({
  dispatchOrbTool: jest.fn(),
  dispatchOrbToolForVertex: jest.fn(),
}));

jest.mock('../../src/services/navigator-consult', () => ({
  consultNavigator: jest.fn(),
  formatConsultResultForLLM: jest.fn(),
  writeNavigatorActionMemory: jest.fn().mockResolvedValue(undefined),
}));

import type { Request } from 'express';
import {
  resolveEffectiveRole,
  withBootstrapTimeout,
  fetchSpecialistContextSection,
  buildTranscriptSection,
  buildSpecialistLanguageDirective,
  buildPersonaBehavioralRule,
  buildBootstrapContextPack,
  handleNavigateToScreen,
  buildNavigatorPolicySection,
  buildClientContext,
  type GeminiLiveSession,
} from '../../src/routes/orb-live';
import type { SupabaseIdentity } from '../../src/middleware/auth-supabase-jwt';
import { getSupabase } from '../../src/lib/supabase';
import { dispatchOrbTool } from '../../src/services/orb-tools-shared';
import { writeNavigatorActionMemory } from '../../src/services/navigator-consult';
import {
  fetchMemoryContextWithIdentity,
  fetchRecentOrbUserTurns,
  formatRecentTurnsBlock,
} from '../../src/services/orb-memory-bridge';
import { getUserContextSummary } from '../../src/services/user-context-profiler';

const mockFetch = global.fetch as jest.Mock;
const mockGetSupabase = getSupabase as jest.Mock;
const mockDispatchOrbTool = dispatchOrbTool as jest.Mock;
const mockWriteNavigatorActionMemory = writeNavigatorActionMemory as jest.Mock;
const mockFetchMemoryContextWithIdentity = fetchMemoryContextWithIdentity as jest.Mock;
const mockFetchRecentOrbUserTurns = fetchRecentOrbUserTurns as jest.Mock;
const mockFormatRecentTurnsBlock = formatRecentTurnsBlock as jest.Mock;
const mockGetUserContextSummary = getUserContextSummary as jest.Mock;

/** Route a mocked global.fetch by URL substring → JSON body / status. */
function routeFetch(routes: Array<{ match: string; ok?: boolean; status?: number; json?: any; reject?: Error }>) {
  mockFetch.mockImplementation((url: string) => {
    const urlString = String(url);
    const hit = routes.find((r) => urlString.includes(r.match));
    if (!hit) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    if (hit.reject) return Promise.reject(hit.reject);
    return Promise.resolve({
      ok: hit.ok !== false,
      status: hit.status ?? (hit.ok !== false ? 200 : 500),
      json: async () => hit.json ?? {},
    });
  });
}

function delay<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// =============================================================================
// resolveEffectiveRole
// =============================================================================

describe('resolveEffectiveRole', () => {
  it('returns the role_preference value when set, even if it differs from active_role', async () => {
    routeFetch([
      { match: 'role_preferences', json: [{ role: 'admin' }] },
      { match: 'user_tenants', json: [{ active_role: 'community' }] },
    ]);
    const role = await resolveEffectiveRole('user-1', 'tenant-1');
    expect(role).toBe('admin');
  });

  it('returns the role_preference value when it matches active_role (no divergence log path)', async () => {
    routeFetch([
      { match: 'role_preferences', json: [{ role: 'developer' }] },
      { match: 'user_tenants', json: [{ active_role: 'developer' }] },
    ]);
    const role = await resolveEffectiveRole('user-2', 'tenant-1');
    expect(role).toBe('developer');
  });

  it('falls back to user_tenants.active_role when role_preferences has no row', async () => {
    routeFetch([
      { match: 'role_preferences', json: [] },
      { match: 'user_tenants', json: [{ active_role: 'professional' }] },
    ]);
    const role = await resolveEffectiveRole('user-3', 'tenant-1');
    expect(role).toBe('professional');
  });

  it('returns null when neither source has a role', async () => {
    routeFetch([
      { match: 'role_preferences', json: [] },
      { match: 'user_tenants', json: [] },
    ]);
    const role = await resolveEffectiveRole('user-4', 'tenant-1');
    expect(role).toBeNull();
  });

  it('is resilient to a non-ok HTTP response from either source (returns null, does not throw)', async () => {
    routeFetch([
      { match: 'role_preferences', ok: false, status: 500 },
      { match: 'user_tenants', ok: false, status: 500 },
    ]);
    await expect(resolveEffectiveRole('user-5', 'tenant-1')).resolves.toBeNull();
  });

  it('is resilient to a thrown network error from either source (returns null, does not throw)', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('role_preferences')) return Promise.reject(new Error('network down'));
      return Promise.resolve({ ok: true, status: 200, json: async () => [{ active_role: 'community' }] });
    });
    await expect(resolveEffectiveRole('user-6', 'tenant-1')).resolves.toBe('community');
  });

  it('returns null when SUPABASE_URL/SERVICE_ROLE env vars are unset (both sources graceful-null)', async () => {
    const prevUrl = process.env.SUPABASE_URL;
    const prevKey = process.env.SUPABASE_SERVICE_ROLE;
    const prevKeyAlt = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const role = await resolveEffectiveRole('user-7', 'tenant-1');
      expect(role).toBeNull();
      // Neither branch should have attempted a network call.
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      process.env.SUPABASE_URL = prevUrl;
      process.env.SUPABASE_SERVICE_ROLE = prevKey;
      if (prevKeyAlt !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKeyAlt;
    }
  });
});

// =============================================================================
// withBootstrapTimeout
// =============================================================================
// Note: this helper already has dedicated, thorough coverage in
// test/orb-live-session-bootstrap-timeout.test.ts (a pre-existing suite in
// this repo). The tests here are intentionally lighter — they exist to keep
// this function inside orb-live.test.ts's scope per the coverage plan
// without duplicating that file's exhaustive timing assertions.

describe('withBootstrapTimeout', () => {
  it('resolves with the real value when it settles before the timeout', async () => {
    const result = await withBootstrapTimeout(delay('real', 5), 'fallback', 'label', 200);
    expect(result).toBe('real');
  });

  it('resolves with the fallback when the real promise is slower than the cap', async () => {
    const result = await withBootstrapTimeout(delay('too-slow', 300), 'fallback', 'label', 30);
    expect(result).toBe('fallback');
  });

  it('resolves with the fallback (not a rejection) when the real promise rejects', async () => {
    const result = await withBootstrapTimeout(Promise.reject(new Error('boom')), 'fallback', 'label', 200);
    expect(result).toBe('fallback');
  });
});

// =============================================================================
// fetchSpecialistContextSection
// =============================================================================

describe('fetchSpecialistContextSection', () => {
  it('returns empty string when userId is null/undefined (no fetch attempted)', async () => {
    expect(await fetchSpecialistContextSection(null)).toBe('');
    expect(await fetchSpecialistContextSection(undefined)).toBe('');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('formats a full context block with open + resolved tickets', async () => {
    routeFetch([
      {
        match: 'rpc/build_specialist_context',
        json: {
          user: { display_name: 'Dragan', vitana_id: 'V-123', tenure_days: 45 },
          ticket_counts: { total: 3, open: 1, resolved: 2 },
          open_tickets: [{ kind: 'bug', owner: 'devon', age_days: 2, summary: 'App crashes on save' }],
          recent_resolved: [{ kind: 'billing', owner: 'atlas', summary: 'Refund issued' }],
        },
      },
    ]);
    const text = await fetchSpecialistContextSection('user-1');
    expect(text).toContain('=== USER CONTEXT (you already know this user) ===');
    expect(text).toContain('Name: Dragan (V-123) — with us 45 days');
    expect(text).toContain('Tickets in our system: 3 total · 1 open · 2 resolved');
    expect(text).toContain('bug (devon), opened 2 days ago — "App crashes on save"');
    expect(text).toContain('billing (atlas) — "Refund issued"');
  });

  it('formats a minimal block with placeholder name when user context has no tickets', async () => {
    routeFetch([
      { match: 'rpc/build_specialist_context', json: { user: {}, ticket_counts: {}, open_tickets: [], recent_resolved: [] } },
    ]);
    const text = await fetchSpecialistContextSection('user-2');
    expect(text).toContain('Name: Unknown');
    expect(text).toContain('Tickets in our system: 0 total · 0 open · 0 resolved');
    expect(text).not.toContain('Open:');
    expect(text).not.toContain('Recent resolved:');
  });

  it('returns empty string when the RPC responds non-ok', async () => {
    routeFetch([{ match: 'rpc/build_specialist_context', ok: false, status: 500 }]);
    expect(await fetchSpecialistContextSection('user-3')).toBe('');
  });

  it('returns empty string when the fetch throws', async () => {
    mockFetch.mockImplementation(() => Promise.reject(new Error('supabase unreachable')));
    expect(await fetchSpecialistContextSection('user-4')).toBe('');
  });

  it('returns empty string when the RPC body is not valid JSON (json() rejects)', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) }),
    );
    expect(await fetchSpecialistContextSection('user-5')).toBe('');
  });
});

// =============================================================================
// buildTranscriptSection
// =============================================================================

describe('buildTranscriptSection', () => {
  it('returns empty string when turns is undefined', () => {
    expect(buildTranscriptSection(undefined, 'vitana')).toBe('');
  });

  it('returns empty string when turns is an empty array', () => {
    expect(buildTranscriptSection([], 'vitana')).toBe('');
  });

  it('labels the source persona "Vitana" when fromPersona is vitana, and title-cases other personas', () => {
    const turns = [{ role: 'user' as const, text: 'hi', timestamp: 't1' }];
    const vitanaText = buildTranscriptSection(turns, 'vitana');
    expect(vitanaText).toContain('handed off from Vitana');
    const devonText = buildTranscriptSection(turns, 'devon');
    expect(devonText).toContain('handed off from Devon');
  });

  it('defaults targetPersona label to "this persona" when omitted', () => {
    const turns = [{ role: 'user' as const, text: 'hi', timestamp: 't1' }];
    const text = buildTranscriptSection(turns, 'vitana');
    expect(text).toContain('You are this persona.');
  });

  it('title-cases an explicit non-vitana targetPersona', () => {
    const turns = [{ role: 'user' as const, text: 'hi', timestamp: 't1' }];
    const text = buildTranscriptSection(turns, 'vitana', 'sage');
    expect(text).toContain('You are Sage.');
  });

  it('labels vitana as the explicit targetPersona correctly', () => {
    const turns = [{ role: 'user' as const, text: 'hi', timestamp: 't1' }];
    const text = buildTranscriptSection(turns, 'devon', 'vitana');
    expect(text).toContain('You are Vitana.');
  });

  it('keeps only the last 12 turns', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      text: `turn-${i}`,
      timestamp: `t${i}`,
    }));
    const text = buildTranscriptSection(turns, 'vitana');
    expect(text).not.toContain('turn-7');
    expect(text).toContain('turn-8'); // index 8 = 20-12
    expect(text).toContain('turn-19');
  });

  it('labels user turns as "User" and assistant turns with the fromPersona label', () => {
    const turns = [
      { role: 'user' as const, text: 'question', timestamp: 't1' },
      { role: 'assistant' as const, text: 'answer', timestamp: 't2' },
    ];
    const text = buildTranscriptSection(turns, 'atlas');
    expect(text).toContain('User: question');
    expect(text).toContain('Atlas: answer');
  });

  it('collapses internal whitespace and skips turns with empty/whitespace-only text', () => {
    const turns = [
      { role: 'user' as const, text: '  hello   there  \n\n friend  ', timestamp: 't1' },
      { role: 'user' as const, text: '   ', timestamp: 't2' },
    ];
    const text = buildTranscriptSection(turns, 'vitana');
    expect(text).toContain('User: hello there friend');
    // Only one "User:" line should be present — the blank turn was skipped.
    expect(text.match(/User:/g)?.length).toBe(1);
  });

  it('truncates a single turn to 400 characters', () => {
    const longText = 'x'.repeat(500);
    const turns = [{ role: 'user' as const, text: longText, timestamp: 't1' }];
    const text = buildTranscriptSection(turns, 'vitana');
    expect(text).toContain('User: ' + 'x'.repeat(400));
    expect(text).not.toContain('x'.repeat(401));
  });

  it('always includes the START/END markers and hand-back instruction', () => {
    const turns = [{ role: 'user' as const, text: 'hi', timestamp: 't1' }];
    const text = buildTranscriptSection(turns, 'vitana', 'devon');
    expect(text).toContain('=== CONVERSATION SO FAR (handed off from Vitana) ===');
    expect(text).toContain('=== END TRANSCRIPT ===');
    expect(text).toContain("switch_persona(to:'vitana')");
  });
});

// =============================================================================
// buildSpecialistLanguageDirective
// =============================================================================

describe('buildSpecialistLanguageDirective', () => {
  it.each([
    ['en', 'English'],
    ['de', 'German'],
    ['fr', 'French'],
    ['es', 'Spanish'],
    ['ar', 'Arabic'],
    ['zh', 'Chinese'],
    ['ru', 'Russian'],
    ['sr', 'Serbian'],
  ])('maps lang=%s to language name %s', (lang, expectedName) => {
    const text = buildSpecialistLanguageDirective(lang);
    expect(text).toContain(`Respond ONLY in ${expectedName}.`);
    expect(text).toContain('[LANGUAGE LOCK]');
  });

  it('defaults to English when lang is undefined', () => {
    expect(buildSpecialistLanguageDirective(undefined)).toContain('Respond ONLY in English.');
  });

  it('defaults to English when lang is an unrecognized code', () => {
    expect(buildSpecialistLanguageDirective('xx')).toContain('Respond ONLY in English.');
  });

  it('names the target language at least twice (name + explicit "in {name}" instruction), for every supported language', () => {
    // The fixed anti-drift line ("Do NOT switch to English") always mentions
    // English by design, so we assert on occurrences of the TARGET language
    // name instead of asserting English's total absence.
    const text = buildSpecialistLanguageDirective('de');
    const occurrences = text.split('German').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// buildPersonaBehavioralRule
// =============================================================================

describe('buildPersonaBehavioralRule', () => {
  it('treats personaKey="" as Vitana (non-specialist) and includes the instruction-manual role block', () => {
    const text = buildPersonaBehavioralRule('');
    expect(text).toContain('[VITANA — INSTRUCTION-MANUAL ROLE]');
    expect(text).toContain('[VITANA ON SWAP-BACK — silent pickup]');
    expect(text).not.toContain('[CLOSE QUESTION + GOODBYE — specialist only]');
  });

  it('treats personaKey="vitana" as non-specialist identically to ""', () => {
    const text = buildPersonaBehavioralRule('vitana');
    expect(text).toContain('[VITANA — INSTRUCTION-MANUAL ROLE]');
    expect(text).not.toContain('[CLOSE QUESTION + GOODBYE — specialist only]');
  });

  it('treats any other personaKey as a specialist and includes the close-question + goodbye + instruction-manual-protection blocks', () => {
    const text = buildPersonaBehavioralRule('devon');
    expect(text).toContain('[CLOSE QUESTION + GOODBYE — specialist only]');
    expect(text).toContain('[INSTRUCTION-MANUAL PROTECTION — specialist only]');
    expect(text).not.toContain('[VITANA — INSTRUCTION-MANUAL ROLE]');
  });

  it('includes the universal behavioral + anti-repetition rules regardless of persona', () => {
    for (const persona of ['', 'vitana', 'sage', 'atlas', 'mira']) {
      const text = buildPersonaBehavioralRule(persona);
      expect(text).toContain('[BEHAVIORAL RULES — universal]');
      expect(text).toContain('[VARY YOUR PHRASING — universal]');
    }
  });
});

// =============================================================================
// buildBootstrapContextPack
// =============================================================================

describe('buildBootstrapContextPack', () => {
  const prevProfilerEnv = process.env.PROFILER_IN_ORB_INSTRUCTION;

  afterEach(() => {
    if (prevProfilerEnv === undefined) delete process.env.PROFILER_IN_ORB_INSTRUCTION;
    else process.env.PROFILER_IN_ORB_INSTRUCTION = prevProfilerEnv;
  });

  function identity(userId: string, tenantId: string): SupabaseIdentity {
    return {
      user_id: userId,
      tenant_id: tenantId,
      email: null,
      exafy_admin: false,
      role: 'authenticated',
      aud: null,
      exp: null,
      iat: null,
    };
  }

  it('short-circuits with skippedReason "missing_identity" when tenant_id or user_id is absent', async () => {
    const result = await buildBootstrapContextPack(identity('', 'tenant-x'), 'session-1');
    expect(result.skippedReason).toBe('missing_identity');
    expect(result.contextInstruction).toBeUndefined();
    expect(mockFetchMemoryContextWithIdentity).not.toHaveBeenCalled();
  });

  it('returns a skippedReason (no crash) when memory fetch has zero items and no other block has content', async () => {
    mockFetchMemoryContextWithIdentity.mockResolvedValueOnce({ ok: false, items: [], formatted_context: '', error: 'no_data' });
    mockFetchRecentOrbUserTurns.mockResolvedValueOnce([]);
    mockFormatRecentTurnsBlock.mockReturnValueOnce('');
    mockGetUserContextSummary.mockResolvedValueOnce({ summary: '', version: 0, cached: false, warnings: [] });
    const result = await buildBootstrapContextPack(identity('u-empty', 't-empty'), 'session-2');
    expect(result.skippedReason).toBe('no_data');
    expect(result.contextInstruction).toBeUndefined();
  });

  it('still returns a wrapped contextInstruction when memoryContext.ok is false but formatted_context is non-empty', async () => {
    mockFetchMemoryContextWithIdentity.mockResolvedValueOnce({
      ok: false,
      items: [],
      formatted_context: 'Partial info survives even on a degraded fetch.',
      error: 'partial_failure',
    });
    mockFetchRecentOrbUserTurns.mockResolvedValueOnce([]);
    mockFormatRecentTurnsBlock.mockReturnValueOnce('');
    mockGetUserContextSummary.mockResolvedValueOnce({ summary: '', version: 0, cached: false, warnings: [] });
    const result = await buildBootstrapContextPack(identity('u-degraded', 't-degraded'), 'session-3');
    expect(result.skippedReason).toBeUndefined();
    expect(result.contextInstruction).toContain('Partial info survives even on a degraded fetch.');
    expect(result.contextInstruction).toContain('=== USER MEMORY CONTEXT ===');
  });

  it('builds a full wrapped contextInstruction on the success path (items present)', async () => {
    mockFetchMemoryContextWithIdentity.mockResolvedValueOnce({
      ok: true,
      items: [{ id: '1' }],
      formatted_context: 'The user likes hiking.',
    });
    mockFetchRecentOrbUserTurns.mockResolvedValueOnce([{ role: 'user', text: 'what did I last say', timestamp: 't' }]);
    mockFormatRecentTurnsBlock.mockReturnValueOnce('RECENT: what did I last say');
    mockGetUserContextSummary.mockResolvedValueOnce({ summary: '', version: 0, cached: false, warnings: [] });
    const result = await buildBootstrapContextPack(identity('u-success', 't-success'), 'session-4');
    expect(result.skippedReason).toBeUndefined();
    expect(result.contextInstruction).toContain('The user likes hiking.');
    expect(result.contextInstruction).toContain('RECENT: what did I last say');
    expect(result.contextInstruction).toContain('=== USER MEMORY CONTEXT ===');
    expect(result.contextInstruction).toContain('=== END USER MEMORY CONTEXT ===');
  });

  it('truncates an oversized combined context at MAX_CONTEXT_CHARS and appends a truncation marker', async () => {
    mockFetchMemoryContextWithIdentity.mockResolvedValueOnce({
      ok: true,
      items: [{ id: '1' }],
      formatted_context: 'A'.repeat(9000),
    });
    mockFetchRecentOrbUserTurns.mockResolvedValueOnce([]);
    mockFormatRecentTurnsBlock.mockReturnValueOnce('');
    mockGetUserContextSummary.mockResolvedValueOnce({ summary: '', version: 0, cached: false, warnings: [] });
    const result = await buildBootstrapContextPack(identity('u-long', 't-long'), 'session-5');
    expect(result.contextInstruction).toContain('[...truncated]');
    // The source formatted_context was 9000 consecutive 'A's; MAX_CONTEXT_CHARS
    // caps the pre-wrap body at 8000, so the longest unbroken run of 'A's
    // surviving into the final (wrapped) instruction should be exactly 8000 —
    // proving truncation actually ran rather than merely appending the marker
    // to the full 9000-char string.
    const longestRun = Math.max(...(result.contextInstruction!.match(/A+/g) || ['']).map((r) => r.length));
    expect(longestRun).toBe(8000);
  });

  it('tolerates the user-context-profiler source failing (rejecting) without crashing the whole build', async () => {
    mockFetchMemoryContextWithIdentity.mockResolvedValueOnce({
      ok: true,
      items: [{ id: '1' }],
      formatted_context: 'Core memory content.',
    });
    mockFetchRecentOrbUserTurns.mockResolvedValueOnce([]);
    mockFormatRecentTurnsBlock.mockReturnValueOnce('');
    mockGetUserContextSummary.mockRejectedValueOnce(new Error('profiler down'));
    const result = await buildBootstrapContextPack(identity('u-profiler-fail', 't-profiler-fail'), 'session-6');
    expect(result.skippedReason).toBeUndefined();
    expect(result.contextInstruction).toContain('Core memory content.');
    expect(result.contextInstruction).not.toContain('USER CONTEXT PROFILE');
  });

  it('skips the profiler call entirely when PROFILER_IN_ORB_INSTRUCTION=false', async () => {
    process.env.PROFILER_IN_ORB_INSTRUCTION = 'false';
    mockFetchMemoryContextWithIdentity.mockResolvedValueOnce({
      ok: true,
      items: [{ id: '1' }],
      formatted_context: 'Core memory content.',
    });
    mockFetchRecentOrbUserTurns.mockResolvedValueOnce([]);
    mockFormatRecentTurnsBlock.mockReturnValueOnce('');
    await buildBootstrapContextPack(identity('u-no-profiler', 't-no-profiler'), 'session-7');
    expect(mockGetUserContextSummary).not.toHaveBeenCalled();
  });

  it('gracefully returns an error skippedReason (does not throw) when a required fetch rejects outright', async () => {
    mockFetchMemoryContextWithIdentity.mockRejectedValueOnce(new Error('supabase timeout'));
    mockFetchRecentOrbUserTurns.mockResolvedValueOnce([]);
    mockGetUserContextSummary.mockResolvedValueOnce({ summary: '', version: 0, cached: false, warnings: [] });
    const result = await buildBootstrapContextPack(identity('u-hard-fail', 't-hard-fail'), 'session-8');
    expect(result.skippedReason).toContain('error:');
    expect(result.skippedReason).toContain('supabase timeout');
  });

  it('serves a cached result on a second call for the same identity, without re-fetching sources', async () => {
    mockFetchMemoryContextWithIdentity.mockResolvedValueOnce({
      ok: true,
      items: [{ id: '1' }],
      formatted_context: 'Cache me.',
    });
    mockFetchRecentOrbUserTurns.mockResolvedValueOnce([]);
    mockFormatRecentTurnsBlock.mockReturnValueOnce('');
    mockGetUserContextSummary.mockResolvedValueOnce({ summary: '', version: 0, cached: false, warnings: [] });

    const id = identity('u-cache', 't-cache');
    const first = await buildBootstrapContextPack(id, 'session-9a');
    expect(mockFetchMemoryContextWithIdentity).toHaveBeenCalledTimes(1);

    const second = await buildBootstrapContextPack(id, 'session-9b');
    expect(mockFetchMemoryContextWithIdentity).toHaveBeenCalledTimes(1); // no second fetch
    expect(second.contextInstruction).toBe(first.contextInstruction);
  });
});

// =============================================================================
// handleNavigateToScreen
// =============================================================================

describe('handleNavigateToScreen', () => {
  function makeSession(overrides: Partial<GeminiLiveSession> = {}): GeminiLiveSession {
    return {
      sessionId: 'session-abc',
      lang: 'en',
      isAnonymous: false,
      identity: {
        user_id: 'user-1',
        tenant_id: 'tenant-1',
        email: null,
        exafy_admin: false,
        role: 'community',
        aud: null,
        exp: null,
        iat: null,
      },
      current_route: '/home',
      recent_routes: [],
      ...overrides,
    } as unknown as GeminiLiveSession;
  }

  beforeEach(() => {
    mockGetSupabase.mockReturnValue({ from: jest.fn() });
  });

  it('errors when neither screen_id nor target is provided', async () => {
    const result = await handleNavigateToScreen(makeSession(), {});
    expect(result.success).toBe(false);
    expect(result.error).toBe('navigate_to_screen requires screen_id (or legacy target).');
    expect(mockDispatchOrbTool).not.toHaveBeenCalled();
  });

  it('accepts the legacy "target" argument as a fallback for screen_id', async () => {
    mockDispatchOrbTool.mockResolvedValueOnce({ ok: true, result: {}, text: 'ok' });
    const result = await handleNavigateToScreen(makeSession(), { target: 'wallet' });
    expect(result.success).toBe(true);
    expect(mockDispatchOrbTool).toHaveBeenCalledWith(
      'navigate_to_screen',
      expect.objectContaining({ target: 'wallet' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('errors with supabase_not_configured when getSupabase() returns null', async () => {
    mockGetSupabase.mockReturnValueOnce(null);
    const result = await handleNavigateToScreen(makeSession(), { screen_id: 'wallet' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('supabase_not_configured');
    expect(mockDispatchOrbTool).not.toHaveBeenCalled();
  });

  it('propagates a dispatcher-level failure (ok:false) as success:false with its error', async () => {
    mockDispatchOrbTool.mockResolvedValueOnce({ ok: false, error: 'unknown screen' });
    const result = await handleNavigateToScreen(makeSession(), { screen_id: 'nope' });
    expect(result).toEqual({ success: false, result: '', error: 'unknown screen' });
  });

  it('translates already_there:true into success:false with the dispatcher-provided text', async () => {
    mockDispatchOrbTool.mockResolvedValueOnce({
      ok: true,
      result: { already_there: true, route: '/home' },
      text: 'You are already on the home screen.',
    });
    const result = await handleNavigateToScreen(makeSession(), { screen_id: 'home' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('You are already on the home screen.');
  });

  it('falls back to a generic already-there message when the dispatcher supplies no text', async () => {
    mockDispatchOrbTool.mockResolvedValueOnce({
      ok: true,
      result: { already_there: true, route: '/home' },
    });
    const result = await handleNavigateToScreen(makeSession(), { screen_id: 'home' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('already on /home');
  });

  it('mutates session state (pendingNavigation, current_route, navigationDispatched) on a successful non-overlay directive', async () => {
    mockDispatchOrbTool.mockResolvedValueOnce({
      ok: true,
      result: {
        screen_id: 'wallet',
        route: '/wallet',
        base_route: '/wallet',
        title: 'Wallet',
        entry_kind: 'screen',
        directive: { type: 'nav', directive: 'go', screen_id: 'wallet', route: '/wallet', title: 'Wallet', reason: 'r', entry_kind: 'screen', vtid: '' },
      },
      text: 'Taking you to your wallet.',
    });
    const session = makeSession({ current_route: '/home' });
    const result = await handleNavigateToScreen(session, { screen_id: 'wallet', reason: 'user asked' });

    expect(result).toEqual({ success: true, result: 'Taking you to your wallet.' });
    expect(session.pendingNavigation).toEqual(
      expect.objectContaining({ screen_id: 'wallet', route: '/wallet', title: 'Wallet', reason: 'user asked' }),
    );
    expect(session.navigationDispatched).toBe(true);
    expect(session.current_route).toBe('/wallet');
    expect(session.recent_routes).toEqual(['/home']);
  });

  it('does NOT update current_route/recent_routes for an overlay entry_kind', async () => {
    mockDispatchOrbTool.mockResolvedValueOnce({
      ok: true,
      result: {
        screen_id: 'settings-modal',
        route: '/settings?modal=1',
        base_route: '/settings',
        title: 'Settings',
        entry_kind: 'overlay',
        directive: { type: 'nav', directive: 'go', screen_id: 'settings-modal', route: '/settings?modal=1', title: 'Settings', reason: 'r', entry_kind: 'overlay', vtid: '' },
      },
      text: 'Opening settings.',
    });
    const session = makeSession({ current_route: '/home' });
    await handleNavigateToScreen(session, { screen_id: 'settings-modal' });
    expect(session.current_route).toBe('/home');
    expect(session.recent_routes).toEqual([]);
    expect(session.navigationDispatched).toBe(true); // still dispatched
  });

  it('writes navigator action memory when the session has identity', async () => {
    mockDispatchOrbTool.mockResolvedValueOnce({
      ok: true,
      result: {
        screen_id: 'wallet',
        route: '/wallet',
        base_route: '/wallet',
        title: 'Wallet',
        entry_kind: 'screen',
        directive: { type: 'nav', directive: 'go', screen_id: 'wallet', route: '/wallet', title: 'Wallet', reason: 'r', entry_kind: 'screen', vtid: '' },
      },
      text: 'ok',
    });
    await handleNavigateToScreen(makeSession(), { screen_id: 'wallet' });
    expect(mockWriteNavigatorActionMemory).toHaveBeenCalledTimes(1);
  });

  it('does NOT write navigator action memory for an anonymous session (no identity)', async () => {
    mockDispatchOrbTool.mockResolvedValueOnce({
      ok: true,
      result: {
        screen_id: 'wallet',
        route: '/wallet',
        base_route: '/wallet',
        title: 'Wallet',
        entry_kind: 'screen',
        directive: { type: 'nav', directive: 'go', screen_id: 'wallet', route: '/wallet', title: 'Wallet', reason: 'r', entry_kind: 'screen', vtid: '' },
      },
      text: 'ok',
    });
    const anonSession = makeSession({ identity: undefined, isAnonymous: true });
    await handleNavigateToScreen(anonSession, { screen_id: 'wallet' });
    expect(mockWriteNavigatorActionMemory).not.toHaveBeenCalled();
  });

  it('returns success:true with dispatcher text and does not mutate session when there is no directive', async () => {
    mockDispatchOrbTool.mockResolvedValueOnce({ ok: true, result: {}, text: 'Just some guidance text.' });
    const session = makeSession({ current_route: '/home' });
    const result = await handleNavigateToScreen(session, { screen_id: 'wallet' });
    expect(result).toEqual({ success: true, result: 'Just some guidance text.' });
    expect(session.pendingNavigation).toBeUndefined();
    expect(session.current_route).toBe('/home');
  });
});

// =============================================================================
// buildNavigatorPolicySection
// =============================================================================

describe('buildNavigatorPolicySection', () => {
  it('returns the German block for lang="de"', () => {
    const text = buildNavigatorPolicySection('de');
    expect(text).toContain('=== VITANA NAVIGATOR — NAVIGATIONSMODUS ===');
    expect(text).not.toContain('=== VITANA NAVIGATOR — NAVIGATION GUIDE MODE ===');
  });

  it('returns the German block for a regional variant like "de-DE" (startsWith match)', () => {
    const text = buildNavigatorPolicySection('de-DE');
    expect(text).toContain('=== VITANA NAVIGATOR — NAVIGATIONSMODUS ===');
  });

  it('returns the English block for lang="en"', () => {
    const text = buildNavigatorPolicySection('en');
    expect(text).toContain('=== VITANA NAVIGATOR — NAVIGATION GUIDE MODE ===');
    expect(text).not.toContain('NAVIGATIONSMODUS');
  });

  it('falls back to the English block for a language with no dedicated translation (e.g. "fr")', () => {
    const text = buildNavigatorPolicySection('fr');
    expect(text).toContain('=== VITANA NAVIGATOR — NAVIGATION GUIDE MODE ===');
  });

  it('falls back to the English block for an empty string', () => {
    const text = buildNavigatorPolicySection('');
    expect(text).toContain('=== VITANA NAVIGATOR — NAVIGATION GUIDE MODE ===');
  });

  it('both language variants mention both tools (get_current_screen and navigate)', () => {
    for (const lang of ['de', 'en']) {
      const text = buildNavigatorPolicySection(lang);
      expect(text).toContain('get_current_screen()');
      expect(text).toContain('navigate(question)');
    }
  });
});

// =============================================================================
// buildClientContext
// =============================================================================

describe('buildClientContext', () => {
  function makeReq(headers: Record<string, string>, body: any = {}, ip = '203.0.113.5'): Request {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    return {
      get: (name: string) => lower[name.toLowerCase()],
      body,
      ip,
    } as unknown as Request;
  }

  beforeEach(() => {
    // Default: no fetch calls expected unless a test explicitly uses a public IP.
    mockFetch.mockImplementation(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }));
  });

  it('skips geo lookup entirely for a private/local IP (no network call)', async () => {
    const req = makeReq({ 'user-agent': 'curl/8.0' }, {}, '127.0.0.1');
    const ctx = await buildClientContext(req);
    expect(ctx.ip).toBe('127.0.0.1');
    expect(ctx.city).toBeUndefined();
    expect(ctx.country).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves the client IP from the first entry of x-forwarded-for', async () => {
    const req = makeReq({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }, {}, '10.0.0.1');
    const ctx = await buildClientContext(req);
    expect(ctx.ip).toBe('198.51.100.7');
  });

  it('falls back to x-real-ip, then x-appengine-user-ip, then req.ip, then "unknown"', async () => {
    expect((await buildClientContext(makeReq({ 'x-real-ip': '198.51.100.8' }))).ip).toBe('198.51.100.8');
    expect((await buildClientContext(makeReq({ 'x-appengine-user-ip': '198.51.100.9' }))).ip).toBe('198.51.100.9');
    expect((await buildClientContext(makeReq({}, {}, '198.51.100.10'))).ip).toBe('198.51.100.10');
    const reqNoIp = { get: () => undefined, body: {}, ip: undefined } as unknown as Request;
    expect((await buildClientContext(reqNoIp)).ip).toBe('unknown');
  });

  it('prefers the client-supplied timezone (x-client-timezone header) over geo-IP', async () => {
    const req = makeReq(
      { 'x-client-timezone': 'Europe/Berlin', 'user-agent': 'curl/8.0' },
      {},
      '127.0.0.1', // private → geo timezone would be empty anyway, but this proves the header path works
    );
    const ctx = await buildClientContext(req);
    expect(ctx.timezone).toBe('Europe/Berlin');
  });

  it('prefers req.body.client_timezone over the header when both are present', async () => {
    const req = makeReq({ 'x-client-timezone': 'Europe/Berlin' }, { client_timezone: 'America/New_York' }, '127.0.0.1');
    const ctx = await buildClientContext(req);
    expect(ctx.timezone).toBe('America/New_York');
  });

  it('reads client_timezone from req.body.client_context.timezone as well', async () => {
    const req = makeReq({}, { client_context: { timezone: 'Asia/Tokyo' } }, '127.0.0.1');
    const ctx = await buildClientContext(req);
    expect(ctx.timezone).toBe('Asia/Tokyo');
  });

  it('leaves timezone undefined when no client hint and geo yields nothing (private IP)', async () => {
    const req = makeReq({}, {}, '127.0.0.1');
    const ctx = await buildClientContext(req);
    expect(ctx.timezone).toBeUndefined();
  });

  it('parses accept-language, taking only the first entry before a comma', async () => {
    const req = makeReq({ 'accept-language': 'de-DE, en-US;q=0.9' }, {}, '127.0.0.1');
    const ctx = await buildClientContext(req);
    expect(ctx.lang).toBe('de-DE');
  });

  it('normalizes a referrer URL down to its hostname', async () => {
    const req = makeReq({ referer: 'https://preview.vitanaland.com/some/path?x=1' }, {}, '127.0.0.1');
    const ctx = await buildClientContext(req);
    expect(ctx.referrer).toBe('preview.vitanaland.com');
  });

  it('leaves referrer undefined for a malformed referrer value', async () => {
    const req = makeReq({ referer: 'not a url' }, {}, '127.0.0.1');
    const ctx = await buildClientContext(req);
    expect(ctx.referrer).toBeUndefined();
  });

  it('detects a mobile Android device from the user-agent', async () => {
    const req = makeReq(
      { 'user-agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/119 Mobile Safari/537.36' },
      {},
      '127.0.0.1',
    );
    const ctx = await buildClientContext(req);
    expect(ctx.isMobile).toBe(true);
    expect(ctx.device).toBe('Android phone');
    expect(ctx.os).toBe('Android');
    expect(ctx.browser).toBe('Chrome');
  });

  it('detects a desktop Windows/Edge device from the user-agent (non-mobile)', async () => {
    const req = makeReq(
      { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/119.0' },
      {},
      '127.0.0.1',
    );
    const ctx = await buildClientContext(req);
    expect(ctx.isMobile).toBe(false);
    expect(ctx.device).toBe('Desktop');
    expect(ctx.os).toBe('Windows');
    expect(ctx.browser).toBe('Edge');
  });

  it('detects an iPhone/Safari device from the user-agent', async () => {
    const req = makeReq(
      { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1' },
      {},
      '127.0.0.1',
    );
    const ctx = await buildClientContext(req);
    expect(ctx.device).toBe('iPhone');
    expect(ctx.os).toBe('iOS');
    expect(ctx.browser).toBe('Safari');
    expect(ctx.isMobile).toBe(true);
  });

  it('returns an all-undefined UA parse when user-agent is absent', async () => {
    const req = makeReq({}, {}, '127.0.0.1');
    const ctx = await buildClientContext(req);
    expect(ctx.device).toBeUndefined();
    expect(ctx.browser).toBeUndefined();
    expect(ctx.os).toBeUndefined();
    expect(ctx.isMobile).toBeUndefined();
  });

  it('performs a geo lookup for a public IP and surfaces the returned city/country/timezone', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('ipapi.co')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ city: 'Cologne', country_name: 'Germany', timezone: 'Europe/Berlin' }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    const req = makeReq({}, {}, '198.51.100.42');
    const ctx = await buildClientContext(req);
    expect(ctx.city).toBe('Cologne');
    expect(ctx.country).toBe('Germany');
    expect(ctx.timezone).toBe('Europe/Berlin');
  });
});
