/**
 * VTID-05164 (Health Hub Phase 1 / C1): the Health Sync consent keys migration,
 * read from the file, against the gateway's registries. Its behaviour on a
 * real Postgres (rows, CHECKs, fn_set_health_consent, privileges, the
 * VTID-05156 revoke in place, idempotency, the prerequisite guard) is tested by
 * scripts/ci/sql-tests/run-health-sync-consent-test.sh (CI SQL-HEALTH-SYNC-CONSENT.yml).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  D10_WP1_CONSENT_KEYS,
  HEALTH_CONSENT_CATEGORY_KEYS,
  HEALTH_CONSENT_CATEGORY_MAP,
  HEALTH_CONSENT_ENFORCEMENT_POINTS,
  HEALTH_SYNC_SOURCE_KINDS,
  MEMBER_GRANTED_VIA,
  type HealthConsentCategoryKey,
} from '../../src/services/consent/health-consent';
import { getConnector } from '../../src/connectors';
import { HEALTH_STORE_CONSENT_KEY_MAP } from '../../src/services/health-store/consent-gate';

const ROOT = path.join(__dirname, '../../../..');
const MIGRATIONS = path.join(ROOT, 'supabase/migrations');
const files = fs.readdirSync(MIGRATIONS);
const file = files.find((f) => /_vtid_05164_health_sync_consent_keys\.sql$/.test(f)) ?? '';
const sql = file ? fs.readFileSync(path.join(MIGRATIONS, file), 'utf8') : '';
const code = sql.replace(/--[^\n]*/g, '');
const d10File = files.find((f) => /_vtid_05092_health_consent_categories\.sql$/.test(f)) as string;
const d10 = fs.readFileSync(path.join(MIGRATIONS, d10File), 'utf8').replace(/--[^\n]*/g, '');
const C1_KEYS = ['sync_activity', 'sync_sleep', 'sync_heart', 'sync_body', 'self_logged_health'] as const;
const D10_GRANTED_VIA = ['checkout_flow', 'settings_connected_apps', 'portal_admin_backfill', 'settings_privacy', 'partner_link_confirm'];

function fnBody(text: string): string {
  return text.slice(text.indexOf('CREATE OR REPLACE FUNCTION public.fn_set_health_consent('), text.indexOf('COMMENT ON FUNCTION public.fn_set_health_consent'));
}

function seedRows(text: string) {
  const block = text.slice(text.lastIndexOf('INSERT INTO public.health_consent_categories'), text.lastIndexOf('ON CONFLICT (key) DO NOTHING'));
  return [...block.matchAll(/\('(\w+)',\s*'(\w+)',\s*'([\w:]+)',\s*(TRUE|FALSE),\s*'(\w+)',\s*(TRUE|FALSE),\s*(\d+)\)/g)].map((m) => ({
    key: m[1],
    resource_type: m[2],
    scope: m[3],
    per_resource: m[4] === 'TRUE',
    current_text_version: m[5],
    processing_active: m[6] === 'TRUE',
    sort: Number(m[7]),
  }));
}

describe('VTID-05164 migration', () => {
  it('exists and is ordered strictly after VTID-05092 (D10 WP1) and VTID-05156 (legacy revoke)', () => {
    expect(file).toBe('20261014130000_vtid_05164_health_sync_consent_keys.sql');
    const ts = (f: string) => f.slice(0, 14);
    expect(ts(file) > ts(d10File)).toBe(true);
    const revoke = files.find((f) => /_vtid_05156_revoke_wearable_samples_rpc\.sql$/.test(f)) as string;
    expect(ts(file) > ts(revoke)).toBe(true);
  });

  it('is one transaction that refuses to run without VTID-05092 and checks its end state', () => {
    expect(code.trim().startsWith('BEGIN;')).toBe(true);
    expect(code.trim().endsWith('COMMIT;')).toBe(true);
    expect(code).toMatch(/apply 20261012180000_vtid_05092_health_consent_categories\.sql first/);
    expect(code).toMatch(/DO \$check\$/);
  });

  it('is additive: no table/column/function drop, no delete or truncate; only the two CHECKs are replaced, by definition', () => {
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|FUNCTION|TRIGGER|POLICY)\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bCREATE\s+TABLE\b/i); // nothing for the migration drift check to track
    const drops = code.match(/\bDROP\s+CONSTRAINT\b[^;]*/gi) ?? [];
    expect(drops).toHaveLength(2);
    expect(code).toMatch(/conrelid = 'public\.connector_registry'::regclass[\s\S]*ILIKE '%category%'/);
    expect(code).toMatch(/conrelid = 'public\.data_sharing_consents'::regclass[\s\S]*ILIKE '%granted_via%'/);
  });

  it('seeds the five Phase 1 keys exactly as the static map says, processing_active, never resetting a version', () => {
    const rows = seedRows(code);
    expect(rows.map((r) => r.key)).toEqual([...C1_KEYS]);
    for (const r of rows) {
      expect(HEALTH_CONSENT_CATEGORY_MAP[r.key as HealthConsentCategoryKey]).toEqual({ resource_type: r.resource_type, scope: r.scope, per_resource: r.per_resource });
      expect(r.current_text_version).toBe('v1');
      expect(r.processing_active).toBe(true);
    }
    expect(code).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
    // D10 seed + C1 seed = the whole union, in order
    expect(HEALTH_CONSENT_CATEGORY_KEYS).toEqual([...D10_WP1_CONSENT_KEYS, ...C1_KEYS]);
    // no default-on column, no consent row
    expect(code).not.toMatch(/default_on|granted_by_default|default_granted/i);
    const outsideFn = code.replace(fnBody(code), '');
    expect(outsideFn).not.toMatch(/INSERT INTO public\.data_sharing_consents\b/);
  });

  it('catalogue guard: every processing_active key names enforcement points that exist and check it', () => {
    for (const r of seedRows(code).filter((x) => x.processing_active)) {
      const points = HEALTH_CONSENT_ENFORCEMENT_POINTS[r.key as HealthConsentCategoryKey];
      expect(points && points.length).toBeTruthy();
      for (const p of points ?? []) {
        const text = fs.readFileSync(path.join(ROOT, p), 'utf8');
        const checks = text.includes(`'${r.key}'`) || (r.key.startsWith('sync_') && text.includes('HEALTH_SYNC_CONSENT_KEYS'));
        expect({ key: r.key, point: p, checks }).toEqual({ key: r.key, point: p, checks: true });
      }
    }
    // sync_* are enforced at the ingest route and in A's gate (S7)
    expect(HEALTH_CONSENT_ENFORCEMENT_POINTS.sync_sleep).toEqual(expect.arrayContaining(['services/gateway/src/routes/health-ingest.ts', 'services/gateway/src/services/health-store/consent-gate.ts']));
    expect(HEALTH_CONSENT_ENFORCEMENT_POINTS.self_logged_health).toEqual(['services/gateway/src/services/health-store/consent-gate.ts']);
  });

  it('the S7 consent-key map uses exactly these keys (C1 filled A2’s null entries)', () => {
    for (const kind of ['phone_store', 'aggregator'] as const) {
      expect(HEALTH_STORE_CONSENT_KEY_MAP[kind]).toEqual({ activity: 'sync_activity', sleep: 'sync_sleep', heart: 'sync_heart', body: 'sync_body', labs: null, habits: null });
    }
    for (const kind of ['diary', 'voice', 'manual'] as const) {
      expect(new Set(Object.values(HEALTH_STORE_CONSENT_KEY_MAP[kind]))).toEqual(new Set(['self_logged_health']));
    }
  });

  it('granted_via: the VTID-05092 values plus native_health_sync, in the CHECK and in the function', () => {
    const list = `'checkout_flow', 'settings_connected_apps', 'portal_admin_backfill',\\s+'settings_privacy', 'partner_link_confirm', 'native_health_sync'`;
    expect(code).toMatch(new RegExp(`CHECK \\(granted_via IN \\(\\s+${list}\\s+\\)\\)`));
    expect(fnBody(code)).toMatch(new RegExp(`p_granted_via NOT IN \\(\\s+${list}\\)`));
    for (const v of D10_GRANTED_VIA) expect(d10).toContain(`'${v}'`);
    for (const v of MEMBER_GRANTED_VIA) expect(code).toContain(`'${v}'`);
    expect(MEMBER_GRANTED_VIA).toContain('native_health_sync');
  });

  it('fn_set_health_consent is the VTID-05092 body except the granted_via list, and stays service_role only', () => {
    const norm = (s: string) => fnBody(s).replace(/,\s*'native_health_sync'/g, '').replace(/\s+/g, ' ').trim();
    expect(norm(code)).toBe(norm(d10));
    expect(fnBody(code)).toMatch(/SECURITY DEFINER\s+SET search_path = public, pg_temp/);
    const FN = 'public.fn_set_health_consent(uuid, uuid, text, text, text, text, text, text, text, uuid, text)';
    for (const role of ['PUBLIC', 'anon', 'authenticated']) expect(code).toContain(`REVOKE ALL ON FUNCTION ${FN} FROM ${role};`);
    expect(code).toContain(`GRANT EXECUTE ON FUNCTION ${FN} TO service_role;`);
    expect(code.match(/GRANT EXECUTE ON FUNCTION/g)).toHaveLength(1);
  });

  it('connector_registry: category CHECK superset with health_store; rows match the code registry', () => {
    expect(code).toMatch(/CHECK \(category IN \('social','wearable','shop','calendar','productivity','aggregator','ai_assistant','health_store'\)\)/);
    const prior = fs.readFileSync(path.join(MIGRATIONS, '20260419000000_vtid_02403_ai_assistants_phase1.sql'), 'utf8');
    expect(prior).toMatch(/CHECK \(category IN \('social','wearable','shop','calendar','productivity','aggregator','ai_assistant'\)\)/);
    for (const id of HEALTH_SYNC_SOURCE_KINDS) {
      const c = getConnector(id);
      expect(c).toMatchObject({ id, category: 'health_store', auth_type: 'sdk_bridge' });
      expect(code).toMatch(new RegExp(`\\('${id}', 'health_store', '${c!.display_name}',`));
    }
    expect(code).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it('the legacy consent-free RPC is closed by VTID-05156, not re-done here', () => {
    const revoke = fs.readFileSync(path.join(MIGRATIONS, '20261014120000_vtid_05156_revoke_wearable_samples_rpc.sql'), 'utf8');
    expect(revoke).toMatch(/REVOKE EXECUTE ON FUNCTION public\.health_ingest_wearable_samples\(jsonb\) FROM PUBLIC, anon, authenticated;/);
    expect(code).not.toMatch(/health_ingest_wearable_samples/);
  });
});

describe('VTID-05164 registries', () => {
  it('declares the Health Sync OASIS topics', () => {
    const cicd = fs.readFileSync(path.join(__dirname, '../../src/types/cicd.ts'), 'utf8');
    for (const t of ['health.sync.batch.processed', 'health.sync.batch.rejected', 'health.sync.source.paused', 'health.sync.source.resumed']) {
      expect(cicd).toContain(`| '${t}'`);
    }
  });

  it('DATABASE_SCHEMA.md records the change', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'DATABASE_SCHEMA.md'), 'utf8');
    expect(doc).toContain('20261014130000_vtid_05164_health_sync_consent_keys.sql');
  });

  it('the SQL test and its workflow exist', () => {
    expect(fs.existsSync(path.join(ROOT, 'scripts/ci/sql-tests/run-health-sync-consent-test.sh'))).toBe(true);
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/SQL-HEALTH-SYNC-CONSENT.yml'), 'utf8');
    expect(wf).toContain('scripts/ci/sql-tests/run-health-sync-consent-test.sh');
  });
});
