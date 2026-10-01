/**
 * VTID-04759: Jev P1 gates B1 (incident dedupe) and B2 (provider-failure
 * type) before self-healing triage. Classifier fixtures are the exact
 * llm.call.failed messages from 14 days of production (2026-09-30).
 */
const rows: any[] = [];
const outcomes: any[] = [];
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}`, created_at: new Date().toISOString() });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
  updateShadowOutcome: jest.fn(async (_sb: unknown, id: string, patch: any) => {
    outcomes.push({ id, ...patch });
    return { data: null, error: null };
  }),
  fetchRecentShadowBySubject: jest.fn(async (_sb: unknown, gate: string, ref: string, since: string) => {
    const hit = rows.filter((r) => r.gate === gate && r.subject_ref === ref && r.created_at >= since).at(-1);
    return { data: hit ? { id: hit.id, subject_ref: hit.subject_ref } : null, error: null };
  }),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import {
  classifyProviderFailure,
  failureTextOf,
  incidentKey,
  runSelfHealGates,
  recordSelfHealGateOutcome,
} from '../src/services/jev/gates/selfheal-gates';
import { PROVIDER_OUTAGE_RE } from '../src/services/dev-autopilot-retry-breaker';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const PROD = {
  bedrockDenied: 'LLM call failed: triage - Bedrock invoke_failed: Operation not allowed',
  deepseek402: 'LLM call failed: triage - DeepSeek 402: {"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}',
  bothFailed: 'LLM call failed on turn 1: both providers failed: primary=deepseek 402 Insufficient Balance; fallback=bedrock AccessDeniedException: Operation not allowed',
  dailyTokens: 'LLM call failed: memory - Bedrock invoke_failed: Too many tokens per day, please wait before trying again.',
  promptTooLong: 'LLM call failed: planner - Bedrock invoke_failed: prompt is too long: 480539 tokens > 200000 maximum',
  badGateway: 'LLM call failed: worker - DeepSeek 502: <html><head><title>502 Bad Gateway</title></head>',
  timeout: 'LLM call failed: worker - DeepSeek request timed out after 600000ms (DEEPSEEK_TIMEOUT_MS)',
  throttled: 'LLM call failed: worker - Bedrock invoke_failed: ThrottlingException: Rate exceeded',
};

const ENV_ON = (p: string, d: string) => ({ JEV_SELFHEAL_PROVIDER_FAILURE_MODE: p, JEV_SELFHEAL_INCIDENT_DEDUPE_MODE: d }) as NodeJS.ProcessEnv;
const sb = {} as any;

beforeEach(() => {
  rows.length = 0;
  outcomes.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04759 B2 provider-failure classifier (production strings)', () => {
  test.each([
    ['bedrockDenied', 'permission', 'stop_and_alert'],
    ['deepseek402', 'credit', 'stop_and_alert'],
    ['bothFailed', 'credit', 'stop_and_alert'],
    ['dailyTokens', 'quota', 'stop_and_alert'],
    ['promptTooLong', 'input_too_large', 'triage'],
    ['badGateway', 'transient', 'retry_once'],
    ['timeout', 'transient', 'retry_once'],
    ['throttled', 'throttle', 'back_off'],
  ])('%s → %s / %s', (k, cls, action) => {
    expect(classifyProviderFailure((PROD as any)[k])).toMatchObject({ cls, action });
  });

  test('both providers are named on a two-provider failure', () => {
    expect(classifyProviderFailure(PROD.bothFailed).providers).toEqual(['bedrock', 'deepseek']);
  });

  test('every message the retry breaker calls an outage is a stop class here too', () => {
    for (const t of [PROD.bedrockDenied, PROD.deepseek402, PROD.bothFailed, 'executor task could not be started: RunTask refused', 'Anthropic: account is currently blocked']) {
      expect(PROVIDER_OUTAGE_RE.test(t)).toBe(true);
      expect(classifyProviderFailure(t).action).toBe('stop_and_alert');
    }
  });

  test('our own endpoint failing with 403/502 is not a provider failure — triage it', () => {
    expect(classifyProviderFailure('GET /api/v1/feed returned 403 Forbidden')).toMatchObject({ cls: 'none', action: 'triage' });
    expect(classifyProviderFailure('health probe: 502 from /alive')).toMatchObject({ cls: 'none', action: 'triage' });
  });

  test('an unrecognised provider failure is unknown (Jev is asked), empty text is none', () => {
    expect(classifyProviderFailure('LLM call failed: worker - Bedrock invoke_failed: something new')).toMatchObject({ cls: 'unknown', action: 'triage' });
    expect(classifyProviderFailure('')).toMatchObject({ cls: 'none' });
  });

  test('failure text is read from whichever field the caller used', () => {
    expect(failureTextOf({ failure: { error: 'a' } })).toBe('a');
    expect(failureTextOf({ original_diagnosis: { error: 'b' } })).toBe('b');
    expect(failureTextOf({ diagnosis: { root_cause: 'c' } })).toBe('c');
  });
});

describe('VTID-04759 B1 incident key', () => {
  test('one outage is one incident whatever execution hit it', () => {
    const v = classifyProviderFailure(PROD.bedrockDenied);
    expect(incidentKey(v, { vtid: 'VTID-1', endpoint: 'dev-autopilot://exec/1' })).toBe('provider:permission:bedrock');
    expect(incidentKey(v, { vtid: 'VTID-2', endpoint: 'dev-autopilot://exec/2' })).toBe('provider:permission:bedrock');
  });
  test('anything else keys on the endpoint, else the vtid (never deduped)', () => {
    const v = classifyProviderFailure('');
    expect(incidentKey(v, { vtid: 'VTID-1', failure: { endpoint: '/api/x' } })).toBe('endpoint:/api/x');
    expect(incidentKey(v, { vtid: 'VTID-1' })).toBe('vtid:VTID-1');
  });
});

describe('VTID-04759 gate modes', () => {
  const triage = (vtid: string, error: string) => ({ vtid, mode: 'post_failure', endpoint: `dev-autopilot://${vtid}`, original_diagnosis: { error } });

  test('off (default): no row, no skip', async () => {
    const r = await runSelfHealGates(triage('VTID-1', PROD.bedrockDenied), { env: {}, sb });
    expect(r.skip).toBeNull();
    expect(rows).toHaveLength(0);
  });

  test('shadow: rows recorded for both gates, triage never skipped — even on a duplicate outage', async () => {
    const env = ENV_ON('shadow', 'shadow');
    const a = await runSelfHealGates(triage('VTID-1', PROD.bedrockDenied), { env, sb });
    const b = await runSelfHealGates(triage('VTID-2', PROD.bedrockDenied), { env, sb });
    expect(a.skip).toBeNull();
    expect(b.skip).toBeNull();
    expect(a.dedupe.duplicate_of).toBeNull();
    expect(b.dedupe.duplicate_of).toBe('provider:permission:bedrock');
    expect(rows.map((r) => r.gate)).toEqual(['selfheal_incident_dedupe', 'selfheal_provider_failure', 'selfheal_incident_dedupe', 'selfheal_provider_failure']);
    expect(rows[1]).toMatchObject({ mode: 'shadow', subject_type: 'triage', subject_ref: 'VTID-1', jev_verdict: { source: 'rules', class: 'permission', action: 'stop_and_alert' }, cost_usd: 0 });
  });

  test('enforce: a provider outage skips triage', async () => {
    const r = await runSelfHealGates(triage('VTID-1', PROD.deepseek402), { env: ENV_ON('enforce', 'off'), sb });
    expect(r.skip).toEqual({ gate: 'selfheal_provider_failure', reason: 'provider_credit' });
  });

  test('enforce: a transient or code failure still triages', async () => {
    expect((await runSelfHealGates(triage('VTID-1', PROD.timeout), { env: ENV_ON('enforce', 'off'), sb })).skip).toBeNull();
    expect((await runSelfHealGates(triage('VTID-2', PROD.promptTooLong), { env: ENV_ON('enforce', 'off'), sb })).skip).toBeNull();
  });

  test('enforce dedupe: the second triage of the same outage within 30 min is skipped; after 30 min it runs', async () => {
    let t = Date.parse('2026-10-01T10:00:00Z');
    const now = () => t;
    const env = ENV_ON('off', 'enforce');
    expect((await runSelfHealGates(triage('VTID-1', PROD.bedrockDenied), { env, sb, now })).skip).toBeNull();
    rows[0].created_at = new Date(t).toISOString();
    t += 10 * 60 * 1000;
    expect((await runSelfHealGates(triage('VTID-2', PROD.bedrockDenied), { env, sb, now })).skip).toEqual({
      gate: 'selfheal_incident_dedupe',
      reason: 'duplicate_open_incident:provider:permission:bedrock',
    });
    rows.forEach((r) => (r.created_at = new Date(Date.parse('2026-10-01T10:00:00Z')).toISOString()));
    t += 40 * 60 * 1000;
    expect((await runSelfHealGates(triage('VTID-3', PROD.bedrockDenied), { env, sb, now })).skip).toBeNull();
  });

  test('a typo in the mode is off, never enforce', async () => {
    const r = await runSelfHealGates(triage('VTID-1', PROD.bedrockDenied), { env: ENV_ON('Enforce', 'true'), sb });
    expect(r.skip).toBeNull();
    expect(rows).toHaveLength(0);
  });

  test('an unrecognised provider failure asks Jev (ops_error_triage) and records its verdict', async () => {
    const call = jest.fn().mockResolvedValue({
      ok: true,
      model: 'jev-1.13.0',
      answers: {
        cause: { type: 'choice', choice: 'dependency', probabilities: { dependency: 0.9 }, confidence: 0.9 },
        needs_human: { type: 'noul', noul: 0.8 },
      },
      usage: { input_tokens: 500, output_tokens: 2 },
      latency_ms: 30,
      attempts: 1,
    });
    const env = { ...ENV_ON('shadow', 'off'), JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
    await runSelfHealGates(triage('VTID-1', 'LLM call failed: worker - Bedrock invoke_failed: brand new failure'), { env, sb, decideOptions: { call } });
    expect(call).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ decision: 'ops_error_triage', jev_verdict: { source: 'rules+jev', class: 'unknown', jev: { outcome: 'decided', cause: 'dependency', needs_human: true } } });
  });

  test('a known class never calls Jev', async () => {
    const call = jest.fn();
    await runSelfHealGates(triage('VTID-1', PROD.bedrockDenied), { env: ENV_ON('shadow', 'off'), sb, decideOptions: { call } });
    expect(call).not.toHaveBeenCalled();
  });

  test('a failing gate store never blocks triage', async () => {
    const repo = require('../src/services/jev/jev-repository');
    repo.fetchRecentShadowBySubject.mockImplementationOnce(async () => {
      throw new Error('db down');
    });
    const r = await runSelfHealGates(triage('VTID-1', PROD.bedrockDenied), { env: ENV_ON('enforce', 'enforce'), sb });
    expect(r.skip).toBeNull();
  });
});

describe('VTID-04759 outcome write-back (agreement)', () => {
  const run = (error: string) =>
    runSelfHealGates({ vtid: 'VTID-1', mode: 'post_failure', original_diagnosis: { error } }, { env: ENV_ON('shadow', 'shadow'), sb });

  test('predicted stop + triage then died on the outage → agreed', async () => {
    const g = await run(PROD.bedrockDenied);
    await recordSelfHealGateOutcome(g, { ok: false, error: PROD.bedrockDenied }, sb);
    expect(outcomes.find((o) => o.id === g.provider.shadow_id)).toMatchObject({ outcome: 'triage_failed:permission', agreed: true });
    expect(outcomes.find((o) => o.id === g.dedupe.shadow_id)).toMatchObject({ outcome: 'triage_failed:permission', agreed: null });
  });

  test('predicted stop but triage succeeded → disagreed', async () => {
    const g = await run(PROD.deepseek402);
    await recordSelfHealGateOutcome(g, { ok: true }, sb);
    expect(outcomes.find((o) => o.id === g.provider.shadow_id)).toMatchObject({ outcome: 'triage_ok', agreed: false });
  });

  test('predicted proceed (transient) and triage succeeded → agreed', async () => {
    const g = await run(PROD.timeout);
    await recordSelfHealGateOutcome(g, { ok: true }, sb);
    expect(outcomes.find((o) => o.id === g.provider.shadow_id)).toMatchObject({ agreed: true });
  });
});

describe('VTID-04759 deploy pins: both gates run in shadow, never enforce', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.resolve(__dirname, '../../..');
  const stage = fs.readFileSync(path.join(root, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
  const prod = fs.readFileSync(path.join(root, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
  test.each([
    ['staging', stage],
    ['prod', prod],
  ])('%s pins shadow for both gates', (_n, wf: string) => {
    expect(wf).toContain('{name:"JEV_SELFHEAL_PROVIDER_FAILURE_MODE", value:"shadow"}');
    expect(wf).toContain('{name:"JEV_SELFHEAL_INCIDENT_DEDUPE_MODE", value:"shadow"}');
    expect(wf).not.toMatch(/JEV_SELFHEAL_\w+_MODE", value:"enforce"/);
  });
  test('the generated pin registry agrees', () => {
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_SELFHEAL_PROVIDER_FAILURE_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
    expect(GATEWAY_WORKFLOW_PINS.JEV_SELFHEAL_INCIDENT_DEDUPE_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
