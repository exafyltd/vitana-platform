/**
 * VTID-04353 (WS-0.4) — the writer for user_open_threads / assistant_promises,
 * which the continuity compiler reads on every session start and nothing wrote.
 */
jest.mock('../../../src/services/llm-router', () => ({ callViaRouter: jest.fn() }));
jest.mock('../../../src/lib/supabase', () => ({ getSupabase: jest.fn(() => null) }));

import {
  parseContinuityReply,
  normalizeTopic,
  recordSessionContinuity,
  writeExtractedContinuity,
  isSessionContinuityWriteEnabled,
  MAX_THREADS,
  MAX_PROMISES,
} from '../../../src/services/continuity/session-continuity-writer';
import { callViaRouter } from '../../../src/services/llm-router';

type Call = { table: string; op: string; payload?: any; filters: Array<[string, unknown]> };

function makeSb(existing: Array<{ thread_id: string; topic: string }> = [], failOn?: string) {
  const calls: Call[] = [];
  const sb: any = {
    from(table: string) {
      const call: Call = { table, op: '', filters: [] };
      const b: any = {
        select() { call.op = 'select'; calls.push(call); return b; },
        update(p: any) { call.op = 'update'; call.payload = p; calls.push(call); return b; },
        insert(p: any) {
          call.op = 'insert'; call.payload = p; calls.push(call);
          return Promise.resolve({ error: failOn === `${table}.insert` ? { message: 'boom' } : null });
        },
        eq(k: string, v: unknown) { call.filters.push([k, v]); return b; },
        limit() { return Promise.resolve({ data: existing, error: null }); },
        then(res: any, rej: any) {
          return Promise.resolve({ error: failOn === `${table}.${call.op}` ? { message: 'boom' } : null }).then(res, rej);
        },
      };
      return b;
    },
  };
  return { sb, calls };
}

const input = { tenant_id: 't1', user_id: 'u1', session_id: 'live-9' };
const turns = [
  { role: 'user' as const, text: 'Ich überlege, ob ich den Halbmarathon im Oktober laufe.' },
  { role: 'assistant' as const, text: 'Ich erinnere dich morgen früh an deinen Trainingsplan.' },
];

describe('parseContinuityReply', () => {
  it('parses a fenced JSON object with prose around it', () => {
    const r = parseContinuityReply('Here:\n```json\n{"open_threads":[{"topic":"Half marathon decision","summary":"Undecided."}],"promises":[{"text":"Remind the user of the plan","due_hint":"tomorrow morning"}]}\n```');
    expect(r.open_threads).toEqual([{ topic: 'Half marathon decision', summary: 'Undecided.' }]);
    expect(r.promises).toEqual([{ text: 'Remind the user of the plan', due_hint: 'tomorrow morning' }]);
  });

  it.each([null, '', 'no json here', '{broken', '[]', '{"open_threads":"x"}'])('degrades to empty on %p', (raw) => {
    expect(parseContinuityReply(raw as any)).toEqual({ open_threads: [], promises: [] });
  });

  it('drops entries without a topic/text, dedupes by normalized topic and clamps counts', () => {
    const threads = Array.from({ length: 6 }, (_, i) => ({ topic: `Topic ${i}` }));
    const r = parseContinuityReply(JSON.stringify({
      open_threads: [{ topic: '' }, { summary: 'no topic' }, { topic: 'Sleep  plan!' }, { topic: 'sleep plan' }, ...threads],
      promises: [{ text: '' }, ...Array.from({ length: 6 }, (_, i) => ({ text: `P${i}` }))],
    }));
    expect(r.open_threads.map((t) => t.topic)).toEqual(['Sleep plan!', 'Topic 0', 'Topic 1']);
    expect(r.open_threads).toHaveLength(MAX_THREADS);
    expect(r.promises).toHaveLength(MAX_PROMISES);
    expect(r.promises[0]).toEqual({ text: 'P0', due_hint: '' });
  });
});

describe('normalizeTopic', () => {
  it('ignores case, accents and punctuation', () => {
    expect(normalizeTopic('Café — Plan!')).toBe(normalizeTopic('cafe plan'));
  });
});

describe('writeExtractedContinuity', () => {
  it('inserts a new thread, touches a matching open one, and inserts promises as owed', async () => {
    const { sb, calls } = makeSb([{ thread_id: 'th-1', topic: 'Sleep plan' }]);
    const out = await writeExtractedContinuity(sb, input, {
      open_threads: [{ topic: 'sleep plan', summary: 'Still testing.' }, { topic: 'Half marathon', summary: 'Undecided.' }],
      promises: [{ text: 'Remind the user of the plan', due_hint: 'tomorrow' }],
    }, '2026-09-23T10:00:00.000Z');
    expect(out).toEqual({ threads_written: 1, threads_touched: 1, promises_written: 1 });

    const read = calls.find((c) => c.op === 'select')!;
    expect(read.filters).toEqual([['tenant_id', 't1'], ['user_id', 'u1'], ['status', 'open']]);

    const upd = calls.find((c) => c.op === 'update')!;
    expect(upd.payload).toEqual({ summary: 'Still testing.', session_id_last: 'live-9', last_mentioned_at: '2026-09-23T10:00:00.000Z' });
    expect(upd.filters).toEqual([['thread_id', 'th-1']]);

    const ins = calls.find((c) => c.op === 'insert' && c.table === 'user_open_threads')!;
    expect(ins.payload).toMatchObject({ tenant_id: 't1', user_id: 'u1', topic: 'Half marathon', session_id_first: 'live-9', session_id_last: 'live-9' });

    const prom = calls.find((c) => c.table === 'assistant_promises')!;
    expect(prom.payload).toEqual([{ tenant_id: 't1', user_id: 'u1', session_id: 'live-9', promise_text: 'Remind the user of the plan (tomorrow)' }]);
  });

  it('throws on a failed write so the caller can report it', async () => {
    const { sb } = makeSb([], 'assistant_promises.insert');
    await expect(writeExtractedContinuity(sb, input, { open_threads: [], promises: [{ text: 'x', due_hint: '' }] })).rejects.toThrow('promise insert failed');
  });
});

describe('recordSessionContinuity', () => {
  beforeEach(() => (callViaRouter as jest.Mock).mockReset());

  it('routes through the memory stage and writes the extraction', async () => {
    (callViaRouter as jest.Mock).mockResolvedValue({
      ok: true,
      text: '{"open_threads":[{"topic":"Half marathon","summary":"Undecided."}],"promises":[]}',
    });
    const { sb } = makeSb();
    const r = await recordSessionContinuity({ ...input, transcript_turns: turns }, { supabase: sb });
    expect(r).toEqual({ ok: true, threads_written: 1, threads_touched: 0, promises_written: 0 });
    const [stage, transcript, opts] = (callViaRouter as jest.Mock).mock.calls[0];
    expect(stage).toBe('memory');
    expect(transcript).toContain('User: Ich überlege');
    expect(opts).toMatchObject({ service: 'session-continuity-writer' });
  });

  it('nothing open → ok with zero writes and no table touched', async () => {
    (callViaRouter as jest.Mock).mockResolvedValue({ ok: true, text: '{"open_threads":[],"promises":[]}' });
    const { sb, calls } = makeSb();
    expect(await recordSessionContinuity({ ...input, transcript_turns: turns }, { supabase: sb })).toEqual({
      ok: true, threads_written: 0, threads_touched: 0, promises_written: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['missing_identity', { ...input, user_id: '', transcript_turns: turns }, {}],
    ['no_user_turn', { ...input, transcript_turns: [turns[1]] }, {}],
    ['storage_unavailable', { ...input, transcript_turns: turns }, { supabase: null }],
  ])('refuses with %s before any model call', async (reason, inp, deps) => {
    const r = await recordSessionContinuity(inp as any, deps as any);
    expect(r).toMatchObject({ ok: false, reason });
    expect(callViaRouter).not.toHaveBeenCalled();
  });

  it('a router failure is extraction_failed, never a throw', async () => {
    (callViaRouter as jest.Mock).mockResolvedValue({ ok: false, error: 'bedrock down' });
    const { sb } = makeSb();
    expect(await recordSessionContinuity({ ...input, transcript_turns: turns }, { supabase: sb })).toMatchObject({
      ok: false, reason: 'extraction_failed',
    });
  });

  it('a write failure is reported, never thrown', async () => {
    (callViaRouter as jest.Mock).mockResolvedValue({ ok: true, text: '{"open_threads":[],"promises":[{"text":"x"}]}' });
    const { sb } = makeSb([], 'assistant_promises.insert');
    const r = await recordSessionContinuity({ ...input, transcript_turns: turns }, { supabase: sb });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('promise insert failed');
  });
});

describe('isSessionContinuityWriteEnabled', () => {
  it('defaults on; only the exact string false disables it', () => {
    expect(isSessionContinuityWriteEnabled(undefined)).toBe(true);
    expect(isSessionContinuityWriteEnabled('0')).toBe(true);
    expect(isSessionContinuityWriteEnabled('false')).toBe(false);
  });
});
