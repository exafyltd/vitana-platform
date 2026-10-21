/**
 * VTID-05164 (Health Hub Phase 1 / C1) — the Health Sync v1 wire contract (S1).
 *
 *   - the committed contract-v1.schema.json equals the schema generated from
 *     the zod source, and its sha256 is locked per contract version
 *     (contract-v1.lock.json): a changed schema without a version bump fails;
 *   - the v1 catalogue: every code is an allowed A catalogue code of one of the
 *     four sync categories, with a UCUM unit, a range and at least one OS type;
 *     no glucose / CGM / HbA1c, reproductive or clinical code;
 *   - the schema is strict (no user_id / tenant_id / unknown field), and the
 *     contract version check answers UNSUPPORTED_CONTRACT_VERSION for a new major.
 *
 * Regenerate after a deliberate, version-bumped change:
 *   UPDATE_HEALTH_SYNC_SCHEMA=1 npx jest test/health-sync/contract.test.ts
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  BATCH_ERROR_CODES,
  CONTRACT_VERSION,
  HEALTH_SYNC_CATALOGUE_V1,
  HEALTH_SYNC_LIMITS,
  MAX_MINOR,
  RECORD_ERROR_CODES,
  buildContractJsonSchema,
  checkContractVersion,
  contractDocument,
  parseHealthSyncBatch,
  syncCatalogueEntry,
} from '../../src/services/health-sync/contract-v1';
import { HEALTH_CODES, healthCodeByKey } from '../../src/services/health-store/catalogue';
import { validBatch } from './helpers';

const DIR = path.join(__dirname, '../../src/services/health-sync');
const SCHEMA_FILE = path.join(DIR, 'contract-v1.schema.json');
const LOCK_FILE = path.join(DIR, 'contract-v1.lock.json');

const serialise = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

if (process.env.UPDATE_HEALTH_SYNC_SCHEMA === '1') {
  const text = serialise(buildContractJsonSchema());
  fs.writeFileSync(SCHEMA_FILE, text);
  const lock = fs.existsSync(LOCK_FILE) ? JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) : { versions: {} };
  if (lock.versions[CONTRACT_VERSION] && lock.versions[CONTRACT_VERSION] !== sha256(text)) {
    throw new Error(`contract ${CONTRACT_VERSION} is locked to another schema: bump CONTRACT_VERSION / MAX_MINOR first`);
  }
  lock.versions[CONTRACT_VERSION] = sha256(text);
  fs.writeFileSync(LOCK_FILE, serialise(lock));
}

describe('schema lock (S1)', () => {
  it('the committed JSON Schema equals the schema generated from the zod source', () => {
    expect(fs.readFileSync(SCHEMA_FILE, 'utf8')).toBe(serialise(buildContractJsonSchema()));
  });

  it('its sha256 is locked for the current contract version — a schema change needs a version bump', () => {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) as { versions: Record<string, string> };
    expect(lock.versions[CONTRACT_VERSION]).toBe(sha256(fs.readFileSync(SCHEMA_FILE, 'utf8')));
    expect(CONTRACT_VERSION).toBe(`1.${MAX_MINOR}`);
  });

  it('the schema is strict and has no identity field', () => {
    const text = fs.readFileSync(SCHEMA_FILE, 'utf8');
    expect(text).not.toMatch(/"user_id"|"tenant_id"/);
    const schema = JSON.parse(text);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(['contract_version', 'batch_id', 'source', 'sync_mode', 'records', 'deletions']));
  });
});

describe('data catalogue v1', () => {
  it('covers activity, sleep, heart and body with A catalogue codes, a UCUM unit, a range and an OS type', () => {
    const cats = new Set(HEALTH_SYNC_CATALOGUE_V1.map((e) => e.category));
    expect([...cats].sort()).toEqual(['activity', 'body', 'heart', 'sleep']);
    for (const e of HEALTH_SYNC_CATALOGUE_V1) {
      const code = healthCodeByKey(e.type);
      expect(code).not.toBeNull();
      expect(code!.category).toBe(e.category);
      expect(code!.catalogue_allowed).toBe(true);
      expect(code!.unit.length).toBeGreaterThan(0);
      expect(code!.plausible_min).not.toBeNull();
      expect(code!.plausible_max).not.toBeNull();
      expect(e.healthkit ?? e.health_connect).toBeTruthy();
      expect(syncCatalogueEntry(e.type)?.code.key).toBe(e.type);
    }
    expect(HEALTH_SYNC_CATALOGUE_V1.map((e) => e.type)).toEqual([
      'steps', 'active_energy', 'exercise_minutes', 'distance', 'workout',
      'sleep_session',
      'heart_rate', 'resting_heart_rate', 'hrv_sdnn', 'hrv_rmssd',
      'body_weight', 'body_fat_percentage',
    ]);
  });

  it('has no glucose / CGM / HbA1c, reproductive or clinical code, and the published document has none either', () => {
    const banned = /glucose|cgm|hba1c|a1c|insulin|menstrua|ovulation|pregnan|sexual|reproduct|clinical|blood_pressure|diagnos/i;
    for (const e of HEALTH_SYNC_CATALOGUE_V1) {
      expect(e.type).not.toMatch(banned);
      expect(String(e.healthkit)).not.toMatch(banned);
      expect(String(e.health_connect)).not.toMatch(banned);
    }
    expect(JSON.stringify(contractDocument())).not.toMatch(/glucose|cgm|hba1c/i);
  });

  it('A codes outside v1 (vo2_max, sleep_efficiency, blood pressure, habits) are not accepted', () => {
    const v1 = new Set(HEALTH_SYNC_CATALOGUE_V1.map((e) => e.type));
    for (const c of HEALTH_CODES.filter((x) => !v1.has(x.key))) expect(syncCatalogueEntry(c.key)).toBeNull();
    expect(syncCatalogueEntry('blood_glucose')).toBeNull();
  });
});

describe('GET /contract document', () => {
  it('names the version, supported majors, four categories with their sync_* keys, limits and every error code', () => {
    const doc = contractDocument();
    expect(doc).toMatchObject({ ok: true, contract_version: '1.0', supported_majors: [1], max_minor: 0 });
    expect(doc.catalogue.map((c) => [c.category, c.consent_key])).toEqual([
      ['activity', 'sync_activity'], ['sleep', 'sync_sleep'], ['heart', 'sync_heart'], ['body', 'sync_body'],
    ]);
    expect(doc.limits).toMatchObject({ max_compressed_bytes: 524288, max_inflated_bytes: 4194304, max_records: 1000, max_deletions: 1000, too_old_days: 400, future_tolerance_minutes: 5 });
    expect(Object.keys(doc.error_codes.batch).sort()).toEqual(Object.keys(BATCH_ERROR_CODES).sort());
    expect(doc.error_codes.batch.RATE_LIMITED).toEqual({ status: 429, retryable: true });
    expect(doc.error_codes.batch.CONSENT_REQUIRED).toEqual({ status: 403, retryable: false });
    expect(doc.error_codes.record).toEqual([...RECORD_ERROR_CODES]);
  });
});

describe('parseHealthSyncBatch', () => {
  it('accepts a valid batch', () => {
    expect(parseHealthSyncBatch(validBatch())).toMatchObject({ ok: true });
  });

  it('a body user_id or tenant_id is INVALID_BATCH (unknown field) — identity only from the JWT', () => {
    for (const k of ['user_id', 'tenant_id']) {
      const r = parseHealthSyncBatch(validBatch({ [k]: 'someone-else' }));
      expect(r).toEqual({ ok: false, code: 'INVALID_BATCH', details: [{ path: '', code: 'unknown_field' }] });
    }
  });

  it('unknown fields at every level are refused with their path', () => {
    const b = validBatch();
    (b.records[0] as Record<string, unknown>).extra = 1;
    const r = parseHealthSyncBatch(b);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.details).toEqual([{ path: 'records.0', code: 'unknown_field' }]);
  });

  it('contract version: a new major or a newer minor is UNSUPPORTED_CONTRACT_VERSION, garbage is INVALID_BATCH', () => {
    expect(checkContractVersion('1.0')).toEqual({ ok: true });
    expect(checkContractVersion('2.0')).toEqual({ ok: false, code: 'UNSUPPORTED_CONTRACT_VERSION' });
    expect(checkContractVersion('1.1')).toEqual({ ok: false, code: 'UNSUPPORTED_CONTRACT_VERSION' });
    expect(checkContractVersion('one')).toEqual({ ok: false, code: 'INVALID_BATCH' });
    expect(parseHealthSyncBatch(validBatch({ contract_version: '2.0', future_field: true }))).toEqual({ ok: false, code: 'UNSUPPORTED_CONTRACT_VERSION' });
  });

  it('limits: more than 1,000 records or deletions is INVALID_BATCH', () => {
    const rec = validBatch().records[0];
    const many = Array.from({ length: HEALTH_SYNC_LIMITS.maxRecords + 1 }, (_, i) => ({ ...rec, record_id: `r${i}` }));
    expect(parseHealthSyncBatch(validBatch({ records: many })).ok).toBe(false);
    const dels = Array.from({ length: HEALTH_SYNC_LIMITS.maxDeletions + 1 }, (_, i) => ({ record_id: `r${i}`, type: 'steps' }));
    expect(parseHealthSyncBatch(validBatch({ deletions: dels })).ok).toBe(false);
  });

  it('times need an offset; the source platform must match the store', () => {
    const b = validBatch();
    b.records[0].start = '2026-10-13T08:00:00';
    expect(parseHealthSyncBatch(b).ok).toBe(false);
    const wrong = validBatch({ source: { ...validBatch().source, platform: 'android' } });
    expect(parseHealthSyncBatch(wrong)).toEqual({ ok: false, code: 'INVALID_BATCH', details: [{ path: 'source.platform', code: 'platform_mismatch' }] });
  });

  it('validation details never echo submitted values', () => {
    const r = parseHealthSyncBatch(validBatch({ batch_id: 'SECRET-VALUE-123' }));
    expect(JSON.stringify(r)).not.toContain('SECRET-VALUE-123');
  });
});
