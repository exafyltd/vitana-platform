/**
 * VTID-04485 — the read-only specialists wait long enough on voice for the
 * answer to land in the same turn. Measured live on staging (VTID-04474): the
 * support specialist took 3.0 s against a 1.5 s ack window, so the member only
 * heard "I'm checking" and had to ask again.
 */
import {
  runAskSupportSpecialist,
  specialistAckWindowMs,
  SPECIALIST_VOICE_ACK_DEFAULT_MS,
} from '../src/orb/live/tools/delegation-tools';
import { registerDelegationTarget, resetDelegationJobs, ACK_WINDOW_MS } from '../src/services/orchestrator/dispatcher';
import { registerDefaultDelegationTargets, resetDefaultRegistration } from '../src/services/orchestrator/delegation-targets';
import { SUPPORT_SPECIALIST_ENABLED_ENV, SUPPORT_TARGET } from '../src/services/orchestrator/support-specialist';

const ENV = 'ORCHESTRATOR_SPECIALIST_VOICE_ACK_MS';
const saved = { flag: process.env[SUPPORT_SPECIALIST_ENABLED_ENV], ack: process.env[ENV] };
afterEach(() => {
  jest.useRealTimers();
  for (const [k, v] of [[SUPPORT_SPECIALIST_ENABLED_ENV, saved.flag], [ENV, saved.ack]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  resetDelegationJobs();
  resetDefaultRegistration();
});

describe('specialistAckWindowMs', () => {
  test('AC-1 voice defaults to 4.5 s, above the 3.0 s measured specialist latency', () => {
    delete process.env[ENV];
    expect(SPECIALIST_VOICE_ACK_DEFAULT_MS).toBe(4_500);
    expect(specialistAckWindowMs('voice')).toBe(4_500);
    expect(specialistAckWindowMs('voice')).toBeGreaterThan(3_000);
  });

  test('AC-2 other channels keep the dispatcher default', () => {
    expect(specialistAckWindowMs('chat')).toBeUndefined();
    expect(specialistAckWindowMs('web')).toBeUndefined();
    expect(ACK_WINDOW_MS.voice).toBe(1_500); // the operator hand-off keeps its short ack
  });

  test('AC-3 env override is clamped to 1.5–8 s; garbage falls back to the default', () => {
    process.env[ENV] = '100'; expect(specialistAckWindowMs('voice')).toBe(1_500);
    process.env[ENV] = '60000'; expect(specialistAckWindowMs('voice')).toBe(8_000);
    process.env[ENV] = '3000'; expect(specialistAckWindowMs('voice')).toBe(3_000);
    process.env[ENV] = 'abc'; expect(specialistAckWindowMs('voice')).toBe(4_500);
  });
});

test('AC-4 a support answer that takes 3 s is spoken in the same turn, not deferred', async () => {
  process.env[SUPPORT_SPECIALIST_ENABLED_ENV] = 'true';
  delete process.env[ENV];
  registerDefaultDelegationTargets();
  registerDelegationTarget({
    ...SUPPORT_TARGET,
    run: () => new Promise((res) => setTimeout(() => res({ ok: true, result: { findings: 'no open tickets' } }), 3_000)),
  });
  jest.useFakeTimers();
  const pending = runAskSupportSpecialist(
    { sessionId: 's1', current_route: '/community', identity: { user_id: 'u-1' }, active_role: 'community' },
    { question: 'Do I have open tickets?' },
  );
  await jest.advanceTimersByTimeAsync(3_001);
  const r = await pending;
  expect(r.success).toBe(true);
  expect(JSON.parse(r.result)).toEqual({ findings: 'no open tickets' });
});

describe('AC-5 the voice tool budget does not cut the specialist off before its ack window', () => {
  // Measured live on staging (gateway e7a8531): a 3.2 s support lookup hit
  // orb-live's flat 3 s TOOL_TIMEOUT_MS and returned "timed out after 3000ms",
  // so the 4.5 s ack window never took effect on the Nova path.
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/orb-live.ts'), 'utf8') as string;

  test('both specialist tools are in the extended-budget set', () => {
    expect(src).toMatch(/SPECIALIST_VOICE_TOOLS = new Set\(\['ask_support_specialist', 'ask_commerce_specialist'\]\)/);
  });

  test('their budget is max(3 s, ack window + 1 s), taken from specialistAckWindowMs', () => {
    expect(src).toMatch(/SPECIALIST_VOICE_TOOLS\.has\(toolName\) \? Math\.max\(3_000, \(specialistAckWindowMs\('voice'\) \?\? SPECIALIST_VOICE_ACK_DEFAULT_MS\) \+ 1_000\)/);
  });

  test('the budget always exceeds the ack window, across the whole clamp range', () => {
    for (const v of ['1500', '4500', '8000', undefined]) {
      if (v === undefined) delete process.env[ENV]; else process.env[ENV] = v;
      const ack = specialistAckWindowMs('voice') as number;
      const budget = Math.max(3_000, ack + 1_000); // mirrors orb-live.ts
      expect(budget).toBeGreaterThan(ack);
      expect(budget).toBeGreaterThanOrEqual(3_000); // never shorter than the old flat budget
    }
  });
});
