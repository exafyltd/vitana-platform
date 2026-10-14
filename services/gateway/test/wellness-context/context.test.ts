/**
 * VTID-05165 (Health Hub Phase 1 / C2) — buildWellnessContext over A's S10
 * fake (the real S3/S4 logic in memory), the two comparison functions on
 * fixture rows, and buildWellnessSystemPrompt's locale wrapping.
 *
 *   - flag off -> 'disabled', nothing read; forced off on staging;
 *   - no ai_health_analysis -> 'consent_required', A's read port not called;
 *   - the read port answering STORE_PENDING / STORE_DISABLED / STORE_UNAVAILABLE
 *     or empty rows -> 'empty', never a throw;
 *   - a withdrawn sync_sleep removes the sleep fact at the next call;
 *   - only WellnessFactKind values appear; no commerce purpose exists;
 *   - comparisons: direction, minimum-data rule;
 *   - the prompt is always locale-wrapped (11 locales).
 */
import {
  activityVolume,
  buildWellnessContextWith,
  buildWellnessSystemPrompt,
  isWellnessContextEnabled,
  isWellnessFactKind,
  sleepDurationVsBaseline,
  WELLNESS_BOUNDARY_RULES,
  WELLNESS_FACT_KINDS,
  WELLNESS_FACTS_OPEN,
  WELLNESS_PURPOSES,
  type WellnessContext,
  type WellnessFact,
} from '../../src/services/wellness-context';
import { buildLocalizedSystemPrompt } from '../../src/i18n/llm-locale';
import { GATEWAY_LOCALES } from '../../src/i18n/catalog';
import { AS_OF, createHarness, daysBefore, grantAll, ME, seed, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

describe('dark gate', () => {
  it('flag off -> disabled; no consent read, no store read, no locale lookup', async () => {
    h.setEnabled(false);
    grantAll(h);
    const getLocale = jest.spyOn(h.deps, 'getLocale');
    const ctx = await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_chat' });
    expect(ctx).toEqual({ status: 'disabled', locale: 'de', facts: [] });
    expect(h.consentChecks).toHaveLength(0);
    expect(h.reads).toHaveLength(0);
    expect(getLocale).not.toHaveBeenCalled();
  });

  it('isWellnessContextEnabled: exact "true", and never on staging', () => {
    expect(isWellnessContextEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isWellnessContextEnabled({ WELLNESS_CONTEXT_ENABLED: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isWellnessContextEnabled({ WELLNESS_CONTEXT_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isWellnessContextEnabled({ WELLNESS_CONTEXT_ENABLED: 'true', VITANA_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isWellnessContextEnabled({ WELLNESS_CONTEXT_ENABLED: 'true', VITANA_ENV: 'staging' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('the purpose union is closed and has no commerce member; any other purpose is disabled and reads nothing', async () => {
    expect([...WELLNESS_PURPOSES]).toEqual(['wellness_chat', 'wellness_recommendation']);
    for (const p of WELLNESS_PURPOSES) expect(p).not.toMatch(/commerce|marketplace|shop|product|offer|rank|ads?\b/i);
    grantAll(h);
    for (const bad of ['commerce', 'marketplace_ranking', 'feature_compute', 'ai_context', undefined]) {
      const ctx = await buildWellnessContextWith(h.deps, ME, { purpose: bad as never });
      expect(ctx.status).toBe('disabled');
    }
    expect(h.reads).toHaveLength(0);
    expect(h.consentChecks).toHaveLength(0);
  });

  it('a missing identity is disabled', async () => {
    grantAll(h);
    expect((await buildWellnessContextWith(h.deps, { tenant_id: '', user_id: ME.user_id }, { purpose: 'wellness_chat' })).status).toBe('disabled');
    expect((await buildWellnessContextWith(h.deps, null as never, { purpose: 'wellness_chat' })).status).toBe('disabled');
    expect(h.reads).toHaveLength(0);
  });
});

describe('consent (fail closed, nothing cached)', () => {
  it('no ai_health_analysis -> consent_required and A\'s read port is not called', async () => {
    h.store.grantConsent(ME, 'sync_sleep', 'apple_health');
    h.store.grantConsent(ME, 'sync_activity', 'apple_health');
    h.setLocale('fr');
    const ctx = await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_recommendation' });
    expect(ctx).toEqual({ status: 'consent_required', locale: 'fr', facts: [] });
    expect(h.reads).toHaveLength(0);
  });

  it('a consent read error is not granted', async () => {
    h.deps.hasConsent = async () => {
      throw new Error('db down');
    };
    const ctx = await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_chat' });
    expect(ctx.status).toBe('consent_required');
    expect(h.reads).toHaveLength(0);
  });

  it('ai_health_analysis but no sync_* on any source -> empty; nothing is read', async () => {
    h.store.grantConsent(ME, 'ai_health_analysis');
    const ctx = await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_chat' });
    expect(ctx.status).toBe('empty');
    expect(h.reads).toHaveLength(0);
    // Each category key is checked on every Health Sync source before giving up.
    expect(h.consentChecks.filter((c) => c.key === 'sync_sleep').map((c) => c.resource)).toEqual(['apple_health', 'health_connect']);
  });

  it('a category consented on any one source (Health Connect) is enough', async () => {
    await seed(h, 30, () => 420, () => 8000);
    h.store.revokeConsent(ME, 'sync_sleep', 'apple_health');
    h.store.revokeConsent(ME, 'sync_activity', 'apple_health');
    h.store.grantConsent(ME, 'ai_health_analysis');
    h.store.grantConsent(ME, 'sync_sleep', 'health_connect');
    const ctx = await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_chat' });
    expect(ctx.facts.map((f) => f.kind)).toEqual(['sleep_duration_vs_baseline']);
  });

  it('a withdrawn sync_sleep removes the sleep fact at the next call, and sleep data is no longer read', async () => {
    await seed(h, 30, (i) => (i < 7 ? 360 : 450), (i) => (i < 7 ? 11000 : 8000));
    grantAll(h);
    const before = await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_chat' });
    expect(before.status).toBe('ok');
    expect(before.facts.map((f) => f.kind).sort()).toEqual(['activity_volume', 'sleep_duration_vs_baseline']);

    h.store.revokeConsent(ME, 'sync_sleep', 'apple_health');
    const after = await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_chat' });
    expect(after.status).toBe('ok');
    expect(after.facts.map((f) => f.kind)).toEqual(['activity_volume']);
    expect((h.reads[h.reads.length - 1] as { codes: string[] }).codes).toEqual(['steps']);
  });

  it('A\'s own I5 check answering consent_required is reported as consent_required', async () => {
    grantAll(h);
    h.deps.readDailyObservations = async () => ({ ok: false, code: 'consent_required' });
    expect((await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_chat' })).status).toBe('consent_required');
  });
});

describe('the read goes only through A\'s S4 port, purpose ai_context', () => {
  it('one read, codes of the consented facts, 30-day window ending on the last complete day', async () => {
    grantAll(h);
    await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_chat' });
    expect(h.reads).toEqual([{ codes: ['sleep_session', 'steps'], from: daysBefore(29), to: AS_OF, purpose: 'ai_context' }]);
  });

  it.each(['STORE_PENDING', 'STORE_DISABLED', 'STORE_UNAVAILABLE', 'INVALID_INPUT', 'PURPOSE_REQUIRED'] as const)(
    'the port answering %s -> empty, no throw',
    async (code) => {
      grantAll(h);
      h.deps.readDailyObservations = async () => ({ ok: false, code });
      const ctx = await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_chat' });
      expect(ctx).toEqual({ status: 'empty', locale: 'de', facts: [] });
    },
  );

  it('the real fake store with its tables absent (STORE_PENDING) -> empty, no throw', async () => {
    grantAll(h);
    h.store.db.missing = true;
    expect((await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_chat' })).status).toBe('empty');
    h.store.db.missing = false;
    h.store.setEnabled(false);
    expect((await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_chat' })).status).toBe('empty');
  });

  it('empty rows -> empty', async () => {
    grantAll(h);
    expect(await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_chat' })).toEqual({ status: 'empty', locale: 'de', facts: [] });
  });

  it('a throwing port or locale lookup never throws out', async () => {
    grantAll(h);
    h.deps.readDailyObservations = async () => {
      throw new Error('boom');
    };
    h.deps.getLocale = async () => {
      throw new Error('no locale');
    };
    await expect(buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_chat' })).resolves.toEqual({ status: 'empty', locale: 'de', facts: [] });
  });
});

describe('facts end to end over the fake store', () => {
  it('computes both implemented facts from the member\'s own baseline; only WellnessFactKind values appear', async () => {
    await seed(h, 30, (i) => (i < 7 ? 360 : 450), (i) => (i < 7 ? 11000 : 8000));
    grantAll(h);
    h.setLocale('sr');
    const ctx = await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_recommendation' });
    expect(ctx.status).toBe('ok');
    expect(ctx.locale).toBe('sr');
    for (const f of ctx.facts) expect(isWellnessFactKind(f.kind)).toBe(true);
    const sleep = ctx.facts.find((f) => f.kind === 'sleep_duration_vs_baseline')!;
    expect(sleep).toMatchObject({ category: 'sleep', code: 'sleep_session', unit: 'min', direction: 'lower', recent_mean: 360, recent_days: 7, baseline_days: 30 });
    // baseline = (7*360 + 23*450) / 30 = 429
    expect(sleep.baseline_mean).toBe(429);
    const steps = ctx.facts.find((f) => f.kind === 'activity_volume')!;
    expect(steps).toMatchObject({ category: 'activity', code: 'steps', direction: 'higher', recent_mean: 11000 });
  });

  it('too little data gives no fact -> empty', async () => {
    await seed(h, 10, () => 420, () => 8000);
    grantAll(h);
    expect((await buildWellnessContextWith(h.deps, ME, { purpose: 'wellness_chat' })).status).toBe('empty');
  });
});

// ---------------------------------------------------------------------------
// Comparison functions on fixture rows
// ---------------------------------------------------------------------------

function rows(code: string, unit: string, values: Array<number | null>): Array<{ date: string; code: string; value: number | null; unit: string }> {
  // values[i] = value i days before AS_OF
  return values.map((v, i) => ({ date: daysBefore(i), code, value: v, unit }));
}

describe('comparison functions (pure)', () => {
  it('direction: lower / higher / stable (within ±5 %)', () => {
    const lower = sleepDurationVsBaseline(rows('sleep_session', 'min', Array.from({ length: 30 }, (_, i) => (i < 7 ? 300 : 480))), AS_OF)!;
    expect(lower.direction).toBe('lower');
    expect(lower.change_pct).toBeLessThan(0);
    const higher = activityVolume(rows('steps', '{steps}', Array.from({ length: 30 }, (_, i) => (i < 7 ? 12000 : 6000))), AS_OF)!;
    expect(higher.direction).toBe('higher');
    expect(higher.change_pct).toBeGreaterThan(0);
    const stable = activityVolume(rows('steps', '{steps}', Array.from({ length: 30 }, (_, i) => (i < 7 ? 8100 : 8000))), AS_OF)!;
    expect(stable.direction).toBe('stable');
  });

  it('windows: recent = last 7 days, baseline = last 30 days, both ending on the reference date', () => {
    const f = sleepDurationVsBaseline(rows('sleep_session', 'min', Array.from({ length: 40 }, () => 420)), AS_OF)!;
    expect(f.recent_window).toEqual({ from: daysBefore(6), to: AS_OF });
    expect(f.baseline_window).toEqual({ from: daysBefore(29), to: AS_OF });
    expect(f.recent_days).toBe(7);
    expect(f.baseline_days).toBe(30);
  });

  it('minimum data: fewer than 4 recent days or 14 baseline days gives no fact', () => {
    const sparseRecent = Array.from({ length: 30 }, (_, i) => (i < 7 ? (i < 3 ? 400 : null) : 420));
    expect(sleepDurationVsBaseline(rows('sleep_session', 'min', sparseRecent), AS_OF)).toBeNull();
    const shortBaseline = Array.from({ length: 13 }, () => 420);
    expect(sleepDurationVsBaseline(rows('sleep_session', 'min', shortBaseline), AS_OF)).toBeNull();
    // 4 recent days + 10 older days = exactly 14 baseline days.
    const enough = Array.from({ length: 17 }, (_, i) => (i < 7 ? (i < 4 ? 400 : null) : 420));
    expect(sleepDurationVsBaseline(rows('sleep_session', 'min', enough), AS_OF)).not.toBeNull();
  });

  it('a zero baseline gives no fact; other codes and out-of-window rows are ignored', () => {
    expect(activityVolume(rows('steps', '{steps}', Array.from({ length: 30 }, () => 0)), AS_OF)).toBeNull();
    expect(activityVolume(rows('active_energy', 'kcal', Array.from({ length: 30 }, () => 500)), AS_OF)).toBeNull();
    const future = [{ date: '2026-10-20', code: 'steps', value: 99999, unit: '{steps}' }];
    const base = rows('steps', '{steps}', Array.from({ length: 30 }, () => 8000));
    expect(activityVolume([...future, ...base], AS_OF)!.recent_mean).toBe(8000);
  });
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const FACT: WellnessFact = {
  kind: 'sleep_duration_vs_baseline',
  category: 'sleep',
  code: 'sleep_session',
  unit: 'min',
  direction: 'lower',
  recent_mean: 360,
  baseline_mean: 429,
  change_pct: -16,
  recent_days: 7,
  baseline_days: 30,
  recent_window: { from: daysBefore(6), to: AS_OF },
  baseline_window: { from: daysBefore(29), to: AS_OF },
};

describe('buildWellnessSystemPrompt', () => {
  it.each(GATEWAY_LOCALES.map((l) => [l]))('always wraps with the user locale (%s)', (locale) => {
    const ctx: WellnessContext = { status: 'ok', locale, facts: [FACT] };
    const out = buildWellnessSystemPrompt('BASE', ctx);
    const unwrappedBody = out.slice(out.indexOf('BASE'));
    expect(out).toBe(buildLocalizedSystemPrompt(unwrappedBody, locale));
    expect(out.startsWith('LANGUAGE: Respond ONLY in ')).toBe(true);
  });

  it('covers all 11 shipped locales', () => {
    expect([...GATEWAY_LOCALES].sort()).toEqual(['ar', 'de', 'en', 'es', 'fr', 'pl', 'pt', 'ru', 'sr', 'tr', 'zh']);
  });

  it('renders the facts as a data block and every boundary rule; non-catalogue kinds are dropped', () => {
    const rogue = { ...FACT, kind: 'condition_label' as never };
    const out = buildWellnessSystemPrompt('BASE', { status: 'ok', locale: 'en', facts: [FACT, rogue] });
    const block = out.slice(out.indexOf(WELLNESS_FACTS_OPEN) + WELLNESS_FACTS_OPEN.length, out.indexOf('</wellness_facts>')).trim();
    const parsed = JSON.parse(block) as Array<{ kind: string }>;
    expect(parsed.map((f) => f.kind)).toEqual(['sleep_duration_vs_baseline']);
    for (const r of WELLNESS_BOUNDARY_RULES) expect(out).toContain(r);
    for (const f of parsed) expect(WELLNESS_FACT_KINDS).toContain(f.kind);
  });

  it('no facts unless status is ok; still locale-wrapped with the rules', () => {
    for (const status of ['disabled', 'consent_required', 'empty'] as const) {
      const out = buildWellnessSystemPrompt('BASE', { status, locale: 'tr', facts: [FACT] });
      expect(out).toContain(`${WELLNESS_FACTS_OPEN}\n[]\n`);
      expect(out.startsWith('LANGUAGE: Respond ONLY in Turkish')).toBe(true);
      expect(out).toContain(WELLNESS_BOUNDARY_RULES[2]);
    }
  });

  it('boundary rules are intent, not finished speech: no quoted sentences', () => {
    for (const r of WELLNESS_BOUNDARY_RULES) expect(r).not.toMatch(/["“”„«»]/);
  });
});
