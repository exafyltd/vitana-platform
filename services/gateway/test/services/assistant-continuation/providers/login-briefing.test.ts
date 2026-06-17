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
