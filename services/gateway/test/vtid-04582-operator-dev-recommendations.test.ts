/**
 * VTID-04582: the Operator Console's autopilot_get_recommendations returns the
 * Dev Autopilot backlog, never the community recommender.
 *
 * Observed 2026-09-25: asked for "the Dev Autopilot recommendations", the tool
 * returned ten community member nudges ("Complete your profile", "Add your
 * photo", "Start a streak on your weakest pillar") — it called the
 * get_autopilot_recommendations RPC with p_user_id = null, which serves every
 * member's rows and never source_type.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('node-fetch');
const mockSnapshot = jest.fn();
jest.mock('../src/services/dev-autopilot-supervisor', () => ({
  buildSupervisorSnapshot: (...a: unknown[]) => mockSnapshot(...a),
}));

import fetch from 'node-fetch';
import { executeTool } from '../src/services/gemini-operator';
import { toDevRecommendations, type DevRecommendationSnapshot, type SnapshotFinding } from '../src/services/operator-dev-recommendations';

const mockedFetch = fetch as unknown as jest.Mock;

function finding(over: Partial<SnapshotFinding>): SnapshotFinding {
  return {
    id: 'f-0', title: 'Finding', status: 'new', source_type: 'dev_autopilot',
    detector: 'todo-scanner-v1', file_path: 'services/gateway/src/x.ts',
    risk_class: 'low', effort_score: 2, impact_score: 6, has_plan: true,
    attempts: 0, age_days: 1, activated_vtid: null,
    blocker: { code: 'auto_approve_off', actor: 'system', label: 'Auto-approve off', detail: 'baseline auto-approve is disabled' },
    ...over,
  };
}

function snapshot(items: SnapshotFinding[]): DevRecommendationSnapshot {
  return {
    generated_at: '2026-09-25T19:50:00.000Z',
    config: { kill_switch: false, baseline_auto_approve: true },
    executions: {
      active: 2, active_by_status: { awaiting_approval: 1, ci: 1 }, awaiting_approval: 1,
      total_7d: 20, succeeded_7d: 12, failed_7d: 6, success_rate_7d: 67,
      top_failure_reasons: [{ reason: 'agent turn cap', count: 3 }],
    },
    findings: { open: items.length, by_actor: { system: 1, human: 1 }, items },
    alerts: [{ severity: 'warning', text: '1 execution(s) waiting for your approval.', tab: 'live' }],
  };
}

describe('toDevRecommendations', () => {
  const items = [
    finding({ id: 'sys-1', title: 'System-blocked', impact_score: 9 }),
    finding({
      id: 'hum-1', title: 'Needs a plan approval', source_type: 'dev_autopilot_impact', detector: 'rule-x',
      risk_class: 'high', activated_vtid: 'VTID-09001',
      blocker: { code: 'plan_required', actor: 'human', label: 'Plan version required', detail: 'generate a plan before approving' },
    }),
    finding({ id: 'mov-1', title: 'Running', blocker: { code: 'in_flight', actor: 'moving', label: 'Executing', detail: 'running' } }),
  ];

  it('puts findings a person can unblock first, then keeps the snapshot order', () => {
    const r = toDevRecommendations(snapshot(items));
    expect(r.findings.map((f) => f.id)).toEqual(['hum-1', 'sys-1', 'mov-1']);
    expect(r.source).toBe('dev_autopilot_supervisor');
  });

  it('carries source, detector, VTID, risk and the blocker into each finding', () => {
    const f = toDevRecommendations(snapshot(items)).findings[0];
    expect(f).toMatchObject({
      id: 'hum-1', source: 'impact_rule', detector: 'rule-x', vtid: 'VTID-09001',
      risk_class: 'high', blocked_by: 'human',
      blocker: 'Plan version required — generate a plan before approving',
    });
  });

  it('builds sync-brief recommendations with priority from risk and requires_approval for human blockers', () => {
    const recs = toDevRecommendations(snapshot(items)).recommendations;
    expect(recs[0]).toMatchObject({ id: 'hum-1', priority: 'high', requires_approval: true, related_vtids: ['VTID-09001'], source: 'dev_autopilot_impact' });
    expect(recs[1]).toMatchObject({ id: 'sys-1', priority: 'low', requires_approval: false, related_vtids: [] });
    expect(recs[0].rationale).toContain('Blocker (human)');
  });

  it('narrows to a VTID when one matches, and reports when none does', () => {
    const hit = toDevRecommendations(snapshot(items), { vtid: 'VTID-09001' });
    expect(hit.findings.map((f) => f.id)).toEqual(['hum-1']);
    expect(hit.vtid_filter).toEqual({ vtid: 'VTID-09001', matched: true });
    const miss = toDevRecommendations(snapshot(items), { vtid: 'VTID-00001' });
    expect(miss.findings).toHaveLength(3);
    expect(miss.vtid_filter).toEqual({ vtid: 'VTID-00001', matched: false });
  });

  it('summarises executions and renders alerts as text', () => {
    const r = toDevRecommendations(snapshot(items));
    expect(r.executions).toMatchObject({ active: 2, awaiting_approval: 1, last_7d: { total: 20, success_rate: 67 } });
    expect(r.alerts).toEqual(['[warning] 1 execution(s) waiting for your approval.']);
  });

  it('caps the list at the requested limit (max 25)', () => {
    const many = Array.from({ length: 40 }, (_, i) => finding({ id: `f-${i}` }));
    expect(toDevRecommendations(snapshot(many)).findings).toHaveLength(10);
    expect(toDevRecommendations(snapshot(many), { limit: 99 }).findings).toHaveLength(25);
  });
});

describe('autopilot_get_recommendations through executeTool', () => {
  const originalFetch = global.fetch;
  let n = 0;

  beforeEach(() => {
    mockSnapshot.mockReset();
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => [], text: async () => '[]' });
    (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }));
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE = 'test-key';
  });
  afterAll(() => { (global as any).fetch = originalFetch; });

  it('returns the Dev Autopilot backlog and never calls the community RPC', async () => {
    mockSnapshot.mockResolvedValue({ ok: true, ...snapshot([finding({ id: 'dev-1', title: 'Refactor large file app.js' })]) });
    const r = await executeTool('autopilot_get_recommendations', {}, `t-04582-${n++}`);
    expect(r.ok).toBe(true);
    const data = r.data as any;
    expect(data.source).toBe('dev_autopilot_supervisor');
    expect(data.findings.map((f: any) => f.title)).toEqual(['Refactor large file app.js']);
    const urls = [...mockedFetch.mock.calls, ...(global.fetch as jest.Mock).mock.calls].map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('get_autopilot_recommendations'))).toBe(false);
  });

  it('fails loudly with the fallback tools when the snapshot is unavailable', async () => {
    mockSnapshot.mockResolvedValue({ ok: false, error: 'dev_autopilot_config missing' });
    const r = await executeTool('autopilot_get_recommendations', {}, `t-04582-${n++}`);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('dev_autopilot_config missing');
    expect((r.data as any).fallback_tools).toEqual(['oasis_analyze_vtid', 'dev_verify_deploy_checklist']);
  });
});

describe('source and prompt contracts', () => {
  const SRC = path.resolve(__dirname, '../src/services');
  const operator = fs.readFileSync(path.join(SRC, 'gemini-operator.ts'), 'utf8');
  const personality = fs.readFileSync(path.join(SRC, 'ai-personality-service.ts'), 'utf8');

  it('the executor no longer reads the community recommender RPC', () => {
    const body = operator.slice(
      operator.indexOf('async function executeGetRecommendations('),
      operator.indexOf('async function executeAnalyzeVTID('),
    );
    expect(body).not.toContain('rpc/get_autopilot_recommendations');
    expect(body).toContain('buildSupervisorSnapshot');
  });

  it('the wire description says the tool never returns community recommendations', () => {
    const decl = operator.slice(operator.indexOf("name: 'autopilot_get_recommendations'"), operator.indexOf("name: 'oasis_analyze_vtid'"));
    expect(decl).toMatch(/NEVER returns community member recommendations/);
    expect(decl).toMatch(/Dev Autopilot backlog/);
  });

  for (const [label, prompt] of [
    ['served operator_chat prompt', () => personality.slice(personality.indexOf('operator_chat: {'), personality.indexOf('calculation_directive:', personality.indexOf('operator_chat: {')))],
    ['inline fallback prompt', () => operator.slice(operator.indexOf('function getOperatorSystemPrompt()'), operator.indexOf('if (opConfig.calculation_directive)', operator.indexOf('function getOperatorSystemPrompt()')))],
  ] as const) {
    it(`${label}: lists the tool, routes backlog questions to it, and tells the model to correct itself`, () => {
      const text = prompt();
      expect(text).toContain('autopilot_get_recommendations: The Dev Autopilot backlog');
      expect(text).toMatch(/Dev Autopilot recommendations\/backlog\/findings → call autopilot_get_recommendations/);
      expect(text).toMatch(/OASIS events are history, not current state/);
      expect(text).toMatch(/never claim a tool returned something it did not/);
    });
  }
});
