/**
 * VTID-04506 (Community Autopilot CA-6): due Autopilot slots are offered on the
 * next ORB wake, a "yes" starts them, and a linked reminder's "done" closes
 * the slot and its suggestion.
 */
process.env.NODE_ENV = 'test';

const mockGetOwn = jest.fn();
const mockMarkCompleted = jest.fn();
jest.mock('../src/services/calendar-service', () => ({
  getOwnCalendarEvent: (...a: unknown[]) => mockGetOwn(...a),
  markEventCompleted: (...a: unknown[]) => mockMarkCompleted(...a),
}));
const mockCompleteSource = jest.fn(async () => ({ completed: true, source_ref_type: 'autopilot_recommendation' }));
jest.mock('../src/services/calendar-producers', () => ({
  completeSourceForCalendarEvent: (...a: unknown[]) => (mockCompleteSource as any)(...a),
}));

import { findDueAutopilotSlot, isInDueWindow, startAutopilotSlot, completeReminderLinkedSlot } from '../src/services/community-autopilot/slot-due';
import { makeAutopilotSlotDueProvider, AUTOPILOT_SLOT_DUE_EXTRA_KEY } from '../src/services/assistant-continuation/providers/autopilot-slot-due';
import { tool_start_autopilot_slot } from '../src/services/orb-tools/community-autopilot-tools';
import { classifyOrbTool } from '../src/services/orchestrator/tool-catalog';

const USER = 'aaaa1111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-24T17:00:00Z');

function fakeSb(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      let data = [...(tables[table] ?? [])];
      const q: any = {
        select: () => q, order: () => q, limit: () => q,
        eq: (c: string, v: any) => { data = data.filter((r) => r[c] === v); return q; },
        is: (c: string, v: any) => { data = data.filter((r) => (r[c] ?? null) === v); return q; },
        gte: (c: string, v: string) => { data = data.filter((r) => r[c] >= v); return q; },
        lte: (c: string, v: string) => { data = data.filter((r) => r[c] <= v); return q; },
        then: (res: any, rej: any) => Promise.resolve({ data, error: null }).then(res, rej),
      };
      return q;
    },
  } as any;
}

const slotEvent = (over: Record<string, unknown> = {}) => ({
  id: 'ev-1', user_id: USER, title: 'Hydration check-in', start_time: '2026-09-24T16:50:00.000Z',
  source_type: 'autopilot', source_ref_type: 'autopilot_recommendation', source_ref_id: 'rec-1',
  status: 'confirmed', completed_at: null, ...over,
});
const rec = (over: Record<string, unknown> = {}) => ({
  id: 'rec-1', user_id: USER, title: 'Trink ein Glas Wasser', status: 'activated', source_ref: 'weakness_hydration', action: null, ...over,
});

describe('due window', () => {
  it('30 minutes before … 15 minutes after now', () => {
    expect(isInDueWindow('2026-09-24T16:31:00Z', NOW)).toBe(true);
    expect(isInDueWindow('2026-09-24T17:14:00Z', NOW)).toBe(true);
    expect(isInDueWindow('2026-09-24T16:20:00Z', NOW)).toBe(false);
    expect(isInDueWindow('2026-09-24T17:30:00Z', NOW)).toBe(false);
  });
});

describe('findDueAutopilotSlot', () => {
  it('finds the member\'s due slot whose suggestion is still activated, with the screen to open', async () => {
    const slot = await findDueAutopilotSlot(fakeSb({ calendar_events: [slotEvent()], autopilot_recommendations: [rec()] }), USER, NOW);
    expect(slot).toMatchObject({ eventId: 'ev-1', recommendationId: 'rec-1', route: '/health' });
  });

  it('ignores completed slots, other sources and suggestions no longer activated', async () => {
    expect(await findDueAutopilotSlot(fakeSb({ calendar_events: [slotEvent({ completed_at: '2026-09-24T16:55:00Z' })], autopilot_recommendations: [rec()] }), USER, NOW)).toBeNull();
    expect(await findDueAutopilotSlot(fakeSb({ calendar_events: [slotEvent({ source_type: 'manual' })], autopilot_recommendations: [rec()] }), USER, NOW)).toBeNull();
    expect(await findDueAutopilotSlot(fakeSb({ calendar_events: [slotEvent()], autopilot_recommendations: [rec({ status: 'completed' })] }), USER, NOW)).toBeNull();
  });

  it('never returns another member\'s slot', async () => {
    expect(await findDueAutopilotSlot(fakeSb({ calendar_events: [slotEvent({ user_id: 'other' })], autopilot_recommendations: [rec()] }), USER, NOW)).toBeNull();
  });
});

describe('wake provider', () => {
  it('offers the due slot as an ask_permission CTA that runs start_autopilot_slot', async () => {
    const provider = makeAutopilotSlotDueProvider({ now: () => NOW });
    const sb = fakeSb({ calendar_events: [slotEvent()], autopilot_recommendations: [rec()] });
    const r = await provider.produce({ extra: { [AUTOPILOT_SLOT_DUE_EXTRA_KEY]: { supabase: sb, userId: USER } } } as any);
    expect(r.status).toBe('returned');
    expect(r.candidate!.cta).toEqual({ type: 'ask_permission', onYesTool: 'start_autopilot_slot', payload: { event_id: 'ev-1' } });
    expect(r.candidate!.userFacingLine).toContain('Trink ein Glas Wasser');
    expect(r.candidate!.dedupeKey).toBe('autopilot-slot-due:ev-1');
  });

  it('suppresses when nothing is due', async () => {
    const provider = makeAutopilotSlotDueProvider({ now: () => NOW });
    const r = await provider.produce({ extra: { [AUTOPILOT_SLOT_DUE_EXTRA_KEY]: { supabase: fakeSb({}), userId: USER } } } as any);
    expect(r.status).toBe('suppressed');
  });

  it('a spoken yes may run it: start_autopilot_slot is a self commit', () => {
    const cap = classifyOrbTool('start_autopilot_slot');
    expect(cap.tier).toBe('commit');
    expect(cap.self).toBe(true);
  });
});

describe('start + reminder completion', () => {
  beforeEach(() => {
    mockGetOwn.mockReset(); mockMarkCompleted.mockReset(); mockCompleteSource.mockClear();
  });

  it('completes the slot and its suggestion', async () => {
    mockGetOwn.mockResolvedValue(slotEvent());
    mockMarkCompleted.mockResolvedValue(slotEvent({ completed_at: NOW.toISOString() }));
    const r = await startAutopilotSlot(USER, 'ev-1');
    expect(r).toMatchObject({ ok: true, recommendation_completed: true });
    expect(mockMarkCompleted).toHaveBeenCalledWith('ev-1', USER, 'completed');
    expect(mockCompleteSource).toHaveBeenCalled();
  });

  it('refuses a slot that is not the member\'s or not from the Autopilot', async () => {
    mockGetOwn.mockResolvedValue(null);
    expect(await startAutopilotSlot(USER, 'ev-x')).toMatchObject({ ok: false, error: 'slot_not_found' });
    mockGetOwn.mockResolvedValue(slotEvent({ source_type: 'manual' }));
    expect(await startAutopilotSlot(USER, 'ev-1')).toMatchObject({ ok: false, error: 'not_an_autopilot_slot' });
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });

  it('the voice tool needs a signed-in member and an event id', async () => {
    expect(await tool_start_autopilot_slot({}, { user_id: '' } as any, {} as any)).toMatchObject({ ok: false });
    expect(await tool_start_autopilot_slot({}, { user_id: USER } as any, {} as any)).toMatchObject({ ok: false, error: 'event_id is required' });
  });

  it('a reminder linked to a slot closes the slot too; an unlinked one does nothing', async () => {
    mockGetOwn.mockResolvedValue(slotEvent());
    mockMarkCompleted.mockResolvedValue(slotEvent({ completed_at: NOW.toISOString() }));
    expect(await completeReminderLinkedSlot({ calendar_event_id: 'ev-1' }, USER)).toMatchObject({ ok: true });
    expect(await completeReminderLinkedSlot({ calendar_event_id: null }, USER)).toBeNull();
  });
});
