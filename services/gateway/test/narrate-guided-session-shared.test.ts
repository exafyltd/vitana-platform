/**
 * DEV-COMHU — narrate_guided_session: speak the FULL authored Guided Journey
 * session script on a voice "yes", not a one-line improvisation.
 *
 * Pins the contract:
 *   1. Returns the first UN-LEARNED topic's full vitana_voice_script verbatim,
 *      under a strict "speak IN FULL, word for word" instruction (skips
 *      already-completed topic_ids, respects current_session).
 *   2. Journey complete (everything done) → done:true + congratulate, no script.
 *   3. Topic with no authored script → has_script:false + introduce-from-knowledge.
 *   4. Missing user_id → ok:false.
 *   5. Registered in ORB_TOOL_REGISTRY so the dispatcher routes to it.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import {
  ORB_TOOL_REGISTRY,
  tool_narrate_guided_session,
} from '../src/services/orb-tools-shared';

const USER = '11111111-1111-4111-8111-111111111111';
const IDENT: any = { user_id: USER, tenant_id: '22222222-2222-4222-8222-222222222222' };

function makeSb(opts: {
  stateData?: { completed_topic_ids?: string[]; current_session?: number } | null;
  topics?: Array<Record<string, unknown>>;
  topicsError?: { message: string } | null;
}): any {
  return {
    from(table: string) {
      if (table === 'user_guided_journey_state') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.stateData ?? null, error: null }) }) }) };
      }
      if (table === 'journey_checklist_topics') {
        const res = { data: opts.topics ?? [], error: opts.topicsError ?? null };
        const b: any = {};
        b.select = () => b;
        b.eq = () => b;
        b.gte = () => b;
        b.order = () => b;
        b.limit = async () => res;
        return b;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const TOPICS = [
  { topic_id: 't1', title: 'Dein Vitana Index', display_label: null, short_description: 's1', vitana_voice_script: 'Willkommen zu Session eins. Hier lernst du, was dein Vitana Index ist und wie er sich zusammensetzt.', session: 1, position: 1 },
  { topic_id: 't2', title: 'Die fünf Säulen', display_label: null, short_description: 's2', vitana_voice_script: 'In Session zwei schauen wir uns die fünf Säulen an.', session: 2, position: 1 },
];

describe('tool_narrate_guided_session', () => {
  it('returns the first UN-LEARNED topic full script, verbatim, with a speak-in-full instruction', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 1 }, topics: TOPICS });
    const r = await tool_narrate_guided_session({} as any, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as any).result.session).toBe(1);
    expect((r as any).result.has_script).toBe(true);
    expect(r.text).toContain('IN FULL'); // strict verbatim contract
    expect(r.text).toContain(TOPICS[0].vitana_voice_script); // the WHOLE authored script
  });

  it('skips completed topics and advances to the next un-learned one', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: ['t1'], current_session: 1 }, topics: TOPICS });
    const r = await tool_narrate_guided_session({} as any, IDENT, sb);
    expect((r as any).result.session).toBe(2);
    expect(r.text).toContain(TOPICS[1].vitana_voice_script);
    expect(r.text).not.toContain(TOPICS[0].vitana_voice_script);
  });

  it('journey complete → done:true, congratulate, no script', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: ['t1', 't2'], current_session: 1 }, topics: TOPICS });
    const r = await tool_narrate_guided_session({} as any, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as any).result.done).toBe(true);
    expect(r.text).toMatch(/JOURNEY COMPLETE/i);
  });

  it('topic with no authored script → has_script:false, introduce from knowledge', async () => {
    const sb = makeSb({
      stateData: { completed_topic_ids: [], current_session: 1 },
      topics: [{ topic_id: 't1', title: 'Leeres Thema', display_label: null, short_description: '', vitana_voice_script: null, session: 1, position: 1 }],
    });
    const r = await tool_narrate_guided_session({} as any, IDENT, sb);
    expect((r as any).result.has_script).toBe(false);
    expect(r.text).toMatch(/No authored script/i);
  });

  it('missing user_id → ok:false', async () => {
    const r = await tool_narrate_guided_session({} as any, { user_id: null } as any, makeSb({}));
    expect(r.ok).toBe(false);
  });

  it('is registered in ORB_TOOL_REGISTRY', () => {
    expect(ORB_TOOL_REGISTRY.narrate_guided_session).toBe(tool_narrate_guided_session);
  });
});
