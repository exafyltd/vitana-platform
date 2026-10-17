/**
 * VTID-05159 (Health Hub Phase 1 / A2) — data-access seam for the health
 * store (A1 migration 20261014100100_vtid_05158_health_store.sql). Thin
 * query wrappers only; every decision lives in ingest.ts / reader.ts /
 * suppression.ts / maintenance.ts. Client-agnostic: built over `sb`
 * (service role; the store's tables and functions grant nothing to browser
 * roles). The in-memory twin used by the S10 fake and the Jest suites is
 * testing/fake-health-store.ts (createMemoryHealthStoreRepository), which
 * implements the same interface with the SQL functions' semantics.
 *
 * Every method resolves to { data, error } and never throws; `error` carries
 * the Postgres / PostgREST code so callers can tell "store not there yet"
 * (STORE_PENDING) and partition routing (23514) apart.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface RepoError {
  code?: string;
  message?: string;
}

export type RepoResult<T> = Promise<{ data: T | null; error: RepoError | null }>;

export interface BatchRow {
  tenant_id: string;
  user_id: string;
  batch_id: string;
  body_sha256: string;
  source_id: string;
  via: string;
  contract_version: string | null;
  tz: string | null;
  s3_key: string | null;
  consent_id: string | null;
  accepted: number;
  quarantined: number;
  rejected: number;
  status: 'received' | 'stored' | 'partial' | 'failed';
  results: unknown;
  received_at: string;
  completed_at?: string | null;
}

export interface QuarantineRow {
  tenant_id: string;
  user_id: string;
  batch_id: string;
  item_index: number;
  code_key: string | null;
  reason: string;
}

export interface IngestChunkParams {
  tenant_id: string;
  user_id: string;
  batch_id: string;
  source_id: string;
  source_kind: string;
  source_rank: number;
  consent_id: string | null;
  tz: string;
  series: Array<Record<string, unknown>>;
  records: Array<Record<string, unknown>>;
}

export interface IngestChunkResult {
  counts: Record<string, number>;
  series: Array<{ i: number; status: string }>;
  records: Array<{ i: number; status: string }>;
  deleted_dates: string[];
}

export interface SeriesRow {
  source_id: string;
  source_kind: string;
  source_rank: number;
  code_id: number;
  bucket_start: string;
  n: number | null;
  sum: number | null;
  min: number | null;
  max: number | null;
  ingested_at: string;
}

export interface SeriesDailyRow extends Omit<SeriesRow, 'bucket_start'> {
  local_date: string;
  tz: string;
}

export interface ObservationRow {
  source_id: string;
  source_kind: string;
  source_rank: number;
  source_record_id: string;
  code_id: number;
  value: number | null;
  unit: string;
  effective_start: string;
  effective_end: string | null;
  device: string | null;
  detail: unknown;
  ingested_at: string;
}

export interface CapacitySnapshot {
  series_5m_rows_estimate: number | null;
  connected_device_sources: number | null;
}

export interface HealthStoreRepository {
  /** The most recent batch row for (user, batch_id) received since `sinceIso`. */
  findBatch(userId: string, batchId: string, sinceIso: string): RepoResult<BatchRow>;
  /** Any member's batch by id (reprocess, service caller). */
  findBatchById(batchId: string, sinceIso: string): RepoResult<BatchRow>;
  /** Item counts of the member's batches since `sinceIso` (quota). */
  listBatchCountsSince(userId: string, sinceIso: string): RepoResult<Array<{ accepted: number; quarantined: number; rejected: number }>>;
  /** The source's earliest retained batch since `sinceIso` (first data, backfill grace). */
  firstBatchForSource(userId: string, sourceId: string, sinceIso: string): RepoResult<{ received_at: string }>;
  insertBatch(row: BatchRow): RepoResult<null>;
  insertQuarantine(rows: QuarantineRow[]): RepoResult<null>;
  ingestChunk(params: IngestChunkParams): RepoResult<IngestChunkResult>;
  ensurePartitions(nowIso: string): RepoResult<number>;
  partitionCheck(nowIso: string): RepoResult<Array<{ parent: string; partition_name: string; for_date: string }>>;
  purge(nowIso: string): RepoResult<{ run_id?: string; partitions_dropped: number; rows_purged: number }>;
  suppress(userId: string, category: string | null, sourceId: string | null, atIso: string): RepoResult<Record<string, number>>;
  unsuppress(userId: string, category: string | null, sourceId: string | null): RepoResult<Record<string, number>>;
  readSeriesDaily(tenantId: string, userId: string, codeIds: number[], from: string, to: string): RepoResult<SeriesDailyRow[]>;
  readSeries(tier: '5m' | '1h', tenantId: string, userId: string, codeIds: number[], fromIso: string, toIso: string): RepoResult<SeriesRow[]>;
  readObservations(tenantId: string, userId: string, codeIds: number[], fromIso: string, toIso: string): RepoResult<ObservationRow[]>;
  capacitySnapshot(): RepoResult<CapacitySnapshot>;
}

/** Table, column or function absent: the store is not applied on this database (STORE_PENDING). */
export function isHealthStoreMissing(error: RepoError | null | undefined): boolean {
  if (!error) return false;
  if (error.code && ['42P01', '42883', 'PGRST202', 'PGRST205'].includes(error.code)) return true;
  const msg = String(error.message ?? '');
  return /(relation|function) "?[\w.]*health_(series|observations|ingest|store|codes)[\w]*"?.* does not exist|could not find the (table|function) '?public\.health_(series|observations|ingest|store|codes)|schema cache.*health_(series|observations|ingest|store|codes)/i.test(
    msg,
  );
}

/** A write found no partition for its row (A1 has no DEFAULT partition). */
export function isPartitionRoutingError(error: RepoError | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '23514') return true;
  return /no partition of relation .* found for row/i.test(String(error.message ?? ''));
}

const SERIES_COLUMNS = 'source_id, source_kind, source_rank, code_id, bucket_start, n, sum, min, max, ingested_at';
const DAILY_COLUMNS = 'source_id, source_kind, source_rank, code_id, local_date, tz, n, sum, min, max, ingested_at';
const OBSERVATION_COLUMNS =
  'source_id, source_kind, source_rank, source_record_id, code_id, value, unit, effective_start, effective_end, device, detail, ingested_at';
const BATCH_COLUMNS =
  'tenant_id, user_id, batch_id, body_sha256, source_id, via, contract_version, tz, s3_key, consent_id, accepted, quarantined, rejected, status, results, received_at, completed_at';

async function wrap<T>(run: () => PromiseLike<{ data: unknown; error: unknown }>): RepoResult<T> {
  try {
    const { data, error } = await run();
    if (error) {
      const e = error as RepoError;
      return { data: null, error: { code: e.code, message: e.message } };
    }
    return { data: (data ?? null) as T | null, error: null };
  } catch (err) {
    return { data: null, error: { code: 'EXCEPTION', message: err instanceof Error ? err.message : String(err) } };
  }
}

export function healthStoreRepository(sb: SupabaseClient): HealthStoreRepository {
  return {
    findBatch: (userId, batchId, sinceIso) =>
      wrap(() =>
        sb
          .from('health_ingest_batches')
          .select(BATCH_COLUMNS)
          .eq('user_id', userId)
          .eq('batch_id', batchId)
          .gte('received_at', sinceIso)
          .order('received_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    findBatchById: (batchId, sinceIso) =>
      wrap(() =>
        sb
          .from('health_ingest_batches')
          .select(BATCH_COLUMNS)
          .eq('batch_id', batchId)
          .gte('received_at', sinceIso)
          .order('received_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    listBatchCountsSince: (userId, sinceIso) =>
      wrap(() =>
        sb
          .from('health_ingest_batches')
          .select('accepted, quarantined, rejected')
          .eq('user_id', userId)
          .gte('received_at', sinceIso)
          .limit(1000),
      ),
    firstBatchForSource: (userId, sourceId, sinceIso) =>
      wrap(() =>
        sb
          .from('health_ingest_batches')
          .select('received_at')
          .eq('user_id', userId)
          .eq('source_id', sourceId)
          .gte('received_at', sinceIso)
          .order('received_at', { ascending: true })
          .limit(1)
          .maybeSingle(),
      ),
    insertBatch: (row) => wrap(() => sb.from('health_ingest_batches').insert(row)),
    insertQuarantine: (rows) => wrap(() => sb.from('health_ingest_quarantine').insert(rows)),
    ingestChunk: (p) =>
      wrap(() =>
        sb.rpc('health_store_ingest', {
          p_tenant: p.tenant_id,
          p_user: p.user_id,
          p_batch_id: p.batch_id,
          p_source_id: p.source_id,
          p_source_kind: p.source_kind,
          p_source_rank: p.source_rank,
          p_consent_id: p.consent_id,
          p_tz: p.tz,
          p_series: p.series,
          p_records: p.records,
        }),
      ),
    ensurePartitions: (nowIso) => wrap(() => sb.rpc('health_store_ensure_partitions', { p_now: nowIso })),
    partitionCheck: (nowIso) => wrap(() => sb.rpc('health_store_partition_check', { p_now: nowIso })),
    purge: (nowIso) => wrap(() => sb.rpc('health_store_purge', { p_now: nowIso })),
    suppress: (userId, category, sourceId, atIso) =>
      wrap(() =>
        sb.rpc('health_store_suppress', { p_user: userId, p_category: category, p_source_id: sourceId, p_at: atIso }),
      ),
    unsuppress: (userId, category, sourceId) =>
      wrap(() => sb.rpc('health_store_unsuppress', { p_user: userId, p_category: category, p_source_id: sourceId })),
    readSeriesDaily: (tenantId, userId, codeIds, from, to) =>
      wrap(() =>
        sb
          .from('health_series_1d')
          .select(DAILY_COLUMNS)
          .eq('tenant_id', tenantId)
          .eq('user_id', userId)
          .in('code_id', codeIds)
          .gte('local_date', from)
          .lte('local_date', to)
          .is('suppressed_at', null)
          .order('local_date', { ascending: true })
          .limit(50000),
      ),
    readSeries: (tier, tenantId, userId, codeIds, fromIso, toIso) =>
      wrap(() =>
        sb
          .from(tier === '5m' ? 'health_series_5m' : 'health_series_1h')
          .select(SERIES_COLUMNS)
          .eq('tenant_id', tenantId)
          .eq('user_id', userId)
          .in('code_id', codeIds)
          .gte('bucket_start', fromIso)
          .lt('bucket_start', toIso)
          .is('suppressed_at', null)
          .order('bucket_start', { ascending: true })
          .limit(50000),
      ),
    readObservations: (tenantId, userId, codeIds, fromIso, toIso) =>
      wrap(() =>
        sb
          .from('health_observations')
          .select(OBSERVATION_COLUMNS)
          .eq('tenant_id', tenantId)
          .eq('user_id', userId)
          .in('code_id', codeIds)
          .gte('effective_start', fromIso)
          .lt('effective_start', toIso)
          .is('suppressed_at', null)
          .order('effective_start', { ascending: true })
          .limit(50000),
      ),
    capacitySnapshot: async () => {
      // Placement re-evaluation inputs (plan Change 4 / 11): the 5-minute tier's
      // planner row estimate and the number of connected device-type sources
      // (an upper bound for connected members). Best effort: a failed count is null.
      type CountResult = { count: number | null; error: unknown };
      const count = async (q: () => PromiseLike<CountResult>): Promise<number | null> => {
        try {
          const r = await q();
          return r && !r.error && typeof r.count === 'number' ? r.count : null;
        } catch {
          return null;
        }
      };
      const series = await count(
        () => sb.from('health_series_5m').select('code_id', { count: 'estimated', head: true }) as unknown as PromiseLike<CountResult>,
      );
      const sources = await count(
        () =>
          sb
            .from('health_sources')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'connected')
            .in('kind', ['device_cloud', 'phone_store', 'aggregator']) as unknown as PromiseLike<CountResult>,
      );
      return { data: { series_5m_rows_estimate: series, connected_device_sources: sources }, error: null };
    },
  };
}
