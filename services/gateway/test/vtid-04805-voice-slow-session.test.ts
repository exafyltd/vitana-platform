/**
 * VTID-04805: Jev P2 gate C3 — the cause of a stalled voice session, judged
 * from its telemetry next to a rules mapping. Shadow only.
 */
const rows: any[] = [];
const seen = new Set<string>();
let stalls: any = { data: [], error: null };
const sessions: Record<string, any[]> = {};
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}` });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
  fetchStallEvents: jest.fn(async () => stalls),
  fetchSessionEvents: jest.fn(async (_sb: unknown, sid: string) => ({ data: sessions[sid] || [], error: null })),
  fetchRecentShadowBySubject: jest.fn(async (_sb: unknown, _gate: string, ref: string) => ({ data: seen.has(ref) ? { id: 'old' } : null, error: null })),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import * as repo from '../src/services/jev/jev-repository';
import {
  buildSlowSessionSignals, isSlowSessionOn, ruleCause, runSlowSessionDay, startSlowSessionScheduler, stopSlowSessionSchedulerForTest,
  type SlowSessionSignals,
} from '../src/services/jev/gates/slow-session-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_VOICE_SLOW_SESSION_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;
const DAY = '2026-09-30';

const diag = (stage: string, extra: Record<string, unknown> = {}) => ({ topic: 'orb.live.diag', metadata: { stage, ...extra } });
const STALL_A = { env: 'staging', reason: 'forwarding_no_ack', session_id: 'live-a', timeout_ms: 45000, turn_count: 2, greeting_sent: true, audio_out_chunks: 170 };
const EVENTS_A = [
  { topic: 'vtid.live.session.start', metadata: { lang: 'de', user_id: 'u1', email: 'x@y.z' } },
  { topic: 'orb.live.context.bootstrap', metadata: { latency_ms: 1209, chars: 33765, user_id: 'u1' } },
  diag('nova_prewarm_missed', { provider: 'nova_sonic', reason: 'none_available' }),
  diag('tool_catalog_trimmed', { bytes_before: 224800, bytes_after: 65432 }),
  diag('input_transcription', { text_preview: 'wo kann ich meine einstellungen' }),
  diag('watchdog_fired', { audio_in: 61, audio_out: 170 }),
  diag('upstream_closed', { reason: 'terminated' }),
  diag('reconnect_triggered'),
  { topic: 'orb.live.tool.executed', metadata: {} },
];

function answer(cause: string, fixable = 0.8) {
  return {
    ok: true, model: 'jev-1.13.0',
    answers: { cause: { type: 'choice', choice: cause, probabilities: { [cause]: 0.85 }, confidence: 0.85 }, fixable: { type: 'noul', noul: fixable } },
    usage: { input_tokens: 400, output_tokens: 2 }, latency_ms: 20, attempts: 1,
  };
}

beforeEach(() => {
  rows.length = 0;
  seen.clear();
  stalls = {
    data: [
      { metadata: STALL_A },
      { metadata: { ...STALL_A, reason: 'audio_stall' } },
      { metadata: { env: 'staging', reason: 'greeting_timeout', session_id: 'live-b', greeting_sent: false } },
      { metadata: { env: 'production', reason: 'greeting_timeout', session_id: 'live-p' } },
    ],
    error: null,
  };
  sessions['live-a'] = EVENTS_A;
  sessions['live-b'] = [];
  (repo.fetchStallEvents as jest.Mock).mockClear();
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterEach(() => stopSlowSessionSchedulerForTest());
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04805 decision', () => {
  test('slow_session_cause: telemetry, no PII, internal planes, cause + fixable', () => {
    const d = getJevDecision('slow_session_cause')!;
    expect(d.data).toBe('telemetry');
    expect(d.pii).toBe('forbid');
    expect(d.planes).toEqual(['internal', 'system_autopilot']);
    expect(Object.keys(d.questions)).toEqual(['cause', 'fixable']);
    expect(Object.keys((d.questions.cause as any).criteria)).toEqual(
      ['upstream_connection', 'upstream_model', 'context_build', 'tool_call', 'prompt_size', 'client_audio', 'unknown'],
    );
  });
});

describe('VTID-04805 signals and rules', () => {
  test('counters and timings by allow-list; never ids, transcripts or contact data', () => {
    const s = buildSlowSessionSignals(STALL_A, EVENTS_A);
    expect(s).toEqual({
      stall_reason: 'forwarding_no_ack', timeout_ms: 45000, turn_count: 2, audio_out_chunks: 170, greeting_sent: true,
      provider: 'nova_sonic', lang: 'de', prewarm_missed: true, context_build_ms: 1209, context_chars: 33765,
      tool_catalog_bytes: 65432, tool_calls: 1, tool_failures: 0, upstream_close_reason: 'terminated', reconnects: 1, audio_in_chunks: 61,
    });
    const text = JSON.stringify(s);
    for (const bad of ['u1', 'x@y.z', 'einstellungen', 'live-a']) expect(text).not.toContain(bad);
  });

  const base: SlowSessionSignals = { stall_reason: 'audio_stall', prewarm_missed: false, tool_calls: 0, tool_failures: 0, reconnects: 0 };
  test.each([
    [{ tool_failures: 1 }, 'tool_call'],
    [{ stall_reason: 'response_timeout', tool_calls: 2 }, 'tool_call'],
    [{ stall_reason: 'forwarding_no_ack', prewarm_missed: true }, 'upstream_connection'],
    [{ context_build_ms: 3744 }, 'context_build'],
    [{ stall_reason: 'greeting_timeout' }, 'upstream_model'],
    [{}, null],
  ])('rules %j → %s', (patch, cause) => {
    expect(ruleCause({ ...base, ...(patch as Partial<SlowSessionSignals>) })).toBe(cause);
  });
});

describe('VTID-04805 gate', () => {
  test('off (default, typo): nothing read, asked or written; scheduler does not start', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_VOICE_SLOW_SESSION_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      expect(isSlowSessionOn(env)).toBe(false);
      expect(await runSlowSessionDay(DAY, { env, sb, vitanaEnv: 'staging', decideOptions: { call } })).toBe(0);
      expect(startSlowSessionScheduler(env)).toBe(false);
    }
    expect(repo.fetchStallEvents).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  test('one row per stalled session of this environment, Jev next to the rules', async () => {
    const call = jest.fn().mockResolvedValueOnce(answer('upstream_connection')).mockResolvedValueOnce(answer('client_audio', 0.2));
    expect(await runSlowSessionDay(DAY, { env: SHADOW, sb, vitanaEnv: 'staging', decideOptions: { call } })).toBe(2);
    const [, since, until] = (repo.fetchStallEvents as jest.Mock).mock.calls[0];
    expect([since, until]).toEqual(['2026-09-30T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][0].state.session).toMatchObject({ stall_reason: 'forwarding_no_ack', prewarm_missed: true });
    expect(rows[0]).toMatchObject({
      gate: 'voice_slow_session', decision: 'slow_session_cause', mode: 'shadow', plane: 'internal', tenant_id: null,
      subject_type: 'voice_session', subject_ref: 'live-a', system_action: 'rule:upstream_connection', jev_outcome: 'decided',
      jev_verdict: { cause: 'upstream_connection', fixable: 0.8, rule_cause: 'upstream_connection', day: DAY },
      agreed: true, outcome: 'compared_with_rule_cause',
    });
    expect(rows[1]).toMatchObject({ subject_ref: 'live-b', system_action: 'rule:upstream_model', agreed: false });
    expect(rows.map((r) => r.subject_ref)).not.toContain('live-p');
  });

  test('a session already judged is skipped; no rule → agreed null', async () => {
    seen.add('live-a');
    stalls.data[2].metadata.reason = 'text_stall';
    const call = jest.fn().mockResolvedValue(answer('unknown'));
    expect(await runSlowSessionDay(DAY, { env: SHADOW, sb, vitanaEnv: 'staging', decideOptions: { call } })).toBe(1);
    expect(rows[0]).toMatchObject({ subject_ref: 'live-b', system_action: 'rule:none', agreed: null, outcome: null });
  });

  test('Jev unavailable → a fallback row; read errors → 0; never throws', async () => {
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await runSlowSessionDay(DAY, { env: SHADOW, sb, vitanaEnv: 'staging', decideOptions: { call: failing } });
    expect(rows[0]).toMatchObject({ jev_outcome: 'fallback', agreed: null, cost_usd: 0, jev_verdict: { rule_cause: 'upstream_connection' } });
    stalls = { data: null, error: { message: 'timeout' } };
    expect(await runSlowSessionDay(DAY, { env: SHADOW, sb, vitanaEnv: 'staging' })).toBe(0);
    (repo.fetchStallEvents as jest.Mock).mockImplementationOnce(async () => { throw new Error('db'); });
    await expect(runSlowSessionDay(DAY, { env: SHADOW, sb, vitanaEnv: 'staging' })).resolves.toBe(0);
    expect(await runSlowSessionDay(DAY, { env: SHADOW, sb: null, vitanaEnv: 'staging' })).toBe(0);
  });
});

describe('VTID-04805 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  test('the scheduler starts from index.ts, guarded, non-fatal', () => {
    const idx = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
    expect(idx).toContain("require('./services/jev/gates/slow-session-gate')");
    expect(idx).toContain('if (startSlowSessionScheduler())');
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_VOICE_SLOW_SESSION_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_VOICE_SLOW_SESSION_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_VOICE_SLOW_SESSION_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
