/**
 * VTID-04626: Voice Self-Healing rebuild.
 *
 * Owner report: the Command Hub Voice Self-Healing screen "is a mess and none
 * of it works". Root causes, each pinned here:
 *   1. The report writer called Bedrock directly with an unsubscribed model
 *      profile → every investigation since 2026-09-01 wrote an empty stub.
 *      It now runs on the `triage` routing stage and records the real error.
 *   2. The prompt described the pipeline as Vertex Gemini Live (decommissioned).
 *   3. Each conversation was reported twice (ws-… and live-… stop hooks).
 *   4. Accept & Execute created 'scheduled' VTIDs nothing ever claims; it now
 *      goes through the Dev Autopilot on-ramp as one open-ended execution.
 *   5. The screen fetched three endpoints without a login token; it is now one
 *      authenticated overview read, rendered from voice-self-healing.js.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import * as fs from 'fs';
import * as path from 'path';

const mockCallViaRouter = jest.fn();
jest.mock('../src/services/llm-router', () => ({
  callViaRouter: (...args: unknown[]) => mockCallViaRouter(...args),
}));
const mockTrigger = jest.fn();
jest.mock('../src/services/operator-execution-onramp', () => ({
  triggerOperatorExecution: (...args: unknown[]) => mockTrigger(...args),
}));
const mockEmit = jest.fn(async () => ({ ok: true }));
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => (mockEmit as any)(...args),
}));

import {
  spawnInvestigator,
  investigatorFailureReason,
  VOICE_INVESTIGATOR_STAGE,
  VOICE_PIPELINE_DESCRIPTION,
} from '../src/services/voice-architecture-investigator';
import {
  isDuplicateQualityReport,
  _resetQualityFingerprintsForTests,
} from '../src/services/voice-self-healing-adapter';
import {
  compactReport,
  deriveInvestigatorHealth,
  deriveAlerts,
  detectionFromEvent,
  isStalePipelineReport,
} from '../src/services/voice-healing-overview';
import { buildAcceptPlan, acceptReport, dismissReports } from '../src/services/voice-healing-actions';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

function validReportJson() {
  return {
    class: 'voice.model_under_responds',
    evidence: { dispatch_count: 2 },
    internal_findings: {
      hypotheses: [
        { hypothesis: 'h', confidence: 0.6, top_3_disconfirming_data_points: ['a', 'b', 'c'] },
      ],
    },
    external_findings: {},
    alternatives: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    recommendation: {
      track: 'stay_and_patch',
      summary: 'Patch the thing',
      confidence: 0.7,
      contradiction_check: 'x',
      proposed_next_steps: ['step one'],
    },
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockCallViaRouter.mockReset();
  mockTrigger.mockReset();
  mockEmit.mockClear();
  _resetQualityFingerprintsForTests();
});

describe('investigator runs on the triage routing stage', () => {
  function evidenceFetch(posted: any[]) {
    mockFetch.mockImplementation((url: string, init?: any) => {
      if (url.includes('voice_architecture_reports') && init?.method === 'POST') {
        posted.push(JSON.parse(init.body));
        return Promise.resolve(jsonResp([{ id: 'rep-1' }]));
      }
      return Promise.resolve(jsonResp([]));
    });
  }

  test('calls callViaRouter("triage") with fallback allowed and the current pipeline in the prompt', async () => {
    const posted: any[] = [];
    evidenceFetch(posted);
    mockCallViaRouter.mockResolvedValue({
      ok: true,
      text: JSON.stringify(validReportJson()),
      provider: 'bedrock',
      model: 'eu.anthropic.claude-sonnet-4-6',
      fallbackUsed: false,
    });
    const r = await spawnInvestigator({ class: 'voice.model_under_responds', normalized_signature: 's', trigger_reason: 'manual' });
    expect(r.ok).toBe(true);
    expect(mockCallViaRouter).toHaveBeenCalledTimes(1);
    const [stage, prompt, opts] = mockCallViaRouter.mock.calls[0];
    expect(stage).toBe('triage');
    expect(VOICE_INVESTIGATOR_STAGE).toBe('triage');
    expect(opts.allowFallback).toBe(true);
    expect(opts.service).toBe('voice-architecture-investigator');
    expect(prompt).toContain('Amazon Nova Sonic');
    expect(prompt).not.toContain('Vertex AI Gemini Live + Cloud TTS');
    expect(VOICE_PIPELINE_DESCRIPTION).toMatch(/Serbian only/);
    // provenance persisted with the report
    expect(posted[0].schema_version).toBe('v1');
    expect(posted[0].report._llm).toMatchObject({ stage: 'triage', provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6' });
  });

  test('a failed call writes a stub with the real category and error, not a blanket claude_no_response', async () => {
    const posted: any[] = [];
    evidenceFetch(posted);
    mockCallViaRouter.mockResolvedValue({ ok: false, error: 'AccessDeniedException: model not available' });
    const r = await spawnInvestigator({ class: 'voice.low_turn_progression', normalized_signature: null, trigger_reason: 'quality_failure' });
    expect(r.ok).toBe(false);
    expect(r.validation.reason).toBe('llm_call_failed');
    expect(posted[0].schema_version).toBe('v1-stub');
    expect(posted[0].report.failure_reason).toBe('llm_call_failed');
    expect(posted[0].report.failure_detail).toContain('AccessDeniedException');
  });

  test('a thrown router error never escapes', async () => {
    evidenceFetch([]);
    mockCallViaRouter.mockRejectedValue(new Error('boom'));
    const r = await spawnInvestigator({ class: 'voice.x', normalized_signature: null, trigger_reason: 'manual' });
    expect(r.ok).toBe(false);
    expect(r.validation.reason).toBe('llm_threw');
  });

  test('investigatorFailureReason categories', () => {
    expect(investigatorFailureReason('llm_json_parse_failed: x')).toBe('llm_json_parse_failed');
    expect(investigatorFailureReason('something else')).toBe('llm_no_response');
  });

  test('the investigator no longer imports the pinned Bedrock client', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/voice-architecture-investigator.ts'), 'utf8');
    expect(src).not.toMatch(/from '\.\/claude-text-client'/);
  });
});

describe('one conversation is reported once', () => {
  const metrics = { audio_in_chunks: 2514, audio_in_forwarded: 1282, audio_out_chunks: 1230, turn_count: 2, duration_ms: 176714 };

  test('the ws-… and live-… stop hooks of the same conversation collapse to one', () => {
    const t = 1_000_000;
    expect(isDuplicateQualityReport({ sessionId: 'live-a', tenantScope: 't1', sessionMetrics: metrics }, t)).toBe(false);
    expect(isDuplicateQualityReport({ sessionId: 'ws-b', tenantScope: 't1', sessionMetrics: { ...metrics, duration_ms: 176607 } }, t + 100)).toBe(true);
  });

  test('a different conversation, another tenant, or a later repeat is not a duplicate', () => {
    const t = 2_000_000;
    isDuplicateQualityReport({ sessionId: 'a', tenantScope: 't1', sessionMetrics: metrics }, t);
    expect(isDuplicateQualityReport({ sessionId: 'b', tenantScope: 't1', sessionMetrics: { ...metrics, turn_count: 3 } }, t)).toBe(false);
    expect(isDuplicateQualityReport({ sessionId: 'c', tenantScope: 't2', sessionMetrics: metrics }, t)).toBe(false);
    expect(isDuplicateQualityReport({ sessionId: 'd', tenantScope: 't1', sessionMetrics: metrics }, t + 3 * 60_000)).toBe(false);
  });

  test('sessions without audio are never fingerprinted', () => {
    const o = { sessionId: 'x', sessionMetrics: { audio_in_chunks: 0, audio_out_chunks: 0 } };
    expect(isDuplicateQualityReport(o)).toBe(false);
    expect(isDuplicateQualityReport(o)).toBe(false);
  });

  test('the duplicate check runs before quality classification in the adapter', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/voice-self-healing-adapter.ts'), 'utf8');
    expect(src.indexOf('isDuplicateQualityReport(opts)')).toBeGreaterThan(-1);
    expect(src.indexOf('isDuplicateQualityReport(opts)')).toBeLessThan(src.indexOf('const qc = classifyQualityFromSessionStop'));
  });

  test('mode flips no longer masquerade as detections', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/voice-shadow-mode.ts'), 'utf8');
    expect(src).toContain("type: 'voice.healing.mode.changed'");
    expect(detectionFromEvent({ created_at: 'x', metadata: { previous_mode: 'off', new_mode: 'shadow' } })).toBeNull();
  });
});

describe('overview helpers', () => {
  const base = {
    id: 'r1', class: 'voice.low_turn_progression', normalized_signature: 'low_turn_zero', trigger_reason: 'quality_failure',
    generated_at: '2026-09-22T22:23:21Z', status: 'open', acknowledged_by: null, acknowledged_at: null, decision_notes: null,
  };

  test('a v1-stub is a failed investigation with its error, never a "? ?" report', () => {
    const c = compactReport({ ...base, schema_version: 'v1-stub', investigator_status: 'failed', failure_reason: 'claude_no_response', failure_detail: 'Operation not allowed' });
    expect(c.failed).toBe(true);
    expect(c.failure_detail).toBe('Operation not allowed');
    expect(c.track).toBeNull();
    expect(c.confidence).toBeNull();
  });

  test('a real report carries track, numeric confidence and step count', () => {
    const c = compactReport({ ...base, schema_version: 'v1', track: 'stay_and_patch', confidence: '0.42', summary: 's', steps: ['a', 'b'] });
    expect(c.failed).toBe(false);
    expect(c.track).toBe('stay_and_patch');
    expect(c.confidence).toBeCloseTo(0.42);
    expect(c.step_count).toBe(2);
  });

  test('reports reasoning about the retired Vertex / Gemini Live pipeline are flagged stale', () => {
    expect(isStalePipelineReport('Instrument the Gemini Live session setup', [])).toBe(true);
    expect(isStalePipelineReport('x', ['Correlate with Vertex AI logs'])).toBe(true);
    expect(isStalePipelineReport('Add per-turn diagnostics to Nova Sonic sessions', ['Tune endpointing'])).toBe(false);
    const c = compactReport({ ...base, schema_version: 'v1', summary: 'Patch the Vertex Live integration', steps: [] });
    expect(c.stale_pipeline).toBe(true);
    const stub = compactReport({ ...base, schema_version: 'v1-stub', failure_detail: 'vertex' });
    expect(stub.stale_pipeline).toBe(false);
  });

  test('investigator health: failing with consecutive count and last good report', () => {
    const h = deriveInvestigatorHealth([
      { generated_at: '2026-09-22', schema_version: 'v1-stub', failure_detail: 'Operation not allowed' },
      { generated_at: '2026-09-18', schema_version: 'v1-stub', failure_detail: 'opus-4-7 not available' },
      { generated_at: '2026-09-17', schema_version: 'v1' },
      { generated_at: '2026-09-15', schema_version: 'v1-stub', failure_detail: 'x' },
    ]);
    expect(h.status).toBe('failing');
    expect(h.consecutive_failures).toBe(2);
    expect(h.last_success_at).toBe('2026-09-17');
    expect(h.last_failure_detail).toBe('Operation not allowed');
    expect(h.failures_30d).toBe(3);
    expect(deriveInvestigatorHealth([]).status).toBe('idle');
    expect(deriveInvestigatorHealth([{ generated_at: 'a', schema_version: 'v1' }]).status).toBe('ok');
  });

  test('alerts name the failing writer and the waiting failed investigations', () => {
    const inv = deriveInvestigatorHealth([{ generated_at: '2026-09-22', schema_version: 'v1-stub', failure_detail: 'Operation not allowed' }]);
    const alerts = deriveAlerts({
      mode: 'shadow',
      pipeline: {
        detector: { status: 'ok', session_stops_24h: 10, last_session_stop_at: null, detections_7d: 0, last_detection_at: null },
        investigator: inv,
        sentinel: { status: 'ok', quarantined: 3, probation: 0 },
        execution: { status: 'idle', accepted_30d: 0, executions_linked: 0 },
      },
      reports: { open: [], failed: [compactReport({ ...base, schema_version: 'v1-stub' })], decided: [] },
      fetch_errors: ['detections: HTTP 500'],
    });
    const titles = alerts.map((a) => a.title).join(' | ');
    expect(alerts[0].level).toBe('error');
    expect(alerts[0].detail).toContain('Operation not allowed');
    expect(titles).toContain('1 failed investigation waiting');
    expect(titles).toContain('3 failure patterns quarantined');
    expect(titles).toContain('could not be loaded');
  });
});

describe('Accept → Dev Autopilot', () => {
  const report = {
    id: '11111111-2222-3333-4444-555555555555',
    class: 'voice.model_under_responds',
    normalized_signature: 'model_under_responds_r20to100',
    trigger_reason: 'quality_failure',
    status: 'open',
    schema_version: 'v1',
    report: validReportJson(),
  };

  test('the plan names the report, the current pipeline, the steps and the constraints', () => {
    const { title, plan } = buildAcceptPlan(report, 'look at barge-in first');
    expect(title).toBe('Voice self-healing: stay and patch for voice.model_under_responds');
    expect(plan).toContain(report.id);
    expect(plan).toContain('Amazon Nova Sonic');
    expect(plan).toContain('1. step one');
    expect(plan).toContain('look at barge-in first');
    expect(plan).toMatch(/never hardcode a sentence Vitana speaks/i);
  });

  test('accept hands ONE open-ended execution to the on-ramp and records it on the report', async () => {
    const patches: any[] = [];
    mockFetch.mockImplementation((url: string, init?: any) => {
      if (init?.method === 'PATCH') { patches.push(JSON.parse(init.body)); return Promise.resolve(jsonResp(null)); }
      return Promise.resolve(jsonResp([report]));
    });
    mockTrigger.mockResolvedValue({ ok: true, execution_id: 'exec-abcdef12', finding_id: 'f1', vtid: 'VTID-09999', vtid_allocated: true });
    const r = await acceptReport(report.id, { user_id: 'u1', email: 'op@exafy.io' }, null);
    expect(r.ok).toBe(true);
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    const input = mockTrigger.mock.calls[0][0];
    expect(input.openEnded).toBe(true);
    expect(input.filesReferenced).toEqual([]);
    expect(input.requestedBy).toBe('voice-healing:u1');
    expect(patches[0].status).toBe('accepted');
    expect(patches[0].report._execution).toMatchObject({ execution_id: 'exec-abcdef12', vtid: 'VTID-09999', accepted_by: 'op@exafy.io' });
    expect(mockEmit.mock.calls[0][0]).toMatchObject({ type: 'voice.healing.report.accepted', vtid: 'VTID-09999' });
  });

  test('accept never creates the old per-step scheduled ledger rows', async () => {
    mockFetch.mockImplementation((url: string) => Promise.resolve(jsonResp(url.includes('?id=eq.') ? [report] : null)));
    mockTrigger.mockResolvedValue({ ok: true, execution_id: 'e', finding_id: 'f', vtid: 'VTID-09998', vtid_allocated: true });
    await acceptReport(report.id, { user_id: 'u1' });
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('allocate_global_vtid'))).toBe(false);
    expect(urls.some((u) => u.includes('vtid_ledger'))).toBe(false);
  });

  test('refuses a failed investigation, a decided report, and surfaces an on-ramp refusal', async () => {
    mockFetch.mockResolvedValueOnce(jsonResp([{ ...report, schema_version: 'v1-stub' }]));
    expect((await acceptReport(report.id, { user_id: 'u' })).status).toBe(400);
    mockFetch.mockResolvedValueOnce(jsonResp([{ ...report, status: 'accepted' }]));
    expect((await acceptReport(report.id, { user_id: 'u' })).status).toBe(409);
    mockFetch.mockResolvedValue(jsonResp([report]));
    mockTrigger.mockResolvedValue({ ok: false, error: 'operator_execution_onramp_disabled' });
    const r = await acceptReport(report.id, { user_id: 'u' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('operator_execution_onramp_disabled');
    expect(mockTrigger).toHaveBeenCalledTimes(1);
  });

  test('dismiss all failed targets only open v1-stubs', async () => {
    mockFetch.mockResolvedValue(jsonResp([{ id: 'a' }, { id: 'b' }]));
    const r = await dismissReports('all_failed', { user_id: 'u' }, 'writer error');
    expect(r.dismissed).toBe(2);
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain('status=eq.open');
    expect(url).toContain('schema_version=eq.v1-stub');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).status).toBe('rejected');
  });

  test('dismiss by id rejects malformed ids', async () => {
    const r = await dismissReports(['not-a-uuid'], { user_id: 'u' }, 'x');
    expect(r.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('routes and screen', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/voice-lab.ts'), 'utf8');
  const hub = path.join(__dirname, '../src/frontend/command-hub');
  const screen = fs.readFileSync(path.join(hub, 'voice-self-healing.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(hub, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(hub, 'index.html'), 'utf8');

  test.each([
    "router.post('/healing/reports/:id/execute', requireExafyAdmin",
    "router.post('/healing/reports/:id/retry', requireExafyAdmin",
    "router.post('/healing/reports/dismiss', requireExafyAdmin",
    "router.post('/healing/mode', requireExafyAdmin",
    "router.patch('/healing/reports/:id', requireExafyAdmin",
    "router.post('/healing/quarantine/release', requireExafyAdmin",
  ])('mutating route is exafy_admin only: %s', (sig) => {
    expect(routes).toContain(sig);
  });

  test('overview route exists behind requireAuth', () => {
    expect(routes.indexOf("router.get('/healing/overview'")).toBeGreaterThan(routes.indexOf('router.use(requireAuth)'));
  });

  test('every screen request carries the login token', () => {
    expect(screen).toContain('buildContextHeaders');
    expect(screen).toMatch(/fetch\(API \+ path, opts\)/);
    expect((screen.match(/fetch\(/g) || []).length).toBe(1);
  });

  test('the screen has no inline styles (CSP)', () => {
    expect(screen).not.toMatch(/style\.cssText|\.style\.|style="/);
  });

  test('the old panel is gone from app.js and the router uses the new screen', () => {
    expect(appJs).not.toContain('function renderVoiceSelfHealingPanel');
    expect(appJs).not.toContain('function renderInlineArchitectureReports');
    expect(appJs).toContain('window.renderVoiceSelfHealingScreen()');
    expect(html).toContain('/command-hub/voice-self-healing.js?v=');
    expect(html).toContain('/command-hub/voice-self-healing.css?v=');
  });
});
