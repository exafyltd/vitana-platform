/**
 * Tests for services/intent-detection-engine.ts's buildContextSignalFromMemory().
 *
 * VTID-03940: this exported function had NO test coverage at all before this
 * file — confirmed via `find services/gateway/test -iname
 * "intent-detection-engine*"` returning nothing. It is a real, live call site
 * (routes/orb-live.ts imports and calls it to build `context_bundle` for
 * intent classification), not dead code, so its `recent_topics` gap was
 * silently dropping real signal from every ORB turn.
 */

import { buildContextSignalFromMemory } from '../src/services/intent-detection-engine';

function memoryContext(items: Array<{ category_key: string; content: string }>) {
  return { ok: true, user_id: 'user-1', items };
}

describe('buildContextSignalFromMemory', () => {
  it('returns undefined when memoryContext.ok is false', () => {
    expect(buildContextSignalFromMemory({ ok: false, user_id: 'user-1', items: [] })).toBeUndefined();
  });

  it('returns undefined when there are no items', () => {
    expect(buildContextSignalFromMemory(memoryContext([]))).toBeUndefined();
  });

  it('extracts personal_facts from personal/relationships items, unchanged', () => {
    const result = buildContextSignalFromMemory(
      memoryContext([
        { category_key: 'personal', content: 'Likes hiking' },
        { category_key: 'relationships', content: 'Married to Alex' },
      ])
    );

    expect(result?.personal_facts).toEqual(['Likes hiking', 'Married to Alex']);
  });

  it('VTID-03940: extracts recent_topics from conversation/notes items instead of always returning []', () => {
    const result = buildContextSignalFromMemory(
      memoryContext([
        { category_key: 'conversation', content: 'Asked about the new gym schedule' },
        { category_key: 'notes', content: 'Wants a reminder for the dentist' },
        { category_key: 'personal', content: 'Likes hiking' },
      ])
    );

    expect(result?.recent_topics).toEqual([
      'Asked about the new gym schedule',
      'Wants a reminder for the dentist',
    ]);
    // Conversation/notes content must not leak into personal_facts, and
    // vice versa — the two buckets are extracted from the same loop.
    expect(result?.personal_facts).toEqual(['Likes hiking']);
  });

  it('recent_topics stays empty when no conversation/notes items are present (no regression)', () => {
    const result = buildContextSignalFromMemory(memoryContext([{ category_key: 'personal', content: 'Likes hiking' }]));

    expect(result?.recent_topics).toEqual([]);
  });

  it('caps recent_topics at 5, same as personal_facts', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ category_key: 'conversation', content: `Topic ${i}` }));

    const result = buildContextSignalFromMemory(memoryContext(items));

    expect(result?.recent_topics).toHaveLength(5);
    expect(result?.recent_topics).toEqual(['Topic 0', 'Topic 1', 'Topic 2', 'Topic 3', 'Topic 4']);
  });

  it('truncates each recent_topics entry to 100 characters, same as personal_facts', () => {
    const longContent = 'x'.repeat(150);

    const result = buildContextSignalFromMemory(memoryContext([{ category_key: 'conversation', content: longContent }]));

    expect(result?.recent_topics[0]).toHaveLength(100);
  });

  it('memory_categories and memory_item_count are unaffected by the recent_topics fix', () => {
    const result = buildContextSignalFromMemory(
      memoryContext([
        { category_key: 'conversation', content: 'a' },
        { category_key: 'personal', content: 'b' },
      ])
    );

    expect(result?.memory_categories.sort()).toEqual(['conversation', 'personal']);
    expect(result?.memory_item_count).toBe(2);
  });
});
