/**
 * VTID-03255 — Journey Foundation P2 (write + delta) tests.
 *
 * Uses a small STATEFUL fake Supabase client so writes (insert/update) are
 * reflected in subsequent verify-live reads — proving the full
 * answer → write → re-verify → delta loop, including the dual-axis gate.
 */

import {
  applyJourneyAnswer,
} from '../src/services/journey-foundation/journey-foundation-delta';

// ── Stateful fake client ─────────────────────────────────────────────────────
// Tables are mutable arrays. Filters are ignored (queries are single-intent);
// inserts/updates mutate the backing array so later reads see them.
function makeStatefulClient(seed: Record<string, any[]> = {}) {
  const db: Record<string, any[]> = { ...seed };
  const rows = (t: string) => (db[t] ??= []);

  function builder(table: string) {
    let pending: any = null; // staged insert payload
    const api: any = {};
    const chain = ['select', 'eq', 'neq', 'not', 'gt', 'gte', 'lt', 'order', 'limit', 'in'];
    for (const m of chain) api[m] = () => api;
    api.insert = (obj: any) => {
      const arr = Array.isArray(obj) ? obj : [obj];
      for (const o of arr) rows(table).push({ ...o });
      pending = arr[arr.length - 1];
      return api;
    };
    api.update = (patch: any) => {
      const list = rows(table);
      if (list.length) Object.assign(list[0], patch);
      else list.push({ ...patch });
      pending = list[0] ?? patch;
      return api;
    };
    api.delete = () => api;
    api.maybeSingle = () =>
      Promise.resolve({ data: pending ?? rows(table)[0] ?? null, error: null });
    api.single = api.maybeSingle;
    const result = () => ({ data: rows(table), count: rows(table).length, error: null });
    api.then = (onF: any, onR: any) => Promise.resolve(result()).then(onF, onR);
    api.catch = (onR: any) => Promise.resolve(result()).catch(onR);
    return api;
  }

  return { _db: db, from: (t: string) => builder(t) } as any;
}

describe('applyJourneyAnswer — write + delta', () => {
  it('writes the goal to life_compass and reports the next move', async () => {
    const client = makeStatefulClient();
    const delta = await applyJourneyAnswer(client, 'u1', {
      step: 'life_compass',
      value: 'Lose 5kg',
      target_value: 5,
      target_unit: 'kg',
      target_date: '2026-12-09',
    });
    expect(client._db['life_compass'][0].primary_goal).toBe('Lose 5kg');
    expect(client._db['life_compass'][0].target_value).toBe(5);
    expect(delta.changed_fields).toContain('life_compass.primary_goal');
    // Goal set but no economy stance yet → gate not passed, still on the gate.
    expect(delta.next_step?.key).toBe('life_compass');
  });

  it('passes the dual-axis gate once both the goal AND economic intent exist', async () => {
    const client = makeStatefulClient({
      life_compass: [{ id: 'g1', primary_goal: 'Lose 5kg', is_active: true }],
    });
    const delta = await applyJourneyAnswer(client, 'u1', {
      step: 'economic_intent',
      value: 'just curious for now',
    });
    expect(client._db['user_journey_foundation'][0].economic_intent).toBe('curious');
    expect(delta.changed_fields).toContain('journey_started_at');
    expect(client._db['user_journey_foundation'][0].journey_started_at).toBeTruthy();
    // Gate passed → next move advances past the gate.
    expect(delta.next_step?.key).not.toBe('life_compass');
  });

  it('normalizes a free-text weakest-habit answer into a pillar', async () => {
    const client = makeStatefulClient();
    await applyJourneyAnswer(client, 'u1', { step: 'weakest_habit', value: 'drinking water' });
    expect(client._db['user_journey_foundation'][0].focus_pillar).toBe('hydration');
  });

  it('records a teacher-moment acknowledgment', async () => {
    const client = makeStatefulClient();
    const delta = await applyJourneyAnswer(client, 'u1', {
      step: 'understand_economy',
      acknowledged: true,
    });
    const ack = client._db['user_journey_foundation'][0].metadata?.teacher_ack ?? [];
    expect(ack).toContain('understand_economy');
    expect(delta.changed_fields).toContain('teacher_ack.understand_economy');
  });

  it('maps a business answer to build_business and surfaces a screen message', async () => {
    const client = makeStatefulClient();
    const delta = await applyJourneyAnswer(client, 'u1', {
      step: 'economic_intent',
      value: 'I want to start a business',
    });
    expect(client._db['user_journey_foundation'][0].economic_intent).toBe('build_business');
    expect(delta.screen_message).toMatch(/stance/i);
  });

  it('VTID-03270: teach mode never writes data (no junk goal from a teaching beat)', async () => {
    // Repro of the live bug: the model called record_journey_answer in a teaching
    // beat with step=life_compass + a step-description value. That must NOT write
    // a goal.
    const client = makeStatefulClient();
    const delta = await applyJourneyAnswer(client, 'u1', {
      step: 'life_compass',
      value: 'profil vervollständigen',
      teachMode: true,
    });
    expect(client._db['life_compass'] ?? []).toHaveLength(0); // no goal row written
    expect(delta.changed_fields).not.toContain('life_compass.primary_goal');
    // a real (non-teach) answer still writes
    const client2 = makeStatefulClient();
    await applyJourneyAnswer(client2, 'u1', { step: 'life_compass', value: 'Lose 5kg' });
    expect(client2._db['life_compass'][0].primary_goal).toBe('Lose 5kg');
  });
});
