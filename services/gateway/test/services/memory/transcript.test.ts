// VTID-04387 — raw conversation turns go to memory_transcript_turns.

import {
  recordTranscriptTurn,
  fetchRecentTranscriptTurns,
  fetchTranscriptWindow,
  rawTurnsAlsoToMemoryItems,
  transcriptRoleOf,
  MAX_TURN_CHARS,
} from '../../../src/services/memory/transcript';

function fakeClient(result: { data?: any; error?: any } = { data: [], error: null }) {
  const calls: Array<{ op: string; args: any[] }> = [];
  const chain: any = {};
  for (const m of ['select', 'eq', 'gte', 'lte', 'order', 'limit']) {
    chain[m] = jest.fn((...args: any[]) => { calls.push({ op: m, args }); return chain; });
  }
  chain.insert = jest.fn((row: any) => { calls.push({ op: 'insert', args: [row] }); return Promise.resolve({ error: result.error ?? null }); });
  chain.then = (resolve: any) => Promise.resolve({ data: result.data, error: result.error ?? null }).then(resolve);
  const client: any = { from: jest.fn((t: string) => { calls.push({ op: 'from', args: [t] }); return chain; }) };
  return { client, calls };
}

const ID = { tenant_id: 't1', user_id: 'u1' };

describe('transcriptRoleOf', () => {
  it('only user/assistant directions are raw turns', () => {
    expect(transcriptRoleOf({ direction: 'user' })).toBe('user');
    expect(transcriptRoleOf({ direction: 'assistant' })).toBe('assistant');
    expect(transcriptRoleOf({ direction: 'system' })).toBeNull();
    expect(transcriptRoleOf(undefined)).toBeNull();
  });
});

describe('rawTurnsAlsoToMemoryItems', () => {
  const prev = process.env.MEMORY_RAW_TURNS_TO_ITEMS;
  afterEach(() => { process.env.MEMORY_RAW_TURNS_TO_ITEMS = prev; });
  it('defaults to true during the transition and is off only on exact "false"', () => {
    delete process.env.MEMORY_RAW_TURNS_TO_ITEMS;
    expect(rawTurnsAlsoToMemoryItems()).toBe(true);
    process.env.MEMORY_RAW_TURNS_TO_ITEMS = 'no';
    expect(rawTurnsAlsoToMemoryItems()).toBe(true);
    process.env.MEMORY_RAW_TURNS_TO_ITEMS = 'false';
    expect(rawTurnsAlsoToMemoryItems()).toBe(false);
  });
});

describe('recordTranscriptTurn', () => {
  it('inserts one row into memory_transcript_turns with role scope applied', async () => {
    const { client, calls } = fakeClient();
    const ok = await recordTranscriptTurn(
      { ...ID, role: 'user', content: '  hello there  ', source: 'orb_voice', session_id: 's1', active_role: 'community' },
      client,
    );
    expect(ok).toBe(true);
    expect(calls[0]).toEqual({ op: 'from', args: ['memory_transcript_turns'] });
    const row = calls.find((c) => c.op === 'insert')!.args[0];
    expect(row).toMatchObject({ tenant_id: 't1', user_id: 'u1', role: 'user', content: 'hello there', source: 'orb_voice', session_id: 's1', active_role: null });
  });

  it('keeps a work role and truncates very long turns', async () => {
    const { client, calls } = fakeClient();
    await recordTranscriptTurn({ ...ID, role: 'assistant', content: 'x'.repeat(MAX_TURN_CHARS + 50), source: 'orb_text', active_role: 'developer' }, client);
    const row = calls.find((c) => c.op === 'insert')!.args[0];
    expect(row.active_role).toBe('developer');
    expect(row.content.length).toBe(MAX_TURN_CHARS);
  });

  it('writes nothing for empty content, missing identity or no client', async () => {
    const { client } = fakeClient();
    expect(await recordTranscriptTurn({ ...ID, role: 'user', content: '  ', source: 'orb_voice' }, client)).toBe(false);
    expect(await recordTranscriptTurn({ tenant_id: '', user_id: 'u1', role: 'user', content: 'hi', source: 'orb_voice' }, client)).toBe(false);
    expect(await recordTranscriptTurn({ ...ID, role: 'user', content: 'hi', source: 'orb_voice' }, null)).toBe(false);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('returns false instead of throwing when the insert fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = fakeClient({ error: { message: 'boom' } });
    expect(await recordTranscriptTurn({ ...ID, role: 'user', content: 'hi', source: 'orb_voice' }, client)).toBe(false);
    warn.mockRestore();
  });
});

describe('reads', () => {
  it('recent turns: filtered by identity and role, newest first, limited', async () => {
    const rows = [{ role: 'user', content: 'b', occurred_at: '2026-09-23T10:01:00Z', session_id: 's' }];
    const { client, calls } = fakeClient({ data: rows });
    const out = await fetchRecentTranscriptTurns(ID, { limit: 3, role: 'user' }, client);
    expect(out).toEqual(rows);
    expect(calls.filter((c) => c.op === 'eq').map((c) => c.args)).toEqual([['tenant_id', 't1'], ['user_id', 'u1'], ['role', 'user']]);
    expect(calls.find((c) => c.op === 'order')!.args).toEqual(['occurred_at', { ascending: false }]);
    expect(calls.find((c) => c.op === 'limit')!.args).toEqual([3]);
  });

  it('window: oldest first between the bounds; empty on error', async () => {
    const { client, calls } = fakeClient({ data: [] });
    await fetchTranscriptWindow(ID, '2026-09-23T00:00:00Z', '2026-09-23T01:00:00Z', client);
    expect(calls.find((c) => c.op === 'gte')!.args).toEqual(['occurred_at', '2026-09-23T00:00:00Z']);
    expect(calls.find((c) => c.op === 'order')!.args).toEqual(['occurred_at', { ascending: true }]);
    const bad = fakeClient({ data: null, error: { message: 'x' } });
    expect(await fetchTranscriptWindow(ID, 'a', 'b', bad.client)).toEqual([]);
  });
});
