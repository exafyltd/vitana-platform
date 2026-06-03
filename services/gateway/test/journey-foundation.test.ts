/**
 * VTID-03255 — Journey Foundation P1 (read path) tests.
 *
 * Covers: the step registry invariants (gate is tier 0, dual-axis, graduation
 * set), next-step + gate ordering, verify-live mapping, and the end-to-end
 * snapshot builder against a fake Supabase client.
 */

import {
  FOUNDATION_STEPS,
  GRADUATION_STEP_KEYS,
  getStepDef,
} from '../src/services/journey-foundation/foundation-steps';
import {
  buildStepViews,
  computeNextStep,
  isGraduated,
  nextStepPrompt,
} from '../src/services/journey-foundation/journey-foundation-next-step';
import { verifyAllSteps } from '../src/services/journey-foundation/journey-foundation-verifier';
import { buildJourneyFoundationSnapshot } from '../src/services/journey-foundation/journey-foundation-state';
import type {
  FoundationStepStatus,
  JourneyFoundationRow,
} from '../src/services/journey-foundation/types';

// ── Fake Supabase client ─────────────────────────────────────────────────────
// Every table maps to a fixture array. Chainable filter methods are no-ops that
// return `this`; terminal resolution reads the fixture (filters are pre-applied
// in the fixture, mirroring the single-intent queries the code issues).
type Fixture = Record<string, any[]>;

function makeClient(fixture: Fixture) {
  const builder = (table: string) => {
    const rows = () => fixture[table] ?? [];
    const result = () => ({ data: rows(), count: rows().length, error: null });
    const api: any = {};
    for (const m of ['select', 'eq', 'neq', 'not', 'gt', 'gte', 'lt', 'order', 'limit', 'in']) {
      api[m] = () => api;
    }
    api.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
    api.single = api.maybeSingle;
    api.then = (onF: any, onR: any) => Promise.resolve(result()).then(onF, onR);
    api.catch = (onR: any) => Promise.resolve(result()).catch(onR);
    return api;
  };
  return { from: (table: string) => builder(table) } as any;
}

const futureDate = '2026-12-09'; // ~190 days past 2026-06-02 in the example spirit

function row(overrides: Partial<JourneyFoundationRow> = {}): JourneyFoundationRow {
  return {
    user_id: 'u1',
    journey_started_at: null,
    current_next_step: null,
    economic_intent: null,
    focus_pillar: null,
    completed_steps_cache: [],
    metadata: {},
    created_at: '2026-06-02T08:00:00Z',
    updated_at: '2026-06-02T08:00:00Z',
    ...overrides,
  };
}

// ── Registry invariants ──────────────────────────────────────────────────────
describe('foundation-steps registry', () => {
  it('has a single tier-0 gate which is life_compass', () => {
    const gates = FOUNDATION_STEPS.filter((s) => s.tier === 0);
    expect(gates).toHaveLength(1);
    expect(gates[0].key).toBe('life_compass');
  });

  it('carries both health and economy strands (dual axis)', () => {
    const strands = new Set(FOUNDATION_STEPS.map((s) => s.strand));
    expect(strands.has('health')).toBe(true);
    expect(strands.has('economy')).toBe(true);
  });

  it('includes the two teacher moments and they are required for graduation', () => {
    expect(getStepDef('understand_economy')?.type).toBe('teacher');
    expect(getStepDef('understand_economy')?.required_for_graduation).toBe(true);
    expect(getStepDef('autopilot')?.type).toBe('teacher');
    expect(getStepDef('autopilot')?.required_for_graduation).toBe(true);
  });

  it('treats economy ACTIVATION steps as inspire-never-block', () => {
    for (const k of ['economic_aspiration', 'connect', 'events', 'marketplace', 'business_live_media']) {
      expect(getStepDef(k)?.required_for_graduation).toBe(false);
    }
  });

  it('keeps tiers monotonically non-decreasing in registry order', () => {
    const tiers = FOUNDATION_STEPS.map((s) => s.tier);
    for (let i = 1; i < tiers.length; i++) expect(tiers[i]).toBeGreaterThanOrEqual(tiers[i - 1]);
  });

  it('every step has both an execute and a teach prompt', () => {
    for (const s of FOUNDATION_STEPS) {
      expect(s.execute_prompt.length).toBeGreaterThan(0);
      expect(s.teach_prompt.length).toBeGreaterThan(0);
    }
  });
});

// ── next-step + gate ─────────────────────────────────────────────────────────
describe('computeNextStep + gate', () => {
  const allOpen = (): Map<string, FoundationStepStatus> =>
    new Map(FOUNDATION_STEPS.map((s) => [s.key, 'open' as FoundationStepStatus]));

  it('drives the gate first for a brand-new user', () => {
    const views = buildStepViews(allOpen());
    expect(computeNextStep(views)?.key).toBe('life_compass');
    expect(isGraduated(views)).toBe(false);
  });

  it('returns the gate even if a later step is somehow done', () => {
    const m = allOpen();
    m.set('diary', 'done');
    const next = computeNextStep(buildStepViews(m));
    expect(next?.key).toBe('life_compass');
  });

  it('moves to the first unfinished required step after the gate passes', () => {
    const m = allOpen();
    m.set('life_compass', 'done');
    m.set('weakest_habit', 'done');
    m.set('reminder', 'active');
    const next = computeNextStep(buildStepViews(m));
    expect(next?.key).toBe('understand_economy'); // required teacher moment
  });

  it('graduates on required steps alone and then still offers an economy activation step', () => {
    const m = allOpen();
    for (const k of GRADUATION_STEP_KEYS) m.set(k, 'done');
    const views = buildStepViews(m);
    expect(isGraduated(views)).toBe(true);
    // activation steps remain open → inspire-always
    expect(computeNextStep(views)?.required_for_graduation).toBe(false);
  });

  it('speaks beat B of the gate when the goal is set but economy stance is missing', () => {
    const gateView = buildStepViews(new Map([['life_compass', 'open']])).find(
      (v) => v.key === 'life_compass',
    )!;
    const prompt = nextStepPrompt(gateView, { goalSet: true, economicIntentSet: false });
    expect(prompt).toMatch(/earn|business|passive income|recommendations|curious/i);
  });

  it('flips execute → teach in teacher mode', () => {
    const view = buildStepViews(new Map([['diary', 'open']])).find((v) => v.key === 'diary')!;
    const execute = nextStepPrompt(view, { teachMode: false });
    const teach = nextStepPrompt(view, { teachMode: true });
    expect(execute).toBe(getStepDef('diary')!.execute_prompt);
    expect(teach).toBe(getStepDef('diary')!.teach_prompt);
    expect(execute).not.toBe(teach);
  });
});

// ── verify-live ──────────────────────────────────────────────────────────────
describe('verifyAllSteps (verify-live)', () => {
  it('reports everything open for an empty user', async () => {
    const client = makeClient({});
    const statuses = await verifyAllSteps(client, 'u1', row());
    expect(statuses.get('life_compass')).toBe('open');
    expect(statuses.get('diary')).toBe('open');
  });

  it('does NOT mark calendar done from auto-seeded journey events', async () => {
    // calendar_events fixture is the POST-filtered (neq source_type journey)
    // set — empty means the user only has journey-seeded events.
    const client = makeClient({ calendar_events: [] });
    const statuses = await verifyAllSteps(client, 'u1', row());
    expect(statuses.get('calendar')).toBe('open');
  });

  it('marks calendar done when a real user-created event exists', async () => {
    const client = makeClient({ calendar_events: [{ id: 'e1' }] });
    const statuses = await verifyAllSteps(client, 'u1', row());
    expect(statuses.get('calendar')).toBe('done');
  });

  it('marks the dual-axis gate done only when goal AND economic intent are present', async () => {
    const withGoal = makeClient({ life_compass: [{ primary_goal: 'Lose 5kg' }] });
    expect((await verifyAllSteps(withGoal, 'u1', row())).get('life_compass')).toBe('open');
    expect(
      (await verifyAllSteps(withGoal, 'u1', row({ economic_intent: 'curious' }))).get(
        'life_compass',
      ),
    ).toBe('done');
  });

  it('reports a running reminder as active, a completed one as done', async () => {
    const running = makeClient({ reminders: [{ status: 'pending' }] });
    const finished = makeClient({ reminders: [{ status: 'completed' }] });
    expect((await verifyAllSteps(running, 'u1', row())).get('reminder')).toBe('active');
    expect((await verifyAllSteps(finished, 'u1', row())).get('reminder')).toBe('done');
  });

  it('reports activated autopilot as active, teacher-acked autopilot as done', async () => {
    const activated = makeClient({ autopilot_recommendations: [{ id: 'r1' }] });
    expect((await verifyAllSteps(activated, 'u1', row())).get('autopilot')).toBe('active');
    const acked = makeClient({});
    const r = row({ metadata: { teacher_ack: ['autopilot'] } });
    expect((await verifyAllSteps(acked, 'u1', r)).get('autopilot')).toBe('done');
  });
});

// ── snapshot builder ─────────────────────────────────────────────────────────
describe('buildJourneyFoundationSnapshot', () => {
  it('returns a not-started journey for a brand-new user', async () => {
    const client = makeClient({});
    const snap = await buildJourneyFoundationSnapshot(client, 'u1');
    expect(snap.journey_started).toBe(false);
    expect(snap.current_next_step?.key).toBe('life_compass');
    expect(snap.goal_day).toBeNull();
    expect(snap.north_stars.health).toBeNull();
    expect(snap.north_stars.economy).toBeNull();
    expect(snap.graduated).toBe(false);
  });

  it('starts the journey and surfaces both north stars once the gate passes', async () => {
    const client = makeClient({
      user_journey_foundation: [
        row({
          journey_started_at: '2026-06-02T09:00:00Z',
          economic_intent: 'curious',
          focus_pillar: 'hydration',
        }),
      ],
      life_compass: [
        { primary_goal: 'Lose 5kg', category: 'longevity', target_date: futureDate, target_value: 5, target_unit: 'kg', starting_value: 80 },
      ],
      reminders: [{ status: 'pending' }],
      profiles: [{ created_at: '2026-06-02T08:00:00Z' }],
    });
    const snap = await buildJourneyFoundationSnapshot(client, 'u1');
    expect(snap.journey_started).toBe(true);
    expect(snap.north_stars.health).toBe('Lose 5kg');
    expect(snap.north_stars.economy).toMatch(/exploring/i);
    expect(snap.weakest_habit).toBe('hydration');
    expect(snap.goal_day).toBeGreaterThanOrEqual(1);
    expect(snap.days_left).toBeGreaterThan(0);
    // weakest_habit + reminder satisfied → next required is the economy teacher moment
    expect(snap.current_next_step?.key).toBe('understand_economy');
    expect(snap.suggested_navigation).toBe('/learn/economy');
  });

  it('marks a health-only user graduated while economy activation stays open', async () => {
    const client = makeClient({
      user_journey_foundation: [
        row({
          journey_started_at: '2026-06-02T09:00:00Z',
          economic_intent: 'curious',
          focus_pillar: 'hydration',
          metadata: { teacher_ack: ['understand_economy', 'autopilot'] },
        }),
      ],
      life_compass: [{ primary_goal: 'Lose 5kg', target_date: futureDate }],
      reminders: [{ status: 'completed' }],
      memory_diary_entries: [{ id: 'd1' }],
      vitana_index_baseline_survey: [{ completed_at: '2026-06-02T10:00:00Z' }],
      profiles: [{ full_name: 'Daniel', date_of_birth: '1990-01-01', created_at: '2026-06-02T08:00:00Z' }],
      calendar_events: [{ id: 'c1' }],
    });
    const snap = await buildJourneyFoundationSnapshot(client, 'u1');
    expect(snap.graduated).toBe(true);
    expect(snap.current_next_step?.required_for_graduation).toBe(false);
  });
});
