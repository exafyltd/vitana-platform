/**
 * VTID-04876 — /ops/attention adapters: one block per adapter, pinning the
 * numeric rubric (plan A "Phase 1 adapters + rubric", amended by N4/N5/N7).
 * Pure: every read is a fake; no network, no database.
 */

import {
  ATTENTION_ADAPTERS,
  autonomyAdapter,
  decisionsWaitingAdapter,
  governanceAdapter,
  operatorPipelineAdapter,
  releaseAdapter,
  serviceHealthAdapter,
  voiceSupervisorAdapter,
  HEALTH_HOLD_MS,
  type LedgerRow,
} from '../src/services/ops-attention-adapters';
import { fakeReads } from './fixtures/ops-attention-fakes';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const H = 60 * MIN;
const ctx = { now: NOW };

const health = (o: any) => ({ name: 'X', url: '/x', group: 'G', status: 'down', healthy: false, http_status: 500, latency_ms: 5, ...o });

describe('service_health adapter (N5 golden path)', () => {
  it('golden-path failing → P1, other failing → P2, degraded → P3; all held 2 min via state', async () => {
    const out = await serviceHealthAdapter(
      fakeReads({
        healthSummary: async () => ({
          checked_at: ago(0),
          items: [
            health({ name: 'Gateway', url: '/health', golden_path: true }),
            health({ name: 'Topics', url: '/api/v1/topics/health' }),
            health({ name: 'Redis', url: '/r', status: 'degraded', http_status: 200 }),
            health({ name: 'OK', url: '/ok', status: 'ok', healthy: true }),
          ],
        }),
      }),
    );
    expect(out.partial_error).toBeUndefined();
    expect(out.candidates.map((c) => [c.key, c.severity])).toEqual([
      ['/health', 'P1'],
      ['/api/v1/topics/health', 'P2'],
      ['/r', 'P3'],
    ]);
    for (const c of out.candidates) {
      expect(c.since).toBeNull();
      expect(c.hold_ms).toBe(HEALTH_HOLD_MS);
      expect(c.hold_ms).toBe(2 * MIN);
    }
  });

  it('an unmeasured golden-path check (no_access) makes the source UNKNOWN, never green', async () => {
    const out = await serviceHealthAdapter(
      fakeReads({
        healthSummary: async () => ({ checked_at: ago(0), items: [health({ name: 'Auth', golden_path: true, status: 'no_access' })] }),
      }),
    );
    expect(out.candidates).toEqual([]);
    expect(out.partial_error).toMatch(/golden_path_not_checked: Auth \(no_access\)/);
  });

  it('an unmeasured non-golden check is skipped silently', async () => {
    const out = await serviceHealthAdapter(
      fakeReads({ healthSummary: async () => ({ checked_at: ago(0), items: [health({ status: 'not_configured' })] }) }),
    );
    expect(out).toEqual({ candidates: [] });
  });
});

describe('release adapter', () => {
  const events = (map: Record<string, { topic: string; created_at: string } | null>) =>
    fakeReads({ latestEvent: async (topics) => map[topics[0]] ?? null });

  it('P1 when the newest prod deploy failed < 2 h ago; not after 2 h; not when completed', async () => {
    const at = (topic: string, ms: number) => events({ 'prod.deploy.completed': { topic, created_at: ago(ms) }, 'staging.verify.passed': { topic: 'staging.verify.passed', created_at: ago(H) } });
    const fail = await releaseAdapter(at('prod.deploy.failed', 119 * MIN), ctx);
    expect(fail.candidates.find((c) => c.key === 'prod_deploy_failed')?.severity).toBe('P1');
    const rb = await releaseAdapter(at('prod.deploy.rolled_back', 30 * MIN), ctx);
    expect(rb.candidates.find((c) => c.key === 'prod_deploy_failed')?.title).toBe('Production deploy rolled back');
    expect((await releaseAdapter(at('prod.deploy.failed', 121 * MIN), ctx)).candidates.find((c) => c.key === 'prod_deploy_failed')).toBeUndefined();
    expect((await releaseAdapter(at('prod.deploy.completed', 5 * MIN), ctx)).candidates.find((c) => c.key === 'prod_deploy_failed')).toBeUndefined();
  });

  it('P2 when STAGING-VERIFY failed on the latest staging deploy, not when a newer deploy landed', async () => {
    const verify = { topic: 'staging.verify.failed', created_at: ago(2 * H) };
    const failed = await releaseAdapter(events({ 'staging.verify.passed': verify, 'staging.deploy.completed': { topic: 'staging.deploy.completed', created_at: ago(3 * H) } }), ctx);
    expect(failed.candidates.find((c) => c.key === 'staging_verify_failed')?.severity).toBe('P2');
    expect(failed.candidates.find((c) => c.key === 'staging_verify_failed')?.since).toBe(verify.created_at);
    const newer = await releaseAdapter(events({ 'staging.verify.passed': verify, 'staging.deploy.completed': { topic: 'staging.deploy.completed', created_at: ago(H) } }), ctx);
    expect(newer.candidates.find((c) => c.key === 'staging_verify_failed')).toBeUndefined();
  });

  it('P3 STAGING-VERIFY stale only beyond 72 h', async () => {
    const pass = (ms: number) => events({ 'staging.verify.passed': { topic: 'staging.verify.passed', created_at: ago(ms) } });
    expect((await releaseAdapter(pass(71 * H), ctx)).candidates.find((c) => c.key === 'staging_verify_stale')).toBeUndefined();
    const stale = (await releaseAdapter(pass(73 * H), ctx)).candidates.find((c) => c.key === 'staging_verify_stale');
    expect(stale?.severity).toBe('P3');
    expect((await releaseAdapter(events({}), ctx)).candidates.find((c) => c.key === 'staging_verify_stale')?.detail).toMatch(/no STAGING-VERIFY/);
  });

  it('commit drift is a P3 candidate held 48 h via state; unreadable build-info → source UNKNOWN', async () => {
    const pass = { 'staging.verify.passed': { topic: 'staging.verify.passed', created_at: ago(H) } };
    const drift = await releaseAdapter(
      fakeReads({ latestEvent: async (t) => (pass as any)[t[0]] ?? null, buildInfo: async (w) => ({ status: 'ok', commit: w === 'prod' ? 'aaa' : 'bbb' }) }),
      ctx,
    );
    const c = drift.candidates.find((x) => x.key === 'commit_drift')!;
    expect(c.severity).toBe('P3');
    expect(c.since).toBeNull();
    expect(c.hold_ms).toBe(48 * H);
    expect(drift.partial_error).toBeUndefined();

    const blind = await releaseAdapter(
      fakeReads({ latestEvent: async (t) => (pass as any)[t[0]] ?? null, buildInfo: async () => ({ status: 'not_configured', reason: 'no_url' }) }),
      ctx,
    );
    expect(blind.partial_error).toMatch(/build_info_prod: no_url/);
  });

  it('a legacy deploy-failure topic within 24 h is P3', async () => {
    const out = await releaseAdapter(
      events({ 'deploy.gateway.failed': { topic: 'cicd.deploy.service.failed', created_at: ago(3 * H) }, 'staging.verify.passed': { topic: 'staging.verify.passed', created_at: ago(H) } }),
      ctx,
    );
    expect(out.candidates.find((c) => c.key.startsWith('legacy_deploy_failed'))?.severity).toBe('P3');
  });
});

describe('voice_supervisor adapter', () => {
  const v = (o: any) => ({ scope: 'provider', key: 'nova', label: 'Nova', metric: 'silent', severity: 'warning', message: 'm', sessions: 40, ...o });
  it('system_wide → P1, segment critical → P2, warning → P3', async () => {
    const out = await voiceSupervisorAdapter(
      fakeReads({
        voiceOverview: async () => ({
          verdict_summary: 'system_wide',
          window: '1h',
          generated_at: ago(0),
          verdicts: [v({ scope: 'system', key: 'silent', severity: 'critical' }), v({ severity: 'critical' }), v({ metric: 'drop' })],
        }),
      }),
    );
    expect(out.candidates.map((c) => c.severity)).toEqual(['P1', 'P2', 'P3']);
    expect(out.candidates.every((c) => c.deeplink.section === 'voice')).toBe(true);
  });

  it('carries quarantines and open architecture reports over from /ops/action-required (P3)', async () => {
    const out = await voiceSupervisorAdapter(
      fakeReads({
        voiceQuarantines: async () => [{ class: 'stall', quarantined_at: ago(H), reason: null }],
        voiceArchitectureReports: async () => [{ id: 'r1', class: 'stall', generated_at: ago(H), track: 'replace' }],
      }),
    );
    expect(out.candidates.map((c) => [c.key, c.severity])).toEqual([
      ['quarantine:stall', 'P3'],
      ['architecture_report:r1', 'P3'],
    ]);
  });

  it('a truncated overview keeps its verdicts (a P1 stays visible) but the source is partial (→ UNKNOWN)', async () => {
    const out = await voiceSupervisorAdapter(
      fakeReads({
        voiceOverview: async () => ({
          verdict_summary: 'system_wide',
          window: '1h',
          generated_at: ago(0),
          truncated: true,
          verdicts: [v({ scope: 'system', key: 'silent', severity: 'critical' })],
        }),
      }),
    );
    expect(out.candidates.map((c) => c.severity)).toEqual(['P1']);
    expect(out.partial_error).toMatch(/truncated at the row cap/);
  });

  it('insufficient_data is no item; a failing overview read throws (→ UNKNOWN)', async () => {
    expect((await voiceSupervisorAdapter(fakeReads())).candidates).toEqual([]);
    await expect(voiceSupervisorAdapter(fakeReads({ voiceOverview: async () => { throw new Error('boom'); } }))).rejects.toThrow('boom');
  });
});

describe('autonomy adapter', () => {
  it('critical alert → P2, warning → P3, info dropped, kill switch and approvals owned elsewhere (N7)', async () => {
    const out = await autonomyAdapter(
      fakeReads({
        supervisorAlerts: async () => [
          { severity: 'critical', text: 'Kill switch is ON — no autonomous execution.', tab: 'auto-approve' },
          { severity: 'critical', text: 'LLM providers are failing every execution', tab: 'live' },
          { severity: 'warning', text: '3 scan run(s) failed in 7 days.', tab: 'runs' },
          { severity: 'warning', text: '2 execution(s) waiting for your approval.', tab: 'live' },
          { severity: 'info', text: 'This gateway does not run the loop', tab: 'live' },
        ],
      }),
      ctx,
    );
    expect(out.candidates.map((c) => [c.severity, c.deeplink.tab])).toEqual([
      ['P2', 'live'],
      ['P3', 'runs'],
    ]);
  });

  it('alert keys ignore the changing numbers in the text', async () => {
    const run = (n: number) => autonomyAdapter(fakeReads({ supervisorAlerts: async () => [{ severity: 'warning', text: `${n} scan run(s) failed in 7 days.`, tab: 'runs' }] }), ctx);
    expect((await run(3)).candidates[0].key).toBe((await run(7)).candidates[0].key);
  });

  it('self-heal rolled_back → P2, escalated → P3, grouped per endpoint, blocklist applied', async () => {
    const row = (o: any) => ({ vtid: 'VTID-01000', endpoint: '/api/v1/a/health', failure_class: 'x', outcome: 'escalated', created_at: ago(2 * H), ...o });
    const out = await autonomyAdapter(
      fakeReads({
        selfHealOutcomes: async () => [
          row({}),
          row({ vtid: 'VTID-01001', outcome: 'rolled_back', created_at: ago(H) }),
          row({ endpoint: '/api/v1/b/health', vtid: 'VTID-01002' }),
          row({ endpoint: 'dev_autopilot.scan', vtid: 'VTID-01003' }),
        ],
      }),
      ctx,
    );
    const a = out.candidates.find((c) => c.key === 'self_heal:/api/v1/a/health')!;
    expect(a.severity).toBe('P2');
    expect(a.count).toBe(2);
    expect(a.since).toBe(ago(2 * H));
    expect(a.deeplink).toEqual({ section: 'oasis', tab: 'vtid-ledger', query: { vtid: 'VTID-01001' } });
    expect(out.candidates.find((c) => c.key === 'self_heal:/api/v1/b/health')!.severity).toBe('P3');
    expect(out.candidates.some((c) => c.key.includes('dev_autopilot'))).toBe(false);
  });
});

describe('operator_pipeline adapter (N4)', () => {
  const row = (o: Partial<LedgerRow>): LedgerRow => ({
    vtid: 'VTID-02000', title: 't', metadata: { autonomous_execution: true }, claimed_by: 'worker-1',
    claim_started_at: ago(3 * H), claim_expires_at: null, updated_at: ago(MIN), ...o,
  });

  it('stuck = no heartbeat > 60 min by claim_expires_at - 60 min, never updated_at', async () => {
    const out = await operatorPipelineAdapter(
      fakeReads({
        inProgressLedger: async () => [
          // heartbeat 61 min ago (expiry = hb + 60 min = 1 min ago) — stuck, although updated_at is fresh
          row({ vtid: 'VTID-02001', claim_expires_at: ago(MIN) }),
          // heartbeat 59 min ago — fine
          row({ vtid: 'VTID-02002', claim_expires_at: new Date(NOW + MIN).toISOString() }),
          // no expiry yet, claim started 3 h ago — stuck
          row({ vtid: 'VTID-02003' }),
        ],
      }),
      ctx,
    );
    expect(out.candidates.map((c) => [c.key, c.severity])).toEqual([
      ['VTID-02001', 'P2'],
      ['VTID-02003', 'P2'],
    ]);
    expect(out.candidates[0].deeplink).toEqual({ section: 'command-hub', tab: 'tasks', query: { vtid: 'VTID-02001' } });
    expect(out.candidates[0].since).toBe(ago(61 * MIN));
  });

  it('only isAutonomousExecutionTask() rows count; session VTIDs are never flagged', async () => {
    const out = await operatorPipelineAdapter(
      fakeReads({
        inProgressLedger: async () => [row({ vtid: 'VTID-03000', metadata: { source: 'claude-code' }, claim_expires_at: ago(5 * H) })],
        pipelineBrokenVtids: async () => ['VTID-03000'],
      }),
      ctx,
    );
    expect(out.candidates).toEqual([]);
  });

  it('broken (pipeline summary) autonomous task → P2 even when unclaimed; no 30–60 min band', async () => {
    const out = await operatorPipelineAdapter(
      fakeReads({
        inProgressLedger: async () => [row({ vtid: 'VTID-04000', claimed_by: null, claim_started_at: null }), row({ vtid: 'VTID-04001', claim_expires_at: ago(-25 * MIN) })],
        pipelineBrokenVtids: async () => ['VTID-04000'],
      }),
      ctx,
    );
    expect(out.candidates.map((c) => [c.key, c.severity, c.title])).toEqual([['VTID-04000', 'P2', 'Broken autonomous task VTID-04000']]);
  });

  it('pipeline summary failure → partial (UNKNOWN), heartbeat items still reported', async () => {
    const out = await operatorPipelineAdapter(
      fakeReads({ inProgressLedger: async () => [row({ claim_expires_at: ago(10 * MIN) })], pipelineBrokenVtids: async () => { throw new Error('500'); } }),
      ctx,
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.partial_error).toMatch(/pipeline_summary/);
  });
});

describe('governance adapter', () => {
  it('a disarmed governance kill-switch control → P2 with who/when', async () => {
    const out = await governanceAdapter(
      fakeReads({
        systemControls: async () => [
          { key: 'autopilot_execution_enabled', enabled: false, reason: 'incident', updated_by: 'ops@x', updated_at: ago(H) },
          { key: 'vtid_allocator_enabled', enabled: true, updated_by: null, updated_at: null },
          { key: 'cognee_extraction_enabled', enabled: false, updated_by: null, updated_at: null },
        ],
      }),
      ctx,
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toMatchObject({ key: 'control:autopilot_execution_enabled', severity: 'P2', since: ago(H) });
    expect(out.candidates[0].detail).toContain('ops@x');
  });

  it('Dev Autopilot kill switch engaged → one P2 fingerprint with the activation time (N7)', async () => {
    const out = await governanceAdapter(
      fakeReads({
        devAutopilotKillSwitch: async () => ({ engaged: true }),
        latestEvent: async (t) => (t[0] === 'dev_autopilot.kill_switch.activated' ? { topic: t[0], created_at: ago(3 * H) } : null),
      }),
      ctx,
    );
    expect(out.candidates).toEqual([expect.objectContaining({ key: 'dev_autopilot_kill_switch', severity: 'P2', since: ago(3 * H) })]);
  });

  it('critical violations → one P2 item, others → one P3 item (grouped with count)', async () => {
    const vio = (id: string, severity: number) => ({ id, severity, status: 'OPEN', created_at: ago(H) });
    const out = await governanceAdapter(fakeReads({ openViolations: async () => [vio('a', 4), vio('b', 5), vio('c', 2)] }), ctx);
    expect(out.candidates.map((c) => [c.key, c.severity, c.count])).toEqual([
      ['violations:critical', 'P2', 2],
      ['violations:open', 'P3', 1],
    ]);
  });

  it('unreadable controls throw (→ UNKNOWN)', async () => {
    await expect(governanceAdapter(fakeReads({ systemControls: async () => { throw new Error('system_controls: unreadable or empty'); } }), ctx)).rejects.toThrow(/unreadable/);
  });
});

describe('decisions_waiting adapter', () => {
  const w = (id: string, ms: number, vtid?: string) => ({ id, vtid, waiting_since: ago(ms) });
  it('waiting > 4 h → P2, > 1 h → P3, ≤ 1 h not shown; grouped per kind with count', async () => {
    const out = await decisionsWaitingAdapter(
      fakeReads({
        devAutopilotAwaitingApproval: async () => [w('e1', 5 * H), w('e2', 2 * H), w('e3', 30 * MIN)],
        selfHealPendingApproval: async () => [w('s1', 90 * MIN, 'VTID-05000')],
        prApprovalsPending: async () => [w('VTID-06000', 59 * MIN, 'VTID-06000')],
      }),
      ctx,
    );
    expect(out.candidates.map((c) => [c.key, c.severity, c.count])).toEqual([
      ['dev_autopilot_approval', 'P2', 2],
      ['self_heal_approval', 'P3', 1],
    ]);
    expect(out.candidates[1].deeplink).toEqual({ section: 'oasis', tab: 'vtid-ledger', query: { vtid: 'VTID-05000' } });
    expect(out.candidates[0].since).toBe(ago(5 * H));
  });

  it('one failing kind → partial (UNKNOWN); all failing → throws', async () => {
    const boom = async () => { throw new Error('x'); };
    const part = await decisionsWaitingAdapter(fakeReads({ prApprovalsPending: boom }), ctx);
    expect(part.partial_error).toMatch(/pr_approval/);
    await expect(
      decisionsWaitingAdapter(fakeReads({ prApprovalsPending: boom, selfHealPendingApproval: boom, devAutopilotAwaitingApproval: boom }), ctx),
    ).rejects.toThrow();
  });
});

describe('registry', () => {
  it('has exactly the seven Phase 1 adapters', () => {
    expect(ATTENTION_ADAPTERS.map((a) => a.id)).toEqual([
      'service_health', 'release', 'voice_supervisor', 'autonomy', 'operator_pipeline', 'governance', 'decisions_waiting',
    ]);
  });
});
