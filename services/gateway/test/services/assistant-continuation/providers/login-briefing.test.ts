/**
 * Greeting v2 — login-briefing provider tests.
 *
 * Locks the contract:
 *   - pickBriefingState maps facts → the right state (graduated > returning >
 *     momentum > building > orient).
 *   - renderBriefingLine always opens with a time-aware, named salutation.
 *   - Compliments are EARNED-ONLY: orient state carries no praise; building/
 *     momentum cite a real number; momentum cites the Index delta.
 *   - The next-session clause names the session number + title when known.
 *   - The provider suppresses cleanly on greetingPolicy='skip' and skips when
 *     no inputs are wired — so it never blocks the silent-reconnect path.
 */

import {
  makeLoginBriefingProvider,
  LOGIN_BRIEFING_PROVIDER_KEY,
  pickBriefingState,
  renderBriefingLine,
  buildWeaknessRider,
  buildProgressBeat,
  buildFastProactiveOpener,
  type BriefingFacts,
} from '../../../../src/services/assistant-continuation/providers/login-briefing';

// Chainable null-Supabase stub: every query resolves to { data: null } so the
// provider degrades to its grounded 'orient' opener instead of needing a full
// journey fixture. Lets us assert the cadence-skip LEAD path end-to-end.
function nullSupabase(): any {
  const result = { data: null, error: null };
  const proxy: any = new Proxy(function () {} as any, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result);
      if (prop === 'maybeSingle' || prop === 'single') return async () => result;
      return () => proxy;
    },
    apply() { return proxy; },
  });
  return { from: () => proxy };
}

const BASE_FACTS: BriefingFacts = {
  sessionsCompleted: 3,
  nextSessionNumber: 4,
  nextSessionTitle: 'Schlaf-Routine',
  graduated: false,
  hasGoal: true,
  indexDeltaUp: null,
  daysSinceLastSession: 0,
};

describe('pickBriefingState', () => {
  it('graduated beats everything', () => {
    expect(pickBriefingState({ ...BASE_FACTS, graduated: true, indexDeltaUp: 12, daysSinceLastSession: 9 }))
      .toBe('graduated');
  });

  it('no progress + not graduated → orient', () => {
    expect(pickBriefingState({ ...BASE_FACTS, sessionsCompleted: 0 })).toBe('orient');
  });

  // BOOTSTRAP-ORB-GREETING-RETURNING-USER: a returning user (any prior ORB
  // session) must never be re-classified as a first-timer just because the
  // guided-curriculum pointer (current_session) has not advanced.
  it('no curriculum progress BUT has a prior session → not orient (returning user)', () => {
    expect(pickBriefingState({ ...BASE_FACTS, sessionsCompleted: 0, hasPriorSession: true, daysSinceLastSession: 0 }))
      .toBe('building');
  });

  it('no curriculum progress + prior session + multi-day gap → returning', () => {
    expect(pickBriefingState({ ...BASE_FACTS, sessionsCompleted: 0, hasPriorSession: true, daysSinceLastSession: 4 }))
      .toBe('returning');
  });

  it('genuine first-timer (no progress, no prior session) → orient', () => {
    expect(pickBriefingState({ ...BASE_FACTS, sessionsCompleted: 0, hasPriorSession: false })).toBe('orient');
  });

  it('multi-day gap → returning', () => {
    expect(pickBriefingState({ ...BASE_FACTS, daysSinceLastSession: 4 })).toBe('returning');
  });

  it('positive Index delta (recent) → momentum', () => {
    expect(pickBriefingState({ ...BASE_FACTS, indexDeltaUp: 8, daysSinceLastSession: 1 })).toBe('momentum');
  });

  it('steady progress, no delta → building', () => {
    expect(pickBriefingState({ ...BASE_FACTS, indexDeltaUp: null, daysSinceLastSession: 1 })).toBe('building');
  });
});

describe('renderBriefingLine (DE)', () => {
  const det = () => 0; // deterministic pool pick

  // RULE 0 (VTID-03307): the briefing line must NEVER end on / contain a passive
  // preference question — Vitana leads and proposes. Guards against the staging
  // "was möchtest du als nächstes tun?" regression returning.
  it('NEVER asks a passive preference question, in any state or language', () => {
    const PASSIVE = /(möchtest du|willst du|what would you like|where would you like|where shall we|what.*tackle|wo möchtest|womit möchtest)/i;
    const states: Array<Partial<BriefingFacts>> = [
      { sessionsCompleted: 0, hasGoal: false },                 // orient
      { indexDeltaUp: null, daysSinceLastSession: 1 },          // building
      { indexDeltaUp: 8, daysSinceLastSession: 1 },             // momentum
      { daysSinceLastSession: 4 },                              // returning
      { graduated: true },                                      // graduated
    ];
    for (const lang of ['de', 'en'] as const) {
      for (const f of states) {
        for (const rng of [() => 0, () => 0.5, () => 0.99]) {
          const line = renderBriefingLine(
            { lang, salutation: 'morning', firstName: 'Maria', facts: { ...BASE_FACTS, ...f } },
            rng,
          );
          expect(line).not.toMatch(PASSIVE);
        }
      }
    }
  });

  it('always opens with a time-aware, named salutation', () => {
    const morning = renderBriefingLine({ lang: 'de', salutation: 'morning', firstName: 'Maria', facts: BASE_FACTS }, det);
    expect(morning.startsWith('Guten Morgen, Maria.')).toBe(true);
    const afternoon = renderBriefingLine({ lang: 'de', salutation: 'afternoon', firstName: 'Maria', facts: BASE_FACTS }, det);
    expect(afternoon.startsWith('Guten Tag, Maria.')).toBe(true);
    const evening = renderBriefingLine({ lang: 'de', salutation: 'evening', firstName: 'Maria', facts: BASE_FACTS }, det);
    expect(evening.startsWith('Guten Abend, Maria.')).toBe(true);
  });

  it('orient state carries NO earned-number praise', () => {
    const line = renderBriefingLine(
      { lang: 'de', salutation: 'afternoon', firstName: 'Maria', facts: { ...BASE_FACTS, sessionsCompleted: 0, hasGoal: false } },
      det,
    );
    expect(line).toContain('ersten Schritt');
    expect(line).not.toMatch(/\d+ Sessions/);
  });

  it('building state cites the real session count and the next session', () => {
    const line = renderBriefingLine(
      { lang: 'de', salutation: 'morning', firstName: 'Maria', facts: { ...BASE_FACTS, sessionsCompleted: 3, indexDeltaUp: null } },
      det,
    );
    expect(line).toContain('3 Sessions');
    expect(line).toContain('Session 4: „Schlaf-Routine"');
  });

  it('momentum state cites the Vitana Index delta as the compliment', () => {
    const line = renderBriefingLine(
      { lang: 'de', salutation: 'morning', firstName: 'Maria', facts: { ...BASE_FACTS, indexDeltaUp: 12 } },
      det,
    );
    expect(line).toContain('12 Punkte');
  });

  it('missing next-session title degrades gracefully', () => {
    const line = renderBriefingLine(
      { lang: 'de', salutation: 'morning', firstName: 'Maria', facts: { ...BASE_FACTS, nextSessionTitle: null } },
      det,
    );
    expect(line).toContain('nächste Session');
    expect(line).not.toContain('null');
  });

  it('nudges to set a goal only when one is missing', () => {
    const withGap = renderBriefingLine(
      { lang: 'de', salutation: 'morning', firstName: 'Maria', facts: { ...BASE_FACTS, hasGoal: false } },
      det,
    );
    expect(withGap).toContain('persönliches Ziel');
    const withGoal = renderBriefingLine(
      { lang: 'de', salutation: 'morning', firstName: 'Maria', facts: { ...BASE_FACTS, hasGoal: true } },
      det,
    );
    expect(withGoal).not.toContain('persönliches Ziel');
  });
});

// Advice #1 — "understood weakness": goal-anchored reversing step.
describe('buildWeaknessRider (advice #1)', () => {
  it('returns empty when no pillar slipped', () => {
    expect(buildWeaknessRider('de', { ...BASE_FACTS })).toBe('');
    expect(buildWeaknessRider('de', { ...BASE_FACTS, weakestPillarDrop: null })).toBe('');
  });

  it('ignores immaterial drops (below the 3-point floor)', () => {
    expect(
      buildWeaknessRider('de', { ...BASE_FACTS, weakestPillarDrop: { pillar: 'sleep', deltaDown: 2 } }),
    ).toBe('');
  });

  it('names the localized pillar + magnitude and proposes ONE reversing step', () => {
    const line = buildWeaknessRider('de', {
      ...BASE_FACTS,
      weakestPillarDrop: { pillar: 'sleep', deltaDown: 7 },
      primaryGoalLabel: null,
    });
    expect(line).toContain('Schlaf');
    expect(line).toContain('7 Punkte');
    expect(line).toContain('ich zeige dir den ersten Schritt'); // proposal, not a question
  });

  it('anchors the weakness to the user goal (the WHY) when present', () => {
    const line = buildWeaknessRider('de', {
      ...BASE_FACTS,
      weakestPillarDrop: { pillar: 'exercise', deltaDown: 5 },
      primaryGoalLabel: 'mehr Energie',
    });
    expect(line).toContain('Bewegung');
    expect(line).toContain('„mehr Energie"');
  });

  it('NEVER contains a passive RULE 0 question, DE or EN, with or without a goal', () => {
    const PASSIVE = /(möchtest du|willst du|was möchtest|what would you like|how can i help|what can i do)/i;
    for (const lang of ['de', 'en'] as const) {
      for (const goal of [null, 'more energy']) {
        const line = buildWeaknessRider(lang, {
          ...BASE_FACTS,
          weakestPillarDrop: { pillar: 'mental', deltaDown: 9 },
          primaryGoalLabel: goal,
        });
        expect(line).not.toMatch(PASSIVE);
        expect(line.length).toBeGreaterThan(0);
      }
    }
  });

  it('weakness rider takes over the building-state lead', () => {
    const line = renderBriefingLine(
      {
        lang: 'de',
        salutation: 'morning',
        firstName: 'Maria',
        facts: {
          ...BASE_FACTS,
          indexDeltaUp: null,
          daysSinceLastSession: 1,
          weakestPillarDrop: { pillar: 'sleep', deltaDown: 6 },
          primaryGoalLabel: 'besser schlafen',
        },
      },
      () => 0,
    );
    expect(pickBriefingState({ ...BASE_FACTS, indexDeltaUp: null, daysSinceLastSession: 1 })).toBe('building');
    expect(line).toContain('Schlaf ist diese Woche um 6 Punkte gesunken');
    expect(line).toContain('„besser schlafen"');
  });
});

// Advice #2 — "visible momentum": progress beat.
describe('buildProgressBeat (advice #2)', () => {
  it('returns empty when nothing is learned or total is unknown', () => {
    expect(buildProgressBeat('de', { ...BASE_FACTS })).toBe('');
    expect(buildProgressBeat('de', { ...BASE_FACTS, topicsLearned: 0, topicsTotal: 254 })).toBe('');
    expect(buildProgressBeat('de', { ...BASE_FACTS, topicsLearned: 12, topicsTotal: 0 })).toBe('');
  });

  it('states X of N green-checked topics + the percentage of the journey', () => {
    const line = buildProgressBeat('de', { ...BASE_FACTS, topicsLearned: 12, topicsTotal: 254 });
    expect(line).toContain('12 von 254');
    expect(line).toContain('auf grün');
    expect(line).toContain('5%'); // round(12/254*100)
  });

  it('celebrates the 100% completion case specially', () => {
    const line = buildProgressBeat('de', { ...BASE_FACTS, topicsLearned: 254, topicsTotal: 254 });
    expect(line).toContain('alle 254 Themen gemeistert');
    expect(line).not.toContain('%');
  });

  it('floors the percentage at 1% so a single topic still reads as progress', () => {
    const line = buildProgressBeat('en', { ...BASE_FACTS, topicsLearned: 1, topicsTotal: 254 });
    expect(line).toContain('1 of 254');
    expect(line).toContain('1%');
  });

  it('NEVER contains a passive RULE 0 question', () => {
    const PASSIVE = /(möchtest du|willst du|what would you like|how can i help)/i;
    for (const lang of ['de', 'en'] as const) {
      const line = buildProgressBeat(lang, { ...BASE_FACTS, topicsLearned: 40, topicsTotal: 254 });
      expect(line).not.toMatch(PASSIVE);
    }
  });

  it('appears in the building state as an earned compliment', () => {
    const line = renderBriefingLine(
      {
        lang: 'de',
        salutation: 'morning',
        firstName: 'Maria',
        facts: { ...BASE_FACTS, indexDeltaUp: null, daysSinceLastSession: 1, topicsLearned: 30, topicsTotal: 254 },
      },
      () => 0,
    );
    expect(line).toContain('30 von 254');
  });
});

// DEV-COMHU-0513 — the SHORT proactive opener spoken on the fast greeting path.
describe('buildFastProactiveOpener (proactive fast greeting)', () => {
  const GENERIC = [
    'Lass uns weitermachen.',
    'Lass uns dort weitermachen, wo wir aufgehört haben.',
    'Willkommen zurück.',
  ];
  const PASSIVE = /(möchtest du|willst du|was möchtest|what would you like|how can i help|what can i do)/i;

  const mk = (f: Partial<BriefingFacts>) =>
    buildFastProactiveOpener({ lang: 'de', salutation: 'morning', firstName: 'Maria', facts: { ...BASE_FACTS, ...f } }, () => 0);

  it('opens with the named salutation and is NOT a generic SHORT_GAP phrase', () => {
    const line = mk({ indexDeltaUp: null, daysSinceLastSession: 1 });
    expect(line.startsWith('Guten Morgen, Maria.')).toBe(true);
    for (const g of GENERIC) expect(line).not.toBe(g);
    expect(line).not.toContain('Willkommen zurück');
  });

  it('weakness → goal/pillar reversing step as the lead', () => {
    const line = mk({ weakestPillarDrop: { pillar: 'sleep', deltaDown: 6 } });
    expect(line).toContain('Schlaf');
    expect(line).toContain('ich zeige dir den ersten Schritt');
  });

  it('building → continues at the named next session, and LEADS', () => {
    const line = mk({ indexDeltaUp: null, daysSinceLastSession: 1, nextSessionTitle: 'Schlaf-Routine' });
    expect(line).toContain('Schlaf-Routine');
    expect(line).toContain('ich führe dich');
  });

  it('returning user → GROUNDED recall of the last session ("Letztes Mal ging es um X"), then LEADS forward', () => {
    // recall title == next title (same session) → no distinct step to name, so
    // it recalls where we left off and leads to the next session (no bluff, no
    // passive "what do you want").
    const line = mk({ daysSinceLastSession: 2, lastSessionTitle: 'Dein Plan', nextSessionTitle: 'Dein Plan' });
    expect(line).toContain('Letztes Mal ging es um „Dein Plan"'); // the REAL last session, recalled
    expect(line).toMatch(/nächsten Session|sag Bescheid|übernehme/); // proactively leads forward
    expect(line).not.toMatch(PASSIVE);
  });

  it('returning user with a DISTINCT next step → names BOTH where we left off AND the next step', () => {
    // lastOpenedTitle (where we left off) ≠ nextStepTitle (the genuine next
    // step) → the opener names both, then offers to lead. This is the core
    // "always know where we left off + proactively the next step" behavior.
    const line = mk({
      daysSinceLastSession: 2,
      lastOpenedTitle: 'Schlaf-Grundlagen',
      nextStepTitle: 'Abendroutine',
    });
    expect(line).toContain('Letztes Mal ging es um „Schlaf-Grundlagen"'); // where we left off
    expect(line).toContain('Abendroutine'); // the distinct next step, named
    expect(line).toContain('ich führe dich'); // and Vitana leads / offers to do it
    expect(line).not.toMatch(PASSIVE);
  });

  it('rotates across three proactive proposals (journey / community / match) — each offers to DO it for the user', () => {
    const facts = { ...BASE_FACTS, daysSinceLastSession: 2, lastOpenedTitle: 'Schlaf-Grundlagen', nextStepTitle: 'Abendroutine' };
    const journey = buildFastProactiveOpener({ lang: 'de', salutation: 'morning', firstName: 'Maria', facts }, () => 0);
    const community = buildFastProactiveOpener({ lang: 'de', salutation: 'morning', firstName: 'Maria', facts }, () => 0.5);
    const match = buildFastProactiveOpener({ lang: 'de', salutation: 'morning', firstName: 'Maria', facts }, () => 0.99);
    expect(journey).toContain('Abendroutine'); // proposal 1: the next session/step
    expect(community).toMatch(/Community/); // proposal 2: post to the community
    expect(match).toMatch(/Aktivitätspartner/); // proposal 3: find a match
    // Every rotation recalls where we left off and offers to do the work.
    for (const l of [journey, community, match]) {
      expect(l).toContain('Letztes Mal ging es um „Schlaf-Grundlagen"');
      expect(l).toMatch(/ich (führe|poste|kümmere|übernehme)/i);
    }
  });

  it('NO false recall when there is no last session — never bluffs "where we left off"', () => {
    const line = mk({ lastSessionTitle: null, lastOpenedTitle: null, nextSessionTitle: 'Schlaf-Routine', nextStepTitle: null });
    expect(line).not.toMatch(/Letztes Mal|wo wir aufgehört|anknüpfen/i); // no recall claim without data
    expect(line).toContain('Schlaf-Routine'); // still leads to the next step
  });

  it('orient (first-time) → proposes a concrete deliverable step, NOT a fixed journey pitch', () => {
    const line = mk({ sessionsCompleted: 0, hasGoal: false });
    expect(line.startsWith('Guten Morgen, Maria.')).toBe(true);
    expect(line).toContain('Lass uns'); // it LEADS (proposal)
    expect(line).not.toContain('durch Vitanaland'); // no fixed "step by step through Vitanaland" line
    expect(line).not.toMatch(/Session eins|ersten Session/); // does not pitch the (possibly empty) journey
  });

  it('FLEXIBLE WORDING — different rng yields different greetings (never hard-coded)', () => {
    const facts = { ...BASE_FACTS, sessionsCompleted: 0, hasGoal: false };
    const a = buildFastProactiveOpener({ lang: 'de', salutation: 'morning', firstName: 'Maria', facts }, () => 0);
    const b = buildFastProactiveOpener({ lang: 'de', salutation: 'morning', firstName: 'Maria', facts }, () => 0.6);
    expect(a).not.toBe(b); // the wording varies — no single hard-coded sentence
  });

  it('stays SHORT (audio-safe) and RULE-0 clean across states/langs/variations', () => {
    const variants: Array<Partial<BriefingFacts>> = [
      { sessionsCompleted: 0, hasGoal: false },
      { indexDeltaUp: null, daysSinceLastSession: 1 },
      { weakestPillarDrop: { pillar: 'exercise', deltaDown: 8 } },
      { graduated: true },
    ];
    for (const lang of ['de', 'en'] as const) {
      for (const v of variants) {
        for (const rng of [() => 0, () => 0.5, () => 0.99]) {
          const line = buildFastProactiveOpener({ lang, salutation: 'morning', firstName: 'Maria', facts: { ...BASE_FACTS, ...v } }, rng);
          expect(line).not.toMatch(PASSIVE);
          expect(line.length).toBeLessThanOrEqual(180); // ~2 short sentences → reliable audio
          expect(line.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('makeLoginBriefingProvider — guardrails', () => {
  it('skips when no inputs are wired', async () => {
    const provider = makeLoginBriefingProvider();
    const res = await provider.produce({ surface: 'orb_wake', extra: {} } as any);
    expect(res.providerKey).toBe(LOGIN_BRIEFING_PROVIDER_KEY);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('no_login_briefing_inputs');
  });

  it('suppresses ONLY on a transparent-reconnect-class skip (network blip — not a deliberate open)', async () => {
    const provider = makeLoginBriefingProvider();
    const res = await provider.produce({
      surface: 'orb_wake',
      extra: {
        loginBriefing: {
          supabase: {} as any,
          userId: 'u1',
          tenantId: 't1',
          lang: 'de',
          firstName: 'Maria',
          timezone: 'Europe/Berlin',
          greetingPolicy: 'skip',
          skipReason: 'transparent_reconnect_forces_skip',
        },
      },
    } as any);
    expect(res.status).toBe('suppressed');
    expect(res.reason).toBe('forced_skip_transparent_reconnect_forces_skip');
  });

  it('LEADS on a cadence-class skip (deliberate re-open within 15 min) — grounded opener, never silent', async () => {
    // greeted_recently_within_window is a DELIBERATE re-tap, not a transparent
    // reconnect: login-briefing must produce the grounded opener (priority 92)
    // so no hard-coded fallback provider can win the turn. All DB reads resolve
    // to null here, so it degrades to the grounded 'orient' opener.
    const provider = makeLoginBriefingProvider();
    const res = await provider.produce({
      surface: 'orb_wake',
      extra: {
        loginBriefing: {
          supabase: nullSupabase(),
          userId: 'u1',
          tenantId: 't1',
          lang: 'de',
          firstName: 'Maria',
          timezone: 'Europe/Berlin',
          greetingPolicy: 'skip',
          skipReason: 'greeted_recently_within_window',
        },
      },
    } as any);
    expect(res.status).toBe('returned');
    expect((res as any).candidate?.userFacingLine?.length ?? 0).toBeGreaterThan(0);
  });
});
