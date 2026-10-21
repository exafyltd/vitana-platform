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
}, upserts?: Array<Record<string, unknown>>): any {
  return {
    from(table: string) {
      if (table === 'user_guided_journey_state') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.stateData ?? null, error: null }) }) }),
          upsert: async (row: Record<string, unknown>) => {
            upserts?.push(row);
            return { error: null };
          },
        };
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
    expect(r.text).toMatch(/word for word/i); // strict verbatim contract
    expect(r.text).toContain(TOPICS[0].vitana_voice_script); // the WHOLE authored script
  });

  it('skips completed topics and advances to the next un-learned one', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: ['t1'], current_session: 1 }, topics: TOPICS });
    const r = await tool_narrate_guided_session({} as any, IDENT, sb);
    expect((r as any).result.session).toBe(2);
    expect(r.text).toContain(TOPICS[1].vitana_voice_script);
    expect(r.text).not.toContain(TOPICS[0].vitana_voice_script);
  });

  // REGRESSION: the user is on session 10 (frontend advanced current_session) but
  // completed_topic_ids is empty because only the voice narrator writes it. The
  // default "what's next" must anchor on current_session and offer session 10 —
  // NOT the first topic of the whole curriculum (session 1, "Starte deine Reise").
  const JOURNEY_1_TO_10 = Array.from({ length: 10 }, (_, i) => ({
    topic_id: `s${i + 1}`,
    title: `Session ${i + 1} Titel`,
    display_label: null,
    short_description: '',
    vitana_voice_script: `Das ist die Narration von Session ${i + 1}.`,
    session: i + 1,
    position: 1,
  }));

  it('REGRESSION: user on session 10 with empty completed set → offers session 10, not session 1', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 10 }, topics: JOURNEY_1_TO_10 });
    const r = await tool_narrate_guided_session({} as any, IDENT, sb);
    expect((r as any).result.session).toBe(10);
    expect(r.text).toContain('Das ist die Narration von Session 10.');
    expect(r.text).not.toContain('Session 1 Titel');
  });

  it('current session fully heard → rolls forward to the next session, never back to 1', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: ['s9'], current_session: 9 }, topics: JOURNEY_1_TO_10 });
    const r = await tool_narrate_guided_session({} as any, IDENT, sb);
    expect((r as any).result.session).toBe(10); // s9 heard → next is session 10
  });

  it('over-advanced current_session (beyond curriculum) does NOT false-complete — falls back to remaining work', async () => {
    // current_session=99 but only 10 sessions exist; nothing is completed. Must still
    // offer real content (floor clamps to maxSession), not claim "journey complete".
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 99 }, topics: JOURNEY_1_TO_10 });
    const r = await tool_narrate_guided_session({} as any, IDENT, sb);
    expect((r as any).result.done).toBeUndefined();
    expect((r as any).result.session).toBe(10); // clamps to the last session with work
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

  it('PROGRESSION: marks the narrated topic complete (green + advance) via upsert', async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 1 }, topics: TOPICS }, upserts);
    await tool_narrate_guided_session({} as any, IDENT, sb);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].completed_topic_ids).toEqual(['t1']); // session 1 now green
    expect(upserts[0].current_session).toBe(1);
  });

  it('PROGRESSION on explicit session_number play: marks ONLY the played topic so the session advances topic-by-topic', async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 1 }, topics: TOPICS }, upserts);
    await tool_narrate_guided_session({ session_number: 1 } as any, IDENT, sb);
    // The played topic IS marked (so the next "more" call serves the next topic),
    // but ONLY that topic — never sessions the user hasn't heard.
    expect(upserts).toHaveLength(1);
    expect(upserts[0].completed_topic_ids).toEqual(['t1']);
  });

  it('PROGRESSION cursor never jumps ahead: playing session 2 marks only session 2 (session 1 stays un-heard)', async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 1 }, topics: TOPICS }, upserts);
    await tool_narrate_guided_session({ session_number: 2 } as any, IDENT, sb);
    // Only session 2's topic is marked — session 1 (t1) is NOT, so the journey's
    // "next recommended" cursor still correctly points at the earliest un-heard topic.
    expect(upserts[0].completed_topic_ids).toEqual(['t2']);
    expect(upserts[0].completed_topic_ids).not.toContain('t1');
  });

  it('FAIL-OPEN: a checklist read error never dead-ends ("das hat nicht geklappt")', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 1 }, topicsError: { message: 'relation does not exist' } });
    const r = await tool_narrate_guided_session({} as any, IDENT, sb);
    expect(r.ok).toBe(true); // NOT a hard failure
    expect((r as any).result.degraded).toBe(true);
    expect(r.text).toMatch(/Guided Journey/i);
  });

  it('EMPTY curriculum (zero topics) → degraded, NOT a false "journey complete"', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 1 }, topics: [] });
    const r = await tool_narrate_guided_session({} as any, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as any).result.done).toBeUndefined(); // must NOT claim complete
    expect((r as any).result.degraded).toBe(true);
  });

  it('SPECIFIC session: session_number plays that exact session', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 1 }, topics: TOPICS });
    const r = await tool_narrate_guided_session({ session_number: 2 } as any, IDENT, sb);
    expect((r as any).result.session).toBe(2);
    expect(r.text).toContain(TOPICS[1].vitana_voice_script);
  });

  it('SPECIFIC session: can REPLAY an already-completed session', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: ['t1', 't2'], current_session: 2 }, topics: TOPICS });
    const r = await tool_narrate_guided_session({ session_number: 1 } as any, IDENT, sb);
    expect((r as any).result.session).toBe(1);
    expect(r.text).toContain(TOPICS[0].vitana_voice_script); // replays despite being completed
  });

  it('SPECIFIC session: out-of-range → not_found, names the valid range (no dead-end)', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 1 }, topics: TOPICS });
    const r = await tool_narrate_guided_session({ session_number: 99 } as any, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as any).result.not_found).toBe(true);
    expect(r.text).toMatch(/no session 99/i);
    expect(r.text).toContain('to 2'); // max session is 2
  });

  // A session with 2–3 topics: play one at a time, report how many remain.
  const SESSION15 = [
    { topic_id: 's15a', title: 'Index Grundlagen', display_label: null, short_description: '', vitana_voice_script: 'Session 15, Thema eins.', session: 15, position: 1 },
    { topic_id: 's15b', title: 'Index vertiefen', display_label: null, short_description: '', vitana_voice_script: 'Session 15, Thema zwei.', session: 15, position: 2 },
    { topic_id: 's15c', title: 'Index anwenden', display_label: null, short_description: '', vitana_voice_script: 'Session 15, Thema drei.', session: 15, position: 3 },
  ];

  it('INFO-ONLY: "what is the title of session 1" returns the real title, does NOT play or mark progress', async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 1 }, topics: TOPICS }, upserts);
    const r = await tool_narrate_guided_session({ session_number: 1, info_only: true } as any, IDENT, sb);
    expect((r as any).result.info_only).toBe(true);
    expect((r as any).result.session_title).toBe('Dein Vitana Index'); // the REAL title
    expect(r.text).toContain('Dein Vitana Index');
    expect(r.text).not.toContain(TOPICS[0].vitana_voice_script); // does NOT speak the script
    expect(r.text).toMatch(/do NOT use a Journey\s+Foundation step/i); // guards against the bug
    expect(upserts).toHaveLength(0); // a question never advances progress
  });

  it('INFO-ONLY: lists the session\'s topics for a multi-topic session', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 1 }, topics: SESSION15 });
    const r = await tool_narrate_guided_session({ session_number: 15, info_only: true } as any, IDENT, sb);
    expect((r as any).result.topic_count).toBe(3);
    expect((r as any).result.topic_titles).toEqual(['Index Grundlagen', 'Index vertiefen', 'Index anwenden']);
    expect(r.text).not.toContain('Session 15, Thema eins.'); // no script playback
  });

  it('INFO-ONLY: session title is STABLE — same title regardless of progress in the session', async () => {
    // User already heard topic one (s15a). The session TITLE must still be the
    // session's first-topic title, not drift to topic two.
    const sb = makeSb({ stateData: { completed_topic_ids: ['s15a'], current_session: 15 }, topics: SESSION15 });
    const r = await tool_narrate_guided_session({ session_number: 15, info_only: true } as any, IDENT, sb);
    expect((r as any).result.session_title).toBe('Index Grundlagen'); // first topic, NOT 'Index vertiefen'
    expect(r.text).toContain('Index Grundlagen');
  });

  it('SESSION with multiple topics: plays the FIRST topic + reports the remaining count', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 1 }, topics: SESSION15 });
    const r = await tool_narrate_guided_session({ session_number: 15 } as any, IDENT, sb);
    expect((r as any).result.topic_id).toBe('s15a'); // first topic of session 15
    expect((r as any).result.remaining_in_session).toBe(2); // 2 more topics in the session (metadata only)
    expect(r.text).toContain('Session 15, Thema eins.'); // the script IS in the spoken text
    // The OLD parrotable "after you finish, offer the next" guidance must be GONE
    // from the spoken text — bundling it made the model recite it and skip the
    // script. (The directive may still *forbid* offering early; that's fine.)
    expect(r.text).not.toMatch(/After you finish/i);
    expect(r.text).not.toMatch(/more topics in session/i);
    expect(r.text).not.toMatch(/offer to continue with session/i);
  });

  it('SESSION topic-by-topic: after the first is heard, the next "session 15" plays topic two', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: ['s15a'], current_session: 15 }, topics: SESSION15 });
    const r = await tool_narrate_guided_session({ session_number: 15 } as any, IDENT, sb);
    expect((r as any).result.topic_id).toBe('s15b'); // advanced to topic two
    expect((r as any).result.remaining_in_session).toBe(1);
  });

  it('NAMED topic: topic_query matches the specific topic across the catalog', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 1 }, topics: SESSION15 });
    const r = await tool_narrate_guided_session({ topic_query: 'Index vertiefen' } as any, IDENT, sb);
    expect((r as any).result.topic_id).toBe('s15b');
    expect(r.text).toContain('Session 15, Thema zwei.');
  });

  it('NAMED topic: no match → not_found_topic, no dead-end', async () => {
    const sb = makeSb({ stateData: { completed_topic_ids: [], current_session: 1 }, topics: SESSION15 });
    const r = await tool_narrate_guided_session({ topic_query: 'völlig unbekannt' } as any, IDENT, sb);
    expect(r.ok).toBe(true);
    expect((r as any).result.not_found_topic).toBe(true);
    expect(r.text).toMatch(/couldn't find/i);          // names the miss
    expect(r.text).toMatch(/offer to play a session/i); // and offers a real alternative
  });

  it('missing user_id → ok:false', async () => {
    const r = await tool_narrate_guided_session({} as any, { user_id: null } as any, makeSb({}));
    expect(r.ok).toBe(false);
  });

  it('is registered in ORB_TOOL_REGISTRY', () => {
    expect(ORB_TOOL_REGISTRY.narrate_guided_session).toBe(tool_narrate_guided_session);
  });
});
