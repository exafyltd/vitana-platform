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
  distilBackfill,
  stopObserver,
} from '../src/services/watcher/watcher-observer';

interface Recorded {
  cursorWrites: Array<Record<string, unknown>>;
  stepWrites: unknown[][];
  queries: Array<{ table: string; or?: string; range?: [number, number] }>;
  lessonInserts: Array<Record<string, unknown>>;
  lessonUpdates: Array<Record<string, unknown>>;
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
  /** Pre-existing watcher_lessons row, to exercise the recurrence path. */
  existingLesson?: Record<string, unknown> | null;
}) {
  const rec: Recorded = {
    cursorWrites: [], stepWrites: [], queries: [], lessonInserts: [], lessonUpdates: [],
  };
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
            select: async () => {
              if (opts.stepWriteError) {
                return { data: null, error: { message: opts.stepWriteError } };
              }
              // The real client returns the full inserted ROW, not just the
              // id — distillation runs on it, so the fake must too.
              const kept = opts.insertedIds ?? rows;
              return {
                data: kept.map((_, i) => ({
                  ...(rows[i] as Record<string, unknown>),
                  id: `s${i}`,
                })),
                error: null,
              };
            },
          };
        },
      };
    }

    if (table === 'watcher_lessons') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: opts.existingLesson ?? null,
                  error: null,
                }),
              }),
            }),
          }),
        }),
        insert: async (row: Record<string, unknown>) => {
          rec.lessonInserts.push(row);
          return { error: null };
        },
        update: (row: Record<string, unknown>) => ({
          eq: async () => {
            rec.lessonUpdates.push(row);
            return { error: null };
          },
        }),
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
    expect(await writeSteps([])).toEqual({ ok: true, written: 0, inserted: [] });
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

/**
 * VTID-03531 — the distiller has to actually be CALLED.
 *
 * Phase 2 shipped distilBatch() and upsertLesson() fully unit-tested, and
 * nothing invoked either of them. The observer ran for three days, recorded
 * 591 steps including a large number of failures, and watcher_lessons stayed
 * at exactly 0 rows. Every unit test passed the whole time, because a unit
 * test of a pure function cannot notice that no caller exists.
 *
 * These tests assert the WIRING, which is the part that was missing.
 */
describe('distillation is wired into the tick (VTID-03531)', () => {
  /** A failed CI event — the shape the distiller is supposed to learn from. */
  function failedEvt(id: string, created_at: string, message: string) {
    return {
      id,
      topic: 'dev_autopilot.execution.ci_failed',
      vtid: 'VTID-01',
      status: 'error',
      message,
      service: 'gateway',
      source: null,
      metadata: {},
      created_at,
    };
  }

  it('writes a lesson when a tick records a new failure', async () => {
    const { client, rec } = fakeSupabase({
      cursorAt: '2026-08-01T00:00:00.000Z',
      eventPages: [[failedEvt('e1', '2026-08-01T01:00:00.000Z', 'error TS2307: cannot find module')]],
    });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    expect(rec.lessonInserts).toHaveLength(1);
    expect(rec.lessonInserts[0].pattern_key).toBe('TS2307:cannot-find-module');
    // The lesson must cite the step it came from, or there is no way back to
    // the evidence when a human asks "why am I being told this?".
    expect(rec.lessonInserts[0].evidence_step_ids).toEqual(['s0']);
  });

  it('does NOT re-distil rows the overlap rescan skipped', async () => {
    // insertedIds: [] models ON CONFLICT DO NOTHING skipping every row — the
    // normal case on every rescan. Distilling those again would inflate
    // frequency once per tick forever and fabricate a recurrence that never
    // happened.
    const { client, rec } = fakeSupabase({
      cursorAt: '2026-08-01T00:00:00.000Z',
      eventPages: [[failedEvt('e1', '2026-08-01T01:00:00.000Z', 'error TS2307: cannot find module')]],
      insertedIds: [],
    });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    expect(rec.lessonInserts).toHaveLength(0);
    expect(rec.lessonUpdates).toHaveLength(0);
  });

  it('bumps frequency instead of re-inserting when the pattern recurs', async () => {
    const { client, rec } = fakeSupabase({
      cursorAt: '2026-08-01T00:00:00.000Z',
      eventPages: [[failedEvt('e2', '2026-08-01T01:00:00.000Z', 'error TS2307: cannot find module')]],
      existingLesson: { id: 'L1', frequency: 1, evidence_step_ids: ['old'] },
    });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    expect(rec.lessonInserts).toHaveLength(0);
    expect(rec.lessonUpdates).toHaveLength(1);
    // frequency 1 -> 2 is the specific transition that matters: loadLessons
    // withholds frequency-1 lessons as singletons, so a lesson that never
    // increments is a lesson that can never be injected.
    expect(rec.lessonUpdates[0].frequency).toBe(2);
    expect(rec.lessonUpdates[0].evidence_step_ids).toEqual(['old', 's0']);
  });

  it('refreshes scope on recurrence so a scope-definition change self-heals', async () => {
    // VTID-03534. Without this, a row written under an older scope definition
    // is found by (stage, pattern_type, pattern_key), has frequency/evidence
    // updated, and keeps its stale scope forever — so a scope fix applies
    // only to patterns never seen before and every already-known pattern
    // stays unreachable permanently. Raised in review of PR #3062.
    const { client, rec } = fakeSupabase({
      cursorAt: '2026-08-01T00:00:00.000Z',
      eventPages: [[failedEvt('e12', '2026-08-01T01:00:00.000Z', 'error TS2307: cannot find module')]],
      existingLesson: { id: 'L1', frequency: 3, evidence_step_ids: [] },
    });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    expect(rec.lessonUpdates).toHaveLength(1);
    // The distiller no longer scopes on the emitting service, so the stale
    // {service: ...} must be overwritten with the current definition.
    expect(rec.lessonUpdates[0].scope).toEqual({});
  });

  it('counts every occurrence in a batch, not one per batch', async () => {
    // Three failures with the same signature really are three occurrences.
    // Counting the batch as a single recurrence undercounts the evidence and
    // keeps a genuine pattern in singleton quarantine longer than the data
    // warrants — and it is what makes a historical backfill correct with no
    // special case.
    const { client, rec } = fakeSupabase({
      cursorAt: '2026-08-01T00:00:00.000Z',
      eventPages: [[
        failedEvt('e7', '2026-08-01T01:00:00.000Z', 'error TS2307: cannot find module a'),
        failedEvt('e8', '2026-08-01T01:00:01.000Z', 'error TS2307: cannot find module b'),
        failedEvt('e9', '2026-08-01T01:00:02.000Z', 'error TS2307: cannot find module c'),
      ]],
      existingLesson: { id: 'L1', frequency: 4, evidence_step_ids: [] },
    });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    expect(rec.lessonUpdates[0].frequency).toBe(7);
  });

  it('files a pattern that arrives already-recurring as non-singleton', async () => {
    const { client, rec } = fakeSupabase({
      cursorAt: '2026-08-01T00:00:00.000Z',
      eventPages: [[
        failedEvt('e10', '2026-08-01T01:00:00.000Z', 'error TS2307: cannot find module a'),
        failedEvt('e11', '2026-08-01T01:00:01.000Z', 'error TS2307: cannot find module b'),
      ]],
    });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    // Inserting at frequency 1 would put a pattern we have two independent
    // observations of straight into quarantine.
    expect(rec.lessonInserts[0].frequency).toBe(2);
    expect(rec.lessonInserts[0].confidence).toBeGreaterThan(0.5);
  });

  it('does not distil successful steps', async () => {
    const { client, rec } = fakeSupabase({
      cursorAt: '2026-08-01T00:00:00.000Z',
      eventPages: [[evt('e3', '2026-08-01T01:00:00.000Z')]],
    });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    // "This worked once" is not a lesson — injecting it builds a prompt that
    // argues for cargo-culting.
    expect(rec.lessonInserts).toHaveLength(0);
  });

  it('merges one tick\'s repeats into a single recurrence, not one per row', async () => {
    const { client, rec } = fakeSupabase({
      cursorAt: '2026-08-01T00:00:00.000Z',
      eventPages: [[
        failedEvt('e4', '2026-08-01T01:00:00.000Z', 'error TS2307: cannot find module a'),
        failedEvt('e5', '2026-08-01T01:00:01.000Z', 'error TS2307: cannot find module b'),
      ]],
    });
    mockGetSupabase.mockReturnValue(client);

    await observerTick();

    expect(rec.lessonInserts).toHaveLength(1);
    expect(rec.lessonInserts[0].evidence_step_ids).toEqual(['s0', 's1']);
  });

  it('a distillation failure never fails the tick', async () => {
    const { client } = fakeSupabase({
      cursorAt: '2026-08-01T00:00:00.000Z',
      eventPages: [[failedEvt('e6', '2026-08-01T01:00:00.000Z', 'boom')]],
    });
    // Nothing downstream may stall on the Watcher — the observer's whole
    // degradation posture depends on this.
    const broken = {
      from: (t: string) => (t === 'watcher_lessons'
        ? { select: () => { throw new Error('lessons table gone'); } }
        : client.from(t)),
    };
    mockGetSupabase.mockReturnValue(broken);

    const results = await observerTick();
    expect(results.find((r) => r.source === 'oasis_events')?.error).toBeUndefined();
  });
});

/**
 * VTID-03531 — historical backfill.
 *
 * The tick path only distils newly-inserted rows, which is what keeps it
 * idempotent across the overlap rescan. The cost is that the 354 failure
 * steps recorded BEFORE the distiller was wired up would never become memory
 * — already present, so the rescan skips them forever. This spends that
 * evidence once, deliberately.
 */
describe('distilBackfill (VTID-03531)', () => {
  function storedFailure(id: string, message: string) {
    return {
      id,
      work_unit_kind: 'vtid',
      work_unit_id: 'VTID-01',
      vtid: 'VTID-01',
      step: 'ci',
      outcome: 'failure',
      actor: 'ci',
      evidence: { message },
      source: 'oasis_events',
      source_ref: id,
      observed_at: '2026-08-01T00:00:00.000Z',
    };
  }

  function backfillSupabase(rows: unknown[]) {
    const rec = { inserts: [] as Record<string, unknown>[] };
    const client = {
      from: (table: string) => {
        if (table === 'watcher_steps') {
          const b: Record<string, unknown> = {};
          for (const m of ['select', 'eq', 'gte', 'order']) b[m] = () => b;
          b.limit = async () => ({ data: rows, error: null });
          return b;
        }
        if (table === 'watcher_lessons') {
          return {
            select: () => ({
              eq: () => ({ eq: () => ({ eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }) }) }),
            }),
            insert: async (row: Record<string, unknown>) => {
              rec.inserts.push(row); return { error: null };
            },
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };
    return { client, rec };
  }

  it('distils already-recorded failures and seeds frequency from real counts', async () => {
    const { client, rec } = backfillSupabase([
      storedFailure('h1', 'error TS2307: cannot find module a'),
      storedFailure('h2', 'error TS2307: cannot find module b'),
      storedFailure('h3', 'heap out of memory'),
    ]);
    mockGetSupabase.mockReturnValue(client);

    const r = await distilBackfill({ sinceIso: '2026-07-01T00:00:00.000Z' });

    expect(r.ok).toBe(true);
    expect(r.scanned).toBe(3);
    expect(r.lessons).toBe(2); // two distinct patterns

    const ts = rec.inserts.find((l) => l.pattern_key === 'TS2307:cannot-find-module')!;
    // Two historical occurrences must be filed as two, not as a singleton —
    // otherwise the backfill produces lessons quarantine then withholds.
    expect(ts.frequency).toBe(2);
    expect(rec.inserts.find((l) => l.pattern_key === 'node:oom')!.frequency).toBe(1);
  });

  it('reports the error instead of throwing when the read fails', async () => {
    mockGetSupabase.mockReturnValue(null);
    const r = await distilBackfill({ sinceIso: '2026-07-01T00:00:00.000Z' });
    expect(r.ok).toBe(false);
    expect(r.lessons).toBe(0);
  });
});
