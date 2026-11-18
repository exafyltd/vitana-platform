// VTID-05718 — chat burst sweep: one push per held burst, with the latest text and the count.
// Owner Option A (2026-11-11): a chat message is held 20 s, then the sweep sends one push per
// recipient and conversation. Cases: a burst of three, a single message, not yet due, read during
// the hold, a second sweep (no double send), a stale claim, and a dispatch failure (no retry loop).

const dispatchPush = jest.fn();
jest.mock('../src/services/push-routing', () => ({
  dispatchPush: (...a: unknown[]) => dispatchPush(...a),
}));
jest.mock('../src/services/notification-service', () => ({
  newPushFanoutOutcome: () => ({ sent: 0, stale: 0, errors: 0 }),
  classifyPushOutcome: (fcm: { sent: number; errors: number }, appilixSent: boolean) => {
    if (fcm.sent > 0 && appilixSent) return 'delivered_both';
    if (fcm.sent > 0) return 'delivered_fcm';
    if (appilixSent) return 'delivered_appilix';
    if (fcm.errors > 0) return 'fcm_error';
    return 'no_device';
  },
}));
jest.mock('../src/i18n/server-locale', () => ({
  bulkGetUserLocales: jest.fn(async (_sb: unknown, ids: string[]) => new Map(ids.map((id) => [id, 'en']))),
}));

import { sweepChatBurstsOnce, burstPayloadData } from '../src/services/chat-burst-sweep';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();

type Row = {
  id: string;
  user_id: string;
  tenant_id: string;
  type: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
  push_outcome: string | null;
  push_sent_at: string | null;
  data: Record<string, any> | null;
};

/** In-memory stand-in for the Supabase builder: the filters the sweep uses, applied to rows. */
function makeDb(rows: Row[]) {
  const from = (_table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'update' = 'select';
    let patch: Record<string, unknown> = {};
    let sortCol: string | null = null;
    let desc = false;
    let limit = Infinity;
    const get = (r: Row, col: string): any => {
      if (col.includes('->>')) return r.data?.[col.split('->>')[1]];
      return (r as any)[col];
    };
    const b: any = {
      select: () => b,
      eq: (col: string, v: unknown) => { filters.push((r) => get(r, col) === v); return b; },
      in: (col: string, vs: unknown[]) => { filters.push((r) => vs.includes(get(r, col))); return b; },
      is: (col: string, v: unknown) => { filters.push((r) => (get(r, col) ?? null) === v); return b; },
      lt: (col: string, v: string) => { filters.push((r) => get(r, col) != null && String(get(r, col)) < v); return b; },
      lte: (col: string, v: string) => { filters.push((r) => get(r, col) != null && String(get(r, col)) <= v); return b; },
      order: (col: string, o?: { ascending?: boolean }) => { sortCol = col; desc = o?.ascending === false; return b; },
      limit: (n: number) => { limit = n; return b; },
      update: (p: Record<string, unknown>) => { op = 'update'; patch = p; return b; },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        try {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          if (op === 'update') {
            for (const r of matched) Object.assign(r, patch);
            resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
            return;
          }
          if (sortCol) {
            const col = sortCol;
            matched.sort((a, b2) => (String(get(a, col)) < String(get(b2, col)) ? -1 : 1) * (desc ? -1 : 1));
          }
          resolve({ data: JSON.parse(JSON.stringify(matched.slice(0, limit))), error: null });
        } catch (e) {
          reject(e);
        }
      },
    };
    return b;
  };
  return { from } as any;
}

function row(id: string, msAgo: number, text: string, extra: Partial<Row> = {}, dataExtra: Record<string, unknown> = {}): Row {
  return {
    id,
    user_id: 'u1',
    tenant_id: 't1',
    type: 'new_chat_message',
    title: 'Dragan Alexander',
    body: text,
    created_at: at(msAgo),
    read_at: null,
    push_outcome: 'pending_burst',
    push_sent_at: null,
    data: { conversation_key: 'dm:sender-1', burst_due_at: at(0), url: '/inbox/u/sender-1', ...dataExtra },
    ...extra,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  dispatchPush.mockImplementation(async (args: any) => {
    args.outcome.sent = 1;
    return { sent: 1, nativeSent: 0, legacySent: 1, appilixSent: false };
  });
});

describe('sweepChatBurstsOnce (VTID-05718)', () => {
  test('a burst of three held messages leaves as ONE push: the latest text and the count', async () => {
    const rows = [
      row('a', 40_000, 'first'),
      row('b', 30_000, 'second'),
      row('c', 25_000, 'third'),
    ];
    const sb = makeDb(rows);
    await sweepChatBurstsOnce(sb, NOW);

    expect(dispatchPush).toHaveBeenCalledTimes(1);
    const sent = dispatchPush.mock.calls[0][0];
    expect(sent).toEqual(expect.objectContaining({ userId: 'u1', tenantId: 't1' }));
    expect(sent.payload.body).toBe('3 new messages · third');
    expect(sent.payload.title).toBe('Dragan Alexander');
    expect(sent.payload.data).toEqual(expect.objectContaining({ conversation_key: 'dm:sender-1', tag: 'chat:dm:sender-1' }));
    expect(sent.payload.data).not.toHaveProperty('burst_due_at');
    expect(sent.payload.data).not.toHaveProperty('claimed_at');

    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('c')!.push_outcome).toBe('delivered_fcm');
    expect(byId.get('c')!.push_sent_at).toEqual(expect.any(String));
    expect(byId.get('a')!.push_outcome).toBe('coalesced');
    expect(byId.get('b')!.push_outcome).toBe('coalesced');
  });

  test('a single held message is sent with its own text and no count', async () => {
    const rows = [row('a', 25_000, 'only one')];
    await sweepChatBurstsOnce(makeDb(rows), NOW);
    expect(dispatchPush).toHaveBeenCalledTimes(1);
    expect(dispatchPush.mock.calls[0][0].payload.body).toBe('only one');
  });

  test('a burst that is not due yet is left alone', async () => {
    const rows = [row('a', 5_000, 'hold on', { data: { conversation_key: 'dm:sender-1', burst_due_at: at(-15_000) } })];
    await sweepChatBurstsOnce(makeDb(rows), NOW);
    expect(dispatchPush).not.toHaveBeenCalled();
    expect(rows[0].push_outcome).toBe('pending_burst');
  });

  test('read during the hold: nothing is sent and the held rows are recorded suppressed_read', async () => {
    const rows = [
      row('a', 30_000, 'one', { read_at: at(10_000) }),
      row('b', 25_000, 'two', { read_at: at(10_000) }),
    ];
    await sweepChatBurstsOnce(makeDb(rows), NOW);
    expect(dispatchPush).not.toHaveBeenCalled();
    expect(rows.map((r) => r.push_outcome)).toEqual(['suppressed_read', 'suppressed_read']);
  });

  test('a second sweep does not send the same burst again', async () => {
    const rows = [row('a', 40_000, 'one'), row('b', 30_000, 'two')];
    const sb = makeDb(rows);
    await sweepChatBurstsOnce(sb, NOW);
    await sweepChatBurstsOnce(sb, NOW + 5_000);
    expect(dispatchPush).toHaveBeenCalledTimes(1);
  });

  test('a claim left in sending by a crash is reclaimed and the burst is sent', async () => {
    const rows = [
      row('a', 90_000, 'stuck', { push_outcome: 'sending' }, { claimed_at: at(120_000) }),
    ];
    await sweepChatBurstsOnce(makeDb(rows), NOW);
    expect(dispatchPush).toHaveBeenCalledTimes(1);
    expect(dispatchPush.mock.calls[0][0].payload.body).toBe('stuck');
  });

  test('a dispatch failure gives up on that burst (dispatch_exception), with no retry loop', async () => {
    dispatchPush.mockRejectedValueOnce(new Error('fcm down'));
    const rows = [row('a', 40_000, 'one'), row('b', 30_000, 'two')];
    const sb = makeDb(rows);
    await sweepChatBurstsOnce(sb, NOW);
    expect(rows.find((r) => r.id === 'b')!.push_outcome).toBe('dispatch_exception');
    await sweepChatBurstsOnce(sb, NOW + 5_000);
    expect(dispatchPush).toHaveBeenCalledTimes(1);
  });

  test('bursts in different conversations are sent separately', async () => {
    const rows = [
      row('a', 40_000, 'dm one'),
      row('b', 40_000, 'group one', { data: { conversation_key: 'group:g1', burst_due_at: at(0) } }),
    ];
    await sweepChatBurstsOnce(makeDb(rows), NOW);
    expect(dispatchPush).toHaveBeenCalledTimes(2);
  });
});

describe('burstPayloadData', () => {
  test('keeps string values, drops internal keys and nulls, stringifies the rest', () => {
    expect(burstPayloadData({ url: '/x', burst_due_at: 'y', claimed_at: 'z', n: 3, gone: null }))
      .toEqual({ url: '/x', n: '3' });
  });
});
