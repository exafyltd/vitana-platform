/**
 * VTID-05012: Jev self-healing observability.
 *
 *   A. a gate that is on but does not ask Jev writes one $0 `skipped` row with a reason;
 *   B. an abstained row is scored on its below-threshold answer (`lean_agreed`), while `agreed`
 *      stays decided-only;
 *   C. `jevGateHealth` marks a gate silent after 48 h without any row.
 */
const rows: any[] = [];
const outcomes: any[] = [];
let insertError: { code?: string; message: string } | null = null;
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    if (insertError) return { data: null, error: insertError };
    // The partial unique index (gate, subject_ref, skip_reason) WHERE jev_outcome = 'skipped'.
    if (row.jev_outcome === 'skipped' && rows.some((r) => r.jev_outcome === 'skipped' && r.gate === row.gate && r.subject_ref === row.subject_ref && r.skip_reason === row.skip_reason)) {
      return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_jev_shadow_skip"' } };
    }
    rows.push({ ...row, id: `s${rows.length + 1}` });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
  updateShadowOutcome: jest.fn(async (_sb: unknown, id: string, patch: any) => {
    outcomes.push({ id, ...patch });
    return { data: null, error: null };
  }),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import { JEV_HEALTH_MIN_DAYS, JEV_NON_GATE_MODE_VARS, JEV_SILENT_AFTER_MS, jevGateHealth, recordJevGateSkip, recordJevShadowOutcome } from '../src/services/jev/jev-shadow';
import { runCiFailureRouting } from '../src/services/jev/gates/ci-failure-gate';
import { runFixVerificationCheck } from '../src/services/jev/gates/fix-verification-gate';
import { runChangeRiskCheck } from '../src/services/jev/gates/change-risk-gate';
import { runTestSelectionCheck } from '../src/services/jev/gates/test-selection-gate';
import { recordPlannabilityOutcome, runPlannabilityCheck } from '../src/services/jev/gates/plannability-gate';
import { runVoiceOutcomeCheck } from '../src/services/jev/gates/voice-outcome-gate';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const sb = {} as any;
const skips = () => rows.filter((r) => r.jev_outcome === 'skipped');

beforeEach(() => {
  rows.length = 0;
  outcomes.length = 0;
  insertError = null;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-05012 A: recordJevGateSkip', () => {
  const SKIP = {
    gate: 'ci_failure_routing', decision: 'ci_failure_bucket', mode: 'shadow' as const, reason: 'no_ci_evidence',
    subject_type: 'dev_autopilot_execution', subject_ref: 'e1', system_action: 'self_heal_fix_mode',
  };

  test('writes one $0 skipped row with the reason and the gate mode', async () => {
    expect(await recordJevGateSkip(SKIP, sb)).toBe('s1');
    expect(rows).toEqual([expect.objectContaining({
      gate: 'ci_failure_routing', decision: 'ci_failure_bucket', mode: 'shadow', plane: 'internal', tenant_id: null,
      subject_type: 'dev_autopilot_execution', subject_ref: 'e1', jev_outcome: 'skipped', skip_reason: 'no_ci_evidence',
      jev_verdict: null, jev_confidence: null, system_action: 'self_heal_fix_mode', cost_usd: 0,
    })]);
  });

  test('a repeat of the same (gate, subject, reason) writes no second row; a new reason does', async () => {
    await recordJevGateSkip(SKIP, sb);
    expect(await recordJevGateSkip(SKIP, sb)).toBeNull();
    await recordJevGateSkip({ ...SKIP, reason: 'error' }, sb);
    expect(skips().map((r) => r.skip_reason)).toEqual(['no_ci_evidence', 'error']);
  });

  test('enforce mode is recorded as enforce', async () => {
    await recordJevGateSkip({ ...SKIP, mode: 'enforce' }, sb);
    expect(rows[0].mode).toBe('enforce');
  });

  test('no client, an insert error or an empty subject: null, never throws', async () => {
    expect(await recordJevGateSkip(SKIP, null)).toBeNull();
    expect(await recordJevGateSkip({ ...SKIP, subject_ref: '' }, sb)).toBeNull();
    insertError = { message: 'boom' };
    await expect(recordJevGateSkip(SKIP, sb)).resolves.toBeNull();
    expect(rows).toEqual([]);
  });
});

describe('VTID-05012 A: gates write a skipped row where they used to end silently', () => {
  const ON = (gateEnv: string, mode = 'shadow') => ({ ...JEV_ON, [gateEnv]: mode }) as NodeJS.ProcessEnv;

  test('ci_failure_routing: no usable log excerpt → skipped no_ci_evidence, Jev not asked', async () => {
    const call = jest.fn();
    const evidence = [{ check_name: 'test', excerpt: '', unavailable: true }] as any;
    expect(await runCiFailureRouting({ executionId: 'e1', failedChecks: ['test'], evidence, env: ON('JEV_CI_FAILURE_ROUTING_MODE'), sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(rows).toEqual([expect.objectContaining({ gate: 'ci_failure_routing', jev_outcome: 'skipped', skip_reason: 'no_ci_evidence', subject_ref: 'e1' })]);
  });

  test('mode off (default and typo) writes nothing', async () => {
    const evidence = [{ check_name: 'test', excerpt: '', unavailable: true }] as any;
    for (const env of [JEV_ON, ON('JEV_CI_FAILURE_ROUTING_MODE', 'on')]) {
      expect(await runCiFailureRouting({ executionId: 'e1', failedChecks: ['test'], evidence, env, sb })).toBeNull();
    }
    expect(rows).toEqual([]);
  });

  test('the normal decided path writes the decision row and no skipped row', async () => {
    const call = jest.fn().mockResolvedValue({
      ok: true, model: 'jev-1.13.0',
      answers: { bucket: { type: 'choice', choice: 'test', probabilities: { test: 0.9 }, confidence: 0.9 } },
      usage: { input_tokens: 300, output_tokens: 2 }, latency_ms: 20, attempts: 1,
    });
    const evidence = [{ check_name: 'Gateway Jest', excerpt: 'FAIL test/x.test.ts\n  ● foo › returns the right value' }] as any;
    await runCiFailureRouting({ executionId: 'e2', failedChecks: ['Gateway Jest'], evidence, env: ON('JEV_CI_FAILURE_ROUTING_MODE'), sb, decideOptions: { call } });
    expect(rows).toHaveLength(1);
    expect(rows[0].jev_outcome).not.toBe('skipped');
    expect(rows[0].skip_reason).toBeUndefined();
  });

  test('fix_verification: no fix context → skipped no_fix_context', async () => {
    const verdict = { state: 'pass', probe: null } as any;
    await runFixVerificationCheck({ executionId: 'e3', verdict, load: async () => null, env: ON('JEV_FIX_VERIFICATION_MODE'), sb });
    expect(skips()).toEqual([expect.objectContaining({ gate: 'fix_verification', skip_reason: 'no_fix_context', system_action: 'verification_pass' })]);
  });

  test('change_risk and test_selection: a thrown error → skipped error (was a console line only)', async () => {
    const boom = jest.fn().mockRejectedValue(new Error('net'));
    // decide() itself never throws, so break the gate's own input handling.
    const brokenInput = { get files(): string[] { throw new Error('bad input'); } } as any;
    await runChangeRiskCheck({ executionId: 'e4', input: brokenInput, env: ON('JEV_CHANGE_RISK_MODE'), sb, decideOptions: { call: boom } });
    await runTestSelectionCheck({
      executionId: 'e5', title: 't', input: { changed_files: ['a.ts'], candidates: [{ path: 'test/a.test.ts', imports_changed: ['a.ts'], test_titles: [] }], importers_total: 1 } as any,
      env: ON('JEV_TEST_SELECTION_MODE'), sb, decideOptions: { call: boom },
    });
    expect(skips().map((r) => [r.gate, r.skip_reason, r.subject_ref])).toEqual([
      ['change_risk', 'error', 'e4'],
      ['test_selection', 'error', 'e5'],
    ]);
  });
});

describe('VTID-05012 B: abstained rows are scored on their lean', () => {
  const PLAN = { ...JEV_ON, JEV_PLANNABILITY_MODE: 'shadow' } as NodeJS.ProcessEnv;
  const FINDING = { id: 'f1', title: 'Missing tests for diary-service.ts', summary: 'createEntry has no unit test.' };
  const plannable = (p: number) => ({
    ok: true, model: 'jev-1.13.0',
    answers: { plannable: { type: 'noul', noul: p }, blocker: { type: 'choice', choice: 'none', probabilities: { none: 0.8 }, confidence: 0.8 } },
    usage: { input_tokens: 300, output_tokens: 2 }, latency_ms: 20, attempts: 1,
  });

  test('plannability abstained: lean kept, lean_agreed written, agreed stays null', async () => {
    const check = runPlannabilityCheck({ finding: FINDING, env: PLAN, sb, decideOptions: { call: jest.fn().mockResolvedValue(plannable(0.6)) } });
    const c = await check;
    expect(rows[0].jev_outcome).toBe('abstained');
    expect(c).toMatchObject({ shadow_id: 's1', plannable: null, lean: true });
    expect(rows[0].jev_verdict).toMatchObject({ plannable: null, lean: true });
    await recordPlannabilityOutcome(Promise.resolve(c), { ok: true, files: 2 } as any, sb);
    expect(outcomes).toEqual([expect.objectContaining({ id: 's1', outcome: 'plan_with_files', agreed: null, lean_agreed: true })]);
  });

  test('plannability decided: no lean, lean_agreed untouched, agreed as before', async () => {
    const c = await runPlannabilityCheck({ finding: FINDING, env: PLAN, sb, decideOptions: { call: jest.fn().mockResolvedValue(plannable(0.05)) } });
    expect(c).toEqual({ shadow_id: 's1', plannable: false });
    await recordPlannabilityOutcome(Promise.resolve(c), { ok: true, files: 0 } as any, sb);
    expect(outcomes[0]).toMatchObject({ agreed: true });
    expect(outcomes[0]).not.toHaveProperty('lean_agreed');
  });

  test('plannability abstained but the outcome is an infra error: lean_agreed null', async () => {
    const c = await runPlannabilityCheck({ finding: FINDING, env: PLAN, sb, decideOptions: { call: jest.fn().mockResolvedValue(plannable(0.6)) } });
    await recordPlannabilityOutcome(Promise.resolve(c), { ok: false, error: 'Bedrock invoke_failed: throttled' } as any, sb);
    expect(outcomes[0]).toMatchObject({ agreed: null });
    expect(['plan_infra_error', 'plan_failed']).toContain(outcomes[0].outcome);
  });

  test('recordJevShadowOutcome leaves lean_agreed out unless given', async () => {
    await recordJevShadowOutcome('x', 'o', true, sb);
    await recordJevShadowOutcome('y', 'o', null, sb, false);
    expect(outcomes[0]).not.toHaveProperty('lean_agreed');
    expect(outcomes[1]).toMatchObject({ lean_agreed: false });
  });

  const VOICE = { ...JEV_ON, JEV_VOICE_SESSION_OUTCOME_MODE: 'shadow' } as NodeJS.ProcessEnv;
  const metrics = { audio_in_chunks: 400, audio_in_forwarded: 380, audio_out_chunks: 2, duration_ms: 45_000, turn_count: 0, user_turns: 3, model_turns: 0 };
  const signals = { stop_reason: 'user_stop', provider: 'nova_sonic', lang: 'de', greeting_sent: true, reconnects: 0, watchdog_reason: null, tool_call_streak: 0 };
  const voice = (choice: string, conf: number) => ({
    ok: true, model: 'jev-1.13.0',
    answers: { outcome: { type: 'choice', choice, probabilities: { [choice]: conf }, confidence: conf }, needs_fix: { type: 'noul', noul: 0.8 } },
    usage: { input_tokens: 300, output_tokens: 2 }, latency_ms: 20, attempts: 1,
  });

  test('voice_session_outcome abstained: lean_agreed at insert, agreed null', async () => {
    await runVoiceOutcomeCheck({ sessionId: 'v1', metrics, signals, ruleClass: 'voice.no_engagement', env: VOICE, sb, decideOptions: { call: jest.fn().mockResolvedValue(voice('no_engagement', 0.3)) } });
    expect(rows[0]).toMatchObject({ jev_outcome: 'abstained', agreed: null, lean_agreed: true, outcome: 'compared_with_rule_class' });
    expect(rows[0].jev_verdict).toMatchObject({ lean: 'no_engagement' });
  });

  test('voice_session_outcome decided: agreed as before, lean_agreed null', async () => {
    await runVoiceOutcomeCheck({ sessionId: 'v2', metrics, signals, ruleClass: 'voice.model_stall', env: VOICE, sb, decideOptions: { call: jest.fn().mockResolvedValue(voice('no_engagement', 0.95)) } });
    expect(rows[0]).toMatchObject({ jev_outcome: 'decided', agreed: false, lean_agreed: null, outcome: 'compared_with_rule_class' });
    expect(rows[0].jev_verdict).not.toHaveProperty('lean');
  });

  test('voice_session_outcome abstained with no rule class: nothing compared', async () => {
    await runVoiceOutcomeCheck({ sessionId: 'v3', metrics, signals, ruleClass: null, env: VOICE, sb, decideOptions: { call: jest.fn().mockResolvedValue(voice('no_engagement', 0.3)) } });
    expect(rows[0]).toMatchObject({ jev_outcome: 'abstained', agreed: null, lean_agreed: null, outcome: null, outcome_at: null });
  });
});

describe('VTID-05012 C: jevGateHealth', () => {
  const NOW = Date.parse('2026-10-09T12:00:00Z');
  const ENV = {
    JEV_CI_FAILURE_ROUTING_MODE: 'shadow',
    JEV_PLANNABILITY_MODE: 'enforce',
    JEV_PR_CLASH_MODE: 'off',
    JEV_REPEAT_RUN_GUARD_MODE: 'typo',
    JEV_FIX_VERIFICATION_MODE: 'shadow',
    OTHER: 'x',
  } as NodeJS.ProcessEnv;

  test('only gates that are on; silent past 48 h or with no row in the window', () => {
    const justInside = new Date(NOW - JEV_SILENT_AFTER_MS).toISOString();
    const justOutside = new Date(NOW - JEV_SILENT_AFTER_MS - 1).toISOString();
    const h = jevGateHealth(
      [
        { gate: 'ci_failure_routing', last_row_at: justOutside },
        { gate: 'plannability', last_row_at: justInside },
        { gate: 'pr_clash', last_row_at: justInside },
      ],
      ENV,
      NOW,
    );
    expect(h).toEqual([
      { gate: 'ci_failure_routing', env: 'JEV_CI_FAILURE_ROUTING_MODE', mode: 'shadow', last_row_at: justOutside, silent: true },
      { gate: 'fix_verification', env: 'JEV_FIX_VERIFICATION_MODE', mode: 'shadow', last_row_at: null, silent: true },
      { gate: 'plannability', env: 'JEV_PLANNABILITY_MODE', mode: 'enforce', last_row_at: justInside, silent: false },
    ]);
  });

  test('member quota and community rate switches are not gates and are never listed', () => {
    const env = { JEV_MEMBER_QUOTA_MODE: 'enforce', JEV_COMMUNITY_RATE_MODE: 'shadow', JEV_PLANNABILITY_MODE: 'shadow' } as NodeJS.ProcessEnv;
    expect(jevGateHealth([], env, NOW).map((h) => h.gate)).toEqual(['plannability']);
    expect([...JEV_NON_GATE_MODE_VARS].sort()).toEqual(['JEV_COMMUNITY_RATE_MODE', 'JEV_MEMBER_QUOTA_MODE']);
  });

  test('drift guard: every JEV_*_MODE the gateway reads or a deploy pins is a shadow gate or a listed non-gate switch', () => {
    const root = path.join(__dirname, '../../..');
    const gatesDir = path.join(__dirname, '../src/services/jev/gates');
    const gateSrc = fs.readdirSync(gatesDir).map((f) => fs.readFileSync(path.join(gatesDir, f), 'utf8')).join('\n');
    const sources = [
      ...['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml'].map((f) => fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8')),
      fs.readFileSync(path.join(__dirname, '../src/services/jev/jev-member-quota.ts'), 'utf8'),
      fs.readFileSync(path.join(__dirname, '../src/services/jev/jev-community-rate.ts'), 'utf8'),
    ].join('\n');
    const vars = [...new Set(sources.match(/JEV_[A-Z0-9_]+_MODE\b/g) || [])];
    expect(vars.length).toBeGreaterThan(20);
    const unknown = vars.filter((v) => {
      if (JEV_NON_GATE_MODE_VARS.has(v)) return false;
      const gate = v.replace(/^JEV_/, '').replace(/_MODE$/, '').toLowerCase();
      return !gateSrc.includes(`'${gate}'`);
    });
    expect(unknown).toEqual([]);
  });

  test('the admin route asks for a window of at least JEV_HEALTH_MIN_DAYS for gate health', () => {
    expect(JEV_HEALTH_MIN_DAYS * 24 * 60 * 60 * 1000).toBeGreaterThanOrEqual(JEV_SILENT_AFTER_MS);
  });

  test('no stats (RPC failed) → every gate that is on reads silent', () => {
    expect(jevGateHealth(null, { JEV_PLANNABILITY_MODE: 'shadow' } as NodeJS.ProcessEnv, NOW)).toEqual([
      { gate: 'plannability', env: 'JEV_PLANNABILITY_MODE', mode: 'shadow', last_row_at: null, silent: true },
    ]);
  });
});

describe('VTID-05012 migration', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../../supabase/migrations/20261009120000_vtid_05012_jev_gate_observability.sql'), 'utf8');

  test('adds skipped to the outcome check, the two columns, the partial unique index and the RPC fields', () => {
    expect(sql).toMatch(/CHECK \(jev_outcome IN \('decided','abstained','fallback','failed','denied','invalid','skipped'\)\)/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS skip_reason TEXT/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS lean_agreed BOOLEAN/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_jev_shadow_skip\s+ON public\.jev_shadow_decisions \(gate, subject_ref, skip_reason\)\s+WHERE jev_outcome = 'skipped'/);
    for (const col of ['skipped BIGINT', 'last_row_at TIMESTAMPTZ', 'lean_compared BIGINT', 'lean_agreed BIGINT']) expect(sql).toContain(col);
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE s\.jev_outcome <> 'skipped'\) AS calls/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.jev_shadow_gate_stats\(INT\) TO service_role/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.jev_shadow_gate_stats\(INT\) FROM PUBLIC, anon, authenticated/);
  });
});
