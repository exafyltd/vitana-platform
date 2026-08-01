/**
 * VTID-03460 / VTID-03461 — Watcher observer cursor semantics.
 *
 * These cover the two failure modes raised in the Codex review of PR #3024,
 * both of which silently destroy timeline data rather than erroring:
 *
 *   1. A failed watcher_steps write was indistinguishable from a
 *      duplicate-only batch (both returned 0), so the cursor advanced past
 *      events that were never persisted. Once they aged out of the overlap
 *      window they were gone, and /health reported no error.
 *   2. An ascending page-limited scan can return a last timestamp OLDER than
 *      the current cursor, which walked the cursor backwards into the same
 *      dense window forever and starved newer events.
 *
 * Neither would ever throw, and neither would show up in a happy-path test —
 * which is exactly why they need explicit coverage.
 */

const mockGetSupabase = jest.fn();
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => mockGetSupabase() }));

import {
  observerTick,
  writeSteps,
  stopObserver,
} from '../src/services/watcher/watcher-observer';

interface Recorded {
  cursorWrites: Array<Record<string, unknown>>;
  stepWrites: unknown[][];
  queries: Array<{ table: string; or?: string; range?: [number, number] }>;
}

/**
 * Fake supabase client. Only models the calls the observer actually makes;
 * anything else throws loudly rather than silently returning undefined, so a
 * refactor that changes the query shape fails here instead of in production.
 */
function fakeSupabase(opts: {
  cursorAt?: string;
  eventPages?: Array<Array<Record<string, unknown>>>;
  execRows?: Array<Record<string, unknown>>;
  stepWriteError?: string;
  eventQueryError?: string;
  /** Simulate ON CONFLICT DO NOTHING skipping rows: fewer ids than rows in. */
  insertedIds?: unknown[];
}) {
  const rec: Recorded = { cursorWrites: [], stepWrites: [], queries: [] };
  const eventPages = opts.eventPages ?? [[]];

  const from = (table: string) => {
    if (table === 'watcher_observer_state') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: opts.cursorAt ? { cursor_at: opts.cursorAt } : null,
              error: null,
            }),
          }),
          order: async () => ({ data: [], error: null }),
        }),
        upsert: async (row: Record<string, unknown>) => {
          rec.cursorWrites.push(row);
          return { error: null };
        },
      };
    }

    if (table === 'watcher_steps') {
      return {
        upsert: (rows: unknown[]) => {
          rec.stepWrites.push(rows);
          // Mirrors the real client: upsert(...).select('id') resolves to the
          // INSERTED rows. Rows skipped by ON CONFLICT DO NOTHING are simply
          // absent, which is what makes the count truthful.
          return {
            select: async () => (opts.stepWriteError
              ? { data: null, error: { message: opts.stepWriteError } }
              : { data: (opts.insertedIds ?? rows).map((_, i) => ({ id: `s${i}` })), error: null }),
          };
        },
      };
    }

    if (table === 'oasis_events') {
      const q: Record<string, unknown> = { table };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'gte', 'order']) builder[m] = () => builder;
      builder.or = (expr: string) => { q.or = expr; return builder; };
      builder.range = async (a: number, b: number) => {
        rec.queries.push({ table, or: q.or as string, range: [a, b] });
        if (opts.eventQueryError) return { data: null, error: { message: opts.eventQueryError } };
        const page = eventPages[Math.floor(a / 500)] ?? [];
        return { data: page, error: null };
      };
      return builder;
    }

    if (table === 'dev_autopilot_executions') {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'gte', 'order']) builder[m] = () => builder;
      builder.limit = async () => ({ data: opts.execRows ?? [], error: null });
      return builder;
    }

    throw new Error(`unexpected table in observer test: ${table}`);
  };

  return { client: { from }, rec };
}

function evt(id: string, created_at: string) {
  return {
    id,
    topic: 'dev_autopilot.plan.generated',
    vtid: 'VTID-01',
    status: 'success',
    message: null,
    service: null,
    source: null,
    metadata: {},
    created_at,
  };
}

afterEach(() => {
  stopObserver();
  jest.clearAllMocks();
});

describe('writeSteps contract', () => {
  it('reports ok with written=0 for an empty batch', async () => {
    mockGetSupabase.mockReturnValue(fakeSupabase({}).client);
    expect(await writeSteps([])).toEqual({ ok: true, written: 0 });
  });

  it('distinguishes a FAILED write from a duplicate-only write', async () => {
    // The core of review finding P1. Both used to be `0`.
    const ok = fakeSupabase({});
    mockGetSupabase.mockReturnValue(ok.client);
    const good = await writeSteps([{ x: 1 } as never]);
    expect(good.ok).toBe(true);

    const bad = fakeSupabase({ stepWriteError: 'deadlock detected' });
    mockGetSupabase.mockReturnValue(bad.client);
    const failed = await writeSteps([{ x: 1 } as never]);
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe('deadlock detected');
    expect(failed.written).toBe(0);
  });

  it('reports failure rather than throwing when supabase is absent', async () => {
    mockGetSupabase.mockReturnValue(null);
    const r = await writeSteps([{ x: 1 } as never]);
    expect(r.ok).toBe(false);
  });
});

describe('cursor advancement (review finding P1)', () => {
  it('does NOT advance the cursor when the step write fails', async () => {
    const cursorAt = '2026-07-30T10:00:00.000Z';
    const { client, rec } = fakeSupabase({
      cursorAt,
      eventPages: [[evt('e1', '2026-07-30T10:05:00.000Z')]],
      stepWriteError: 'connection reset',
    });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    const oasisCursor = rec.cursorWrites.find((c) => c.source === 'oasis_events');
    expect(oasisCursor).toBeDefined();
    // Held at the old value: re-reading is free, losing events is not.
    expect(oasisCursor!.cursor_at).toBe(cursorAt);
    // And the failure is VISIBLE rather than swallowed.
    expect(oasisCursor!.last_error).toBe('connection reset');
  });

  it('advances and clears last_error when the write succeeds', async () => {
    const { client, rec } = fakeSupabase({
      cursorAt: '2026-07-30T10:00:00.000Z',
      eventPages: [[evt('e1', '2026-07-30T10:05:00.000Z')]],
    });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    const c = rec.cursorWrites.find((x) => x.source === 'oasis_events')!;
    expect(c.cursor_at).toBe('2026-07-30T10:05:00.000Z');
    expect(c.last_error).toBeNull();
  });

  it('holds the cursor and records the error when the QUERY fails', async () => {
    const cursorAt = '2026-07-30T10:00:00.000Z';
    const { client, rec } = fakeSupabase({ cursorAt, eventQueryError: 'relation missing' });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    const c = rec.cursorWrites.find((x) => x.source === 'oasis_events')!;
    expect(c.cursor_at).toBe(cursorAt);
    expect(c.last_error).toBe('relation missing');
  });
});

describe('cursor never regresses (review finding P2)', () => {
  it('keeps the newer cursor when a page ends older than it', async () => {
    // An ascending page-limited scan starts at (cursor - overlap), so a full
    // page can end BEFORE the cursor. Writing that back walked the cursor
    // backwards into the same dense window on every tick, and newer events
    // were never reached.
    const cursorAt = '2026-07-30T10:00:00.000Z';
    const older = '2026-07-30T09:58:00.000Z'; // inside the overlap, before cursor
    const { client, rec } = fakeSupabase({
      cursorAt,
      eventPages: [[evt('e1', older)]],
    });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    const c = rec.cursorWrites.find((x) => x.source === 'oasis_events')!;
    expect(c.cursor_at).toBe(cursorAt);
    expect(new Date(c.cursor_at as string).getTime())
      .toBeGreaterThanOrEqual(new Date(older).getTime());
  });

  it('holds the cursor when a tick reads nothing at all', async () => {
    const cursorAt = '2026-07-30T10:00:00.000Z';
    const { client, rec } = fakeSupabase({ cursorAt, eventPages: [[]] });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    const c = rec.cursorWrites.find((x) => x.source === 'oasis_events')!;
    expect(c.cursor_at).toBe(cursorAt);
  });
});

describe('scan shape', () => {
  it('pushes the topic allowlist into the QUERY, not just the normalizer', async () => {
    // Filtering only in JS meant a busy 5-minute window could fill the page
    // with product telemetry (autopilot.health.stuck_task alone: 2,692 rows
    // in 45 days) and starve the scan of real development events.
    const { client, rec } = fakeSupabase({
      cursorAt: '2026-07-30T10:00:00.000Z',
      eventPages: [[]],
    });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    const q = rec.queries.find((x) => x.table === 'oasis_events');
    expect(q).toBeDefined();
    expect(q!.or).toContain('topic.in.');
    expect(q!.or).toContain('dev_autopilot.plan.generated');
    expect(q!.or).toContain('topic.like.vtid.stage.worker_*');
    // The high-volume product topics must NOT be selected at all.
    expect(q!.or).not.toContain('autopilot.health.stuck_task');
    expect(q!.or).not.toContain('vtid.live.session.start');
  });

  it('drains a dense window across pages instead of stalling on page one', async () => {
    // A full page means there is more behind it. Stopping after one page
    // leaves the cursor inside the same window every tick.
    const full = Array.from({ length: 500 }, (_, i) =>
      evt(`a${i}`, '2026-07-30T10:01:00.000Z'));
    const tail = [evt('b0', '2026-07-30T10:09:00.000Z')];
    const { client, rec } = fakeSupabase({
      cursorAt: '2026-07-30T10:00:00.000Z',
      eventPages: [full, tail],
    });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    const pages = rec.queries.filter((x) => x.table === 'oasis_events');
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[0].range).toEqual([0, 499]);
    expect(pages[1].range).toEqual([500, 999]);
    // Forward progress reached the tail page's timestamp.
    const c = rec.cursorWrites.find((x) => x.source === 'oasis_events')!;
    expect(c.cursor_at).toBe('2026-07-30T10:09:00.000Z');
  });

  it('stops paging as soon as a page comes back partial', async () => {
    const { client, rec } = fakeSupabase({
      cursorAt: '2026-07-30T10:00:00.000Z',
      eventPages: [[evt('e1', '2026-07-30T10:05:00.000Z')]],
    });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    expect(rec.queries.filter((x) => x.table === 'oasis_events').length).toBe(1);
  });
});

describe('written count is truthful (VTID-03473)', () => {
  /**
   * Regression. writeSteps used `count: 'exact'`, but ignoreDuplicates makes
   * the upsert ON CONFLICT DO NOTHING and PostgREST returns no exact count
   * for that — so `count ?? 0` reported 0 on every successful write.
   * Production had 536 rows with last_written stuck at 0.
   *
   * last_written is the field that makes "scans every tick, writes nothing"
   * visible. A hard zero makes it read the same whether the normalizer works
   * or is dead, blinding the one diagnostic built to catch that.
   */
  it('reports the number of rows actually inserted', async () => {
    mockGetSupabase.mockReturnValue(fakeSupabase({}).client);
    const r = await writeSteps([{ a: 1 } as never, { b: 2 } as never, { c: 3 } as never]);
    expect(r.ok).toBe(true);
    expect(r.written).toBe(3);
  });

  it('counts only inserts, not rows skipped by the conflict clause', async () => {
    // 3 rows in, 1 new: an overlap rescan where 2 were already recorded.
    mockGetSupabase.mockReturnValue(fakeSupabase({ insertedIds: [1] }).client);
    const r = await writeSteps([{ a: 1 } as never, { b: 2 } as never, { c: 3 } as never]);
    expect(r.written).toBe(1);
  });

  it('surfaces a non-zero written count on the cursor row', async () => {
    // The end-to-end point: health must be able to show progress.
    const { client, rec } = fakeSupabase({
      cursorAt: '2026-07-30T10:00:00.000Z',
      eventPages: [[evt('e1', '2026-07-30T10:05:00.000Z')]],
    });
    mockGetSupabase.mockReturnValue(client);
    await observerTick();
    const c = rec.cursorWrites.find((x) => x.source === 'oasis_events')!;
    expect(c.last_written).toBe(1);
  });
});
