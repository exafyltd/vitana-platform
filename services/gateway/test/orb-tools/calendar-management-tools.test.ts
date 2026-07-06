/**
 * Calendar management voice tools (VTID-02761) — unit tests.
 *
 * Mocked SupabaseClient (chainable builder, thenable) for reads and a mocked
 * calendar-service module for the write paths (reschedule/cancel/complete)
 * and the conflict check — no network, no real DB.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

jest.mock('../../src/services/calendar-service', () => ({
  rescheduleEvent: jest.fn(),
  softDeleteEvent: jest.fn(),
  markEventCompleted: jest.fn(),
  checkConflicts: jest.fn(),
}));

import {
  rescheduleEvent,
  softDeleteEvent,
  markEventCompleted,
  checkConflicts,
} from '../../src/services/calendar-service';
import {
  CALENDAR_MGMT_TOOL_HANDLERS,
  CALENDAR_MGMT_TOOL_DECLARATIONS,
  tool_reschedule_event,
  tool_cancel_event,
  tool_complete_event,
  tool_find_free_slot,
  tool_get_event_details,
  tool_check_calendar_conflicts,
} from '../../src/services/orb-tools/calendar-management-tools';

const IDENT = { user_id: 'user-1', tenant_id: 'tenant-1', role: 'community' };
const NO_USER = { user_id: '', tenant_id: 'tenant-1', role: 'community' } as any;

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ev-1',
    title: 'Yoga class',
    description: null,
    location: 'Studio 3',
    start_time: '2030-01-07T09:00:00.000Z',
    end_time: '2030-01-07T10:00:00.000Z',
    event_type: 'health',
    status: 'confirmed',
    completion_status: null,
    completed_at: null,
    completion_notes: null,
    reschedule_count: 0,
    original_start_time: null,
    priority_score: 50,
    wellness_tags: ['exercise'],
    source_type: 'manual',
    role_context: 'community',
    ...overrides,
  };
}

/** Chainable, thenable supabase mock resolving every query with `rows`. */
function fakeSupabase(rows: unknown[], error: { message: string } | null = null) {
  const builder: any = {};
  for (const m of ['select', 'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'ilike', 'order', 'limit', 'is']) {
    builder[m] = jest.fn(() => builder);
  }
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error });
  const from = jest.fn(() => builder);
  return { sb: { from } as unknown as SupabaseClient, builder, from };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe('calendar management tools — exports', () => {
  const NAMES = [
    'reschedule_event',
    'cancel_event',
    'complete_event',
    'find_free_slot',
    'get_event_details',
    'check_calendar_conflicts',
  ];

  it.each(NAMES)('%s has a handler and a declaration', (name) => {
    expect(typeof CALENDAR_MGMT_TOOL_HANDLERS[name]).toBe('function');
    const decl = CALENDAR_MGMT_TOOL_DECLARATIONS.find((d) => d.name === name);
    expect(decl).toBeDefined();
    expect(typeof decl!.description).toBe('string');
  });

  it('declarations avoid Vertex-unsupported schema keys', () => {
    const banned = ['"default"', '"minimum"', '"maximum"', '"format"', '"examples"'];
    const json = JSON.stringify(CALENDAR_MGMT_TOOL_DECLARATIONS.map((d) => d.parameters));
    for (const key of banned) expect(json).not.toContain(key);
  });
});

// ---------------------------------------------------------------------------
// reschedule_event
// ---------------------------------------------------------------------------

describe('tool_reschedule_event', () => {
  it('moves an event and keeps its duration when new_end is omitted', async () => {
    const { sb } = fakeSupabase([event()]);
    (rescheduleEvent as jest.Mock).mockResolvedValue(event({ start_time: '2030-01-08T14:00:00.000Z' }));

    const res = await tool_reschedule_event(
      { event_id: 'ev-1', new_start: '2030-01-08T14:00:00Z' },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('Yoga class');
    expect((res as any).text).toContain('Jan 8');
    // Original event was 60 min → new_end must preserve that duration.
    expect(rescheduleEvent).toHaveBeenCalledWith(
      'ev-1',
      'user-1',
      '2030-01-08T14:00:00.000Z',
      '2030-01-08T15:00:00.000Z',
    );
  });

  it('returns a disambiguation list when the title matches several upcoming events', async () => {
    const { sb } = fakeSupabase([
      event({ id: 'ev-1', title: 'Yoga class', start_time: '2030-01-07T09:00:00.000Z' }),
      event({ id: 'ev-2', title: 'Yoga retreat', start_time: '2030-01-09T09:00:00.000Z' }),
    ]);
    const res = await tool_reschedule_event(
      { title_query: 'yoga', new_start: '2030-01-10T09:00:00Z' },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('Yoga class');
    expect((res as any).text).toContain('Yoga retreat');
    expect((res as any).result.needs_disambiguation).toBe(true);
    expect(rescheduleEvent).not.toHaveBeenCalled();
  });

  it('rejects a missing/invalid new_start', async () => {
    const { sb } = fakeSupabase([event()]);
    const res = await tool_reschedule_event({ event_id: 'ev-1', new_start: 'not-a-date' }, IDENT, sb);
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('new_start');
  });

  it('requires an authenticated user', async () => {
    const { sb } = fakeSupabase([]);
    const res = await tool_reschedule_event({ new_start: '2030-01-08T14:00:00Z' }, NO_USER, sb);
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('authenticated');
  });
});

// ---------------------------------------------------------------------------
// cancel_event
// ---------------------------------------------------------------------------

describe('tool_cancel_event', () => {
  it('asks for confirmation before cancelling', async () => {
    const { sb } = fakeSupabase([event()]);
    const res = await tool_cancel_event({ title_query: 'yoga' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).result.needs_confirmation).toBe(true);
    expect((res as any).text).toContain('Yoga class');
    expect((res as any).text).toContain('confirm');
    expect(softDeleteEvent).not.toHaveBeenCalled();
  });

  it('cancels after confirm=true', async () => {
    const { sb } = fakeSupabase([event()]);
    (softDeleteEvent as jest.Mock).mockResolvedValue(event({ status: 'cancelled' }));
    const res = await tool_cancel_event({ event_id: 'ev-1', confirm: true }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('Cancelled');
    expect((res as any).text).toContain('Yoga class');
    expect(softDeleteEvent).toHaveBeenCalledWith('ev-1', 'user-1');
  });

  it('says so when the event is already cancelled', async () => {
    const { sb } = fakeSupabase([event({ status: 'cancelled' })]);
    const res = await tool_cancel_event({ event_id: 'ev-1', confirm: true }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('already cancelled');
    expect(softDeleteEvent).not.toHaveBeenCalled();
  });

  it('requires an authenticated user', async () => {
    const { sb } = fakeSupabase([]);
    const res = await tool_cancel_event({ event_id: 'ev-1' }, NO_USER, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// complete_event
// ---------------------------------------------------------------------------

describe('tool_complete_event', () => {
  it('marks an event as skipped with notes', async () => {
    const { sb } = fakeSupabase([event()]);
    (markEventCompleted as jest.Mock).mockResolvedValue(event({ completion_status: 'skipped' }));
    const res = await tool_complete_event(
      { event_id: 'ev-1', outcome: 'skipped', notes: 'felt tired' },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('Yoga class');
    expect((res as any).text).toContain('skipped');
    expect(markEventCompleted).toHaveBeenCalledWith('ev-1', 'user-1', 'skipped', 'felt tired');
  });

  it('defaults the outcome to completed', async () => {
    const { sb } = fakeSupabase([event()]);
    (markEventCompleted as jest.Mock).mockResolvedValue(event({ completion_status: 'completed' }));
    const res = await tool_complete_event({ event_id: 'ev-1' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect(markEventCompleted).toHaveBeenCalledWith('ev-1', 'user-1', 'completed', null);
  });

  it('rejects an unknown outcome', async () => {
    const { sb } = fakeSupabase([event()]);
    const res = await tool_complete_event({ event_id: 'ev-1', outcome: 'done-ish' }, IDENT, sb);
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('outcome');
    expect(markEventCompleted).not.toHaveBeenCalled();
  });

  it('requires an authenticated user', async () => {
    const { sb } = fakeSupabase([]);
    const res = await tool_complete_event({ event_id: 'ev-1' }, NO_USER, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// find_free_slot
// ---------------------------------------------------------------------------

describe('tool_find_free_slot', () => {
  it('finds the first gap between events within waking hours', async () => {
    // Busy 08:00-09:00 and 09:30-12:00 UTC → first 30-min gap is 09:00-09:30.
    const { sb } = fakeSupabase([
      { id: 'a', title: 'A', start_time: '2030-01-07T08:00:00.000Z', end_time: '2030-01-07T09:00:00.000Z', status: 'confirmed' },
      { id: 'b', title: 'B', start_time: '2030-01-07T09:30:00.000Z', end_time: '2030-01-07T12:00:00.000Z', status: 'confirmed' },
    ]);
    const res = await tool_find_free_slot(
      { duration_minutes: 30, search_from: '2030-01-07T00:00:00Z', timezone: 'UTC' },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    expect((res as any).result.slot_start).toBe('2030-01-07T09:00:00.000Z');
    expect((res as any).result.slot_end).toBe('2030-01-07T09:30:00.000Z');
    expect((res as any).text).toContain('30 minutes');
  });

  it('starts at 8 AM local time in the requested timezone when the calendar is empty', async () => {
    const { sb } = fakeSupabase([]);
    // Berlin is UTC+1 in January → local 08:00 = 07:00Z.
    const res = await tool_find_free_slot(
      { duration_minutes: 60, search_from: '2030-01-07T00:00:00Z', timezone: 'Europe/Berlin' },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    expect((res as any).result.slot_start).toBe('2030-01-07T07:00:00.000Z');
  });

  it('rejects a missing duration', async () => {
    const { sb } = fakeSupabase([]);
    const res = await tool_find_free_slot({}, IDENT, sb);
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('duration_minutes');
  });

  it('requires an authenticated user', async () => {
    const { sb } = fakeSupabase([]);
    const res = await tool_find_free_slot({ duration_minutes: 30 }, NO_USER, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get_event_details
// ---------------------------------------------------------------------------

describe('tool_get_event_details', () => {
  it('speaks the full details of a single match', async () => {
    const { sb } = fakeSupabase([event({ description: 'Bring your own mat' })]);
    const res = await tool_get_event_details({ title_query: 'yoga' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('Yoga class');
    expect((res as any).text).toContain('Studio 3');
    expect((res as any).text).toContain('Bring your own mat');
    expect((res as any).result.found).toBe(true);
  });

  it('answers plainly when nothing matches', async () => {
    const { sb } = fakeSupabase([]);
    const res = await tool_get_event_details({ title_query: 'unicorn parade' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).text).toContain('could not find');
  });

  it('errors without event_id or title_query', async () => {
    const { sb } = fakeSupabase([]);
    const res = await tool_get_event_details({}, IDENT, sb);
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('event_id or title_query');
  });

  it('requires an authenticated user', async () => {
    const { sb } = fakeSupabase([]);
    const res = await tool_get_event_details({ event_id: 'ev-1' }, NO_USER, sb);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// check_calendar_conflicts
// ---------------------------------------------------------------------------

describe('tool_check_calendar_conflicts', () => {
  it('names the overlapping events', async () => {
    (checkConflicts as jest.Mock).mockResolvedValue([
      event({ id: 'ev-9', title: 'Team standup', start_time: '2030-01-07T09:00:00.000Z' }),
    ]);
    const { sb } = fakeSupabase([]);
    const res = await tool_check_calendar_conflicts(
      { start_time: '2030-01-07T09:00:00Z', end_time: '2030-01-07T10:00:00Z' },
      IDENT,
      sb,
    );
    expect(res.ok).toBe(true);
    expect((res as any).result.has_conflicts).toBe(true);
    expect((res as any).text).toContain('Team standup');
    expect(checkConflicts).toHaveBeenCalledWith(
      'user-1',
      'community',
      '2030-01-07T09:00:00.000Z',
      '2030-01-07T10:00:00.000Z',
    );
  });

  it('defaults end_time to one hour after start_time and reports a free window', async () => {
    (checkConflicts as jest.Mock).mockResolvedValue([]);
    const { sb } = fakeSupabase([]);
    const res = await tool_check_calendar_conflicts({ start_time: '2030-01-07T09:00:00Z' }, IDENT, sb);
    expect(res.ok).toBe(true);
    expect((res as any).result.has_conflicts).toBe(false);
    expect((res as any).text).toContain('free');
    expect(checkConflicts).toHaveBeenCalledWith(
      'user-1',
      'community',
      '2030-01-07T09:00:00.000Z',
      '2030-01-07T10:00:00.000Z',
    );
  });

  it('rejects a missing start_time', async () => {
    const { sb } = fakeSupabase([]);
    const res = await tool_check_calendar_conflicts({}, IDENT, sb);
    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('start_time');
  });

  it('requires an authenticated user', async () => {
    const { sb } = fakeSupabase([]);
    const res = await tool_check_calendar_conflicts({ start_time: '2030-01-07T09:00:00Z' }, NO_USER, sb);
    expect(res.ok).toBe(false);
  });
});
