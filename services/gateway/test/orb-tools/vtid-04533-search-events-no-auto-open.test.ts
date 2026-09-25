/**
 * VTID-04533 — search_events opens an event only when the member asked.
 *
 * Owner report 2026-09-25 (staging): "are there any other events except these
 * two?" → search_events over a date range found one event → auto-navigated to
 * its drawer, which closes the voice session, and told Vitana to say
 * "Opening …" instead of answering. Opening now requires open_event === true.
 */
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/services/event-relevance-scoring', () => ({
  scoreAndRankEvents: jest.fn(),
  formatForVoice: jest.fn(() => 'Found 1 upcoming event:\nThe Future of Social Wellness | Sat'),
}));

import { tool_search_events } from '../../src/services/orb-tools-shared';
import { buildLiveApiTools } from '../../src/orb/live/tools/live-tool-catalog';
const scoring = require('../../src/services/event-relevance-scoring');
const { emitOasisEvent } = require('../../src/services/oasis-event-service');

const EVENT = { id: 'e1', title: 'The Future of Social Wellness', start_time: '2026-10-01T17:00:00Z' };

function fakeSb() {
  const chain: any = {
    select: () => chain, gte: () => chain, lte: () => chain, order: () => chain, eq: () => chain, in: () => chain, ilike: () => chain,
    limit: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    // Awaiting the query builder resolves it, like supabase-js.
    then: (res: any, rej: any) => Promise.resolve({ data: [EVENT], error: null }).then(res, rej),
  };
  return { from: () => chain } as any;
}

const ID = { user_id: 'u1', tenant_id: null, session_id: 's1' } as any;

describe('VTID-04533 — search_events never opens an event on its own', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    scoring.scoreAndRankEvents.mockReturnValue({ best: [{ event: EVENT, score: 0.9 }], alternatives: [] });
  });

  test('a question that matches exactly one event is answered, not opened', async () => {
    const r: any = await tool_search_events({ date_from: '2026-09-27', date_to: '2026-10-31' } as any, ID, fakeSb());
    expect(r.ok).toBe(true);
    expect(r.result.decision).toBe('list_only');
    expect(r.result.directive).toBeUndefined();
    expect(r.text).not.toMatch(/^Opening/);
    expect(r.text).toContain('The Future of Social Wellness');
    expect(emitOasisEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'orb.search_events.auto_nav' }));
  });

  test('open_event must be exactly true — truthy strings do not open', async () => {
    const r: any = await tool_search_events({ query: 'wellness', open_event: 'true' } as any, ID, fakeSb());
    expect(r.result.directive).toBeUndefined();
  });

  test('an explicit ask to open one event still opens its drawer', async () => {
    const r: any = await tool_search_events({ query: 'wellness', open_event: true } as any, ID, fakeSb());
    expect(r.result.decision).toBe('auto_nav');
    expect(r.result.directive).toMatchObject({ directive: 'navigate', screen_id: 'OVERLAY.EVENT_DRAWER' });
    expect(r.text).toBe('Opening "The Future of Social Wellness".');
  });

  test('open_event with an ambiguous result still lists instead of guessing', async () => {
    scoring.scoreAndRankEvents.mockReturnValue({
      best: [{ event: EVENT, score: 0.8 }, { event: { ...EVENT, id: 'e2', title: 'Other' }, score: 0.75 }],
      alternatives: [],
    });
    const r: any = await tool_search_events({ query: 'wellness', open_event: true } as any, ID, fakeSb());
    expect(r.result.directive).toBeUndefined();
  });

  test('the voice declaration offers open_event and says the tool only answers otherwise', () => {
    const tools = buildLiveApiTools('authenticated', '/', 'community', 'vitanaland') as any[];
    const decl = tools.flatMap((g) => g.function_declarations ?? []).find((d: any) => d.name === 'search_events');
    expect(decl.parameters.properties.open_event.type).toBe('boolean');
    expect(decl.parameters.required).not.toContain('open_event');
    expect(decl.description).toContain('Opens an event only with open_event.');
  });
});
