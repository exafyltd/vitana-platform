/**
 * Conversation Flow v3 provider — SAFE rebuild tests.
 *
 * The critical invariants after the breakage:
 *   - flag gate (off → suppressed)
 *   - SPEAK-ONLY: cta is benign `offer_demo`, NEVER navigate / ask_permission
 *     with onYesTool (that fired nav at greeting and killed the audio)
 *   - RULE 0: lines are proposals, never "what can I do for you?"-style questions
 *   - privacy: match never speaks a name
 *   - selection match → topic → song → suppress
 */

const getSystemControlMock = jest.fn();
jest.mock('../src/services/system-controls-service', () => ({
  getSystemControl: (...a: unknown[]) => getSystemControlMock(...a),
}));

import {
  makeConversationFlowV3Provider,
  FLOW_V3_EXTRA_KEY,
} from '../src/services/assistant-continuation/providers/conversation-flow-v3-provider';

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
const ctx = (lang = 'de') => ({
  extra: { [FLOW_V3_EXTRA_KEY]: { supabase, tenantId: 't1', userId: 'user-1', lang, firstName: 'Mariia' } },
}) as any;
const provider = makeConversationFlowV3Provider({ newId: () => 'x', now: () => 0 });

// A passive/preference question pattern the opener must NEVER match (RULE 0).
const PASSIVE = /(what can i (do|help)|what (do|would) you|wie kann ich dir helfen|was möchtest du|how can i help)/i;

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
  it('suppresses when flag off', async () => {
    getSystemControlMock.mockResolvedValue({ enabled: false });
    expect((await provider.produce(ctx())).status).toBe('suppressed');
  });
});

describe('SAFE invariants', () => {
  it('match: SPEAK-ONLY benign cta, no navigation, no name', async () => {
    tables.user_intents = { data: [{ intent_id: 'i1' }] };
    tables.intent_matches = { count: 1 };
    const r = await provider.produce(ctx('de'));
    expect(r.status).toBe('returned');
    expect(r.candidate?.cta.type).toBe('offer_demo'); // NOT navigate / ask_permission
    expect((r.candidate?.cta as any).onYesTool).toBeUndefined();
    expect(r.candidate?.userFacingLine).not.toContain('Mariia'); // privacy
    expect(r.candidate?.userFacingLine).not.toMatch(PASSIVE); // RULE 0
  });

  it('topic: NAMED introduce, benign cta, RULE-0 compliant', async () => {
    tables.journey_checklist_topics = {
      data: [{ topic_id: 't1', title: 'Life Compass', display_label: null, short_description: null, vitana_voice_script: 's', manual_path: '/x', session: 1 }],
    };
    const r = await provider.produce(ctx('de'));
    expect(r.candidate?.userFacingLine).toContain('Life Compass');
    expect(r.candidate?.userFacingLine).toMatch(/vorstellen/i);
    expect(r.candidate?.cta.type).toBe('offer_demo');
    expect(r.candidate?.userFacingLine).not.toMatch(PASSIVE);
  });

  it('song: benign cta, RULE-0 compliant', async () => {
    tables.media_uploads = { count: 3 };
    const r = await provider.produce(ctx('de'));
    expect(r.candidate?.userFacingLine).toMatch(/Song/i);
    expect(r.candidate?.cta.type).toBe('offer_demo');
    expect(r.candidate?.userFacingLine).not.toMatch(PASSIVE);
  });

  it('NO candidate ever carries a navigate/ask_permission cta (audio-kill guard)', async () => {
    // exercise all three focuses + greeting; none may use a nav-firing cta
    const scenarios: Array<() => void> = [
      () => { tables.user_intents = { data: [{ intent_id: 'i' }] }; tables.intent_matches = { count: 1 }; },
      () => { tables.journey_checklist_topics = { data: [{ topic_id: 't', title: 'X', display_label: null, short_description: null, vitana_voice_script: null, manual_path: '/x', session: 1 }] }; },
      () => { tables.media_uploads = { count: 1 }; },
    ];
    for (const setup of scenarios) {
      jest.clearAllMocks();
      getSystemControlMock.mockResolvedValue({ enabled: true });
      tables = {
        user_intents: { data: [] }, intent_matches: { count: 0 },
        user_guided_journey_state: { data: { completed_topic_ids: [], current_session: 1 } },
        journey_checklist_topics: { data: [] }, media_uploads: { count: 0 },
      };
      setup();
      const r = await provider.produce(ctx('en'));
      expect(['offer_demo', 'noop']).toContain(r.candidate?.cta.type);
    }
  });

  it('match outranks topic and song', async () => {
    tables.user_intents = { data: [{ intent_id: 'i1' }] };
    tables.intent_matches = { count: 1 };
    tables.journey_checklist_topics = { data: [{ topic_id: 't1', title: 'X', display_label: null, short_description: null, vitana_voice_script: null, manual_path: '/x', session: 1 }] };
    tables.media_uploads = { count: 3 };
    expect((await provider.produce(ctx())).candidate?.kind).toBe('match_journey_next_move');
  });

  it('suppresses when nothing to surface', async () => {
    expect((await provider.produce(ctx())).status).toBe('suppressed');
  });
});
