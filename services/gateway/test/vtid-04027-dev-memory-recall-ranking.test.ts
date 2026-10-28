/**
 * VTID-04027: operator memory recall is top-10, category-diverse and
 * bounded. Pins the round-robin selection (every category with a relevant
 * row gets a seat before any category gets a second; per-category cap;
 * similarity order preserved in the output; dedupe by id), the bounded
 * renderer (row clip, total budget, header kept for the VTID-03892
 * consumers), and the wiring (recall fetches RECALL_CANDIDATES, the block
 * carries at most RECALL_SELECT rows).
 */

jest.mock('node-fetch');
jest.mock('../src/services/dev-agent-memory', () => ({ recallDevMemory: jest.fn(), writeDevMemory: jest.fn() }));
jest.mock('../src/services/llm-router', () => ({ callViaRouter: jest.fn(), getRoutingPolicy: jest.fn() }));

import type { DevMemoryHit } from '../src/services/dev-agent-memory';
import {
  DEV_MEMORY_BLOCK_HEADER, RECALL_BLOCK_MAX_CHARS, RECALL_CANDIDATES, RECALL_MAX_PER_CATEGORY, RECALL_ROW_CONTENT_MAX, RECALL_SELECT,
  diversifyRecallHits, renderDevMemoryBlock,
} from '../src/services/dev-memory-ranking';

function hit(id: string, category: DevMemoryHit['category'], similarity: number, extra: Partial<DevMemoryHit> = {}): DevMemoryHit {
  return { id, category, similarity, title: `title ${id}`, content: `content ${id}`, vtid: null, importance: 50, source: 'session', tags: [], created_at: '2026-09-17T00:00:00Z', ...extra };
}

describe('VTID-04027 diversifyRecallHits', () => {
  it('gives every category a seat before any category gets a second, then keeps similarity order', () => {
    const hits = [
      hit('i1', 'incident', 0.95), hit('i2', 'incident', 0.94), hit('i3', 'incident', 0.93), hit('i4', 'incident', 0.92), hit('i5', 'incident', 0.91),
      hit('d1', 'decision', 0.80), hit('c1', 'convention', 0.70), hit('g1', 'gotcha', 0.60), hit('p1', 'preference', 0.50),
    ];
    const out = diversifyRecallHits(hits, { limit: 5, maxPerCategory: 4 });
    expect(out.map((h) => h.id)).toEqual(['i1', 'd1', 'c1', 'g1', 'p1']);
    // Similarity order is preserved in the output even though selection was round-robin.
    expect(out.map((h) => h.similarity)).toEqual([0.95, 0.80, 0.70, 0.60, 0.50]);
  });

  it('fills remaining seats round-robin up to the per-category cap and the limit', () => {
    const hits = [
      hit('i1', 'incident', 0.99), hit('i2', 'incident', 0.98), hit('i3', 'incident', 0.97), hit('i4', 'incident', 0.96), hit('i5', 'incident', 0.95), hit('i6', 'incident', 0.94),
      hit('d1', 'decision', 0.90), hit('d2', 'decision', 0.89),
    ];
    const out = diversifyRecallHits(hits, { limit: 10, maxPerCategory: 4 });
    expect(out.map((h) => h.id)).toEqual(['i1', 'i2', 'i3', 'i4', 'd1', 'd2']);
    expect(out.filter((h) => h.category === 'incident')).toHaveLength(RECALL_MAX_PER_CATEGORY);
  });

  it('defaults to RECALL_SELECT rows, dedupes by id, and handles empty input', () => {
    const many = Array.from({ length: 30 }, (_, i) => hit(`x${i}`, (['decision', 'gotcha', 'incident', 'convention', 'preference', 'task_outcome'] as const)[i % 6], 1 - i / 100));
    expect(diversifyRecallHits(many)).toHaveLength(RECALL_SELECT);
    expect(diversifyRecallHits([hit('a', 'decision', 0.9), hit('a', 'decision', 0.9)])).toHaveLength(1);
    expect(diversifyRecallHits([])).toEqual([]);
  });
});

describe('VTID-04027 renderDevMemoryBlock', () => {
  it('keeps the VTID-03892 header, tags the VTID, clips each row, and drops rows past the total budget best-first', () => {
    const rows = [
      hit('a', 'decision', 0.9, { vtid: 'VTID-04006', title: 'Agent executor model policy', content: 'DeepSeek Flash primary,   Bedrock\n\nfallback. '.repeat(30) }),
      hit('b', 'gotcha', 0.8, { content: 'z'.repeat(RECALL_ROW_CONTENT_MAX + 100) }),
    ];
    const block = renderDevMemoryBlock(rows);
    expect(block.startsWith(DEV_MEMORY_BLOCK_HEADER)).toBe(true);
    expect(block).toContain('Relevant engineering memory');
    expect(block).toContain('- [decision] (VTID-04006) Agent executor model policy: DeepSeek Flash primary, Bedrock fallback.');
    const gotchaLine = block.split('\n').find((l) => l.startsWith('- [gotcha]'))!;
    expect(gotchaLine.length).toBeLessThan(RECALL_ROW_CONTENT_MAX + 60);
    expect(gotchaLine.endsWith('…')).toBe(true);
    const big = Array.from({ length: 40 }, (_, i) => hit(`r${i}`, 'incident', 1 - i / 100, { content: 'q'.repeat(RECALL_ROW_CONTENT_MAX) }));
    const bounded = renderDevMemoryBlock(big);
    expect(bounded.length).toBeLessThanOrEqual(RECALL_BLOCK_MAX_CHARS);
    expect(bounded).toContain('- [incident] title r0:');
    expect(bounded).not.toContain('title r39:');
  });
});

describe('VTID-04027 wiring', () => {
  it('processWithGemini fetches RECALL_CANDIDATES rows and the prompt block carries at most RECALL_SELECT of them, category-diverse', async () => {
    const { recallDevMemory } = require('../src/services/dev-agent-memory');
    const { callViaRouter } = require('../src/services/llm-router');
    const hits = [
      ...Array.from({ length: 12 }, (_, i) => hit(`inc${i}`, 'incident', 0.99 - i / 100)),
      hit('dec', 'decision', 0.70), hit('conv', 'convention', 0.65), hit('pref', 'preference', 0.60),
    ];
    (recallDevMemory as jest.Mock).mockResolvedValue({ ok: true, hits });
    (callViaRouter as jest.Mock).mockResolvedValue({ ok: true, text: 'reply', provider: 'deepseek', model: 'deepseek-flash', toolCalls: [] });
    const { processWithGemini } = require('../src/services/gemini-operator');
    await processWithGemini({ text: 'what did we decide about the executor model policy?', threadId: 'rank-thread' });
    expect(recallDevMemory).toHaveBeenCalledWith(expect.any(String), 'vitana-platform', expect.objectContaining({ limit: RECALL_CANDIDATES }));
    const opts = (callViaRouter as jest.Mock).mock.calls[0][2];
    const block = String(opts.systemPrompt);
    const rows = block.split('\n').filter((l) => l.startsWith('- ['));
    expect(rows.length).toBeLessThanOrEqual(RECALL_SELECT);
    expect(rows.filter((l) => l.startsWith('- [incident]')).length).toBeLessThanOrEqual(RECALL_MAX_PER_CATEGORY);
    expect(block).toContain('- [decision] title dec');
    expect(block).toContain('- [convention] title conv');
    expect(block).toContain('- [preference] title pref');
  });
});
