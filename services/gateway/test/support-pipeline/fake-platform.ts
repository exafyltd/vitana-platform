/**
 * VTID-04456 — an in-memory stand-in for the one database the customer
 * support pipeline writes to, so the pipeline's REAL code runs end to end in
 * a test.
 *
 * The support pipeline talks to Postgres two ways, and both are served from
 * the same in-memory tables here:
 *
 *   1. supabase-js (`sb.from(...).insert/select/update`, `sb.rpc(...)`) —
 *      the ticket insert in report-to-specialist-core, the app route and the
 *      typed ORB tools. {@link FakePlatform.client}.
 *   2. raw PostgREST over `fetch` (`/rest/v1/<table>?col=op.value`) — the spec
 *      drafter, auto-dispatch, the execution bridge and the completion
 *      reconciler. {@link FakePlatform.fetch}, installed as `global.fetch`.
 *
 * Nothing here decides pipeline behaviour: each filter, update and insert is
 * applied literally, the way PostgREST would. Two database-side behaviours
 * are emulated because the gateway relies on them and no gateway code
 * performs them:
 *   - the `assign_feedback_ticket_number()` trigger (FB-YYYY-MM-NNNNNN), and
 *   - `auto_triage_pending_feedback_tickets()` (placeholder spec for a
 *     triaged bug / ux_issue) — {@link FakePlatform.runAutoTriage}. The test
 *     suite checks the emulation against the migration text, so the two
 *     cannot drift apart silently.
 */

import { randomUUID } from 'crypto';

export type Row = Record<string, any>;

export const FAKE_SUPABASE_URL = 'http://localhost:54321';

/** The heading the SQL auto-triage writes as a placeholder spec. */
export const AUTO_TRIAGE_PLACEHOLDER_HEADING = '# Devon auto-draft spec (placeholder)';

type Filter = { col: string; op: string; val: any };

function parseFilterValue(raw: string): { op: string; val: any } {
  const neg = raw.startsWith('not.');
  const body = neg ? raw.slice(4) : raw;
  const dot = body.indexOf('.');
  const op = dot === -1 ? body : body.slice(0, dot);
  let val: any = dot === -1 ? '' : body.slice(dot + 1);
  if (op === 'in') val = String(val).replace(/^\(|\)$/g, '').split(',').filter(Boolean);
  if (op === 'is') val = val === 'null' ? null : val === 'true' ? true : val === 'false' ? false : val;
  return { op: neg ? `not.${op}` : op, val };
}

function likeToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/%/g, '.*');
  return new RegExp(`^${esc}$`, 'is');
}

function matches(row: Row, f: Filter): boolean {
  const v = row[f.col];
  switch (f.op) {
    case 'eq': return v !== undefined && v !== null && String(v) === String(f.val);
    case 'neq': return String(v) !== String(f.val);
    case 'in': return (f.val as string[]).includes(String(v));
    case 'is': return f.val === null ? v === null || v === undefined : v === f.val;
    case 'not.is': return f.val === null ? v !== null && v !== undefined : v !== f.val;
    case 'ilike': return typeof v === 'string' && likeToRegex(String(f.val)).test(v);
    case 'not.ilike': return !(typeof v === 'string' && likeToRegex(String(f.val)).test(v));
    case 'gte': return v != null && String(v) >= String(f.val);
    case 'lte': return v != null && String(v) <= String(f.val);
    case 'gt': return v != null && String(v) > String(f.val);
    case 'lt': return v != null && String(v) < String(f.val);
    default:
      throw new Error(`fake-platform: unsupported filter operator "${f.op}" on ${f.col}`);
  }
}

function project(row: Row, select: string | null): Row {
  if (!select || select.trim() === '*') return { ...row };
  const out: Row = {};
  for (const col of select.split(',').map((c) => c.trim()).filter(Boolean)) out[col] = row[col];
  return out;
}

function jsonResponse(status: number, body: unknown): Response {
  if (body === undefined) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export interface FakePlatformOptions {
  /** Persona the two-gate RPC picks for a text, or null to leave it unrouted. */
  pickSpecialist?: (text: string) => { persona_key: string; matched_phrase?: string; confidence?: number } | null;
}

export class FakePlatform {
  readonly tables: Record<string, Row[]> = {};
  /** Every PostgREST call made through {@link fetch}, for assertions. */
  readonly restCalls: Array<{ method: string; table: string; query: string }> = [];
  private ticketSeq = 0;

  constructor(private readonly opts: FakePlatformOptions = {}) {}

  table(name: string): Row[] {
    if (!this.tables[name]) this.tables[name] = [];
    return this.tables[name];
  }

  ticket(id: string): Row {
    const t = this.table('feedback_tickets').find((r) => r.id === id);
    if (!t) throw new Error(`fake-platform: no feedback_ticket ${id}`);
    return t;
  }

  /** Insert with the column defaults and triggers the real tables apply. */
  insert(table: string, input: Row): Row {
    const now = new Date().toISOString();
    const row: Row = { id: randomUUID(), created_at: now, updated_at: now, ...input };
    if (table === 'feedback_tickets') {
      // assign_feedback_ticket_number() trigger.
      this.ticketSeq += 1;
      const d = new Date();
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      row.ticket_number = row.ticket_number ?? `FB-${ym}-${String(this.ticketSeq).padStart(6, '0')}`;
      row.status = row.status ?? 'new';
      row.priority = row.priority ?? null;
      row.surface = row.surface ?? null;
      row.spec_md = row.spec_md ?? null;
      row.classifier_meta = row.classifier_meta ?? null;
      row.linked_finding_id = row.linked_finding_id ?? null;
      row.linked_vtid = row.linked_vtid ?? null;
      row.duplicate_of = row.duplicate_of ?? null;
      row.supervisor_notes = row.supervisor_notes ?? null;
      row.intake_messages = row.intake_messages ?? [];
      row.structured_fields = row.structured_fields ?? {};
    }
    if (table === 'autopilot_recommendations') {
      row.activated_vtid = row.activated_vtid ?? null;
    }
    this.table(table).push(row);
    return row;
  }

  private select(table: string, filters: Filter[]): Row[] {
    return this.table(table).filter((r) => filters.every((f) => matches(r, f)));
  }

  // ---------------------------------------------------------------------------
  // Raw PostgREST (global.fetch)
  // ---------------------------------------------------------------------------

  readonly fetch = async (input: any, init: any = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = String(init.method || 'GET').toUpperCase();
    const m = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
    if (!m) throw new Error(`fake-platform: unexpected fetch ${method} ${url.href}`);
    const table = m[1];
    this.restCalls.push({ method, table, query: url.search });

    const filters: Filter[] = [];
    let select: string | null = null;
    let limit: number | null = null;
    let order: { col: string; desc: boolean } | null = null;
    for (const [key, raw] of url.searchParams.entries()) {
      if (key === 'select') { select = raw; continue; }
      if (key === 'limit') { limit = Number(raw); continue; }
      if (key === 'order') {
        const [col, dir] = raw.split('.');
        order = { col, desc: dir === 'desc' };
        continue;
      }
      if (key === 'offset' || key === 'on_conflict') continue;
      filters.push({ col: key, ...parseFilterValue(raw) });
    }
    const prefer = String((init.headers && (init.headers.Prefer || init.headers.prefer)) || '');
    const wantsRows = prefer.includes('return=representation');

    if (method === 'GET') {
      let rows = this.select(table, filters);
      if (order) {
        const { col, desc } = order;
        rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (desc ? -1 : 1));
      }
      if (limit != null) rows = rows.slice(0, limit);
      return jsonResponse(200, rows.map((r) => project(r, select)));
    }
    if (method === 'PATCH') {
      const patch = init.body ? JSON.parse(init.body) : {};
      const rows = this.select(table, filters);
      for (const r of rows) Object.assign(r, patch, { updated_at: new Date().toISOString() });
      return wantsRows ? jsonResponse(200, rows.map((r) => project(r, select))) : jsonResponse(204, undefined);
    }
    if (method === 'POST') {
      const body = init.body ? JSON.parse(init.body) : {};
      const created = (Array.isArray(body) ? body : [body]).map((b) => this.insert(table, b));
      return wantsRows ? jsonResponse(201, created.map((r) => project(r, select))) : jsonResponse(201, undefined);
    }
    throw new Error(`fake-platform: unsupported method ${method} on ${table}`);
  };

  // ---------------------------------------------------------------------------
  // supabase-js client
  // ---------------------------------------------------------------------------

  client(): any {
    const platform = this;
    return {
      from(table: string) {
        const filters: Filter[] = [];
        let op: 'select' | 'insert' | 'update' = 'select';
        let payload: any = null;
        let selectCols: string | null = null;
        const run = async (single: 'one' | 'maybe' | null) => {
          if (op === 'insert') {
            const rows = (Array.isArray(payload) ? payload : [payload]).map((p) => platform.insert(table, p));
            const out = rows.map((r) => project(r, selectCols));
            return { data: single ? out[0] ?? null : out, error: null };
          }
          const rows = platform.select(table, filters);
          if (op === 'update') {
            for (const r of rows) Object.assign(r, payload, { updated_at: new Date().toISOString() });
          }
          const out = rows.map((r) => project(r, selectCols));
          if (single === 'one') {
            return out.length === 1
              ? { data: out[0], error: null }
              : { data: null, error: { message: `expected one row, got ${out.length}` } };
          }
          if (single === 'maybe') return { data: out[0] ?? null, error: null };
          return { data: out, error: null };
        };
        const q: any = {
          select(cols?: string) { selectCols = cols ?? null; return q; },
          insert(row: any) { op = 'insert'; payload = row; return q; },
          update(patch: any) { op = 'update'; payload = patch; return q; },
          eq(col: string, val: any) { filters.push({ col, op: 'eq', val }); return q; },
          in(col: string, vals: any[]) { filters.push({ col, op: 'in', val: vals.map(String) }); return q; },
          is(col: string, val: any) { filters.push({ col, op: 'is', val }); return q; },
          order() { return q; },
          limit() { return q; },
          single() { return run('one'); },
          maybeSingle() { return run('maybe'); },
          then(resolve: any, reject: any) { return run(null).then(resolve, reject); },
        };
        return q;
      },
      rpc(name: string, args: Record<string, any>) {
        if (name === 'pick_specialist_for_text' || name === 'pick_specialist_for_text_tenant') {
          const picked = platform.opts.pickSpecialist?.(String(args?.p_text ?? '')) ?? null;
          return Promise.resolve({
            data: picked
              ? [{ decision: 'forward', gate: 'forward_explicit', confidence: 0.9, ...picked }]
              : [{ decision: 'answer_inline', gate: 'no_forward_request', persona_key: null }],
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: { message: `fake-platform: unknown rpc ${name}` } });
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Database-side behaviour the gateway relies on
  // ---------------------------------------------------------------------------

  /** Stands in for the classifier: stamps classifier_meta and moves a fresh
   *  ticket to triaged, the precondition auto-triage reads. */
  classify(ticketId: string, triagedAt: string = new Date(Date.now() - 10 * 60_000).toISOString()): void {
    const t = this.ticket(ticketId);
    t.classifier_meta = { ...(t.classifier_meta || {}), classifier: 'fake', pick_confidence: 0.9 };
    t.priority = t.priority ?? 'p2';
    if (t.status === 'new' || t.status === 'triaged') {
      t.status = 'triaged';
      t.triaged_at = t.triaged_at && t.triaged_at < triagedAt ? t.triaged_at : triagedAt;
    }
  }

  /**
   * auto_triage_pending_feedback_tickets() (migration 20260923130000), bug /
   * ux_issue branch: a triaged ticket older than 5 minutes, classified, not a
   * duplicate and not on the human-only support surface gets a placeholder
   * Devon spec and moves to spec_ready. Returns the ids it moved.
   */
  runAutoTriage(now: number = Date.now()): string[] {
    const moved: string[] = [];
    for (const t of this.table('feedback_tickets')) {
      if (t.status !== 'triaged') continue;
      if (!t.triaged_at || Date.parse(t.triaged_at) >= now - 5 * 60_000) continue;
      if (t.duplicate_of) continue;
      if (t.classifier_meta == null) continue;
      if ((t.surface ?? '') === 'support') continue;
      if (t.kind !== 'bug' && t.kind !== 'ux_issue') continue;
      t.status = 'spec_ready';
      t.resolver_agent = 'devon';
      t.spec_md = `${AUTO_TRIAGE_PLACEHOLDER_HEADING}\n## User report\n${t.raw_transcript ?? ''}\n## Risk + rollback\nPriority ${t.priority ?? 'unset'} ${t.kind} ticket; the real spec is drafted by the gateway spec drafter.`;
      moved.push(t.id);
    }
    return moved;
  }
}
