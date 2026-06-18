/**
 * Conversation Flow v3 provider — live wiring tests.
 *
 * Verifies the flag gate, the match→topic→song selection from mocked tables,
 * the privacy-safe match line (no name), the deterministic nav CTA for
 * match/song, the verbal-introduce (no premature nav) CTA for topics, and
 * graceful suppression when nothing is surfaceable.
 */

const getSystemControlMock = jest.fn();
jest.mock('../src/services/system-controls-service', () => ({
  getSystemControl: (...a: unknown[]) => getSystemControlMock(...a),
}));

import {
  makeConversationFlowV3Provider,
  FLOW_V3_EXTRA_KEY,
} from '../src/services/assistant-continuation/providers/conversation-flow-v3-provider';

// Per-table configurable Supabase mock.
type TableResult = { data?: any; count?: number; error?: any };
let tables: Record<string, TableResult>;

function builder(result: TableResult) {
  const res = { data: result.data ?? null, count: result.count ?? 0, error: result.error ?? null };
  const b: any = {};
  for (const m of ['select', 'eq', 'or', 'gte', 'order']) b[m] = jest.fn(() => b);
  b.limit = jest.fn(() => Promise.resolve(res));
  b.maybeSingle = jest.fn(() => Promise.resolve({ data: result.data ?? null, error: result.error ?? null }));
  b.then = (onF: any, onR: any) => Promise.resolve(res).then(onF, onR);
  return b;
}
const supabase: any = { from: (t: string) => builder(tables[t] ?? {}) };

function ctx(lang = 'de') {
  return {
    extra: {
      [FLOW_V3_EXTRA_KEY]: { supabase, tenantId: 'tenant-1', userId: 'user-1', lang, firstName: 'Mariia' },
    },
  } as any;
}

const provider = makeConversationFlowV3Provider({ newId: () => 'fixed', now: () => 0 });

beforeEach(() => {
  jest.clearAllMocks();
  getSystemControlMock.mockResolvedValue({ enabled: true });
  tables = {
    user_intents: { data: [] },
    intent_matches: { count: 0 },
    user_guided_journey_state: { data: { completed_topic_ids: [], current_session: 1 } },
    journey_checklist_topics: { data: [] },
    media_uploads: { count: 0 },
  };
});

describe('flag gate', () => {
  it('suppresses when the flag is off', async () => {
    getSystemControlMock.mockResolvedValue({ enabled: false });
    const r = await provider.produce(ctx());
    expect(r.status).toBe('suppressed');
    expect(r.reason).toBe('flag_disabled');
  });

  it('skips when inputs are missing', async () => {
    const r = await provider.produce({ extra: {} } as any);
    expect(r.status).toBe('skipped');
  });
});

describe('selection', () => {
  it('new match → privacy-safe (NO name) + deterministic nav to /me/matches', async () => {
    tables.user_intents = { data: [{ intent_id: 'i1' }] };
    tables.intent_matches = { count: 2 };
    const r = await provider.produce(ctx('de'));
    expect(r.status).toBe('returned');
    expect(r.candidate?.kind).toBe('match_journey_next_move');
    expect(r.candidate?.userFacingLine).toContain('neues Match');
    expect(r.candidate?.userFacingLine).not.toContain('Mariia'); // privacy: never the name
    expect(r.candidate?.cta).toEqual({
      type: 'ask_permission',
      onYesTool: 'navigate_to_screen',
      payload: { url: '/me/matches' },
    });
  });

  it('un-learned topic → NAMED, verbal-introduce, NO premature nav', async () => {
    tables.journey_checklist_topics = {
      data: [
        { topic_id: 't1', title: 'Life Compass', display_label: 'Life Compass', short_description: null, vitana_voice_script: 's', manual_path: '/memory?open=life_compass', session: 1 },
      ],
    };
    const r = await provider.produce(ctx('de'));
    expect(r.status).toBe('returned');
    expect(r.candidate?.kind).toBe('feature_discovery');
    expect(r.candidate?.userFacingLine).toContain('Life Compass');
    expect(r.candidate?.userFacingLine).toMatch(/vorstellen/i); // "introduce", not "show"
    expect(r.candidate?.cta.type).toBe('ask_permission');
    expect((r.candidate?.cta as any).onYesTool).toBeUndefined(); // no jump on the introduce-yes
    expect((r.candidate?.cta as any).payload.route).toBe('/memory?open=life_compass');
  });

  it('skips already-green topics and picks the next un-learned one', async () => {
    tables.user_guided_journey_state = { data: { completed_topic_ids: ['t1'], current_session: 1 } };
    tables.journey_checklist_topics = {
      data: [
        { topic_id: 't1', title: 'Done One', display_label: 'Done One', short_description: null, vitana_voice_script: null, manual_path: '/x', session: 1 },
        { topic_id: 't2', title: 'Daily Diary', display_label: 'Daily Diary', short_description: null, vitana_voice_script: null, manual_path: '/diary', session: 1 },
      ],
    };
    const r = await provider.produce(ctx('en'));
    expect(r.candidate?.userFacingLine).toContain('Daily Diary');
  });

  it('song offer when no match and no un-learned topic → autoplay nav', async () => {
    tables.media_uploads = { count: 5 };
    const r = await provider.produce(ctx('de'));
    expect(r.status).toBe('returned');
    expect(r.candidate?.userFacingLine).toMatch(/Song/i);
    expect((r.candidate?.cta as any).payload.url).toBe('/comm/media-hub?tab=music&autoplay=random');
  });

  it('match outranks topic and song', async () => {
    tables.user_intents = { data: [{ intent_id: 'i1' }] };
    tables.intent_matches = { count: 1 };
    tables.journey_checklist_topics = {
      data: [{ topic_id: 't1', title: 'Life Compass', display_label: null, short_description: null, vitana_voice_script: null, manual_path: '/x', session: 1 }],
    };
    tables.media_uploads = { count: 3 };
    const r = await provider.produce(ctx('de'));
    expect(r.candidate?.kind).toBe('match_journey_next_move');
  });

  it('suppresses when nothing to surface', async () => {
    const r = await provider.produce(ctx('de'));
    expect(r.status).toBe('suppressed');
    expect(r.reason).toMatch(/nothing_to_surface/);
  });

  it('English locale renders English lines', async () => {
    tables.media_uploads = { count: 1 };
    const r = await provider.produce(ctx('en'));
    expect(r.candidate?.userFacingLine).toMatch(/play you a song/i);
  });
});
