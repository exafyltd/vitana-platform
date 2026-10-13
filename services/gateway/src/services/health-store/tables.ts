/**
 * VTID-05159 (Health Hub Phase 1 / A2) — S5: the health store's member-data
 * tables (A1 migration 20261014100100_vtid_05158_health_store.sql).
 *
 * Only services/health-store/** may reference these tables — erasure and
 * export code included. Every other module, the wellness context included,
 * goes through S3 (writeHealthSamples) and S4 (the readers). The vtid-05025
 * commerce boundary test and B's / C's boundary tests import this constant.
 */
export const HEALTH_STORE_TABLES = [
  'health_series_5m',
  'health_series_1h',
  'health_series_1d',
  'health_observations',
  'health_ingest_batches',
  'health_ingest_quarantine',
] as const;

export type HealthStoreTable = (typeof HEALTH_STORE_TABLES)[number];
