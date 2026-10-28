/**
 * VCAOP repository abstraction (CTRL-API-0004).
 *
 * The router depends on this interface, not on Prisma/Supabase directly, so it is
 * testable in-memory (mock-first, BLK-001) and swappable for a Prisma-backed impl
 * that runs the OASIS-append in the SAME transaction as the read-model write
 * (Sec. 4, AC for CTRL-API-0004). The in-memory impl below is for tests/dev.
 */

export interface Record_ {
  id: string;
  [k: string]: unknown;
}

export interface Repository {
  list(collection: string, filter?: (r: Record_) => boolean): Promise<Record_[]>;
  get(collection: string, id: string): Promise<Record_ | null>;
  create(collection: string, record: Record_): Promise<Record_>;
  update(collection: string, id: string, patch: Partial<Record_>): Promise<Record_ | null>;
}

let counter = 0;
export function newId(prefix = 'rec'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/** Simple in-memory repository for tests and local dev. */
export class InMemoryRepository implements Repository {
  private readonly store = new Map<string, Map<string, Record_>>();

  private col(collection: string): Map<string, Record_> {
    let c = this.store.get(collection);
    if (!c) {
      c = new Map();
      this.store.set(collection, c);
    }
    return c;
  }

  async list(collection: string, filter?: (r: Record_) => boolean): Promise<Record_[]> {
    const all = [...this.col(collection).values()];
    return filter ? all.filter(filter) : all;
  }

  async get(collection: string, id: string): Promise<Record_ | null> {
    return this.col(collection).get(id) ?? null;
  }

  async create(collection: string, record: Record_): Promise<Record_> {
    const rec = { ...record, id: record.id || newId(collection) };
    this.col(collection).set(rec.id, rec);
    return rec;
  }

  async update(collection: string, id: string, patch: Partial<Record_>): Promise<Record_ | null> {
    const existing = this.col(collection).get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id };
    this.col(collection).set(id, updated);
    return updated;
  }

  /** Seed helper for tests. */
  async seed(collection: string, records: Record_[]): Promise<void> {
    for (const r of records) await this.create(collection, r);
  }
}
