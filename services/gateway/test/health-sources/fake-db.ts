/**
 * VTID-05161 — in-memory PostgREST-shaped fake for the health_sources tests.
 * Models exactly what B1's code relies on: column projection in select order,
 * eq / is / in filters, order, limit, maybeSingle / single, insert / update /
 * upsert with `.select()`, rpc, and the health_sources constraints (both legacy
 * unique keys, the identity key, the connector_registry FK). A table can be
 * marked missing (PGRST205, as PostgREST answers for an unapplied table) and
 * the whole client can be made to throw.
 */
import { randomUUID } from 'crypto';

type Row = Record<string, any>;

export interface FakeDb {
  client: any;
  tables: Record<string, Row[]>;
  missing: Set<string>;
  calls: Array<{ table: string; op: string }>;
  rpcResults: Record<string, { data: unknown; error: unknown }>;
  throwAll: boolean;
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function identityKey(r: Row): string {
  return [r.tenant_id, r.user_id, r.kind, r.connector_id ?? '', r.provider_user_id ?? ''].join('|');
}

function checkHealthSource(db: FakeDb, row: Row, selfId: string | null): { code: string; message: string } | null {
  const others = db.tables.health_sources.filter((r) => r.id !== selfId);
  if (row.connector_id != null && !(db.tables.connector_registry ?? []).some((c) => c.id === row.connector_id)) {
    return { code: '23503', message: 'insert or update on table "health_sources" violates foreign key constraint "health_sources_connector_fk"' };
  }
  for (const k of ['legacy_user_connection_id', 'legacy_user_integration_id']) {
    if (row[k] != null && others.some((r) => r[k] === row[k])) return { code: '23505', message: `duplicate key value violates unique constraint (${k})` };
  }
  if (others.some((r) => identityKey(r) === identityKey(row))) {
    return { code: '23505', message: 'duplicate key value violates unique constraint "health_sources_identity_key"' };
  }
  return null;
}

const HS_DEFAULTS = () => ({
  id: randomUUID(),
  connector_id: null,
  provider_user_id: null,
  token_ref: null,
  sync_cursor: {},
  last_sync_at: null,
  last_error_code: null,
  connected_at: null,
  disconnected_at: null,
  legacy_user_connection_id: null,
  legacy_user_integration_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

export function createFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const db: FakeDb = {
    client: null,
    tables: { health_sources: [], connector_registry: [], user_connections: [], user_integrations: [], user_tenants: [], ...clone(seed) },
    missing: new Set(),
    calls: [],
    rpcResults: {},
    throwAll: false,
  };

  function from(table: string) {
    if (db.throwAll) throw new Error('fake: network down');
    const filters: Array<(r: Row) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let op: 'select' | 'insert' | 'update' | 'upsert' = 'select';
    let cols: string[] | null = null;
    let payload: any;
    let onConflict = '';
    let limit: number | null = null;
    let mode: 'many' | 'single' | 'maybe' = 'many';
    let returning = false;

    const chain: any = {
      select: (c?: string) => {
        if (op === 'select') cols = c && c !== '*' ? c.split(',').map((s) => s.trim()) : null;
        else returning = true;
        if (op !== 'select' && c && c !== '*') cols = c.split(',').map((s) => s.trim());
        return chain;
      },
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), chain),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), chain),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), chain),
      order: (c: string, o?: { ascending?: boolean }) => (orders.push({ col: c, asc: o?.ascending !== false }), chain),
      limit: (n: number) => ((limit = n), chain),
      abortSignal: () => chain,
      maybeSingle: () => ((mode = 'maybe'), chain),
      single: () => ((mode = 'single'), chain),
      insert: (rows: any) => ((op = 'insert'), (payload = rows), chain),
      update: (patch: any) => ((op = 'update'), (payload = patch), chain),
      upsert: (rows: any, o?: { onConflict?: string }) => ((op = 'upsert'), (payload = rows), (onConflict = o?.onConflict ?? ''), chain),
      then: (resolve: any, reject: any) => Promise.resolve().then(run).then(resolve, reject),
    };

    const project = (r: Row) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c] === undefined ? null : clone(r[c])])) : clone(r));

    function shape(rows: Row[]) {
      const out = rows.map(project);
      if (mode === 'many') return { data: out, error: null };
      if (mode === 'maybe') return out.length > 1 ? { data: null, error: { code: 'PGRST116', message: 'multiple rows' } } : { data: out[0] ?? null, error: null };
      return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'not exactly one row' } };
    }

    function run() {
      db.calls.push({ table, op });
      if (db.missing.has(table)) {
        return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } };
      }
      const rows = db.tables[table] ?? (db.tables[table] = []);
      if (op === 'select') {
        let out = rows.filter((r) => filters.every((f) => f(r)));
        for (const o of [...orders].reverse()) {
          out = [...out].sort((a, b) => {
            const x = a[o.col], y = b[o.col];
            if (x === y) return 0;
            if (x === null || x === undefined) return o.asc ? 1 : -1;
            if (y === null || y === undefined) return o.asc ? -1 : 1;
            return (x < y ? -1 : 1) * (o.asc ? 1 : -1);
          });
        }
        if (limit !== null) out = out.slice(0, limit);
        return shape(out);
      }
      if (op === 'insert') {
        const inserted: Row[] = [];
        for (const incoming of Array.isArray(payload) ? payload : [payload]) {
          const row = table === 'health_sources' ? { ...HS_DEFAULTS(), ...clone(incoming) } : { id: randomUUID(), ...clone(incoming) };
          if (table === 'health_sources') {
            const err = checkHealthSource(db, row, null);
            if (err) return { data: null, error: err };
          }
          rows.push(row);
          inserted.push(row);
        }
        return returning || mode !== 'many' ? shape(inserted) : { data: null, error: null };
      }
      if (op === 'update') {
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        for (const r of hit) {
          const next = { ...r, ...clone(payload), updated_at: new Date().toISOString() };
          if (table === 'health_sources') {
            const err = checkHealthSource(db, next, r.id);
            if (err) return { data: null, error: err };
          }
          Object.assign(r, next);
        }
        return returning ? shape(hit) : { data: null, error: null };
      }
      // upsert
      const keys = onConflict.split(',').filter(Boolean);
      const done: Row[] = [];
      for (const incoming of Array.isArray(payload) ? payload : [payload]) {
        const existing = rows.find((r) => keys.length > 0 && keys.every((k) => r[k] === incoming[k]));
        if (existing) Object.assign(existing, clone(incoming));
        else rows.push({ id: randomUUID(), ...clone(incoming) });
        done.push(existing ?? rows[rows.length - 1]);
      }
      return returning || mode !== 'many' ? shape(done) : { data: null, error: null };
    }
    return chain;
  }

  db.client = {
    from,
    rpc: (name: string) => {
      if (db.throwAll) throw new Error('fake: network down');
      db.calls.push({ table: `rpc:${name}`, op: 'rpc' });
      return Promise.resolve(db.rpcResults[name] ?? { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache` } });
    },
  };
  return db;
}
