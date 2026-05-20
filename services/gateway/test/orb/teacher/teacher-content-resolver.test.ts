/**
 * VTID-03112 (T1) — tests for the Teacher Mode content resolver.
 *
 * The resolver MUST:
 *   - Fetch the active capability row from system_capabilities.
 *   - Fetch the manual content from knowledge_docs at manual_path.
 *   - Build a Remaining list of up to 5 capabilities in pedagogical order,
 *     excluding the active one + everything already in the ledger.
 *   - Never throw — degrade to null on any failure so the audio path
 *     stays safe.
 */

import { resolveTeacherModeContent } from '../../../src/orb/teacher/teacher-content-resolver';

type FakeRow = Record<string, unknown>;

function fakeSb(opts: {
  catalog?: FakeRow[] | null;
  catalogError?: { message: string } | null;
  ledger?: FakeRow[] | null;
  ledgerError?: { message: string } | null;
  doc?: FakeRow | null;
  docError?: { message: string } | null;
  expectedPaths?: string[];
}) {
  let pathLookups = 0;
  return {
    pathLookups: () => pathLookups,
    from(table: string): any {
      if (table === 'system_capabilities') {
        const chain: any = { select: () => chain, eq: () => chain };
        chain.then = (resolve: any) =>
          resolve({ data: opts.catalog, error: opts.catalogError ?? null });
        return chain;
      }
      if (table === 'user_capability_awareness') {
        const chain: any = { select: () => chain, eq: () => chain };
        chain.then = (resolve: any) =>
          resolve({ data: opts.ledger, error: opts.ledgerError ?? null });
        return chain;
      }
      if (table === 'knowledge_docs') {
        const chain: any = {
          select: () => chain,
          eq: (_col: string, _val: string) => {
            pathLookups += 1;
            return chain;
          },
          maybeSingle: () =>
            Promise.resolve({ data: opts.doc, error: opts.docError ?? null }),
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as any;
}

const NOW_ISO = '2026-05-20T11:00:00Z';

const FIVE_PILLARS: FakeRow = {
  capability_key: 'five_pillars',
  display_name: 'The Five Pillars',
  description: 'Foundation concept',
  manual_path: '/manuals/maxina/00-concepts/five-pillars',
  enabled: true,
  pedagogical_order: 10,
};

const VITANA_ID: FakeRow = {
  capability_key: 'vitana_id',
  display_name: 'Your Vitana ID',
  description: 'Identity in the community',
  manual_path: '/manuals/maxina/00-concepts/vitana-id',
  enabled: true,
  pedagogical_order: 30,
};

const ACTIVITY_MATCH: FakeRow = {
  capability_key: 'activity_match',
  display_name: 'Activity Match',
  description: 'Match with community members',
  manual_path: '/manuals/maxina/03-community/activity-match',
  enabled: true,
  pedagogical_order: 140,
};

describe('VTID-03112 — resolveTeacherModeContent', () => {
  test('returns content for the active capability + remaining curriculum (no ledger)', async () => {
    const sb = fakeSb({
      catalog: [FIVE_PILLARS, VITANA_ID, ACTIVITY_MATCH],
      ledger: [],
      doc: { content: '# The Five Pillars\n\nThis is the manual.' },
    });
    const out = await resolveTeacherModeContent({
      supabase: sb,
      tenantId: 't1',
      userId: 'u1',
      activeCapabilityKey: 'five_pillars',
      nowIso: NOW_ISO,
    });
    expect(out).not.toBeNull();
    expect(out!.active_capability_key).toBe('five_pillars');
    expect(out!.active_display_name).toBe('The Five Pillars');
    expect(out!.active_manual_content).toContain('# The Five Pillars');
    // Remaining excludes the active capability AND walks pedagogical_order:
    // vitana_id (30) before activity_match (140).
    expect(out!.remaining_capabilities.length).toBeGreaterThanOrEqual(2);
    expect(out!.remaining_capabilities[0].capability_key).toBe('vitana_id');
    expect(out!.remaining_capabilities[1].capability_key).toBe('activity_match');
    // Active capability must NOT appear in the remaining list.
    expect(
      out!.remaining_capabilities.some((c) => c.capability_key === 'five_pillars'),
    ).toBe(false);
  });

  test('truncates oversized manual content to keep system_instruction bounded', async () => {
    const bigContent = 'X'.repeat(20000);
    const sb = fakeSb({
      catalog: [FIVE_PILLARS],
      ledger: [],
      doc: { content: bigContent },
    });
    const out = await resolveTeacherModeContent({
      supabase: sb,
      tenantId: 't1',
      userId: 'u1',
      activeCapabilityKey: 'five_pillars',
      nowIso: NOW_ISO,
    });
    expect(out).not.toBeNull();
    expect(out!.active_manual_content.length).toBeLessThan(7000);
    expect(out!.active_manual_content).toContain('[…truncated]');
  });

  test('missing knowledge_docs row degrades to empty manual content (still returns)', async () => {
    const sb = fakeSb({
      catalog: [FIVE_PILLARS],
      ledger: [],
      doc: null,
    });
    const out = await resolveTeacherModeContent({
      supabase: sb,
      tenantId: 't1',
      userId: 'u1',
      activeCapabilityKey: 'five_pillars',
      nowIso: NOW_ISO,
    });
    expect(out).not.toBeNull();
    expect(out!.active_manual_content).toBe('');
    expect(out!.active_display_name).toBe('The Five Pillars');
  });

  test('catalog error returns null (never throws)', async () => {
    const sb = fakeSb({
      catalog: null,
      catalogError: { message: 'simulated db outage' },
    });
    const out = await resolveTeacherModeContent({
      supabase: sb,
      tenantId: 't1',
      userId: 'u1',
      activeCapabilityKey: 'five_pillars',
      nowIso: NOW_ISO,
    });
    expect(out).toBeNull();
  });

  test('active capability not in catalog returns null', async () => {
    const sb = fakeSb({
      catalog: [VITANA_ID],
      ledger: [],
    });
    const out = await resolveTeacherModeContent({
      supabase: sb,
      tenantId: 't1',
      userId: 'u1',
      activeCapabilityKey: 'capability_does_not_exist',
      nowIso: NOW_ISO,
    });
    expect(out).toBeNull();
  });

  test('ledger filters out already-tried capabilities from remaining', async () => {
    const sb = fakeSb({
      catalog: [FIVE_PILLARS, VITANA_ID, ACTIVITY_MATCH],
      ledger: [
        // vitana_id already tried — excluded from remaining.
        {
          capability_key: 'vitana_id',
          awareness_state: 'tried',
          dismiss_count: 0,
          last_introduced_at: null,
        },
      ],
      doc: { content: '# manual' },
    });
    const out = await resolveTeacherModeContent({
      supabase: sb,
      tenantId: 't1',
      userId: 'u1',
      activeCapabilityKey: 'five_pillars',
      nowIso: NOW_ISO,
    });
    expect(out).not.toBeNull();
    const keys = out!.remaining_capabilities.map((c) => c.capability_key);
    expect(keys).not.toContain('vitana_id'); // filtered by ledger state
    expect(keys).toContain('activity_match'); // still eligible
  });

  test('remaining list capped at 5 entries even with a large catalog', async () => {
    const catalog: FakeRow[] = [
      FIVE_PILLARS,
      ...Array.from({ length: 10 }, (_, i) => ({
        capability_key: `cap_${i}`,
        display_name: `Capability ${i}`,
        description: 'desc',
        manual_path: null,
        enabled: true,
        pedagogical_order: 20 + i,
      })),
    ];
    const sb = fakeSb({
      catalog,
      ledger: [],
      doc: { content: '# manual' },
    });
    const out = await resolveTeacherModeContent({
      supabase: sb,
      tenantId: 't1',
      userId: 'u1',
      activeCapabilityKey: 'five_pillars',
      nowIso: NOW_ISO,
    });
    expect(out).not.toBeNull();
    expect(out!.remaining_capabilities.length).toBeLessThanOrEqual(5);
  });
});
