/**
 * VTID-05164 (Health Hub Phase 1 / C1) — S1: the Health Sync wire contract v1.
 *
 * This file is the ONLY source of the external Health Sync schema (shared
 * interface S1). The native app's Health Sync module and any server-side
 * aggregator adapter send exactly this shape to POST /api/v1/health/ingest.
 *
 *   - Prose for the native team: docs/programs/health-hub/HEALTH-SYNC-CONTRACT-v1.md
 *   - Generated JSON Schema: ./contract-v1.schema.json (from the zod schemas
 *     below; test/health-sync/contract.test.ts regenerates it and fails on any
 *     difference). ./contract-v1.lock.json records its sha256 per contract
 *     version: a changed schema without a minor or major version bump fails CI.
 *
 * Codes, units, kinds and plausibility ranges are NOT redefined here: they
 * come from A's catalogue (services/health-store/catalogue.ts, S2). This file
 * only adds which catalogue codes the v1 wire accepts and their HealthKit /
 * Health Connect identifiers, for the four sync categories.
 *
 * Identity is never part of the wire: there is no user_id or tenant_id field
 * (the schema is strict, so sending one is INVALID_BATCH). Identity comes only
 * from the JWT.
 */

import { z } from 'zod/v4';
import { healthCodeByKey, type HealthCode } from '../health-store/catalogue';
import { HEALTH_SYNC_CATEGORIES, type HealthSyncCategory, HEALTH_SYNC_SOURCE_KINDS } from '../consent/health-consent';

export const HEALTH_SYNC_VTID = 'VTID-05164';

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

export const CONTRACT_VERSION = '1.0';
export const SUPPORTED_MAJORS = [1] as const;
/** The highest minor of major 1 the server accepts. Minor versions only add optional fields or codes, server first. */
export const MAX_MINOR = 0;

export type ContractVersionCheck = { ok: true } | { ok: false; code: 'INVALID_BATCH' | 'UNSUPPORTED_CONTRACT_VERSION' };

/** "major.minor": major in SUPPORTED_MAJORS and minor <= MAX_MINOR. */
export function checkContractVersion(v: unknown): ContractVersionCheck {
  if (typeof v !== 'string') return { ok: false, code: 'INVALID_BATCH' };
  const m = /^(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (!m) return { ok: false, code: 'INVALID_BATCH' };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!(SUPPORTED_MAJORS as readonly number[]).includes(major) || minor > MAX_MINOR) {
    return { ok: false, code: 'UNSUPPORTED_CONTRACT_VERSION' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Limits (S1: the wire limits are C's)
// ---------------------------------------------------------------------------

export const HEALTH_SYNC_LIMITS = Object.freeze({
  /** Request body as sent (compressed when Content-Encoding: gzip). */
  maxCompressedBytes: 512 * 1024,
  /** After gunzip (zip-bomb bound). */
  maxInflatedBytes: 4 * 1024 * 1024,
  maxRecords: 1000,
  maxDeletions: 1000,
  maxSleepStages: 200,
  /** Server window, one rule with the store (S3): start older than this is OUT_OF_WINDOW. */
  tooOldDays: 400,
  /** end more than this ahead of the server clock is OUT_OF_WINDOW. */
  futureToleranceMinutes: 5,
  /** Recommended backfill on first connect. */
  defaultBackfillDays: 90,
  /** Series pre-aggregation (S1): 5-minute intervals within this many days, 1-hour intervals older. */
  fiveMinuteWindowDays: 30,
});

// ---------------------------------------------------------------------------
// Data catalogue v1 (closed): A's codes the wire accepts, with OS identifiers
// ---------------------------------------------------------------------------

export interface HealthSyncCatalogueEntry {
  /** A's catalogue key (S2) = the wire `type`. */
  type: string;
  category: HealthSyncCategory;
  /** HealthKit identifier, or null when HealthKit has no such type. */
  healthkit: string | null;
  /** Health Connect record type (and aggregate metric where one is used), or null. */
  health_connect: string | null;
}

const entry = (type: string, category: HealthSyncCategory, healthkit: string | null, health_connect: string | null): HealthSyncCatalogueEntry =>
  Object.freeze({ type, category, healthkit, health_connect });

/**
 * Glucose / CGM, reproductive and clinical records are excluded (program §2,
 * owner decision 7): the app must not request OS permission for them. A's
 * catalogue codes that are not listed here (vo2_max, sleep_efficiency, blood
 * pressure, the self-logged habits) are UNSUPPORTED_TYPE on the wire.
 */
export const HEALTH_SYNC_CATALOGUE_V1: readonly HealthSyncCatalogueEntry[] = Object.freeze([
  // activity
  entry('steps', 'activity', 'HKQuantityTypeIdentifierStepCount', 'StepsRecord'),
  entry('active_energy', 'activity', 'HKQuantityTypeIdentifierActiveEnergyBurned', 'ActiveCaloriesBurnedRecord'),
  entry('exercise_minutes', 'activity', 'HKQuantityTypeIdentifierAppleExerciseTime', 'ExerciseSessionRecord.EXERCISE_DURATION_TOTAL'),
  entry('distance', 'activity', 'HKQuantityTypeIdentifierDistanceWalkingRunning', 'DistanceRecord'),
  entry('workout', 'activity', 'HKWorkoutType', 'ExerciseSessionRecord'),
  // sleep (session with optional stages)
  entry('sleep_session', 'sleep', 'HKCategoryTypeIdentifierSleepAnalysis', 'SleepSessionRecord'),
  // heart
  entry('heart_rate', 'heart', 'HKQuantityTypeIdentifierHeartRate', 'HeartRateRecord'),
  entry('resting_heart_rate', 'heart', 'HKQuantityTypeIdentifierRestingHeartRate', 'RestingHeartRateRecord'),
  entry('hrv_sdnn', 'heart', 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', null),
  entry('hrv_rmssd', 'heart', null, 'HeartRateVariabilityRmssdRecord'),
  // body
  entry('body_weight', 'body', 'HKQuantityTypeIdentifierBodyMass', 'WeightRecord'),
  entry('body_fat_percentage', 'body', 'HKQuantityTypeIdentifierBodyFatPercentage', 'BodyFatRecord'),
]);

const CATALOGUE_BY_TYPE: ReadonlyMap<string, HealthSyncCatalogueEntry> = new Map(HEALTH_SYNC_CATALOGUE_V1.map((e) => [e.type, e]));

/** The v1 catalogue entry for a wire type, with A's code; null when the type is not in v1. */
export function syncCatalogueEntry(type: string): (HealthSyncCatalogueEntry & { code: HealthCode }) | null {
  const e = CATALOGUE_BY_TYPE.get(type);
  if (!e) return null;
  const code = healthCodeByKey(type);
  if (!code || code.category !== e.category || !code.catalogue_allowed) return null;
  return { ...e, code };
}

/** The v1 catalogue as GET /contract publishes it (units, kinds and ranges from A's catalogue). */
export function publishedCatalogue() {
  return HEALTH_SYNC_CATEGORIES.map((category) => ({
    category,
    consent_key: `sync_${category}`,
    codes: HEALTH_SYNC_CATALOGUE_V1.filter((e) => e.category === category).map((e) => {
      const code = healthCodeByKey(e.type) as HealthCode;
      return {
        type: e.type,
        kind: code.kind,
        unit: code.unit,
        plausible_min: code.plausible_min,
        plausible_max: code.plausible_max,
        healthkit: e.healthkit,
        health_connect: e.health_connect,
      };
    }),
  }));
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const RECORD_ERROR_CODES = [
  'UNSUPPORTED_TYPE',
  'UNIT_MISMATCH',
  'IMPLAUSIBLE_VALUE',
  'OUT_OF_WINDOW',
  'CATEGORY_NOT_CONSENTED',
  'INVALID_RECORD',
  'STORE_UNAVAILABLE',
] as const;
export type RecordErrorCode = (typeof RECORD_ERROR_CODES)[number];

export interface BatchErrorSpec {
  status: number;
  retryable: boolean;
}

export const BATCH_ERROR_CODES = Object.freeze({
  INVALID_BATCH: { status: 400, retryable: false },
  UNSUPPORTED_CONTRACT_VERSION: { status: 400, retryable: false },
  UNAUTHENTICATED: { status: 401, retryable: true },
  TENANT_REQUIRED: { status: 400, retryable: false },
  CONSENT_REQUIRED: { status: 403, retryable: false },
  SOURCE_PAUSED: { status: 409, retryable: false },
  INGEST_DISABLED: { status: 409, retryable: false },
  BATCH_ID_REUSED: { status: 409, retryable: false },
  BATCH_TOO_LARGE: { status: 413, retryable: false },
  UNSUPPORTED_ENCODING: { status: 415, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  STORE_PENDING: { status: 503, retryable: true },
  STORE_UNAVAILABLE: { status: 503, retryable: true },
} satisfies Record<string, BatchErrorSpec>);
export type BatchErrorCode = keyof typeof BATCH_ERROR_CODES;

// ---------------------------------------------------------------------------
// Schemas (strict: unknown fields are INVALID_BATCH)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** ISO-8601 date-time WITH an offset (Z or ±hh:mm). */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const uuid = () => z.string().regex(UUID_RE);
const isoTime = () => z.string().max(40).regex(ISO_WITH_OFFSET);
const shortText = (max: number) => z.string().min(1).max(max);

export const SourceV1 = z.strictObject({
  kind: z.enum(HEALTH_SYNC_SOURCE_KINDS),
  install_id: uuid(),
  platform: z.enum(['ios', 'android']),
  os_version: shortText(32),
  app_version: shortText(32),
  device: z.strictObject({ manufacturer: shortText(64).optional(), model: shortText(64).optional() }).optional(),
});

export const SleepStageV1 = z.strictObject({
  stage: z.enum(['awake', 'light', 'deep', 'rem', 'asleep', 'in_bed', 'out_of_bed']),
  start: isoTime(),
  end: isoTime(),
});

export const StatsV1 = z.strictObject({
  n: z.number().int().positive(),
  sum: z.number(),
  min: z.number(),
  max: z.number(),
});

export const RecordV1 = z.strictObject({
  record_id: shortText(256),
  type: shortText(64),
  value: z.number().optional(),
  stats: StatsV1.optional(),
  unit: shortText(32),
  start: isoTime(),
  end: isoTime(),
  tz: shortText(64),
  origin_app_id: shortText(256).optional(),
  /** sleep_session only: the stages of the session. */
  stages: z.array(SleepStageV1).max(HEALTH_SYNC_LIMITS.maxSleepStages).optional(),
});

export const DeletionV1 = z.strictObject({
  record_id: shortText(256),
  type: shortText(64),
});

export const BatchV1 = z.strictObject({
  contract_version: z.string().regex(/^\d{1,3}\.\d{1,3}$/),
  batch_id: uuid(),
  source: SourceV1,
  sync_mode: z.enum(['incremental', 'backfill']),
  records: z.array(RecordV1).max(HEALTH_SYNC_LIMITS.maxRecords),
  deletions: z.array(DeletionV1).max(HEALTH_SYNC_LIMITS.maxDeletions),
});

export type HealthSyncBatchV1 = z.infer<typeof BatchV1>;
export type HealthSyncRecordV1 = z.infer<typeof RecordV1>;
export type HealthSyncDeletionV1 = z.infer<typeof DeletionV1>;

/** POST /source-state body. */
export const SourceStateV1 = z.strictObject({
  source_kind: z.enum(HEALTH_SYNC_SOURCE_KINDS),
  install_id: uuid(),
  state: z.enum(['os_permission_revoked', 'active']),
  permitted_categories: z.array(z.enum(HEALTH_SYNC_CATEGORIES)).max(HEALTH_SYNC_CATEGORIES.length),
});
export type HealthSyncSourceStateV1 = z.infer<typeof SourceStateV1>;

export interface ValidationDetail {
  path: string;
  code: string;
}

/** zod issues -> {path, code}; never the submitted values. */
export function validationDetails(error: z.ZodError, max = 50): ValidationDetail[] {
  return error.issues.slice(0, max).map((i) => ({
    path: i.path.map(String).join('.'),
    code: i.code === 'unrecognized_keys' ? 'unknown_field' : i.code,
  }));
}

export type ParseBatchResult =
  | { ok: true; batch: HealthSyncBatchV1 }
  | { ok: false; code: 'INVALID_BATCH' | 'UNSUPPORTED_CONTRACT_VERSION'; details?: ValidationDetail[] };

/** Contract version first (so an unknown major is never reported as unknown fields), then the strict schema. */
export function parseHealthSyncBatch(body: unknown): ParseBatchResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, code: 'INVALID_BATCH' };
  const version = checkContractVersion((body as Record<string, unknown>).contract_version);
  if (!version.ok) {
    return version.code === 'INVALID_BATCH'
      ? { ok: false, code: 'INVALID_BATCH', details: [{ path: 'contract_version', code: 'invalid_format' }] }
      : { ok: false, code: 'UNSUPPORTED_CONTRACT_VERSION' };
  }
  const parsed = BatchV1.safeParse(body);
  if (!parsed.success) return { ok: false, code: 'INVALID_BATCH', details: validationDetails(parsed.error) };
  const expectedPlatform = parsed.data.source.kind === 'apple_health' ? 'ios' : 'android';
  if (parsed.data.source.platform !== expectedPlatform) {
    return { ok: false, code: 'INVALID_BATCH', details: [{ path: 'source.platform', code: 'platform_mismatch' }] };
  }
  return { ok: true, batch: parsed.data };
}

// ---------------------------------------------------------------------------
// Published documents
// ---------------------------------------------------------------------------

/** The generated JSON Schema of the request body (contract-v1.schema.json). */
export function buildContractJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(BatchV1, { target: 'draft-2020-12' }) as Record<string, unknown>;
  return {
    ...schema,
    $id: 'https://vitanaland.com/schemas/health-sync/v1/batch.json',
    title: 'Vitana Health Sync batch v1',
    'x-contract-version': CONTRACT_VERSION,
  };
}

/** GET /api/v1/health/ingest/contract — the app self-checks against it at start. */
export function contractDocument() {
  return {
    ok: true,
    contract_version: CONTRACT_VERSION,
    supported_majors: [...SUPPORTED_MAJORS],
    max_minor: MAX_MINOR,
    catalogue: publishedCatalogue(),
    limits: {
      max_compressed_bytes: HEALTH_SYNC_LIMITS.maxCompressedBytes,
      max_inflated_bytes: HEALTH_SYNC_LIMITS.maxInflatedBytes,
      max_records: HEALTH_SYNC_LIMITS.maxRecords,
      max_deletions: HEALTH_SYNC_LIMITS.maxDeletions,
      too_old_days: HEALTH_SYNC_LIMITS.tooOldDays,
      future_tolerance_minutes: HEALTH_SYNC_LIMITS.futureToleranceMinutes,
      default_backfill_days: HEALTH_SYNC_LIMITS.defaultBackfillDays,
      five_minute_window_days: HEALTH_SYNC_LIMITS.fiveMinuteWindowDays,
    },
    error_codes: {
      batch: Object.fromEntries(Object.entries(BATCH_ERROR_CODES).map(([k, v]) => [k, { status: v.status, retryable: v.retryable }])),
      record: [...RECORD_ERROR_CODES],
    },
  };
}
