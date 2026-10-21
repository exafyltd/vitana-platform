/**
 * create_index_improvement_plan — CONFIRM-BEFORE-WRITE.
 *
 * THE BUG (operator screenshots): Vitana proposed a plan, the user agreed to
 * "a plan", and she immediately wrote 6 calendar events without showing them —
 * "Ich habe ja keine Ahnung, was du da einträgst" / "du musst doch erst mit mir".
 *
 * Contract pinned here:
 *  - default (confirm omitted/false) → PROPOSE: returns the concrete plan, writes
 *    NOTHING (createCalendarEvent never called), text asks for the go-ahead.
 *  - confirm=true → COMMIT: writes the events and reports what was added.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

const createCalendarEvent = jest.fn(
  async (_uid: string, input: { title: string; start_time: string }) => ({
    title: input.title,
    start_time: input.start_time,
  }),
);
jest.mock('../../../src/services/calendar-service', () => ({ createCalendarEvent }));

import { tool_create_index_improvement_plan } from '../../../src/services/orb-tools-shared';
import { buildIndexPlanPreviewText } from '../../../src/services/orb-index-coach-text';

// sb only needs the autopilot_recommendations query → return [] so the tool
// falls back to the built-in PILLAR_ACTION_TEMPLATES (real, has nutrition items).
function makeSb() {
  return {
    from() {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.in = () => c;
      c.not = () => c;
      c.order = () => c;
      c.limit = () => Promise.resolve({ data: [] });
      return c;
    },
  } as never;
}

const id = { user_id: 'u1', tenant_id: 't1', role: 'community' } as never;

beforeEach(() => createCalendarEvent.mockClear());

describe('create_index_improvement_plan — confirm-before-write', () => {
  it('default (no confirm) → PROPOSE: writes nothing, asks for the go-ahead', async () => {
    const r = await tool_create_index_improvement_plan({ pillar: 'nutrition', days: 14, actions_per_week: 3 }, id, makeSb());
    expect(r.ok).toBe(true);
    expect(createCalendarEvent).not.toHaveBeenCalled(); // NOTHING written
    expect((r as { result: { preview?: boolean } }).result.preview).toBe(true);
    expect(r.text).toMatch(/PROPOSAL/);
    expect(r.text).toMatch(/NOT yet on the calendar/i);
    expect(r.text).toMatch(/confirm=true/);
    expect(r.text).toMatch(/Do NOT say you already added/i);
  });

  it('confirm=true → COMMIT: writes the events and reports what was added', async () => {
    const r = await tool_create_index_improvement_plan(
      { pillar: 'nutrition', days: 14, actions_per_week: 3, confirm: true },
      id,
      makeSb(),
    );
    expect(r.ok).toBe(true);
    expect(createCalendarEvent).toHaveBeenCalled(); // events WRITTEN
    expect((r as { result: { scheduled_count?: number } }).result.scheduled_count).toBeGreaterThan(0);
    expect(r.text).toMatch(/added to the calendar/i);
    expect(r.text).not.toMatch(/PROPOSAL/);
  });
});

describe('buildIndexPlanPreviewText', () => {
  it('names each proposed activity + date, asks, and instructs the confirm re-call', () => {
    const t = buildIndexPlanPreviewText('nutrition', 14, [
      { title: 'Meal planning block', start_time: '2026-06-30T10:00:00Z' },
      { title: 'Mindful eating session', start_time: '2026-07-02T10:00:00Z' },
    ]);
    expect(t).toMatch(/Meal planning block \(2026-06-30\)/);
    expect(t).toMatch(/NOT yet on the calendar/i);
    expect(t).toMatch(/ASK whether to add them/i);
    expect(t).toMatch(/confirm=true/);
    expect(t).toMatch(/Do NOT say you already added/i);
  });
});
