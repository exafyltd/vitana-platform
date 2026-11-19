/**
 * Delivery loop: the ledger. Everything the loop knows and everything it has done is a row in OASIS (`oasis_events`), so the loop
 * keeps no state of its own and a restart, a second gateway task or a crash in the middle of a cycle loses nothing.
 *
 *   record  one idempotent write: the same key is one row, and a repeat answers `duplicate: true` (see emitOasisEvent).
 *   read    the rows of some topics after a keyset cursor (created_at, id), oldest first: how the loop observes.
 *   find    the newest rows of one topic whose metadata matches: how the loop counts attempts and finds open work.
 *
 * Rows are scoped to this gateway's environment (`metadata.env`): staging and production share the table and each reads only its own.
 * The loop never writes status `error` (the lifecycle mapper's `*.failed` catch-all would move a VTID to failed); a failure is `warning`.
 */
import { VITANA_ENV } from '../../env';
import { emitOasisEvent, idempotentEventId } from '../oasis-event-service';
import { DELIVERY_VTID } from '../delivery-host';
import type { CicdEventType } from '../../types/cicd';
import type { Cursor, LedgerEvent } from './facts';

export const LOOP_SOURCE = 'delivery-loop';

export interface LoopEvent {
  type: CicdEventType;
  vtid?: string;
  /** Never `error`. */
  status: 'info' | 'success' | 'warning';
  message: string;
  payload: Record<string, unknown>;
  /** The idempotency key: the same fact is one row. */
  key: string;
}

export type RecordResult = { ok: true; duplicate: boolean; event_id?: string } | { ok: false; error: string };
export type ReadResult = { ok: true; events: LedgerEvent[] } | { ok: false; error: string };

export type MetaValue = string | number | boolean;

export interface Ledger {
  record(e: LoopEvent): Promise<RecordResult>;
  read(q: { topics: readonly string[]; after: Cursor | null; limit: number }): Promise<ReadResult>;
  find(q: { topic: string; where?: Readonly<Record<string, MetaValue>>; since?: string; limit?: number }): Promise<ReadResult>;
}

/** The metadata of a loop row: the payload, the delivery markers, and the key. */
export function metadataOf(e: LoopEvent): Record<string, unknown> {
  // A fact the poller writes in place of a missed webhook keeps its own `host` (gitlab); every other loop row is host `loop`.
  return { plane: 'delivery', host: 'loop', ...e.payload, dedupe_key: e.key };
}

const META_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const safeStatus = (s: string): 'info' | 'success' | 'warning' => (s === 'success' || s === 'warning' ? s : s === 'error' ? 'warning' : 'info');

// ---------------------------------------------------------------------------------------------------------
// OASIS
// ---------------------------------------------------------------------------------------------------------

export interface OasisLedgerOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** The environment whose rows are read; default this gateway's VITANA_ENV. */
  scope?: 'staging' | 'production';
  timeoutMs?: number;
  emit?: typeof emitOasisEvent;
}

const SELECT = 'id,created_at,vtid,topic,status,message,metadata';

export function createOasisLedger(options: OasisLedgerOptions = {}): Ledger {
  const scope = options.scope ?? VITANA_ENV;
  const doFetch = options.fetch ?? fetch;
  const emit = options.emit ?? emitOasisEvent;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function get(query: string): Promise<ReadResult> {
    const env = options.env ?? process.env;
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE;
    if (!url || !key) return { ok: false, error: 'oasis_not_configured' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await doFetch(`${url}/rest/v1/oasis_events?select=${SELECT}&${query}`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: controller.signal });
      if (!r.ok) return { ok: false, error: `oasis_read_${r.status}` };
      const rows = await r.json();
      if (!Array.isArray(rows)) return { ok: false, error: 'oasis_bad_response' };
      return { ok: true, events: rows.map(toLedgerEvent).filter((x): x is LedgerEvent => x !== null) };
    } catch (e) {
      return { ok: false, error: e instanceof Error && e.name === 'AbortError' ? 'oasis_timeout' : 'oasis_unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  const scopeFilter = `metadata->>env=eq.${scope}`;

  return {
    async record(e) {
      const status = safeStatus(e.status);
      const r = await emit({
        vtid: e.vtid ?? DELIVERY_VTID,
        type: e.type,
        source: LOOP_SOURCE,
        status,
        message: e.message.slice(0, 500),
        payload: metadataOf(e),
        idempotency_key: e.key,
        env: scope,
      });
      return r.ok ? { ok: true, duplicate: r.duplicate === true, event_id: r.event_id } : { ok: false, error: r.error ?? 'emit_failed' };
    },

    read({ topics, after, limit }) {
      const names = topics.filter((t) => /^[a-z0-9_.]+$/.test(t));
      if (names.length === 0) return Promise.resolve({ ok: true, events: [] });
      let q = `topic=in.(${names.join(',')})&${scopeFilter}&order=created_at.asc,id.asc&limit=${Math.max(1, Math.min(limit, 500))}`;
      if (after) {
        const t = after.created_at;
        const id = after.id;
        // Keyset: strictly after (created_at, id). `created_at=gt` alone would skip rows that share a timestamp.
        q += `&or=${encodeURIComponent(`(created_at.gt.${t},and(created_at.eq.${t},id.gt.${id}))`)}`;
      }
      return get(q);
    },

    find({ topic, where = {}, since, limit = 50 }) {
      if (!/^[a-z0-9_.]+$/.test(topic)) return Promise.resolve({ ok: false, error: 'bad_topic' });
      let q = `topic=eq.${topic}&${scopeFilter}&order=created_at.desc,id.desc&limit=${Math.max(1, Math.min(limit, 500))}`;
      for (const [k, v] of Object.entries(where)) {
        if (!META_KEY_RE.test(k)) return Promise.resolve({ ok: false, error: 'bad_metadata_key' });
        q += `&metadata->>${k}=eq.${encodeURIComponent(String(v))}`;
      }
      if (since) q += `&created_at=gte.${encodeURIComponent(since)}`;
      return get(q);
    },
  };
}

function toLedgerEvent(row: unknown): LedgerEvent | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.created_at !== 'string' || typeof r.topic !== 'string') return null;
  return {
    id: r.id,
    created_at: r.created_at,
    vtid: typeof r.vtid === 'string' ? r.vtid : null,
    topic: r.topic,
    status: typeof r.status === 'string' ? r.status : null,
    message: typeof r.message === 'string' ? r.message : null,
    metadata: typeof r.metadata === 'object' && r.metadata !== null && !Array.isArray(r.metadata) ? (r.metadata as Record<string, unknown>) : {},
  };
}

// ---------------------------------------------------------------------------------------------------------
// In memory: the same contract, for tests and the rehearsal harness
// ---------------------------------------------------------------------------------------------------------

/**
 * A ledger held in memory that behaves as OASIS does for the loop: an idempotent record (same env, topic and key is one row), a
 * keyset read, and a metadata match. `now` is the clock that stamps rows; `env` the scope.
 */
export class MemoryLedger implements Ledger {
  readonly rows: LedgerEvent[] = [];
  private readonly keys = new Map<string, LedgerEvent>();
  /** Set to make the next `n` calls of a method fail (a database that is down). */
  failNext: { record: number; read: number; find: number } = { record: 0, read: 0, find: 0 };
  private seq = 0;

  constructor(private readonly options: { now?: () => number; env?: string } = {}) {}

  /** Strictly increasing: a row inserted later never sorts before one inserted earlier, whatever the clock says. */
  private nowIso(): string {
    this.seq += 1;
    const base = this.options.now ? this.options.now() : Date.parse('2026-11-18T10:00:00.000Z');
    return new Date(base + this.seq).toISOString();
  }

  /** The row of an event as emitOasisEvent writes it. Used for the facts the webhook stage writes and for the loop's own events. */
  insert(e: { vtid?: string; type: string; status?: string; message?: string; payload: Record<string, unknown>; key?: string; created_at?: string }): { row: LedgerEvent; duplicate: boolean } {
    const scope = this.options.env ?? 'staging';
    const key = e.key ?? (typeof e.payload.dedupe_key === 'string' ? e.payload.dedupe_key : undefined);
    const id = key ? idempotentEventId(scope, e.type, key) : `mem-${this.rows.length + 1}-${Math.random().toString(16).slice(2, 10)}`;
    const existing = key ? this.keys.get(id) : undefined;
    if (existing) return { row: existing, duplicate: true };
    const row: LedgerEvent = {
      id,
      created_at: e.created_at ?? this.nowIso(),
      vtid: e.vtid ?? DELIVERY_VTID,
      topic: e.type,
      status: e.status ?? 'info',
      message: e.message ?? e.type,
      metadata: { ...e.payload, env: scope },
    };
    this.rows.push(row);
    if (key) this.keys.set(id, row);
    return { row, duplicate: false };
  }

  async record(e: LoopEvent): Promise<RecordResult> {
    if (this.failNext.record > 0) {
      this.failNext.record -= 1;
      return { ok: false, error: 'oasis_unreachable' };
    }
    const { row, duplicate } = this.insert({ vtid: e.vtid, type: e.type, status: safeStatus(e.status), message: e.message, payload: metadataOf(e), key: e.key });
    return { ok: true, duplicate, event_id: row.id };
  }

  async read({ topics, after, limit }: { topics: readonly string[]; after: Cursor | null; limit: number }): Promise<ReadResult> {
    if (this.failNext.read > 0) {
      this.failNext.read -= 1;
      return { ok: false, error: 'oasis_unreachable' };
    }
    const want = new Set(topics);
    const ordered = this.rows.filter((r) => want.has(r.topic)).sort(compareRows);
    const rest = after ? ordered.filter((r) => compareRows(r, { created_at: after.created_at, id: after.id }) > 0) : ordered;
    return { ok: true, events: rest.slice(0, Math.max(1, Math.min(limit, 500))) };
  }

  async find({ topic, where = {}, since, limit = 50 }: { topic: string; where?: Readonly<Record<string, MetaValue>>; since?: string; limit?: number }): Promise<ReadResult> {
    if (this.failNext.find > 0) {
      this.failNext.find -= 1;
      return { ok: false, error: 'oasis_unreachable' };
    }
    const matches = this.rows
      .filter((r) => r.topic === topic)
      .filter((r) => Object.entries(where).every(([k, v]) => String(r.metadata[k]) === String(v)))
      .filter((r) => !since || r.created_at >= since)
      .sort((a, b) => compareRows(b, a));
    return { ok: true, events: matches.slice(0, Math.max(1, Math.min(limit, 500))) };
  }

  /** The rows of a topic, oldest first (a test helper). */
  topic(t: string): LedgerEvent[] {
    return this.rows.filter((r) => r.topic === t).sort(compareRows);
  }
}

function compareRows(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export { compareRows };
