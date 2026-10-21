/**
 * VTID-05168 — Life Timeline P2: every Vitana Index recompute is locked and
 * recorded, and pillar logs become timeline moments linked to the movement.
 *
 * - recordIndexRecompute calls vitana_index_recompute_and_record with the
 *   trigger and source; falls back to the legacy RPC ONLY when the recording
 *   function does not exist yet (migration not applied); any other error is
 *   returned, never retried.
 * - writePillarLogMoment writes a catalog `health.log.*` moment carrying the
 *   movement id; every log kind is a visible moment of the right pillar.
 * - A voice water log writes `health.log.water` linked to the movement.
 * - CI guard (sparring F15): no gateway code writes vitana_index_scores or
 *   calls the core / legacy RPC directly — the recording function is the only
 *   writer. The migration routes every SQL-side path through it too.
 */
import * as fs from 'fs';
import * as path from 'path';

const writeTimelineRow = jest.fn(async (_row: Record<string, unknown>) => undefined);
jest.mock('../src/services/timeline-projector', () => ({
  writeTimelineRow: (row: Record<string, unknown>) => writeTimelineRow(row),
}));

import { createQueryMock } from './services/voice-tools/supabase-mock';
const mock = createQueryMock();
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => mock.client) }));

import {
  recordIndexRecompute,
  RECORDING_RPC,
  LEGACY_RPC,
  INDEX_RECOMPUTE_TRIGGERS,
} from '../src/services/vitana-index/record-recompute';
import { writePillarLogMoment, FEATURE_KEY_TO_LOG_KIND } from '../src/services/vitana-index/pillar-log-moment';
import { classifyActivityType } from '../src/services/timeline/catalog';
import { logHealthSignal } from '../src/services/voice-tools/health-log';

const SRC = path.resolve(__dirname, '../src');
const REPO = path.resolve(__dirname, '../../..');
const MIGRATION = path.join(REPO, 'supabase/migrations/20261014140000_vtid_05168_index_movements.sql');

function rpcStub(responses: Record<string, { data: unknown; error: unknown }>) {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    rpc: jest.fn(async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      return responses[name] ?? { data: null, error: null };
    }),
  };
}

describe('VTID-05168 recordIndexRecompute', () => {
  it('calls the recording function with trigger and source', async () => {
    const sb = rpcStub({ [RECORDING_RPC]: { data: { ok: true, score_total: 300, movement_id: 'm1' }, error: null } });
    const r = await recordIndexRecompute(sb as never, {
      userId: 'u1', date: '2026-10-14', trigger: 'voice_log', sourceKind: 'health_feature', sourceRef: 'water_intake',
    });
    expect(r.data?.movement_id).toBe('m1');
    expect(sb.calls).toEqual([{
      name: RECORDING_RPC,
      params: { p_user_id: 'u1', p_date: '2026-10-14', p_trigger: 'voice_log', p_source_kind: 'health_feature', p_source_ref: 'water_intake', p_model_version: 'v3-5pillar' },
    }]);
  });

  it.each([
    [{ code: 'PGRST202', message: 'Could not find the function public.vitana_index_recompute_and_record' }],
    [{ message: 'function public.vitana_index_recompute_and_record(uuid, date, text, text, text, text) does not exist' }],
  ])('falls back to the legacy RPC only while the recording function is missing (%o)', async (err) => {
    const sb = rpcStub({
      [RECORDING_RPC]: { data: null, error: err },
      [LEGACY_RPC]: { data: { ok: true, score_total: 300 }, error: null },
    });
    const r = await recordIndexRecompute(sb as never, { userId: 'u1', date: '2026-10-14', trigger: 'diary' });
    expect(r.error).toBeNull();
    expect(r.data?.score_total).toBe(300);
    expect(sb.calls.map((c) => c.name)).toEqual([RECORDING_RPC, LEGACY_RPC]);
    expect(sb.calls[1].params).toEqual({ p_user_id: 'u1', p_date: '2026-10-14', p_model_version: 'v3-5pillar' });
  });

  it('returns any other error without retrying', async () => {
    const sb = rpcStub({ [RECORDING_RPC]: { data: null, error: { code: '42501', message: 'permission denied' } } });
    const r = await recordIndexRecompute(sb as never, { userId: 'u1', date: '2026-10-14', trigger: 'manual_log' });
    expect(r.error?.message).toBe('permission denied');
    expect(sb.calls).toHaveLength(1);
  });

  it('every trigger the gateway sends is a valid SQL trigger token', () => {
    for (const t of INDEX_RECOMPUTE_TRIGGERS) expect(t).toMatch(/^[a-z][a-z0-9_]{1,40}$/);
  });
});

describe('VTID-05168 pillar log moments', () => {
  beforeEach(() => writeTimelineRow.mockClear());

  it.each([
    ['water', 'hydration'],
    ['meal', 'nutrition'],
    ['exercise', 'exercise'],
    ['sleep', 'sleep'],
    ['meditation', 'mental'],
    ['mood', 'mental'],
    ['stress', 'mental'],
  ])('health.log.%s is a visible moment of the %s pillar', (kind, pillar) => {
    expect(classifyActivityType(`health.log.${kind}`)).toMatchObject({ tier: 'moment', pillar, matched: `health.log.${kind}` });
  });

  it('every mapped feature key is one the Index counts', () => {
    const counted = new Set([
      'biomarker_glucose', 'biomarker_hba1c', 'meal_log', 'macro_balance', 'water_intake', 'hydration_log',
      'wearable_heart_rate', 'wearable_steps', 'wearable_workout', 'vo2_max', 'wearable_sleep_duration',
      'wearable_sleep_efficiency', 'wearable_hrv', 'wearable_sleep_stages', 'wearable_stress', 'mood_entry',
      'meditation_minutes', 'journal_entry',
    ]);
    for (const key of Object.keys(FEATURE_KEY_TO_LOG_KIND)) expect(counted.has(key)).toBe(true);
  });

  it('writes the moment with the movement id and only the provided params', async () => {
    await writePillarLogMoment({
      userId: 'u1', kind: 'water', via: 'manual', date: '2026-10-14', movementId: 'm9',
      params: { amount_ml: 500, ignored: undefined, empty: '' },
    });
    expect(writeTimelineRow).toHaveBeenCalledWith({
      user_id: 'u1',
      activity_type: 'health.log.water',
      activity_data: { via: 'manual', date: '2026-10-14', movement_id: 'm9', amount_ml: 500 },
      dedupe_key: undefined,
      source: 'projector:health_log_manual',
    });
  });

  it('a voice water log writes health.log.water linked to the recorded movement', async () => {
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
    for (const t of ['user_tenants', 'vitana_index_scores', 'health_features_daily', 'user_integrations']) {
      mock.setTable(t, { data: null, error: null });
    }
    mock.setRpc(RECORDING_RPC, { data: { ok: true, score_total: 210, score_hydration: 52, movement_id: 'mv-1' }, error: null });
    const r = await logHealthSignal({ user_id: 'u1', tenant_id: 't1', tool: 'log_water', date: '2026-10-14', amount_ml: 500 } as never);
    expect(r.ok).toBe(true);
    expect(mock.rpcCalls.some((c: any) => c.name === RECORDING_RPC && c.params?.p_trigger === 'voice_log' && c.params?.p_source_ref === 'water_intake')).toBe(true);
    expect(writeTimelineRow).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'u1',
      activity_type: 'health.log.water',
      activity_data: expect.objectContaining({ via: 'voice', movement_id: 'mv-1', amount_ml: 500 }),
    }));
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js)$/.test(e.name) && !p.includes(`${path.sep}frontend${path.sep}`)) out.push(p);
  }
  return out;
}

describe('VTID-05168 single writer guard', () => {
  const files = walk(SRC);
  const allowed = path.join(SRC, 'services/vitana-index/record-recompute.ts');

  it('no gateway code writes vitana_index_scores directly', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8');
      const re = /from\(\s*['"]vitana_index_scores['"]\s*\)(?=([\s\S]{0,400}))/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        const chain = m[1].split(/;\s*\n/)[0];
        if (/\.(upsert|insert|update|delete)\(/.test(chain)) offenders.push(path.relative(SRC, f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only record-recompute.ts calls the legacy or core compute RPC', () => {
    const offenders = files
      .filter((f) => f !== allowed)
      .filter((f) => /rpc\(\s*['"](health_compute_vitana_index_for_user|health_compute_vitana_index_core)['"]/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('the migration routes every SQL-side recompute through the recording function', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toMatch(/RENAME TO health_compute_vitana_index_core/);
    for (const trigger of ["'unspecified'", "'daily'", "'calendar_completion'", "'self_heal'"]) {
      expect(sql).toContain(`vitana_index_recompute_and_record(`);
      expect(sql).toContain(trigger);
    }
    // Members keep the two overloads; never the recording function or the core.
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.vitana_index_recompute_and_record\([^)]*\) FROM anon, authenticated/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.health_compute_vitana_index_core\([^)]*\) FROM anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.health_compute_vitana_index\(date, text\) TO authenticated/);
  });
});
