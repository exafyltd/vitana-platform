/**
 * VTID-03110 — tests for buildTeacherDeflectionForEmptyRecommendations.
 *
 * Hard requirement: the empty-state response of `get_recommendations`
 * must NEVER speak the phrase "no personalized recommendations" (or
 * any close variant). It must instead pivot to a teaching offer.
 *
 * These tests fake the Supabase client so we can pin catalog + ledger
 * shapes deterministically.
 */

import { buildTeacherDeflectionForEmptyRecommendations } from '../../../../../src/services/assistant-continuation/providers/teacher/teacher-deflection';

function fakeSb(opts: {
  catalog?: any[] | null;
  ledger?: any[] | null;
  catalogError?: { message: string } | null;
  ledgerError?: { message: string } | null;
}) {
  const catalog = opts.catalog;
  const ledger = opts.ledger;
  return {
    from(table: string) {
      const isLedger = table === 'user_capability_awareness';
      const chain: any = {
        select: () => chain,
        eq: () => chain,
      };
      const data = isLedger ? ledger : catalog;
      const error = isLedger ? (opts.ledgerError ?? null) : (opts.catalogError ?? null);
      // The orchestrator awaits the final eq() chain. We make the chain
      // thenable so `await sb.from(...).select(...).eq(...)` resolves
      // with `{ data, error }`.
      (chain as any).then = (resolve: any) => resolve({ data, error });
      return chain;
    },
  } as any;
}

const NOW_ISO = '2026-05-20T09:00:00Z';

const FIVE_PILLARS = {
  capability_key: 'five_pillars',
  display_name: 'The Five Pillars',
  description: 'Foundation concept',
  manual_path: '/manuals/maxina/00-concepts/five-pillars',
  enabled: true,
  pedagogical_order: 10,
};

const ACTIVITY_MATCH = {
  capability_key: 'activity_match',
  display_name: 'Activity Match',
  description: 'Community matching',
  manual_path: '/manuals/maxina/03-community/activity-match',
  enabled: true,
  pedagogical_order: 140,
};

const NO_REC_FORBIDDEN_PHRASES = [
  'no personalized recommendations',
  'no recommendations available',
  'check back later',
  'keine personalisierten',
  'keine Empfehlungen verfügbar',
];

function assertNoForbiddenPhrase(text: string): void {
  const lower = text.toLowerCase();
  for (const phrase of NO_REC_FORBIDDEN_PHRASES) {
    expect(lower).not.toContain(phrase.toLowerCase());
  }
}

describe('VTID-03110 — buildTeacherDeflectionForEmptyRecommendations', () => {
  test('NEVER speaks "no personalized recommendations" — picks next teaching capability instead (en)', async () => {
    const out = await buildTeacherDeflectionForEmptyRecommendations({
      supabase: fakeSb({ catalog: [FIVE_PILLARS, ACTIVITY_MATCH], ledger: [] }),
      tenantId: 't1',
      userId: 'u1',
      lang: 'en',
      recType: 'all',
      nowIso: NOW_ISO,
    });
    assertNoForbiddenPhrase(out);
    expect(out).toContain('The Five Pillars'); // pedagogical_order=10 wins over 140
  });

  test('NEVER speaks "no recommendations" — DE variant uses German teaching offer', async () => {
    const out = await buildTeacherDeflectionForEmptyRecommendations({
      supabase: fakeSb({ catalog: [FIVE_PILLARS, ACTIVITY_MATCH], ledger: [] }),
      tenantId: 't1',
      userId: 'u1',
      lang: 'de',
      recType: 'all',
      nowIso: NOW_ISO,
    });
    assertNoForbiddenPhrase(out);
    expect(out).toContain('The Five Pillars');
    // German body markers
    expect(out.toLowerCase()).toMatch(/vitanaland|magst du/);
  });

  test('recType=match acknowledges the match miss explicitly without dismissing', async () => {
    const out = await buildTeacherDeflectionForEmptyRecommendations({
      supabase: fakeSb({ catalog: [FIVE_PILLARS], ledger: [] }),
      tenantId: 't1',
      userId: 'u1',
      lang: 'en',
      recType: 'match',
      nowIso: NOW_ISO,
    });
    assertNoForbiddenPhrase(out);
    // recType=match acknowledges the community-match miss but pivots
    // to teaching.
    expect(out.toLowerCase()).toMatch(/community match|fresh.*match/);
    expect(out).toContain('The Five Pillars');
  });

  test('empty catalog → fallback phrasing still does NOT say "no recommendations"', async () => {
    const out = await buildTeacherDeflectionForEmptyRecommendations({
      supabase: fakeSb({ catalog: [], ledger: [] }),
      tenantId: 't1',
      userId: 'u1',
      lang: 'en',
      recType: 'all',
      nowIso: NOW_ISO,
    });
    assertNoForbiddenPhrase(out);
    expect(out.toLowerCase()).toMatch(/vitanaland/);
  });

  test('catalog fetch error → fallback phrasing (never throws upward)', async () => {
    const out = await buildTeacherDeflectionForEmptyRecommendations({
      supabase: fakeSb({
        catalog: null,
        ledger: null,
        catalogError: { message: 'simulated db outage' },
      }),
      tenantId: 't1',
      userId: 'u1',
      lang: 'en',
      recType: 'all',
      nowIso: NOW_ISO,
    });
    assertNoForbiddenPhrase(out);
    // Still produces SOMETHING speakable — never a thrown error reaching
    // the tool result.
    expect(out.length).toBeGreaterThan(20);
  });

  test('all-capabilities-introduced → fallback (no eligible pick)', async () => {
    const introducedRecently = new Date(Date.parse(NOW_ISO) - 60 * 60 * 1000).toISOString();
    const out = await buildTeacherDeflectionForEmptyRecommendations({
      supabase: fakeSb({
        catalog: [FIVE_PILLARS],
        ledger: [
          {
            capability_key: 'five_pillars',
            awareness_state: 'introduced',
            dismiss_count: 0,
            last_introduced_at: introducedRecently, // within 7-day filter
          },
        ],
      }),
      tenantId: 't1',
      userId: 'u1',
      lang: 'en',
      recType: 'all',
      nowIso: NOW_ISO,
    });
    assertNoForbiddenPhrase(out);
    expect(out.toLowerCase()).toMatch(/vitanaland/);
  });

  test('pedagogical_order drives the pick — first-time user gets foundations, NOT alphabetical', async () => {
    // Even though "activity_match" is alphabetically first, "five_pillars"
    // has pedagogical_order=10 vs 140. Curriculum order wins.
    const out = await buildTeacherDeflectionForEmptyRecommendations({
      supabase: fakeSb({
        catalog: [ACTIVITY_MATCH, FIVE_PILLARS],
        ledger: [],
      }),
      tenantId: 't1',
      userId: 'u1',
      lang: 'en',
      recType: 'all',
      nowIso: NOW_ISO,
    });
    expect(out).toContain('The Five Pillars');
    expect(out).not.toContain('Activity Match');
  });

  test('unknown lang falls back to English phrasing', async () => {
    const out = await buildTeacherDeflectionForEmptyRecommendations({
      supabase: fakeSb({ catalog: [FIVE_PILLARS], ledger: [] }),
      tenantId: 't1',
      userId: 'u1',
      lang: 'xx-unknown',
      recType: 'all',
      nowIso: NOW_ISO,
    });
    assertNoForbiddenPhrase(out);
    expect(out).toContain('The Five Pillars');
    // English markers
    expect(out.toLowerCase()).toMatch(/vitanaland|introduce|learn/);
  });
});
