/**
 * VTID-05658 — best-effort daily "seen" recorder for the native-app adoption measurement.
 *
 * One row per (day, tenant, member, class) in client_identity_daily_seen. De-duplicated in memory per
 * instance, so a member costs at most one upsert per class per UTC day per instance. A write failure
 * (table missing because the migration is not applied, network, RLS) is swallowed: it never reaches the
 * request, and a short back-off stops a missing table from being retried on every request.
 */
import { getSupabase } from '../../lib/supabase';
import type { ClientClass } from '../client-identity/classify';

export const SEEN_TABLE = 'client_identity_daily_seen';
export const SEEN_CONFLICT_KEY = 'day,tenant_id,user_id,client_class';

export interface SeenRow {
  day: string;
  tenant_id: string;
  user_id: string;
  client_class: ClientClass;
}

/** Writes one row; resolves on success, rejects (or throws) on failure. Injectable for tests. */
export type SeenWriter = (row: SeenRow) => Promise<void>;

const MAX_KEYS = 50_000;
const FAILURE_BACKOFF_MS = 60_000;

export const defaultSeenWriter: SeenWriter = async (row) => {
  const supabase = getSupabase();
  if (!supabase) throw new Error('supabase not configured');
  const { error } = await supabase
    .from(SEEN_TABLE)
    .upsert(row, { onConflict: SEEN_CONFLICT_KEY, ignoreDuplicates: true });
  if (error) throw new Error(error.message);
};

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface SeenRecorder {
  record(input: { tenantId: string; userId: string; clientClass: ClientClass }): void;
  /** test helper */
  reset(): void;
}

export function createSeenRecorder(
  writer: SeenWriter = defaultSeenWriter,
  clock: () => Date = () => new Date(),
): SeenRecorder {
  let currentDay = '';
  let seen = new Set<string>();
  let blockedUntil = 0;

  return {
    record({ tenantId, userId, clientClass }) {
      try {
        const now = clock();
        if (now.getTime() < blockedUntil) return;
        const day = utcDay(now);
        if (day !== currentDay) {
          currentDay = day;
          seen = new Set();
        }
        const key = `${tenantId}|${userId}|${clientClass}`;
        if (seen.has(key)) return;
        if (seen.size >= MAX_KEYS) seen = new Set();
        seen.add(key);
        const row: SeenRow = { day, tenant_id: tenantId, user_id: userId, client_class: clientClass };
        let pending: Promise<void>;
        try {
          pending = Promise.resolve(writer(row));
        } catch (err) {
          pending = Promise.reject(err);
        }
        pending.catch((err) => {
          seen.delete(key);
          blockedUntil = clock().getTime() + FAILURE_BACKOFF_MS;
          console.warn(`[client-identity] daily-seen write failed (soft): ${(err as Error)?.message ?? err}`);
        });
      } catch {
        /* best effort: never throw into the request */
      }
    },
    reset() {
      currentDay = '';
      seen = new Set();
      blockedUntil = 0;
    },
  };
}

export const seenRecorder: SeenRecorder = createSeenRecorder();
