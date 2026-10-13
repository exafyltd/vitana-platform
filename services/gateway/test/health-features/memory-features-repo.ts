/**
 * VTID-05162: an in-memory HealthFeaturesRepository for the B2 suites (the
 * semantics of the three tables in 20261014100700_vtid_05162_health_features_v2.sql:
 * unique (tenant, user, date, feature_key) for v2, unique (tenant, user, date)
 * for the pending markers). `fail[method]` makes a method answer an error
 * ('error'), a missing table ('missing') or throw ('throw').
 */
import type {
  FeatureV2Row,
  HealthFeaturesRepository,
  PendingMarker,
  RepoResult,
} from '../../src/services/health-features/health-features-repository';

type Mode = 'error' | 'missing' | 'throw';

export interface MemoryFeaturesRepo extends HealthFeaturesRepository {
  v2: Map<string, FeatureV2Row>;
  pending: Map<string, PendingMarker>;
  fail: Partial<Record<keyof HealthFeaturesRepository, Mode>>;
  calls: Array<keyof HealthFeaturesRepository>;
}

export function createMemoryFeaturesRepo(): MemoryFeaturesRepo {
  const v2 = new Map<string, FeatureV2Row>();
  const pending = new Map<string, PendingMarker>();
  const fail: MemoryFeaturesRepo['fail'] = {};
  const calls: MemoryFeaturesRepo['calls'] = [];
  const k2 = (t: string, u: string, d: string, f: string) => `${t}|${u}|${d}|${f}`;
  const kp = (t: string, u: string, d: string) => `${t}|${u}|${d}`;

  async function run<T>(m: keyof HealthFeaturesRepository, fn: () => T): Promise<RepoResult<T>> {
    calls.push(m);
    const mode = fail[m];
    if (mode === 'throw') throw new Error(`${m} threw`);
    if (mode === 'missing') return { data: null, error: { code: '42P01', message: 'relation "health_features_daily_v2" does not exist' } };
    if (mode === 'error') return { data: null, error: { code: '57014', message: 'canceling statement' } };
    return { data: fn(), error: null };
  }

  return {
    v2,
    pending,
    fail,
    calls,
    upsertFeaturesV2: (rows) => run('upsertFeaturesV2', () => {
      for (const r of rows) v2.set(k2(r.tenant_id, r.user_id, r.date, r.feature_key), { ...r });
      return null;
    }),
    listFeaturesV2Keys: (t, u, dates) => run('listFeaturesV2Keys', () =>
      Array.from(v2.values()).filter((r) => r.tenant_id === t && r.user_id === u && dates.includes(r.date)).map((r) => ({ date: r.date, feature_key: r.feature_key }))),
    deleteFeaturesV2: (t, u, d, keys) => run('deleteFeaturesV2', () => {
      for (const f of keys) v2.delete(k2(t, u, d, f));
      return null;
    }),
    listFeaturesV2Dates: (t, u) => run('listFeaturesV2Dates', () =>
      Array.from(v2.values()).filter((r) => r.tenant_id === t && r.user_id === u).map((r) => ({ date: r.date }))),
    upsertPending: (rows) => run('upsertPending', () => {
      for (const r of rows) {
        const key = kp(r.tenant_id, r.user_id, r.date);
        pending.set(key, { ...r, attempts: pending.get(key)?.attempts ?? 0 });
      }
      return null;
    }),
    deletePending: (t, u, dates) => run('deletePending', () => {
      for (const d of dates) pending.delete(kp(t, u, d));
      return null;
    }),
    listStalePending: (before, limit) => run('listStalePending', () =>
      Array.from(pending.values()).filter((p) => p.enqueued_at < before).sort((a, b) => (a.enqueued_at < b.enqueued_at ? -1 : 1)).slice(0, limit)),
    setPendingAttempts: (t, u, d, attempts) => run('setPendingAttempts', () => {
      const p = pending.get(kp(t, u, d));
      if (p) p.attempts = attempts;
      return null;
    }),
  };
}
