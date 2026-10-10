/**
 * VTID-05065 (Phase 1 of the sparred "Kiro on one server-side run record" plan):
 * one RUN per Kiro turn, stored server-side, owns everything about that turn.
 *
 *   kiro_runs        — one row per turn: who, which thread, status, the reply,
 *                      the pending approval card, the gateway task that owns it.
 *   kiro_run_events  — the turn's events in order (`seq`), replayable: message
 *                      text (coalesced), tool calls and updates, approval cards
 *                      and their answers, the turn end and every status change.
 *
 * A run starts and returns at once; the turn runs in this gateway task's
 * background through the SAME executor the old /chat path uses (registered by
 * routes/operator.ts with setKiroRunExecutor), so recording, OASIS chat events,
 * history restore and the model pick are unchanged. The console only displays a
 * run, and can always replay it (GET /runs/:id/stream?after_seq=).
 *
 * Ordering: `seq` is assigned here, in-process, by the one task that owns the
 * run, BEFORE the event goes to live listeners and to the database, so replay
 * plus live hand-off has no gap and no duplicate. Database writes are batched
 * (one bulk insert per run every 1 s or 20 events, flushed at the end and at
 * shutdown).
 *
 * Liveness: each gateway process has GATEWAY_TASK_ID; every 30 s ONE update
 * refreshes last_heartbeat_at on its own unfinished runs. A sweep (boot + every
 * 60 s, every task) marks other tasks' unfinished runs with a heartbeat older
 * than 2 min `interrupted` — a guarded UPDATE, so a second task's sweep is a
 * no-op, and an OASIS event is emitted only for rows the UPDATE changed. The
 * graceful-shutdown hook flushes and marks this task's runs interrupted at once.
 *
 * One running run per thread; up to 2 queued behind it (a third is refused,
 * `queue_full`); the next queued run starts when the current one ends.
 *
 * Fail-open on the store: if kiro_runs cannot be written (migration not applied
 * yet, database error), the old /chat path still answers the turn in-process
 * and logs the error; the new run routes refuse (`store_unavailable`).
 *
 * Admin-only Operator Console data. OASIS payloads carry run id, thread id and
 * status only — never message text.
 */
import { randomInt, randomUUID } from 'crypto';
import type { KiroTurnEvent, KiroTurnEventSink } from './kiro-events';
import { answerPermission } from './permission-broker';
import { cancelKiroTurn } from './kiro-turn';
import { emitOasisEvent } from '../oasis-event-service';
import type { CicdEventType } from '../../types/cicd';

const LOG = '[VTID-05065]';

/** This gateway process. Stored on its runs as `gateway_task`. */
export const GATEWAY_TASK_ID = randomUUID();

export const KIRO_RUN_STATUSES = ['queued', 'running', 'waiting_permission', 'completed', 'refused', 'incomplete', 'failed', 'cancelled', 'interrupted'] as const;
export type KiroRunStatus = (typeof KIRO_RUN_STATUSES)[number];
export const KIRO_RUN_ACTIVE_STATUSES: readonly KiroRunStatus[] = ['queued', 'running', 'waiting_permission'];
export function isTerminalRunStatus(s: unknown): boolean {
  return typeof s === 'string' && (KIRO_RUN_STATUSES as readonly string[]).includes(s) && !(KIRO_RUN_ACTIVE_STATUSES as readonly string[]).includes(s);
}
const ACTIVE_IN = `in.(${KIRO_RUN_ACTIVE_STATUSES.join(',')})`;

export const KIRO_RUN_LIMITS = {
  maxQueuedPerThread: 2,
  coalesceMs: 500,
  coalesceBytes: 2_048,
  flushMs: 1_000,
  flushEvents: 20,
  heartbeatMs: 30_000,
  sweepMs: 60_000,
  staleMs: 120_000,
  controlMs: 2_000,
  shutdownMs: 3_000,
  streamPollMs: 1_000,
  memoryEvents: 5_000,
  listLimit: 20,
};

/** The event types the console has always received as SSE frames (the old /chat/stream path). */
export const LEGACY_KIRO_FRAME_TYPES = new Set(['kiro.message_chunk', 'kiro.tool_call', 'kiro.tool_update', 'kiro.permission_request', 'kiro.turn_end']);

export interface KiroRunEvent { seq: number; type: string; payload: Record<string, unknown>; created_at: string }
export type KiroRunListener = (ev: KiroRunEvent) => void;

/** What the old /chat path needs to record the turn the way it always has. */
export interface KiroRunTurn {
  requestId: string;
  createdAt: string;
  attachments: Array<{ oasis_ref: string; kind: string }>;
  mode: string;
  conversation_id?: string;
  validatedVtid?: string;
  channel?: string;
}
export interface KiroRunExecutorInput extends KiroRunTurn { threadId: string; userId: string | null; message: string; emit: KiroTurnEventSink }
/** The /chat outcome: HTTP status + the exact body /chat returns. */
export interface KiroRunOutcome { status: number; body: Record<string, unknown> }
export type KiroRunExecutor = (input: KiroRunExecutorInput) => Promise<KiroRunOutcome>;

let executor: KiroRunExecutor | null = null;
/** routes/operator.ts registers the one Kiro chat-turn implementation both paths share. */
export function setKiroRunExecutor(fn: KiroRunExecutor | null): void { executor = fn; }

// ---------------------------------------------------------------------------
// Store (PostgREST, service role) — same pattern as operator-threads.ts
// ---------------------------------------------------------------------------

interface Supa { url: string; key: string }
function supaConfig(): Supa | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  return url && key ? { url, key } : null;
}

async function rest<T>(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const s = supaConfig();
  if (!s) return { ok: false, status: 0, error: 'supabase_not_configured' };
  try {
    const res = await fetch(`${s.url}/rest/v1/${path}`, {
      method: init.method || 'GET',
      headers: {
        apikey: s.key,
        Authorization: `Bearer ${s.key}`,
        'Content-Type': 'application/json',
        Prefer: init.prefer || (init.method && init.method !== 'GET' ? 'return=minimal' : 'return=representation'),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) return { ok: false, status: res.status, error: (await res.text().catch(() => '')).slice(0, 200) };
    if (res.status === 204) return { ok: true, status: 204 };
    const text = await res.text();
    return { ok: true, status: res.status, data: text ? (JSON.parse(text) as T) : undefined };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

const enc = encodeURIComponent;
export const KIRO_RUN_COLUMNS = 'id,thread_id,user_id,status,message,reply,stop_reason,kiro_model,workspace,error,pending_permission,cancel_requested_at,gateway_task,created_at,started_at,ended_at,last_heartbeat_at';

export interface KiroRunRow {
  id: string; thread_id: string; user_id: string; status: KiroRunStatus; message: string;
  reply: string | null; stop_reason: string | null; kiro_model: string | null; workspace: Record<string, unknown> | null;
  error: string | null; pending_permission: Record<string, unknown> | null; cancel_requested_at: string | null;
  gateway_task: string | null; created_at: string; started_at: string | null; ended_at: string | null; last_heartbeat_at: string | null;
}

// ---------------------------------------------------------------------------
// Event log: seq, coalescing, live pub/sub, batched inserts
// ---------------------------------------------------------------------------

export type KiroRunEventWriter = (rows: Array<{ run_id: string; seq: number; type: string; payload: Record<string, unknown>; created_at: string }>) => Promise<boolean>;

const writeEventsToStore: KiroRunEventWriter = async (rows) => {
  const r = await rest('kiro_run_events?on_conflict=run_id,seq', { method: 'POST', body: rows, prefer: 'resolution=ignore-duplicates,return=minimal' });
  if (!r.ok) console.error(`${LOG} kiro_run_events insert failed (${r.status}): ${r.error}`);
  return r.ok;
};

/**
 * One run's events. `seq` is assigned here before the live emit and the database
 * write. Message text is coalesced (one event per `coalesceMs` or `coalesceBytes`);
 * every other event first closes the open text, so order is kept.
 */
export class KiroRunEventLog {
  private seq = 0;
  private readonly listeners = new Set<KiroRunListener>();
  private text = '';
  private textTimer: NodeJS.Timeout | null = null;
  private pendingRows: Array<{ run_id: string; seq: number; type: string; payload: Record<string, unknown>; created_at: string }> = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** Every event of the run while it is live in this task (replay for a local listener). */
  readonly events: KiroRunEvent[] = [];
  /** Inserts sent to the store (for the volume check in tests). */
  inserts = 0;

  constructor(readonly runId: string, private readonly write: KiroRunEventWriter | null = writeEventsToStore, private readonly limits = KIRO_RUN_LIMITS) {}

  get lastSeq(): number { return this.seq; }

  subscribe(fn: KiroRunListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** A piece of the reply text; joined with its neighbours before it becomes an event. */
  appendText(text: string): void {
    if (!text) return;
    this.text += text;
    if (Buffer.byteLength(this.text, 'utf8') >= this.limits.coalesceBytes) { this.closeText(); return; }
    if (!this.textTimer) {
      this.textTimer = setTimeout(() => { this.textTimer = null; this.closeText(); }, this.limits.coalesceMs);
      this.textTimer.unref?.();
    }
  }

  /** Turn the open text (if any) into one `kiro.message_chunk` event. */
  closeText(): void {
    if (this.textTimer) { clearTimeout(this.textTimer); this.textTimer = null; }
    if (!this.text) return;
    const text = this.text;
    this.text = '';
    this.record('kiro.message_chunk', { text });
  }

  push(type: string, payload: Record<string, unknown>): KiroRunEvent {
    this.closeText();
    return this.record(type, payload);
  }

  private record(type: string, payload: Record<string, unknown>): KiroRunEvent {
    this.seq += 1;
    const ev: KiroRunEvent = { seq: this.seq, type, payload, created_at: new Date().toISOString() };
    this.events.push(ev);
    if (this.events.length > this.limits.memoryEvents) this.events.shift();
    for (const fn of [...this.listeners]) {
      try { fn(ev); } catch (err) { console.warn(`${LOG} run listener failed:`, err instanceof Error ? err.message : err); }
    }
    if (this.write) {
      this.pendingRows.push({ run_id: this.runId, seq: ev.seq, type, payload, created_at: ev.created_at });
      if (this.pendingRows.length >= this.limits.flushEvents) void this.flush();
      else if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, this.limits.flushMs);
        this.flushTimer.unref?.();
      }
    }
    return ev;
  }

  /** Write every buffered event (one bulk insert); inserts run one after another, in seq order. */
  flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.chain = this.chain.then(async () => {
      if (!this.write || this.pendingRows.length === 0) return;
      const rows = this.pendingRows;
      this.pendingRows = [];
      this.inserts += 1;
      const ok = await this.write(rows).catch(() => false);
      // Kept for the next flush, in order (bounded: the oldest are dropped past the memory cap).
      if (!ok) this.pendingRows = [...rows, ...this.pendingRows].slice(-this.limits.memoryEvents);
    });
    return this.chain;
  }

  /** Close the open text and write everything (terminal status, shutdown). */
  async drain(): Promise<void> {
    this.closeText();
    await this.flush();
  }

  dispose(): void {
    if (this.textTimer) clearTimeout(this.textTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.textTimer = null;
    this.flushTimer = null;
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * The run status for a finished turn. kiro_status ok → completed; refused and incomplete
 * keep their name; error, busy, not_connected, no_credits (and anything else) → failed.
 * A turn Kiro ended because it was cancelled is `cancelled`. A non-200 outcome is failed.
 */
export function runStatusForOutcome(outcome: KiroRunOutcome): KiroRunStatus {
  if (outcome.status !== 200) return 'failed';
  const meta = (outcome.body.meta ?? {}) as Record<string, unknown>;
  if (meta.stop_reason === 'cancelled') return 'cancelled';
  switch (meta.kiro_status) {
    case 'ok': return 'completed';
    case 'refused': return 'refused';
    case 'incomplete': return 'incomplete';
    default: return 'failed';
  }
}

/** The columns a finished run stores from its outcome. */
export function runFieldsForOutcome(outcome: KiroRunOutcome): Pick<KiroRunRow, 'reply' | 'stop_reason' | 'kiro_model' | 'workspace' | 'error'> {
  const body = outcome.body;
  const meta = (body.meta ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const workspace = meta.kiro_workspace || Array.isArray(meta.kiro_workspace_dirty)
    ? { ...(meta.kiro_workspace ? { kiro_workspace: meta.kiro_workspace } : {}), ...(Array.isArray(meta.kiro_workspace_dirty) ? { kiro_workspace_dirty: meta.kiro_workspace_dirty } : {}) }
    : null;
  const kiroStatus = str(meta.kiro_status);
  const error = outcome.status !== 200
    ? str(body.error) ?? `http_${outcome.status}`
    : kiroStatus && !['ok', 'refused', 'incomplete'].includes(kiroStatus) ? `${kiroStatus}${str(meta.error) ? `: ${str(meta.error)}` : ''}` : null;
  return { reply: str(body.reply), stop_reason: str(meta.stop_reason), kiro_model: str(meta.kiro_model), workspace, error: error ? error.slice(0, 500) : null };
}

// ---------------------------------------------------------------------------
// Runs owned by this task
// ---------------------------------------------------------------------------

interface LiveRun {
  id: string;
  threadId: string;
  userId: string | null;
  message: string;
  createdAt: string;
  turn: KiroRunTurn;
  status: KiroRunStatus;
  log: KiroRunEventLog;
  persisted: boolean;
  done: Promise<KiroRunOutcome>;
  resolve: (o: KiroRunOutcome) => void;
  pendingPerms: Map<string, Record<string, unknown>>;
  cancelRequested: boolean;
  finished: boolean;
  patchChain: Promise<unknown>;
}

const live = new Map<string, LiveRun>();
const threadLocks = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call for the same thread (start and pump never interleave). */
function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = threadLocks.get(threadId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  threadLocks.set(threadId, tail);
  void tail.then(() => { if (threadLocks.get(threadId) === tail) threadLocks.delete(threadId); });
  return next;
}

function localRunsOf(threadId: string): LiveRun[] {
  return [...live.values()].filter((r) => r.threadId === threadId && !r.finished).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function emitRunOasis(type: Extract<CicdEventType, 'operator.kiro.run_started' | 'operator.kiro.run_finished' | 'operator.kiro.run_interrupted'>, row: { id: string; thread_id: string; status: string; user_id?: string | null }): Promise<void> {
  const what = type === 'operator.kiro.run_started' ? 'started' : type === 'operator.kiro.run_finished' ? `finished (${row.status})` : 'interrupted';
  await emitOasisEvent({
    vtid: 'VTID-05065',
    type,
    source: 'gateway-operator',
    status: type === 'operator.kiro.run_interrupted' ? 'warning' : row.status === 'failed' ? 'error' : 'info',
    message: `Kiro run ${what}`,
    actor_id: row.user_id ?? undefined,
    actor_role: 'admin',
    surface: 'command-hub',
    payload: { run_id: row.id, thread_id: row.thread_id, status: row.status },
  }).catch(() => undefined);
}

/** A guarded update of this run's row: only while it is still unfinished. Serialized per run. */
function patchRun(run: LiveRun, body: Record<string, unknown>): Promise<unknown> {
  if (!run.persisted) return Promise.resolve();
  run.patchChain = run.patchChain.then(async () => {
    const r = await rest(`kiro_runs?id=eq.${enc(run.id)}&status=${ACTIVE_IN}`, { method: 'PATCH', body });
    if (!r.ok) console.error(`${LOG} kiro_runs update failed (${r.status}): ${r.error}`);
  });
  return run.patchChain;
}

function setStatus(run: LiveRun, status: KiroRunStatus, extra: Record<string, unknown> = {}): void {
  const changed = run.status !== status;
  run.status = status;
  if (changed) run.log.push('run.status', { status });
  void patchRun(run, { status, ...extra });
}

function onTurnEvent(run: LiveRun, e: KiroTurnEvent): void {
  if (run.finished) return;
  if (e.type === 'kiro.message_chunk') { run.log.appendText(e.text); return; }
  const { type, ...payload } = e;
  run.log.push(type, payload as Record<string, unknown>);
  if (e.type === 'kiro.permission_request') {
    const card = { request_id: e.request_id, tool_call_id: e.tool_call_id, title: e.title, kind: e.kind, expires_at: e.expires_at };
    run.pendingPerms.set(e.request_id, card);
    setStatus(run, 'waiting_permission', { pending_permission: card });
  } else if (e.type === 'kiro.permission_answer') {
    run.pendingPerms.delete(e.request_id);
    const next = [...run.pendingPerms.values()].pop();
    if (next) setStatus(run, 'waiting_permission', { pending_permission: next });
    else setStatus(run, 'running', { pending_permission: null });
  }
}

async function execute(run: LiveRun): Promise<void> {
  let outcome: KiroRunOutcome;
  try {
    if (!executor) throw new Error('kiro run executor not registered');
    outcome = await executor({ ...run.turn, threadId: run.threadId, userId: run.userId, message: run.message, emit: (e) => onTurnEvent(run, e) });
  } catch (err) {
    console.error(`${LOG} kiro run ${run.id} failed:`, err instanceof Error ? err.message : err);
    outcome = { status: 500, body: { ok: false, error: 'Internal server error', details: err instanceof Error ? err.message : String(err) } };
  }
  await finish(run, runStatusForOutcome(outcome), outcome);
}

async function finish(run: LiveRun, status: KiroRunStatus, outcome: KiroRunOutcome): Promise<void> {
  if (run.finished) { run.resolve(outcome); return; }
  run.finished = true;
  run.log.closeText();
  const fields = runFieldsForOutcome(outcome);
  run.status = status;
  // VTID-05070: events another task left for this run (a screenshot) land before the end.
  if (run.persisted) await drainKiroRunInbox([run]);
  await patchRun(run, { status, ...fields, pending_permission: null, ended_at: new Date().toISOString() });
  run.log.push('run.status', { status, ...(fields.stop_reason ? { stop_reason: fields.stop_reason } : {}), ...(fields.error ? { error: fields.error } : {}) });
  await run.log.drain();
  live.delete(run.id);
  run.log.dispose();
  run.resolve(outcome);
  if (run.persisted) await emitRunOasis('operator.kiro.run_finished', { id: run.id, thread_id: run.threadId, status, user_id: run.userId });
  await pumpThread(run.threadId);
}

/** A run whose row another task (or the sweep) already ended: stop it here without writing. */
function endedElsewhere(run: LiveRun, status: KiroRunStatus): void {
  if (run.finished) return;
  run.finished = true;
  run.status = status;
  run.log.push('run.status', { status });
  void run.log.drain().then(() => run.log.dispose());
  live.delete(run.id);
  run.resolve({ status: 409, body: { ok: false, error: status === 'cancelled' ? 'kiro_run_cancelled' : 'kiro_run_interrupted', run_id: run.id } });
}

async function beginRunning(run: LiveRun): Promise<void> {
  run.status = 'running';
  run.log.push('run.status', { status: 'running' });
  if (run.persisted) await emitRunOasis('operator.kiro.run_started', { id: run.id, thread_id: run.threadId, status: 'running', user_id: run.userId });
  void execute(run);
}

/** Start the oldest queued run of the thread this task owns, when nothing else runs there. */
export function pumpThread(threadId: string): Promise<void> {
  return withThreadLock(threadId, async () => {
    for (;;) {
      const mine = localRunsOf(threadId);
      const queued = mine.filter((r) => r.status === 'queued');
      if (queued.length === 0) return;
      if (mine.some((r) => r.status !== 'queued')) return;
      const next = queued[0];
      if (next.persisted) {
        const act = await rest<Array<{ id: string; status: string }>>(`kiro_runs?thread_id=eq.${enc(threadId)}&status=${ACTIVE_IN}&select=id,status&order=created_at.asc`);
        if (act.ok && act.data) {
          if (act.data.some((r) => r.status !== 'queued' && !live.has(r.id))) return; // another task's run is still going
          const oldest = act.data.find((r) => r.status === 'queued');
          if (oldest && oldest.id !== next.id && !live.has(oldest.id)) return; // another task's queued run goes first
        }
        const now = new Date().toISOString();
        const claim = await rest<Array<{ id: string }>>(`kiro_runs?id=eq.${enc(next.id)}&status=eq.queued&select=id`, {
          method: 'PATCH', body: { status: 'running', started_at: now, last_heartbeat_at: now }, prefer: 'return=representation',
        });
        if (claim.ok && Array.isArray(claim.data) && claim.data.length === 0) { endedElsewhere(next, 'cancelled'); continue; }
      }
      await beginRunning(next);
      return;
    }
  });
}

export type StartKiroRunResult =
  | { ok: true; run_id: string; status: 'running' | 'queued'; done: Promise<KiroRunOutcome> }
  | { ok: false; error: 'queue_full' | 'store_unavailable' | 'executor_missing' };

/**
 * Start a run for the thread (or queue it behind the thread's current run) and return at
 * once. `listener` is attached before the first event. With `requirePersisted` the run is
 * refused when its row cannot be written (the run routes); without it (the old /chat path)
 * the turn still runs, unrecorded as a run, and the failure is logged.
 */
export function startKiroRun(input: {
  threadId: string; userId: string | null; message: string; turn: KiroRunTurn;
  listener?: KiroRunListener; requirePersisted?: boolean;
}): Promise<StartKiroRunResult> {
  if (!executor) return Promise.resolve({ ok: false, error: 'executor_missing' });
  return withThreadLock(input.threadId, async (): Promise<StartKiroRunResult> => {
    const mine = localRunsOf(input.threadId);
    const act = await rest<Array<{ id: string; status: string }>>(`kiro_runs?thread_id=eq.${enc(input.threadId)}&status=${ACTIVE_IN}&select=id,status`);
    const statuses = new Map<string, string>(mine.map((r) => [r.id, r.status]));
    if (act.ok && act.data) for (const r of act.data) if (!statuses.has(r.id)) statuses.set(r.id, r.status);
    const queuedCount = [...statuses.values()].filter((s) => s === 'queued').length;
    const busy = statuses.size > 0;
    if (busy && queuedCount >= KIRO_RUN_LIMITS.maxQueuedPerThread) return { ok: false, error: 'queue_full' };
    const status: 'running' | 'queued' = busy ? 'queued' : 'running';
    const id = randomUUID();
    const now = new Date().toISOString();
    const ins = await rest('kiro_runs', {
      method: 'POST',
      body: {
        id, thread_id: input.threadId, user_id: input.userId ?? '', status, message: input.message,
        gateway_task: GATEWAY_TASK_ID, created_at: now, last_heartbeat_at: now, ...(status === 'running' ? { started_at: now } : {}),
      },
    });
    if (!ins.ok) {
      console.error(`${LOG} kiro_runs insert failed (${ins.status}): ${ins.error}`);
      if (input.requirePersisted) return { ok: false, error: 'store_unavailable' };
    }
    let resolve!: (o: KiroRunOutcome) => void;
    const done = new Promise<KiroRunOutcome>((r) => { resolve = r; });
    const run: LiveRun = {
      id, threadId: input.threadId, userId: input.userId, message: input.message, createdAt: now, turn: input.turn,
      status: 'queued', log: new KiroRunEventLog(id, ins.ok ? writeEventsToStore : null), persisted: ins.ok,
      done, resolve, pendingPerms: new Map(), cancelRequested: false, finished: false, patchChain: Promise.resolve(),
    };
    if (input.listener) run.log.subscribe(input.listener);
    live.set(id, run);
    if (status === 'running') await beginRunning(run);
    else run.log.push('run.status', { status: 'queued' });
    return { ok: true, run_id: id, status, done };
  });
}

// ---------------------------------------------------------------------------
// Reads, cancel, permissions
// ---------------------------------------------------------------------------

function localRow(run: LiveRun): KiroRunRow {
  return {
    id: run.id, thread_id: run.threadId, user_id: run.userId ?? '', status: run.status, message: run.message, reply: null, stop_reason: null,
    kiro_model: null, workspace: null, error: null, pending_permission: [...run.pendingPerms.values()].pop() ?? null, cancel_requested_at: null,
    gateway_task: GATEWAY_TASK_ID, created_at: run.createdAt, started_at: null, ended_at: null, last_heartbeat_at: null,
  };
}

export async function getKiroRun(runId: string): Promise<KiroRunRow | null> {
  const r = await rest<KiroRunRow[]>(`kiro_runs?id=eq.${enc(runId)}&select=${KIRO_RUN_COLUMNS}&limit=1`);
  if (r.ok && r.data && r.data[0]) return r.data[0];
  const l = live.get(runId);
  return l ? localRow(l) : null;
}

/** The caller's latest runs of one thread, newest first. */
export async function listKiroRuns(threadId: string, userId: string, limit = KIRO_RUN_LIMITS.listLimit): Promise<KiroRunRow[] | null> {
  const r = await rest<KiroRunRow[]>(`kiro_runs?thread_id=eq.${enc(threadId)}&user_id=eq.${enc(userId)}&select=${KIRO_RUN_COLUMNS}&order=created_at.desc&limit=${limit}`);
  return r.ok ? (r.data ?? []) : null;
}

/** Who owns a thread, from the thread row and the thread's runs. Null fields = unknown. */
export async function kiroThreadOwnership(threadId: string): Promise<{ owner: string | null; engine: string | null; otherRunOwners: string[] }> {
  const t = await rest<Array<{ user_id: string | null; engine: string | null }>>(`operator_threads?id=eq.${enc(threadId)}&select=user_id,engine&limit=1`);
  const runs = await rest<Array<{ user_id: string }>>(`kiro_runs?thread_id=eq.${enc(threadId)}&select=user_id&limit=50`);
  const row = t.ok && t.data ? t.data[0] : undefined;
  return {
    owner: row?.user_id ?? null,
    engine: row ? (row.engine ?? 'llm') : null,
    otherRunOwners: runs.ok && runs.data ? [...new Set(runs.data.map((r) => r.user_id))] : [],
  };
}

export type CancelKiroRunResult = { ok: true; status: KiroRunStatus | 'cancelling' } | { ok: false; error: 'not_found' | 'forbidden' | 'not_active' };

/** Owner only. Queued → cancelled now; running → Kiro's own cancel (the run ends `cancelled`). */
export async function cancelKiroRun(runId: string, userId: string | null): Promise<CancelKiroRunResult> {
  const l = live.get(runId);
  if (l && !l.finished) {
    if (l.userId !== userId) return { ok: false, error: 'forbidden' };
    if (l.status === 'queued') {
      await finish(l, 'cancelled', { status: 409, body: { ok: false, error: 'kiro_run_cancelled', run_id: l.id } });
      return { ok: true, status: 'cancelled' };
    }
    l.cancelRequested = true;
    cancelKiroTurn(l.threadId, l.userId);
    return { ok: true, status: 'cancelling' };
  }
  const row = await getKiroRun(runId);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.user_id !== userId) return { ok: false, error: 'forbidden' };
  if (isTerminalRunStatus(row.status)) return { ok: false, error: 'not_active' };
  const now = new Date().toISOString();
  if (row.status === 'queued') {
    const r = await rest<Array<{ id: string }>>(`kiro_runs?id=eq.${enc(runId)}&status=eq.queued&select=id`, {
      method: 'PATCH', body: { status: 'cancelled', ended_at: now }, prefer: 'return=representation',
    });
    if (r.ok && r.data && r.data.length > 0) {
      await emitRunOasis('operator.kiro.run_finished', { id: row.id, thread_id: row.thread_id, status: 'cancelled', user_id: row.user_id });
      return { ok: true, status: 'cancelled' };
    }
    return { ok: false, error: 'not_active' };
  }
  // Running on another gateway task: that task's control tick sends Kiro's cancel.
  const r = await rest(`kiro_runs?id=eq.${enc(runId)}&status=${ACTIVE_IN}`, { method: 'PATCH', body: { cancel_requested_at: now } });
  return r.ok ? { ok: true, status: 'cancelling' } : { ok: false, error: 'not_found' };
}

/**
 * VTID-05065: answer an approval card that is not waiting in THIS task (the run lives on
 * another gateway task): the answer is written onto the run's pending card and the owning
 * task's control tick hands it to Kiro. Owner only.
 */
export async function answerPersistedPermission(requestId: string, userId: string | null, allow: boolean): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'forbidden' }> {
  const r = await rest<Array<{ id: string; user_id: string; pending_permission: Record<string, unknown> | null }>>(
    `kiro_runs?pending_permission->>request_id=eq.${enc(requestId)}&status=eq.waiting_permission&select=id,user_id,pending_permission&limit=1`);
  const row = r.ok && r.data ? r.data[0] : undefined;
  if (!row || !row.pending_permission) return { ok: false, error: 'not_found' };
  if (row.user_id !== userId) return { ok: false, error: 'forbidden' };
  const u = await rest<Array<{ id: string }>>(`kiro_runs?id=eq.${enc(row.id)}&pending_permission->>request_id=eq.${enc(requestId)}&select=id`, {
    method: 'PATCH', body: { pending_permission: { ...row.pending_permission, answer: { allow, at: new Date().toISOString() } } }, prefer: 'return=representation',
  });
  return u.ok && u.data && u.data.length > 0 ? { ok: true } : { ok: false, error: 'not_found' };
}

// ---------------------------------------------------------------------------
// Following a run: replay after `after_seq`, then live, no gap, no duplicate
// ---------------------------------------------------------------------------

function isTerminalEvent(ev: { type: string; payload: Record<string, unknown> }): boolean {
  return ev.type === 'run.status' && isTerminalRunStatus(ev.payload.status);
}

async function storedEvents(runId: string, afterSeq: number): Promise<KiroRunEvent[]> {
  const out: KiroRunEvent[] = [];
  let after = afterSeq;
  for (;;) {
    const r = await rest<KiroRunEvent[]>(`kiro_run_events?run_id=eq.${enc(runId)}&seq=gt.${after}&select=seq,type,payload,created_at&order=seq.asc&limit=500`);
    if (!r.ok || !r.data || r.data.length === 0) return out;
    out.push(...r.data);
    after = r.data[r.data.length - 1].seq;
    if (r.data.length < 500) return out;
  }
}

/**
 * Deliver the run's events after `afterSeq`, in seq order, each once, until a terminal
 * status event (or `isClosed()`). A run live in this task: subscribe first, replay the
 * store, then this task's in-memory log (which holds every event emitted while the store
 * replay was in flight, so nothing needs a separate buffer), then live — the switch from
 * the log to live is synchronous, so no event falls between them, and `seq <= lastSent`
 * drops anything seen twice. A run on another task (or already finished): replay the
 * store, then poll it.
 */
export async function followKiroRun(runId: string, afterSeq: number, onEvent: KiroRunListener, isClosed: () => boolean): Promise<void> {
  let lastSent = afterSeq;
  let ended = false;
  let wake: (() => void) | null = null;
  const send = (ev: KiroRunEvent): void => {
    if (ended || isClosed() || ev.seq <= lastSent) return;
    lastSent = ev.seq;
    onEvent(ev);
    if (isTerminalEvent(ev)) { ended = true; wake?.(); }
  };
  const run = live.get(runId);
  let replaying = true;
  // Events emitted while replaying are in run.log.events, sent right after the store replay.
  const unsubscribe = run && !run.finished
    ? run.log.subscribe((ev) => { if (!replaying) send(ev); })
    : null;
  try {
    for (const ev of await storedEvents(runId, lastSent)) send(ev);
    if (unsubscribe && run) {
      for (const ev of [...run.log.events]) send(ev);
      replaying = false;
      while (!ended && !isClosed()) {
        await new Promise<void>((r) => {
          wake = r;
          const t = setTimeout(r, KIRO_RUN_LIMITS.streamPollMs);
          t.unref?.();
        });
        wake = null;
      }
      return;
    }
    while (!ended && !isClosed()) {
      const row = await rest<Array<{ status: string }>>(`kiro_runs?id=eq.${enc(runId)}&select=status&limit=1`);
      const status = row.ok && row.data && row.data[0] ? row.data[0].status : null;
      for (const ev of await storedEvents(runId, lastSent)) send(ev);
      if (ended || isClosed()) return;
      if (status === null || isTerminalRunStatus(status)) {
        // Ended without a stored terminal event (the sweep, or a lost write): say how it ended.
        if (!ended) { ended = true; onEvent({ seq: lastSent, type: 'run.status', payload: { status: status ?? 'interrupted' }, created_at: new Date().toISOString() }); }
        return;
      }
      await new Promise<void>((r) => { const t = setTimeout(r, KIRO_RUN_LIMITS.streamPollMs); t.unref?.(); });
    }
  } finally {
    unsubscribe?.();
  }
}

// ---------------------------------------------------------------------------
// VTID-05070: events from outside the turn (a Kiro screenshot stored by the media route)
// ---------------------------------------------------------------------------

/** At most this many screenshots (`kiro.image` events) per run. */
export const KIRO_RUN_SCREENSHOT_LIMIT = 10;
/**
 * An event for a run another gateway task owns is written as an INBOX row: the same table,
 * type `<type>.inbox`, a NEGATIVE seq (never replayed: streams read seq > after_seq >= 0).
 * The owning task's control tick (every 2 s) and its finish() re-emit inbox rows as real
 * events in seq order, flush them, then delete the inbox rows. No schema change.
 */
const INBOX = '.inbox';

/** The user's current (running or waiting) run of the thread: this task's first, else the store's. */
export async function activeKiroRunFor(threadId: string, userId: string): Promise<{ id: string; local: boolean } | null> {
  const l = localRunsOf(threadId).find((r) => r.userId === userId && r.status !== 'queued');
  if (l) return { id: l.id, local: true };
  const r = await rest<Array<{ id: string }>>(
    `kiro_runs?thread_id=eq.${enc(threadId)}&user_id=eq.${enc(userId)}&status=in.(running,waiting_permission)&select=id&order=created_at.desc&limit=1`);
  return r.ok && r.data && r.data[0] ? { id: r.data[0].id, local: false } : null;
}

/** How many `type` events the run has: this task's log plus the store (stored rows and inbox rows). Null = unknown. */
export async function countKiroRunEvents(runId: string, type: string): Promise<number | null> {
  const l = live.get(runId);
  if (l && !l.persisted) return l.log.events.filter((e) => e.type === type).length;
  const types = l ? `eq.${type}${INBOX}` : `in.(${type},${type}${INBOX})`;
  const r = await rest<Array<{ seq: number }>>(`kiro_run_events?run_id=eq.${enc(runId)}&type=${types}&select=seq&limit=1000`);
  if (!r.ok) return null;
  return (r.data ?? []).length + (l ? l.log.events.filter((e) => e.type === type).length : 0);
}

/** Append one event to a run: in order right here when this task owns it, else through the inbox. */
export async function appendKiroRunEvent(runId: string, type: string, payload: Record<string, unknown>): Promise<{ ok: true; via: 'local' | 'inbox'; seq: number | null } | { ok: false; error: string }> {
  const l = live.get(runId);
  if (l && !l.finished) {
    const ev = l.log.push(type, payload);
    return { ok: true, via: 'local', seq: ev.seq };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const seq = -(1 + randomInt(2 ** 31 - 2));
    const r = await rest('kiro_run_events', { method: 'POST', body: { run_id: runId, seq, type: `${type}${INBOX}`, payload, created_at: new Date().toISOString() } });
    if (r.ok) return { ok: true, via: 'inbox', seq: null };
    if (r.status !== 409) return { ok: false, error: r.error ?? `store_${r.status}` };
  }
  return { ok: false, error: 'inbox_conflict' };
}

/** Re-emit the inbox rows of these (owned, persisted) runs as real events, then remove them. */
async function drainKiroRunInbox(runs: LiveRun[]): Promise<number> {
  const owned = runs.filter((r) => r.persisted);
  if (owned.length === 0) return 0;
  const r = await rest<Array<{ run_id: string; seq: number; type: string; payload: Record<string, unknown> | null; created_at: string }>>(
    `kiro_run_events?run_id=in.(${owned.map((x) => x.id).join(',')})&seq=lt.0&select=run_id,seq,type,payload,created_at&order=created_at.asc&limit=100`);
  if (!r.ok || !r.data || r.data.length === 0) return 0;
  const done = new Map<string, number[]>();
  for (const row of r.data) {
    const run = live.get(row.run_id);
    if (!run || !row.type.endsWith(INBOX)) continue;
    run.log.push(row.type.slice(0, -INBOX.length), row.payload ?? {});
    done.set(row.run_id, [...(done.get(row.run_id) ?? []), row.seq]);
  }
  for (const [runId, seqs] of done) {
    await live.get(runId)?.log.flush();
    const d = await rest(`kiro_run_events?run_id=eq.${enc(runId)}&seq=in.(${seqs.join(',')})`, { method: 'DELETE' });
    if (!d.ok) console.error(`${LOG} kiro_run_events inbox delete failed (${d.status}): ${d.error}`);
  }
  return [...done.values()].reduce((n, s) => n + s.length, 0);
}

// ---------------------------------------------------------------------------
// Liveness: heartbeat, control tick, sweep, shutdown
// ---------------------------------------------------------------------------

/** ONE update: refresh last_heartbeat_at on this task's unfinished runs. */
export async function kiroRunsHeartbeatTick(): Promise<boolean> {
  if (![...live.values()].some((r) => r.persisted && !r.finished)) return false;
  const r = await rest(`kiro_runs?gateway_task=eq.${enc(GATEWAY_TASK_ID)}&status=${ACTIVE_IN}`, { method: 'PATCH', body: { last_heartbeat_at: new Date().toISOString() } });
  if (!r.ok) console.error(`${LOG} kiro_runs heartbeat failed (${r.status}): ${r.error}`);
  return r.ok;
}

/**
 * What another gateway task wrote onto this task's runs: a cancel, an approval answer,
 * a queued run cancelled, a run the sweep ended. Then start queued runs whose turn it is.
 */
export async function kiroRunsControlTick(): Promise<void> {
  const mine = [...live.values()].filter((r) => r.persisted && !r.finished);
  if (mine.length === 0) return;
  const r = await rest<Array<{ id: string; status: KiroRunStatus; cancel_requested_at: string | null; pending_permission: Record<string, any> | null }>>(
    `kiro_runs?id=in.(${mine.map((x) => x.id).join(',')})&select=id,status,cancel_requested_at,pending_permission`);
  if (!r.ok || !r.data) return;
  for (const run of mine) {
    const row = r.data.find((x) => x.id === run.id);
    if (!row || run.finished) continue;
    if (isTerminalRunStatus(row.status)) { endedElsewhere(run, row.status); continue; }
    if (row.cancel_requested_at && !run.cancelRequested && run.status !== 'queued') {
      run.cancelRequested = true;
      cancelKiroTurn(run.threadId, run.userId);
    }
    const answer = row.pending_permission?.answer;
    const reqId = row.pending_permission?.request_id;
    if (answer && typeof reqId === 'string' && run.pendingPerms.has(reqId)) answerPermission(reqId, run.userId, answer.allow === true);
  }
  // VTID-05070: events another gateway task left for these runs (screenshots stored there).
  await drainKiroRunInbox(mine.filter((x) => !x.finished));
  for (const threadId of new Set(mine.filter((x) => x.status === 'queued').map((x) => x.threadId))) await pumpThread(threadId);
}

/**
 * Other tasks' unfinished runs whose heartbeat is older than `staleMs` → interrupted.
 * Guarded (unfinished statuses only, stale heartbeat), so a second sweep changes nothing;
 * one OASIS event per row this UPDATE changed.
 */
export async function sweepStaleKiroRuns(now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - KIRO_RUN_LIMITS.staleMs).toISOString();
  const r = await rest<Array<{ id: string; thread_id: string; user_id: string }>>(
    `kiro_runs?status=${ACTIVE_IN}&last_heartbeat_at=lt.${enc(cutoff)}&gateway_task=neq.${enc(GATEWAY_TASK_ID)}&select=id,thread_id,user_id`,
    { method: 'PATCH', body: { status: 'interrupted', ended_at: new Date(now).toISOString(), pending_permission: null, error: 'gateway_task_lost' }, prefer: 'return=representation' },
  );
  if (!r.ok) { console.error(`${LOG} kiro_runs sweep failed (${r.status}): ${r.error}`); return 0; }
  const rows = r.data ?? [];
  for (const row of rows) await emitRunOasis('operator.kiro.run_interrupted', { id: row.id, thread_id: row.thread_id, status: 'interrupted', user_id: row.user_id });
  return rows.length;
}

/**
 * Graceful-shutdown drain hook (index.ts appends it to the existing drainHooks): close and
 * write every open run's events, mark this task's unfinished runs interrupted, one OASIS
 * event per row changed. Bounded by `boundMs` (3 s inside the shared 5 s drain).
 */
export async function drainKiroRunsForShutdown(boundMs: number = KIRO_RUN_LIMITS.shutdownMs): Promise<{ interrupted: number; timedOut: boolean }> {
  stopKiroRunTimers();
  let interrupted = 0;
  const work = (async () => {
    const mine = [...live.values()].filter((r) => !r.finished);
    for (const run of mine) {
      run.finished = true;
      run.status = 'interrupted';
      run.log.push('run.status', { status: 'interrupted' });
    }
    await Promise.all(mine.map((run) => run.log.drain().catch(() => undefined)));
    if (mine.some((run) => run.persisted)) {
      const r = await rest<Array<{ id: string; thread_id: string; user_id: string }>>(
        `kiro_runs?gateway_task=eq.${enc(GATEWAY_TASK_ID)}&status=${ACTIVE_IN}&select=id,thread_id,user_id`,
        { method: 'PATCH', body: { status: 'interrupted', ended_at: new Date().toISOString(), pending_permission: null, error: 'gateway_shutdown' }, prefer: 'return=representation' },
      );
      if (!r.ok) console.error(`${LOG} kiro_runs shutdown update failed (${r.status}): ${r.error}`);
      for (const row of r.data ?? []) {
        interrupted += 1;
        await emitRunOasis('operator.kiro.run_interrupted', { id: row.id, thread_id: row.thread_id, status: 'interrupted', user_id: row.user_id });
      }
    }
    for (const run of mine) {
      live.delete(run.id);
      run.log.dispose();
      run.resolve({ status: 503, body: { ok: false, error: 'kiro_run_interrupted', run_id: run.id } });
    }
  })();
  let timer: NodeJS.Timeout | null = null;
  const bound = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), Math.max(0, boundMs)); timer.unref?.(); });
  const res = await Promise.race([work.then(() => 'done' as const), bound]);
  if (timer) clearTimeout(timer);
  return { interrupted, timedOut: res === 'timeout' };
}

let timers: NodeJS.Timeout[] = [];

/** Boot: sweep once, then heartbeat (30 s), sweep (60 s) and the control tick (2 s). All unref'd. */
export function startKiroRunTimers(): void {
  if (timers.length) return;
  void sweepStaleKiroRuns().catch(() => undefined);
  const every = (ms: number, fn: () => Promise<unknown>) => {
    let busy = false;
    const t = setInterval(() => {
      if (busy) return;
      busy = true;
      fn().catch((err) => console.warn(`${LOG} timer failed:`, err instanceof Error ? err.message : err)).finally(() => { busy = false; });
    }, ms);
    t.unref?.();
    timers.push(t);
  };
  every(KIRO_RUN_LIMITS.heartbeatMs, kiroRunsHeartbeatTick);
  every(KIRO_RUN_LIMITS.sweepMs, () => sweepStaleKiroRuns());
  every(KIRO_RUN_LIMITS.controlMs, kiroRunsControlTick);
}

export function stopKiroRunTimers(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}

/** Tests: this task's live runs and their in-memory state. */
export function liveKiroRunIds(): string[] { return [...live.keys()]; }
export function liveKiroRunInserts(runId: string): number | null { return live.get(runId)?.log.inserts ?? null; }
export function resetKiroRunsForTests(): void {
  stopKiroRunTimers();
  for (const r of live.values()) r.log.dispose();
  live.clear();
  threadLocks.clear();
}
