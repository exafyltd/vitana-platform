// VTID-04407 — Operator thread handoffs into dev_agent_memory.
const supaCalls: string[] = [];
let responses: Record<string, any> = {};
jest.mock('../../../src/services/dev-autopilot-execute', () => ({
  getSupabase: () => ({ url: 'http://x', key: 'k' }),
  supa: async (_s: any, path: string) => {
    supaCalls.push(path);
    const key = Object.keys(responses).find((k) => path.includes(k));
    return key ? responses[key] : { ok: true, data: [] };
  },
}));
const writeDevMemory = jest.fn();
jest.mock('../../../src/services/dev-agent-memory', () => ({ writeDevMemory: (...a: any[]) => writeDevMemory(...a) }));
jest.mock('../../../src/services/llm-router', () => ({ callViaRouter: jest.fn() }));

import {
  buildHandoffInput, cleanHandoff, writeThreadHandoff, runHandoffSweep, findIdleThreads,
  HANDOFF_MAX_CHARS, HANDOFF_MAX_INPUT_CHARS, threadTag,
} from '../../../src/services/dev-memory/handoff';

const USER = '11111111-1111-4111-8111-111111111111';
const thread = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: USER, title: 'Fix CI', summary: 'Working on VTID-04400', last_message_at: '2026-09-23T10:00:00.000Z' };
const msgs = [
  { role: 'assistant', content: 'Newest', created_at: '2026-09-23T10:00:00Z' },
  { role: 'user', content: 'Oldest', created_at: '2026-09-23T09:00:00Z' },
];

beforeEach(() => { supaCalls.length = 0; responses = {}; writeDevMemory.mockReset(); });

describe('pure helpers', () => {
  it('orders messages oldest first and caps from the front', () => {
    const input = buildHandoffInput(thread, [...msgs].reverse() as any);
    expect(input.indexOf('Oldest')).toBeLessThan(input.indexOf('Newest'));
    expect(input).toContain('Summary so far:\nWorking on VTID-04400');
    const big = buildHandoffInput(thread, [{ role: 'user', content: 'x'.repeat(50_000) }, { role: 'user', content: 'LAST' }] as any);
    expect(big.length).toBeLessThanOrEqual(HANDOFF_MAX_INPUT_CHARS + 200);
    expect(big).toContain('LAST');
  });
  it('treats NONE as nothing and caps length', () => {
    expect(cleanHandoff('NONE')).toBeNull();
    expect(cleanHandoff('none.')).toBeNull();
    expect(cleanHandoff('  ')).toBeNull();
    expect(cleanHandoff('y'.repeat(5000))!.length).toBe(HANDOFF_MAX_CHARS);
  });
});

describe('writeThreadHandoff', () => {
  it('skips threads without an owner (voice / machine turns)', async () => {
    expect((await writeThreadHandoff({ ...thread, user_id: null })).status).toBe('no_owner');
    expect(supaCalls).toHaveLength(0);
  });

  it('skips when the latest handoff is newer than the last message', async () => {
    responses['dev_agent_memory?category=eq.handoff'] = { ok: true, data: [{ id: 'h0', created_at: '2026-09-23T11:00:00+00:00' }] };
    const writer = jest.fn();
    expect((await writeThreadHandoff(thread, { writer })).status).toBe('already_current');
    expect(writer).not.toHaveBeenCalled();
  });

  it('writes a handoff for the owner, tagged by thread, superseding the previous one', async () => {
    responses['dev_agent_memory?category=eq.handoff'] = { ok: true, data: [{ id: 'h0', created_at: '2026-09-22T11:00:00+00:00' }] };
    responses['operator_messages?'] = { ok: true, data: msgs };
    writeDevMemory.mockResolvedValue({ ok: true, id: 'h1' });
    const writer = jest.fn().mockResolvedValue({ ok: true, text: 'Where it stopped: PR #3606 green. Next: VTID-04401.' });
    const out = await writeThreadHandoff(thread, { writer });
    expect(out).toEqual({ status: 'written', id: 'h1' });
    const w = writeDevMemory.mock.calls[0][0];
    expect(w).toMatchObject({ category: 'handoff', authorUserId: USER, supersedes: 'h0', source: 'session', vtid: 'VTID-04400' });
    expect(w.tags).toEqual(expect.arrayContaining([threadTag(thread.id), 'VTID-04400', 'VTID-04401']));
    expect(writer.mock.calls[0][0].indexOf('Oldest')).toBeLessThan(writer.mock.calls[0][0].indexOf('Newest'));
  });

  it('writes nothing when the model says NONE or fails', async () => {
    responses['operator_messages?'] = { ok: true, data: msgs };
    expect((await writeThreadHandoff(thread, { writer: async () => ({ ok: true, text: 'NONE' }) })).status).toBe('nothing_to_hand_over');
    expect((await writeThreadHandoff(thread, { writer: async () => ({ ok: false, error: 'down' }) }))).toEqual({ status: 'llm_failed', error: 'down' });
    expect(writeDevMemory).not.toHaveBeenCalled();
  });

  it('reports a failed write instead of throwing', async () => {
    responses['operator_messages?'] = { ok: true, data: msgs };
    writeDevMemory.mockResolvedValue({ ok: false, error: 'embedding_failed' });
    expect(await writeThreadHandoff(thread, { writer: async () => ({ ok: true, text: 'x' }) })).toEqual({ status: 'write_failed', error: 'embedding_failed' });
  });
});

describe('sweep', () => {
  it('selects owned threads quiet for the idle window within the lookback', async () => {
    const now = new Date('2026-09-23T12:00:00Z');
    await findIdleThreads(now, { idleMinutes: 60, limit: 5 });
    const q = supaCalls[0];
    expect(q).toContain('user_id=not.is.null');
    expect(q).toContain(`last_message_at=lte.${encodeURIComponent('2026-09-23T11:00:00.000Z')}`);
    expect(q).toContain(`last_message_at=gte.${encodeURIComponent('2026-09-22T10:00:00.000Z')}`);
    expect(q).toContain('limit=5');
  });

  it('counts outcomes per thread', async () => {
    responses['operator_threads?'] = { ok: true, data: [thread, { ...thread, id: 'b', user_id: null }] };
    responses['operator_messages?'] = { ok: true, data: msgs };
    writeDevMemory.mockResolvedValue({ ok: true, id: 'h1' });
    const r = await runHandoffSweep({ writer: async () => ({ ok: true, text: 'note' }) });
    expect(r).toEqual({ candidates: 2, outcomes: { written: 1, no_owner: 1 }, written: 1 });
  });
});
