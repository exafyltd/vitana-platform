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
  type BriefingFacts,
} from '../../../../src/services/assistant-continuation/providers/login-briefing';

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

describe('makeLoginBriefingProvider — guardrails', () => {
  it('skips when no inputs are wired', async () => {
    const provider = makeLoginBriefingProvider();
    const res = await provider.produce({ surface: 'orb_wake', extra: {} } as any);
    expect(res.providerKey).toBe(LOGIN_BRIEFING_PROVIDER_KEY);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('no_login_briefing_inputs');
  });

  it('suppresses on greetingPolicy=skip (silent reconnect)', async () => {
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
        },
      },
    } as any);
    expect(res.status).toBe('suppressed');
    expect(res.reason).toBe('greeting_policy_skip');
  });
});
