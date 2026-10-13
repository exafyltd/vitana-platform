/**
 * VTID-05133 — a tiny in-memory stand-in for the supabase-js query builder,
 * enough for the Community MCP tools: from().select().eq/neq/in/gt/is/order/limit,
 * maybeSingle() and await. Records every table touched so tests can assert a
 * table was never read or written. No network, no real database.
 */
export type Row = Record<string, unknown>;

export interface FakeDb {
  tables: Record<string, Row[]>;
  touched: string[];
  failTables: Set<string>;
  from: (t: string) => Query;
}

type Filter = (r: Row) => boolean;

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private single = false;
  constructor(private db: FakeDb, private table: string) {}
  select(_cols?: string) {
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => r[c] !== v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]));
    return this;
  }
  gt(c: string, v: string) {
    this.filters.push((r) => typeof r[c] === 'string' && (r[c] as string) > v);
    return this;
  }
  gte(c: string, v: string) {
    this.filters.push((r) => typeof r[c] === 'string' && (r[c] as string) >= v);
    return this;
  }
  lte(c: string, v: string) {
    this.filters.push((r) => typeof r[c] === 'string' && (r[c] as string) <= v);
    return this;
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) === v);
    return this;
  }
  ilike() {
    return this;
  }
  or() {
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  private run(): { data: unknown; error: unknown } {
    this.db.touched.push(this.table);
    if (this.db.failTables.has(this.table)) return { data: null, error: { message: 'boom' } };
    let rows = (this.db.tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      rows = [...rows].sort((a, b) => ((a[col] as number) > (b[col] as number) ? 1 : -1) * (asc ? 1 : -1));
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    if (this.single) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
  then<T1 = { data: unknown; error: unknown }, T2 = never>(
    ok?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    ko?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(ok, ko);
  }
}

export function fakeDb(tables: Record<string, Row[]>): FakeDb {
  const db: FakeDb = {
    tables,
    touched: [],
    failTables: new Set(),
    from: (t: string) => new Query(db, t),
  };
  return db;
}
