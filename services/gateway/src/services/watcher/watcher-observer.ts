/**
 * VTID-03460 — Watcher Phase 1: the observer.
 *
 * Plan: docs/WATCHER-AGENT-PLAN.md (VTID-03454), Phase 1.
 *
 * One tick, two scans (oasis_events, dev_autopilot_executions), both
 * cursor-driven, both idempotent. Sessions arrive by push instead
 * (POST /api/v1/watcher/session-step) because a Claude Code session has no
 * table to poll.
 *
 * =============================================================================
 * THIS MODULE EMITS NO OASIS EVENTS. NOT ONE.
 * =============================================================================
 * Its scan is a poll. CLAUDE.md §6 is unambiguous: "OASIS is for STATE
 * TRANSITIONS and DECISIONS — not loops. Polling ≠ progress. Heartbeat ≠
 * event." An observer that announced its own ticks would be both a rule
 * violation and a self-inflicted flood — it would then observe its own
 * announcements. Phase 3 emits exactly one event type
 * (`vtid.decision.watcher.reminded`) because raising a reminder IS a
 * decision. Nothing before then.
 *
 * =============================================================================
 * Degradation posture
 * =============================================================================
 * Every DB call is best-effort: a failure is caught, recorded on the source's
 * cursor row, and the tick moves on. Nothing downstream may ever stall on the
 * Watcher (that is why `loadExecutionLessons` in dev-autopilot-execute.ts
 * returns [] on error, and this follows the same rule).
 *
 * But silent degradation is its own bug — CLAUDE.md ALWAYS rule 10 says fail
 * loudly. So the failure is *recorded*, not swallowed: `last_error` and
 * `last_written` land on watcher_observer_state and surface through
 * GET /api/v1/watcher/health. A source that scans rows every tick and writes
 * zero is visible there as a broken normalizer rather than as silence.
 */

import { getSupabase } from '../../lib/supabase';
import {
  SOURCE_EXECUTIONS,
  SOURCE_OASIS,
  normalizeExecution,
  normalizeOasisEvent,
  observedTopics,
  type ExecutionRow,
  type OasisEventRow,
} from './normalizers';
import { distilBatch } from './distiller';
import { upsertLesson } from './lessons-store';
import type { SourceTickResult, WatcherStep } from './types';

const LOG_PREFIX = '[watcher-observer]';

/**
 * A step as it came BACK from the database — same shape plus the assigned id.
 * The id is what links a lesson to the evidence that produced it, so
 * distillation has to run on the persisted row rather than on the in-memory
 * WatcherStep that was sent.
 */
export type StoredStep = WatcherStep & { id: string };

/** One tick per minute matches dev-autopilot-watcher's cadence. */
export const OBSERVER_TICK_MS = 60_000;

/**
 * How far behind the cursor each scan re-reads.
 *
 * Rows do not necessarily become visible in created_at order — a row can be
 * inserted with a created_at slightly behind one already committed, and a
 * strict `> cursor` scan would step straight over it and lose the step
 * forever. Re-reading a 5-minute tail costs a handful of no-op upserts
 * (the UNIQUE constraint absorbs them) and buys immunity to that whole class
 * of silent loss.
 */
export const OVERLAP_MS = 5 * 60_000;

/** Rows per page. */
const SCAN_LIMIT = 500;

/**
 * Pages drained per source per tick (so up to SCAN_LIMIT * this rows).
 * Bounds one tick's work while still guaranteeing forward progress through a
 * dense window — a single-page scan would sit inside the same busy interval
 * every tick and never reach newer events.
 */
const MAX_PAGES_PER_TICK = 10;

/**
 * How far back a cold start reaches. Deliberately short: the point of Phase 1
 * is to prove the timeline reconstructs correctly going forward, and a
 * multi-month backfill on first boot would bury that signal under history
 * whose events may predate the topics we allowlist. Backfill is a separate,
 * deliberate operation.
 */
const COLD_START_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function isEnabled(): boolean {
  return (process.env.WATCHER_OBSERVER_ENABLED || 'true').toLowerCase() !== 'false';
}

// =============================================================================
// Cursor state
// =============================================================================

async function readCursor(source: string): Promise<string> {
  const sb = getSupabase();
  if (!sb) return new Date(Date.now() - COLD_START_LOOKBACK_MS).toISOString();

  const { data, error } = await sb
    .from('watcher_observer_state')
    .select('cursor_at')
    .eq('source', source)
    .maybeSingle();

  if (error || !data?.cursor_at) {
    return new Date(Date.now() - COLD_START_LOOKBACK_MS).toISOString();
  }
  return data.cursor_at as string;
}

async function writeCursor(
  source: string,
  cursorAt: string,
  written: number,
  error?: string,
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const now = new Date().toISOString();
  await sb.from('watcher_observer_state').upsert(
    {
      source,
      cursor_at: cursorAt,
      last_run_at: now,
      last_error: error ?? null,
      last_written: written,
      updated_at: now,
    },
    { onConflict: 'source' },
  );
}

// =============================================================================
// Writing steps
// =============================================================================

/**
 * Upsert normalized steps. `ignoreDuplicates` is what makes the overlap
 * rescan free: a step already recorded is skipped, not rewritten, so
 * observed_at keeps the value it had when first seen rather than drifting
 * forward on every rescan.
 *
 * Returns {ok, written} rather than a bare count. A bare count cannot
 * distinguish "wrote nothing because every row was a duplicate" (the normal,
 * healthy case on every overlap rescan) from "wrote nothing because the
 * write FAILED" — and the caller advances its cursor on that value. Conflate
 * them and a transient DB error silently drops every event in the batch the
 * moment it ages out of the overlap window, while /health cheerfully reports
 * no error. That is precisely the silent degradation this module's header
 * promises not to do.
 */
export async function writeSteps(
  steps: WatcherStep[],
): Promise<{ ok: boolean; written: number; inserted: StoredStep[]; error?: string }> {
  if (steps.length === 0) return { ok: true, written: 0, inserted: [] };
  const sb = getSupabase();
  if (!sb) return { ok: false, written: 0, inserted: [], error: 'supabase unavailable' };

  try {
    // `.select('id')` rather than `count: 'exact'` — VTID-03473.
    //
    // With ignoreDuplicates the upsert becomes ON CONFLICT DO NOTHING, and
    // PostgREST returns no exact count for that, so `count` came back null and
    // `count ?? 0` reported 0 on every successful write. Measured in
    // production: 536 rows genuinely written, last_written stuck at 0.
    //
    // That is not cosmetic. last_written exists so that "this source scans
    // every tick and writes nothing" is VISIBLE — the signature of a broken
    // normalizer. Hard-zero means the health field reads identically whether
    // the normalizer works perfectly or is completely dead, so the one
    // diagnostic built to catch that failure was blind to it.
    //
    // Returning the inserted ids gives a true count: rows skipped by the
    // conflict clause are simply absent from the response.
    //
    // The full row (not just the id) comes back because distillation runs on
    // exactly this set — VTID-03531. Rows the conflict clause skipped were
    // already distilled on the tick that first inserted them, so selecting
    // only the genuinely-new rows is what makes distillation idempotent
    // across the overlap rescan without needing a second dedupe pass.
    const { data, error } = await sb
      .from('watcher_steps')
      .upsert(steps, {
        onConflict: 'source,source_ref,step',
        ignoreDuplicates: true,
      })
      .select('id, work_unit_kind, work_unit_id, vtid, step, outcome, actor, evidence, source, source_ref, observed_at');

    if (error) {
      console.error(`${LOG_PREFIX} write failed:`, error.message);
      return { ok: false, written: 0, inserted: [], error: error.message };
    }
    const inserted = (Array.isArray(data) ? data : []) as StoredStep[];
    return { ok: true, written: inserted.length, inserted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} write threw:`, message);
    return { ok: false, written: 0, inserted: [], error: message };
  }
}

// =============================================================================
// Distillation
// =============================================================================

/**
 * Turn this tick's newly-recorded failures into watcher_lessons.
 *
 * This is the step that was missing until VTID-03531. Phase 2 built the
 * distiller and the lessons store, both unit-tested, and nothing ever called
 * them: `distilBatch` and `upsertLesson` had zero call sites outside tests.
 * The observer accumulated 591 steps — including a large number of failures —
 * against a permanently empty watcher_lessons table, so the Watcher recorded
 * history it could never turn into memory. Every reminder it could serve came
 * from the 25 hand-authored rules; nothing was ever learned from what
 * actually happened, which is the entire point of the system.
 *
 * Runs once per tick over the union of both scans rather than per page, so a
 * pattern appearing several times in one tick counts as ONE recurrence
 * (distilBatch merges it) instead of inflating frequency by page count.
 *
 * Best-effort, like every other write here: a distillation failure is logged
 * and never propagates, because nothing downstream may stall on the Watcher.
 */
export async function distilTick(steps: StoredStep[]): Promise<number> {
  if (steps.length === 0) return 0;
  const lessons = distilBatch(steps);
  let written = 0;
  for (const lesson of lessons) {
    try {
      if (await upsertLesson(lesson)) written++;
    } catch (err) {
      console.warn(`${LOG_PREFIX} distil failed for ${lesson.pattern_key}:`, err);
    }
  }
  if (written > 0) console.log(`${LOG_PREFIX} distilled ${written} lesson(s)`);
  return written;
}

// =============================================================================
// Source scans
// =============================================================================

/**
 * PostgREST filter restricting the scan to development topics.
 *
 * Pushing the allowlist into the QUERY, not just the normalizer, is what
 * keeps this scan viable. oasis_events is dominated by user-facing product
 * runtime — autopilot.health.stuck_task alone logged 2,692 rows in 45 days
 * and vtid.live.* another ~1,400, against roughly 50 real development rows.
 * Selecting unfiltered and discarding in JS means a busy five-minute window
 * can exceed SCAN_LIMIT on noise alone, which starves the scan of the very
 * events it exists to read.
 */
function oasisTopicFilter(): string {
  const exact = observedTopics().join(',');
  // The worker-stage family is a regex in the normalizer; `like` is its
  // PostgREST equivalent. Anchored to `vtid.stage.worker_` so it cannot
  // pull in vtid.stage.matches.* and the other product stages.
  return `topic.in.(${exact}),topic.like.vtid.stage.worker_*`;
}

async function scanOasisEvents(sink: StoredStep[]): Promise<SourceTickResult> {
  const cursor = await readCursor(SOURCE_OASIS);
  const from = new Date(new Date(cursor).getTime() - OVERLAP_MS).toISOString();

  const sb = getSupabase();
  if (!sb) {
    return { source: SOURCE_OASIS, scanned: 0, written: 0, cursor_at: cursor, error: 'supabase unavailable' };
  }

  let scanned = 0;
  let written = 0;
  // Highest timestamp actually READ this tick. The cursor may only ever move
  // forward to this value — see the write-back below.
  let maxSeen = cursor;

  for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
    const { data, error } = await sb
      .from('oasis_events')
      .select('id, topic, vtid, status, message, service, source, metadata, created_at')
      .gte('created_at', from)
      .or(oasisTopicFilter())
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * SCAN_LIMIT, (page + 1) * SCAN_LIMIT - 1);

    if (error) {
      // Leave the cursor where it was: re-reading is free, losing events is not.
      await writeCursor(SOURCE_OASIS, cursor, written, error.message);
      return { source: SOURCE_OASIS, scanned, written, cursor_at: cursor, error: error.message };
    }

    const rows = (data || []) as OasisEventRow[];
    if (rows.length === 0) break;
    scanned += rows.length;

    const steps = rows
      .map(normalizeOasisEvent)
      .filter((s): s is WatcherStep => s !== null);

    const w = await writeSteps(steps);
    if (!w.ok) {
      // The batch did NOT persist. Advancing past it would put a permanent
      // hole in the timeline as soon as these rows age out of the overlap.
      await writeCursor(SOURCE_OASIS, cursor, written, w.error || 'write failed');
      return { source: SOURCE_OASIS, scanned, written, cursor_at: cursor, error: w.error || 'write failed' };
    }
    written += w.written;
    sink.push(...w.inserted);

    const lastTs = rows[rows.length - 1].created_at;
    if (lastTs > maxSeen) maxSeen = lastTs;

    // Partial page → the window is drained; nothing left to paginate.
    if (rows.length < SCAN_LIMIT) break;
    // Full page → keep draining. Paging (rather than stopping at one page)
    // is what guarantees forward progress when a window is dense: stopping
    // early would leave the cursor inside the same window every tick and the
    // scan would never reach newer events.
  }

  // Never regress. An ascending scan that fills its page returns rows whose
  // last timestamp can be OLDER than the current cursor, and writing that
  // back would walk the cursor backwards into the same dense window forever.
  const next = maxSeen > cursor ? maxSeen : cursor;
  await writeCursor(SOURCE_OASIS, next, written);

  return { source: SOURCE_OASIS, scanned, written, cursor_at: next };
}

async function scanExecutions(sink: StoredStep[]): Promise<SourceTickResult> {
  const cursor = await readCursor(SOURCE_EXECUTIONS);
  const from = new Date(new Date(cursor).getTime() - OVERLAP_MS).toISOString();

  const sb = getSupabase();
  if (!sb) {
    return { source: SOURCE_EXECUTIONS, scanned: 0, written: 0, cursor_at: cursor, error: 'supabase unavailable' };
  }

  const { data, error } = await sb
    .from('dev_autopilot_executions')
    // Kept on one line deliberately: supabase-js parses the select string at
    // the TYPE level, and a concatenated expression defeats that parse — it
    // degrades the row type to GenericStringError[] and the cast below then
    // fails to compile. Do not "tidy" this into a multi-line concat.
    .select('id, status, finding_id, branch, pr_url, pr_number, failure_stage, self_healing_vtid, parent_execution_id, auto_fix_depth, updated_at')
    .gte('updated_at', from)
    .order('updated_at', { ascending: true })
    .limit(SCAN_LIMIT);

  if (error) {
    await writeCursor(SOURCE_EXECUTIONS, cursor, 0, error.message);
    return { source: SOURCE_EXECUTIONS, scanned: 0, written: 0, cursor_at: cursor, error: error.message };
  }

  const rows = (data || []) as ExecutionRow[];
  const steps = rows
    .map(normalizeExecution)
    .filter((s): s is WatcherStep => s !== null);

  const w = await writeSteps(steps);
  if (!w.ok) {
    // Same rule as the events scan: a failed write must not advance the
    // cursor, or the rows are lost the moment they leave the overlap window.
    await writeCursor(SOURCE_EXECUTIONS, cursor, 0, w.error || 'write failed');
    return {
      source: SOURCE_EXECUTIONS, scanned: rows.length, written: 0,
      cursor_at: cursor, error: w.error || 'write failed',
    };
  }
  sink.push(...w.inserted);

  // Never regress (see the events scan for why). This source is far lower
  // volume, but the same invariant has to hold or the two sources drift.
  const lastTs = rows.length > 0 ? rows[rows.length - 1].updated_at : cursor;
  const next = lastTs > cursor ? lastTs : cursor;
  await writeCursor(SOURCE_EXECUTIONS, next, w.written);

  return { source: SOURCE_EXECUTIONS, scanned: rows.length, written: w.written, cursor_at: next };
}

/**
 * One-off distillation of failures ALREADY recorded in watcher_steps.
 *
 * The tick path deliberately distils only newly-inserted rows, which is what
 * keeps it idempotent across the overlap rescan. The cost of that choice is
 * that history recorded before the distiller was wired up (VTID-03531 — 354
 * failure steps across three days) would never become memory at all: those
 * rows are already present, so the rescan skips them forever and the system
 * starts learning from a standing start while sitting on a pile of unused
 * evidence.
 *
 * This exists to spend that evidence once. It is admin-triggered rather than
 * automatic because the observer's contract is that backfill is a deliberate
 * operation, not something a restart quietly performs.
 *
 * Safe to run more than once: distilBatch merges by pattern and upsertLesson
 * is keyed on (stage, pattern_type, pattern_key). Re-running does inflate
 * frequency for already-distilled patterns, though, so it is bounded by
 * `sinceIso` and reports what it touched rather than running open-ended.
 */
export async function distilBackfill(opts: {
  sinceIso: string;
  limit?: number;
}): Promise<{ ok: boolean; scanned: number; lessons: number; error?: string }> {
  const sb = getSupabase();
  if (!sb) return { ok: false, scanned: 0, lessons: 0, error: 'supabase unavailable' };

  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000);
  try {
    const { data, error } = await sb
      .from('watcher_steps')
      .select('id, work_unit_kind, work_unit_id, vtid, step, outcome, actor, evidence, source, source_ref, observed_at')
      .eq('outcome', 'failure')
      .gte('observed_at', opts.sinceIso)
      .order('observed_at', { ascending: true })
      .limit(limit);

    if (error) return { ok: false, scanned: 0, lessons: 0, error: error.message };

    const rows = (data || []) as StoredStep[];
    const lessons = await distilTick(rows);
    return { ok: true, scanned: rows.length, lessons };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, scanned: 0, lessons: 0, error: message };
  }
}

// =============================================================================
// Tick
// =============================================================================

let tickInFlight = false;

/**
 * Run one observation tick. Exported so /api/v1/watcher/health can force a
 * scan and so tests can drive it without waiting on a timer.
 *
 * Re-entrancy guard: a slow scan must not overlap with the next timer fire.
 * Two concurrent scans would read the same cursor and duplicate the work —
 * harmless for correctness (the upsert dedupes) but a pointless doubling of
 * DB load during exactly the backlog conditions that made the scan slow.
 */
export async function observerTick(): Promise<SourceTickResult[]> {
  if (!isEnabled()) return [];
  if (tickInFlight) return [];
  tickInFlight = true;
  try {
    // Sequential, not parallel: the two scans hit the same Postgres and the
    // volumes are tiny. Parallelism here would buy nothing and make the log
    // interleaving harder to read when a scan misbehaves.
    const results: SourceTickResult[] = [];
    // Collects the rows both scans actually INSERTED this tick, so
    // distillation sees each new step exactly once across both sources.
    const inserted: StoredStep[] = [];
    for (const scan of [scanOasisEvents, scanExecutions]) {
      try {
        results.push(await scan(inserted));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${LOG_PREFIX} scan threw:`, message);
        results.push({ source: scan.name, scanned: 0, written: 0, cursor_at: '', error: message });
      }
    }

    // After both scans, never between them: one tick's worth of the same
    // failure must count as one recurrence, not one per source.
    try {
      await distilTick(inserted);
    } catch (err) {
      console.error(`${LOG_PREFIX} distil threw:`, err);
    }

    return results;
  } finally {
    tickInFlight = false;
  }
}

// =============================================================================
// Lifecycle
// =============================================================================

let started = false;
let timer: NodeJS.Timeout | null = null;

export function startObserver(): void {
  if (started) return;
  if (!isEnabled()) {
    console.log(`${LOG_PREFIX} disabled (WATCHER_OBSERVER_ENABLED=false)`);
    return;
  }
  started = true;
  console.log(`${LOG_PREFIX} starting (tick=${OBSERVER_TICK_MS}ms, overlap=${OVERLAP_MS}ms)`);
  timer = setInterval(() => {
    observerTick().catch((e) => console.error(`${LOG_PREFIX} tick:`, e));
  }, OBSERVER_TICK_MS);
}

export function stopObserver(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

export function isObserverRunning(): boolean {
  return started;
}
