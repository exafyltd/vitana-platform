/**
 * VTID-04851: recall() facts compete in the context window as current state.
 *
 * The shadow comparison (VTID-04784) found recall ~3 facts short of the
 * legacy read in 11 of 18 production sessions: the window decays relevance by
 * occurred_at, recall stamped facts with the date they were learned, and old
 * facts lost their slots to episodes. A current fact is true now.
 */
import { packToRecallItems } from '../../../src/services/memory/recall';
import { selectContextWindow } from '../../../src/services/context-window-manager';

const DAY = 24 * 3600 * 1000;
const longAgo = new Date(Date.now() - 60 * DAY).toISOString();
const now = new Date().toISOString();

function pack(nFacts: number, nEpisodes: number): any {
  return {
    ok: true,
    blocks: {
      SEMANTIC: {
        kind: 'SEMANTIC',
        facts: Array.from({ length: nFacts }, (_, i) => ({
          id: `f${i}`, fact_key: `user_fact_key_number_${i}`, fact_value: `a longer value that a member once told Vitana, number ${i}`, fact_value_type: 'text',
          entity: 'self', confidence: 0.9, actor_id: 'user_stated', asserted_at: longAgo,
        })),
      },
      EPISODIC: {
        kind: 'EPISODIC',
        hits: Array.from({ length: nEpisodes }, (_, i) => ({
          id: `e${i}`, kind: 'utterance', content: `A recent personal note the member mentioned in passing during a voice session, about their week and their plans, item ${i}.`,
          category_key: 'personal', source: 'orb_voice', importance: 60, occurred_at: now, actor_id: 'memory_items', conversation_id: null,
        })),
      },
    },
    meta: { degraded: false, streams_hit: [] },
  };
}

describe('VTID-04851 recall facts are current state', () => {
  it('stamps a fact with the read time and keeps the learned date', () => {
    const { items } = packToRecallItems(pack(1, 0));
    const f = items[0];
    expect(Date.now() - new Date(f.occurred_at).getTime()).toBeLessThan(60_000);
    expect(f.content_json.asserted_at).toBe(longAgo);
    expect(f.created_at).toBe(longAgo);
  });

  // Facts and the member's own "personal" episodes share the personal
  // domain's 5,000-char budget; ranked by decayed relevance, fresh episodes
  // used to win it and old facts were dropped.
  it('old facts are not pushed out of the personal budget by fresh personal episodes', () => {
    const { items } = packToRecallItems(pack(45, 25));
    const sel = selectContextWindow(items as any, 50, 't', 'u', 't');
    const facts = sel.includedItems.filter((i: any) => i.source === 'memory_facts').length;
    // The legacy read stamps facts with the read time; recall must keep the same facts.
    const legacyLike = items.map((i: any) => (i.source === 'memory_facts' ? { ...i, occurred_at: now } : i));
    const legacy = selectContextWindow(legacyLike as any, 50, 't', 'u', 't')
      .includedItems.filter((i: any) => i.source === 'memory_facts').length;
    expect(facts).toBe(legacy);
    expect(facts).toBe(45);
  });
});
