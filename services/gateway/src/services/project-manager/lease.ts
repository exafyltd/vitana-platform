/**
 * VTID-05217 — Project Manager: the per-tick Postgres lease (plan §6, §6.3).
 *
 * A single `pm_lease` row is claimed per tick with
 *   UPDATE pm_lease SET holder=$1, expires_at=now()+<ttl>
 *     WHERE id = 1 AND expires_at < now() RETURNING ...
 * so that when several ECS tasks run the PM, only one holds the lease and ACTS
 * in a given window — the others skip the tick. Merges additionally go through
 * safe-merge, which refuses an already-merged PR, so a lost lease never double
 * merges (plan Risks).
 *
 * VTID-05274 (plan kiro-autonomy-fallback §5 C6): the table exists since
 * VTID-05214 (supabase/migrations/20261015180000_vtid_05214_plan_sparring_policy_approval.sql,
 * one seeded row). `PgLeaseManager` takes it through an injected `LeaseClient`
 * (production: PostgREST with the service role, `PostgrestLeaseClient`). The
 * fail-safe stays: a missing relation → `table_absent`, any other error →
 * `error`, held → `held_by_other`; all three make the tick a no-op. The last
 * outcome is exposed (`getLastLease`, /status `last_lease`) and logged once per
 * change, so a silently non-acting PM is visible. TTL = tick − 30 s (config).
 */

/** The outcome of trying to take the per-tick lease. */
export type LeaseOutcome =
  | { acquired: true; holder: string; expires_at: string }
  /** The lease could not be taken: another task holds it this window. */
  | { acquired: false; reason: 'held_by_other' }
  /** The pm_lease table does not exist — tick no-ops. */
  | { acquired: false; reason: 'table_absent' }
  /** Any acquisition error — treated like no lease: the tick no-ops. */
  | { acquired: false; reason: 'error'; error: string };

/** The seam the act layer takes its per-tick lease through. */
export interface LeaseManager {
  /** Try to take the lease for this tick. Never throws. */
  acquire(holder: string): Promise<LeaseOutcome>;
}

/** The last lease outcome, for /status (`acquired|held_by_other|table_absent|error|null`). */
export type LeaseState = 'acquired' | 'held_by_other' | 'table_absent' | 'error';
let lastLease: LeaseState | null = null;

/** Record a lease outcome; logs once whenever the outcome changes. */
export function recordLease(outcome: LeaseOutcome): void {
  const s: LeaseState = outcome.acquired ? 'acquired' : outcome.reason;
  if (s !== lastLease) {
    const why = !outcome.acquired && outcome.reason === 'error' ? ` (${outcome.error})` : '';
    console.log(`[PM] pm_lease: ${lastLease ?? 'none'} → ${s}${why}`);
  }
  lastLease = s;
}

export function getLastLease(): LeaseState | null {
  return lastLease;
}

/**
 * The fail-safe default: acquires nothing and reports `table_absent`, so a
 * `live` tick with no lease wired safely no-ops rather than acting without a lease.
 */
export class NoLeaseManager implements LeaseManager {
  async acquire(): Promise<LeaseOutcome> {
    return { acquired: false, reason: 'table_absent' };
  }
}

export function defaultLeaseManager(): LeaseManager {
  return new NoLeaseManager();
}

/**
 * The conditional UPDATE … WHERE expires_at < now() RETURNING, as a seam.
 * Returns the updated rows (empty = held by another task); throws an error
 * carrying the Postgres / PostgREST `code` on failure.
 */
export interface LeaseClient {
  tryAcquire(holder: string, ttlMs: number): Promise<{ rows: Array<{ holder: string | null; expires_at: string }> }>;
}

/** Codes for "relation does not exist": Postgres 42P01, PostgREST PGRST205 (not in the schema cache). */
const TABLE_ABSENT_CODES = new Set(['42P01', 'PGRST205']);

export class PgLeaseManager implements LeaseManager {
  constructor(private readonly client: LeaseClient, private readonly ttlMs: number) {}

  async acquire(holder: string): Promise<LeaseOutcome> {
    let outcome: LeaseOutcome;
    try {
      const { rows } = await this.client.tryAcquire(holder, this.ttlMs);
      outcome = rows.length > 0
        ? { acquired: true, holder, expires_at: rows[0].expires_at }
        : { acquired: false, reason: 'held_by_other' };
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      outcome = typeof code === 'string' && TABLE_ABSENT_CODES.has(code)
        ? { acquired: false, reason: 'table_absent' }
        : { acquired: false, reason: 'error', error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
    recordLease(outcome);
    return outcome;
  }
}

/**
 * Production `LeaseClient`: PostgREST PATCH on `pm_lease` (id = 1, expires_at <
 * now) with the service role — the gateway's own runtime write of its lease row
 * (`GRANT UPDATE (holder, expires_at)` to service_role in the VTID-05214 migration).
 */
export class PostgrestLeaseClient implements LeaseClient {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async tryAcquire(holder: string, ttlMs: number): Promise<{ rows: Array<{ holder: string | null; expires_at: string }> }> {
    const url = this.env.SUPABASE_URL;
    const key = this.env.SUPABASE_SERVICE_ROLE;
    if (!url || !key) throw Object.assign(new Error('supabase not configured'), { code: 'not_configured' });
    const nowIso = new Date(this.now()).toISOString();
    const expires = new Date(this.now() + ttlMs).toISOString();
    const res = await this.fetchFn(
      `${url}/rest/v1/pm_lease?id=eq.1&expires_at=lt.${encodeURIComponent(nowIso)}`,
      {
        method: 'PATCH',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ holder, expires_at: expires }),
      },
    );
    const text = await res.text();
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const j = JSON.parse(text) as { code?: string };
        if (typeof j.code === 'string') code = j.code;
      } catch {
        // non-JSON error body
      }
      throw Object.assign(new Error(`pm_lease ${res.status}`), { code });
    }
    const rows = text ? (JSON.parse(text) as Array<{ holder: string | null; expires_at: string }>) : [];
    return { rows };
  }
}
