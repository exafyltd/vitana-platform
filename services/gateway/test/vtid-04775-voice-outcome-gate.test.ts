/**
 * VTID-04775: Jev P1 gate C1 — the outcome class of an ORB voice session,
 * from its own telemetry, next to the rule-based voice-failure class.
 */
const rows: any[] = [];
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}` });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
  updateShadowOutcome: jest.fn(async () => ({ data: null, error: null })),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import {
  buildVoiceOutcomeSignals,
  isVoiceOutcomeOn,
  ruleOutcome,
  runVoiceOutcomeCheck,
} from '../src/services/jev/gates/voice-outcome-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' };
const SHADOW = { ...JEV_ON, JEV_VOICE_SESSION_OUTCOME_MODE: 'shadow' };
const sb = {} as any;

const metrics = { audio_in_chunks: 400, audio_in_forwarded: 380, audio_out_chunks: 2, duration_ms: 45_000, turn_count: 0, user_turns: 3, model_turns: 0 };
const signals = { stop_reason: 'user_stop', provider: 'nova_sonic', lang: 'de', greeting_sent: true, reconnects: 0, watchdog_reason: null, tool_call_streak: 0 };

function answer(choice: string, conf = 0.85) {
  return {
    ok: true,
    model: 'jev-1.13.0',
    answers: {
      outcome: { type: 'choice', choice, probabilities: { [choice]: conf }, confidence: conf },
      needs_fix: { type: 'noul', noul: choice === 'completed' ? 0.1 : 0.8 },
    },
    usage: { input_tokens: 300, output_tokens: 2 },
    latency_ms: 20,
    attempts: 1,
  };
}

beforeEach(() => {
  rows.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04775 decision', () => {
  test('voice_session_outcome: telemetry, pii forbidden, internal planes, eight outcomes', () => {
    const d = getJevDecision('voice_session_outcome')!;
    expect(d.data).toBe('telemetry');
    expect(d.pii).toBe('forbid');
    expect(d.planes).toEqual(['internal', 'system_autopilot']);
    expect(Object.keys((d.questions.outcome as any).criteria)).toEqual([
      'completed', 'user_left_early', 'no_engagement', 'one_way_audio',
      'connection_dropped', 'model_stalled', 'looping', 'failed_to_start',
    ]);
    expect(d.input.safeParse({ duration_s: 1, turns: 0, audio_in_chunks: 0, audio_out_chunks: 0 }).success).toBe(true);
  });
});

describe('VTID-04775 signals', () => {
  test('reads counters and flags by allow-list only — never transcript, identity or memory', () => {
    const session = {
      upstreamProvider: 'nova_sonic',
      lang: 'de',
      greetingSent: true,
      _reconnectCount: 2,
      responseWatchdogReason: 'no_audio_out',
      consecutiveToolCalls: 4,
      transcriptTurns: [{ role: 'user', text: 'mein Blutdruck ist 150/95' }],
      identity: { user_id: 'u1', email: 'x@y.z' },
      memoryContext: 'secret',
    };
    const sig = buildVoiceOutcomeSignals(session, 'user_stop');
    expect(sig).toEqual({
      stop_reason: 'user_stop',
      provider: 'nova_sonic',
      lang: 'de',
      greeting_sent: true,
      reconnects: 2,
      watchdog_reason: 'no_audio_out',
      tool_call_streak: 4,
    });
    expect(JSON.stringify(sig)).not.toMatch(/Blutdruck|u1|x@y|secret/);
  });

  test('a missing or odd session yields empty signals, never a throw', () => {
    expect(buildVoiceOutcomeSignals(null, 'x')).toMatchObject({ stop_reason: 'x', provider: undefined, reconnects: undefined });
    expect(buildVoiceOutcomeSignals({ _reconnectCount: -1, lang: 42 }, '')).toMatchObject({ reconnects: undefined, lang: undefined, stop_reason: undefined });
  });
});

describe('VTID-04775 check', () => {
  test('off (default, typo) and synthetic: nothing asked or written', async () => {
    const call = jest.fn();
    for (const env of [{}, { ...JEV_ON, JEV_VOICE_SESSION_OUTCOME_MODE: 'on' }]) {
      expect(isVoiceOutcomeOn(env)).toBe(false);
      expect(await runVoiceOutcomeCheck({ sessionId: 'v1', metrics, signals, env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(await runVoiceOutcomeCheck({ sessionId: 'v1', metrics, signals, synthetic: true, env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  test('no metrics and no connection failure: skipped', async () => {
    const call = jest.fn();
    expect(await runVoiceOutcomeCheck({ sessionId: 'v2', env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  test('shadow: one row with Jev next to the rule class; agreement when the rules named one', async () => {
    const call = jest.fn().mockResolvedValue(answer('no_engagement'));
    const id = await runVoiceOutcomeCheck({ sessionId: 'v3', metrics, signals, ruleClass: 'voice.no_engagement', env: SHADOW, sb, decideOptions: { call } });
    expect(id).toBe('s1');
    const state = call.mock.calls[0][0].state.session;
    expect(state).toMatchObject({ stop_reason: 'user_stop', provider: 'nova_sonic', duration_s: 45, turns: 0, audio_in_chunks: 400, rule_class: 'voice.no_engagement' });
    expect(rows[0]).toMatchObject({
      gate: 'voice_session_outcome',
      mode: 'shadow',
      plane: 'internal',
      tenant_id: null,
      subject_type: 'orb_voice_session',
      subject_ref: 'v3',
      jev_outcome: 'decided',
      jev_verdict: { outcome: 'no_engagement', needs_fix: 0.8, rule_outcome: 'no_engagement' },
      system_action: 'voice.no_engagement',
      agreed: true,
      outcome: 'compared_with_rule_class',
    });
  });

  test('disagreement with the rules is recorded as agreed=false', async () => {
    const call = jest.fn().mockResolvedValue(answer('connection_dropped'));
    await runVoiceOutcomeCheck({ sessionId: 'v4', metrics, signals, ruleClass: 'voice.model_stall', env: SHADOW, sb, decideOptions: { call } });
    expect(rows[0]).toMatchObject({ agreed: false, system_action: 'voice.model_stall' });
  });

  test('no rule class: agreed null, the row measures the rules’ blind spot', async () => {
    const call = jest.fn().mockResolvedValue(answer('model_stalled'));
    await runVoiceOutcomeCheck({ sessionId: 'v5', metrics, signals, ruleClass: null, env: SHADOW, sb, decideOptions: { call } });
    expect(rows[0]).toMatchObject({ system_action: 'no_rule_class', agreed: null, outcome: null, outcome_at: null });
  });

  test('a fast-fail with no metrics still earns a row when the connection failed', async () => {
    const call = jest.fn().mockResolvedValue(answer('failed_to_start'));
    await runVoiceOutcomeCheck({ sessionId: 'v6', signals: { ...signals, stop_reason: 'connection_failed', connection_failed: true }, env: SHADOW, sb, decideOptions: { call } });
    expect(call.mock.calls[0][0].state.session).toMatchObject({ connection_failed: true, turns: 0, audio_out_chunks: 0 });
    expect(rows[0]).toMatchObject({ subject_ref: 'v6', jev_verdict: { outcome: 'failed_to_start' } });
  });

  test('a throwing Jev call never throws out of the gate', async () => {
    const call = jest.fn().mockRejectedValue(new Error('net'));
    await expect(runVoiceOutcomeCheck({ sessionId: 'v7', metrics, signals, env: SHADOW, sb, decideOptions: { call } })).resolves.toBeNull();
  });

  test('rule class → outcome mapping covers the quality and error classes', () => {
    expect(ruleOutcome('voice.model_under_responds')).toBe('one_way_audio');
    expect(ruleOutcome('voice.upstream_disconnect')).toBe('connection_dropped');
    expect(ruleOutcome('voice.tool_loop')).toBe('looping');
    expect(ruleOutcome('voice.config_missing')).toBe('failed_to_start');
    expect(ruleOutcome('voice.unknown')).toBeNull();
    expect(ruleOutcome(null)).toBeNull();
  });
});

describe('VTID-04775 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  test('the fire-and-forget dispatch runs the gate after the rule classifier, never on a repeat report', () => {
    const adapter = read('src/services/voice-self-healing-adapter.ts');
    const fn = adapter.slice(adapter.indexOf('export function dispatchVoiceFailureFireAndForget('));
    expect(fn).toContain('dispatchVoiceFailure(opts)');
    expect(fn).toContain("if (!isVoiceOutcomeOn() || result.action === 'duplicate_session_report') return;");
    expect(fn).toContain('void runVoiceOutcomeCheck({');
    expect(fn).toContain('ruleClass: result.class ?? null');
  });

  test('every session-stop dispatch passes outcome signals', () => {
    const orb = read('src/routes/orb-live.ts');
    const ctrl = read('src/orb/live/session/live-session-controller.ts');
    const dispatches = (orb.match(/dispatchVoiceFailureFireAndForget\(\{/g) || []).length;
    const withSignals = (orb.match(/outcomeSignals: /g) || []).length;
    expect(dispatches).toBe(5);
    expect(withSignals).toBe(dispatches);
    expect(orb).toContain("buildVoiceOutcomeSignals(existingSession, 'superseded_by_new_session')");
    expect(orb).toContain("buildVoiceOutcomeSignals(liveSession, 'ws_stop_session')");
    expect(orb).toContain('connection_failed: true');
    expect(ctrl).toContain("outcomeSignals: buildVoiceOutcomeSignals(session, 'user_stop')");
    expect(ctrl).toContain('VTID-04775 flow-test-exempt');
  });

  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_VOICE_SESSION_OUTCOME_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_VOICE_SESSION_OUTCOME_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_VOICE_SESSION_OUTCOME_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
