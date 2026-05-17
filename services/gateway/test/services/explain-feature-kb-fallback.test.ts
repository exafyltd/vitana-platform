/**
 * VTID-03051 — explain_feature KB fallback unit tests.
 *
 * Locks the server-side chain behaviour added in this PR. Before this
 * slice, `tool_explain_feature` on a pattern miss returned `found:false`
 * plus a guidance string and expected the LLM to make a second tool
 * call to `search_knowledge`. Gemini Live frequently narrated the first
 * response as a final "I couldn't find it" answer — user had to re-ask
 * to coax the second call.
 *
 * The fix: when explainFeature() misses, the tool now calls
 * searchKnowledge inline and puts the answer in `text`. Both the
 * dispatchOrbToolForVertex path and the LiveKit `summarize()` path
 * prefer `text` over the structured result, so the LLM receives a
 * usable answer in a single tool round trip.
 *
 * The three cases covered:
 *   1. Pattern match — KB chain is NOT called (unchanged behavior).
 *   2. Pattern miss + KB has results — answer surfaced in `text`,
 *      `result.knowledge_fallback=true`, docs in `result.docs`.
 *   3. Pattern miss + KB returns no docs — `text:''`, the structured
 *      `result.knowledge_fallback=false`, guidance preserved.
 *   4. Pattern miss + KB throws — same as case 3 (silent fallback).
 */

import { tool_explain_feature } from '../../src/services/orb-tools-shared';

jest.mock('../../src/services/explain-feature-service', () => ({
  explainFeature: jest.fn(),
}));

jest.mock('../../src/services/knowledge-hub', () => ({
  searchKnowledge: jest.fn(),
}));

import { explainFeature as mockExplainFeature } from '../../src/services/explain-feature-service';
import { searchKnowledge as mockSearchKnowledge } from '../../src/services/knowledge-hub';

const explainMock = mockExplainFeature as jest.Mock;
const kbMock = mockSearchKnowledge as jest.Mock;

beforeEach(() => {
  explainMock.mockReset();
  kbMock.mockReset();
});

describe('VTID-03051 tool_explain_feature KB fallback', () => {
  it('returns the pattern-match payload when found and does NOT call searchKnowledge', async () => {
    explainMock.mockReturnValue({
      found: true,
      topic_canonical: 'maxina_community',
      pillar_lift: null,
      summary_voice_en: 'Maxina is your community.',
      summary_voice_de: 'Maxina ist deine Community.',
      steps_voice_en: [],
      steps_voice_de: [],
      redirect_route: '/community',
      redirect_offer_en: '',
      redirect_offer_de: '',
      citation: 'kb/...',
    });

    const out = await tool_explain_feature({ feature: 'Maxina Community' });

    expect(out.ok).toBe(true);
    expect(out.text).toBe('');
    const r = out.result as { found: boolean; topic_canonical: string };
    expect(r.found).toBe(true);
    expect(r.topic_canonical).toBe('maxina_community');
    // Critical: KB fallback only fires on pattern miss. Pattern match
    // must NOT incur the extra search round trip.
    expect(kbMock).not.toHaveBeenCalled();
  });

  it('chains to searchKnowledge on pattern miss + surfaces answer as text', async () => {
    explainMock.mockReturnValue({
      found: false,
      reason: 'no_pattern_match',
    });
    kbMock.mockResolvedValue({
      ok: true,
      answer: 'Maxina is your community on Vitanaland — a tenant-scoped longevity space.',
      docs: [
        { id: '1', title: 'What Is Maxina?', path: 'kb/01-foundation/01-what-is-maxina.md' },
        { id: '2', title: 'Maxina Across Vitanaland', path: 'kb/07-maxina-experience/01-maxina-across-vitanaland.md' },
      ],
    });

    const out = await tool_explain_feature({ topic: 'Maxina Community' });

    expect(out.ok).toBe(true);
    expect(out.text).toContain('Maxina is your community on Vitanaland');
    expect(kbMock).toHaveBeenCalledWith({ query: 'Maxina Community', maxResults: 5 });

    const r = out.result as {
      found: boolean;
      reason: string;
      knowledge_fallback: boolean;
      docs: Array<{ title: string }>;
    };
    expect(r.found).toBe(false);
    expect(r.reason).toBe('no_pattern_match');
    expect(r.knowledge_fallback).toBe(true);
    expect(r.docs).toHaveLength(2);
    expect(r.docs[0].title).toBe('What Is Maxina?');
  });

  it('preserves the guidance fallback when KB returns no docs', async () => {
    explainMock.mockReturnValue({ found: false, reason: 'no_pattern_match' });
    kbMock.mockResolvedValue({ ok: true, answer: '', docs: [] });

    const out = await tool_explain_feature({ topic: 'completely-unknown-thing' });

    expect(out.ok).toBe(true);
    // text is empty so dispatchOrbToolForVertex / summarize() fall through
    // to the structured result, where the LLM can read `guidance` and
    // make its own chain decision (the prior contract).
    expect(out.text).toBe('');

    const r = out.result as {
      knowledge_fallback: boolean;
      docs: unknown[];
      guidance: string;
    };
    expect(r.knowledge_fallback).toBe(false);
    expect(r.docs).toHaveLength(0);
    expect(r.guidance).toContain('search_knowledge');
    expect(r.guidance).toContain('Maxina Instruction Manual');
  });

  it('silently degrades to the guidance fallback when searchKnowledge throws', async () => {
    explainMock.mockReturnValue({ found: false, reason: 'no_pattern_match' });
    kbMock.mockRejectedValue(new Error('Supabase RPC timed out'));

    const out = await tool_explain_feature({ topic: 'Maxina Community' });

    // KB failure must NEVER turn into a tool error — the explain_feature
    // contract is "always ok:true with structured result"; otherwise the
    // LLM treats the call as a hard error.
    expect(out.ok).toBe(true);
    expect(out.text).toBe('');

    const r = out.result as { knowledge_fallback: boolean; docs: unknown[] };
    expect(r.knowledge_fallback).toBe(false);
    expect(r.docs).toHaveLength(0);
  });

  it('rejects an empty topic up-front (unchanged contract)', async () => {
    const out = await tool_explain_feature({});
    expect(out.ok).toBe(false);
    expect(out.error).toBe('topic is required');
    // Critical: no exploratory KB call for empty input.
    expect(kbMock).not.toHaveBeenCalled();
    expect(explainMock).not.toHaveBeenCalled();
  });

  it('accepts the legacy `feature` argument the LiveKit agent sends', async () => {
    explainMock.mockReturnValue({ found: false, reason: 'no_pattern_match' });
    kbMock.mockResolvedValue({ ok: true, answer: 'doc body', docs: [{ id: 'x', title: 't' }] });

    const out = await tool_explain_feature({ feature: 'Diary' });

    expect(out.ok).toBe(true);
    expect(kbMock).toHaveBeenCalledWith({ query: 'Diary', maxResults: 5 });
  });
});
