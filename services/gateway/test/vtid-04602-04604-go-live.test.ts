/**
 * VTID-04602 / 04603 / 04604 — the three fixes the owner approved before the
 * specialists go live in production.
 */
import { SPECIALIST_VOICE_ACK_DEFAULT_MS, SPECIALIST_REUSE_WITHIN_MS } from '../src/orb/live/tools/delegation-tools';
import {
  clearDelegationTargets,
  delegateToAgent,
  registerDelegationTarget,
  resetDelegationJobs,
  type DelegationCaller,
} from '../src/services/orchestrator/dispatcher';
import { checkVoiceCalendarWrite, memberHasSpoken, PAST_START_TOLERANCE_MS } from '../src/orb/live/tools/calendar-write-guard';

const caller: DelegationCaller = {
  user_id: 'u-1', tenant_id: 't-1', platform_role: 'community', exafy_admin: false,
  surface: 'vitanaland', channel: 'voice', session_id: 's-1',
} as DelegationCaller;

function registerCounting(delayMs: number) {
  let calls = 0;
  registerDelegationTarget({
    agent_id: 'support', domain: 'community', tier: 'read', surfaces: ['vitanaland'],
    description: 'test', run: async () => { calls += 1; await new Promise((r) => setTimeout(r, delayMs)); return { ok: true, result: { findings: `run ${calls}` } }; },
  } as never);
  return () => calls;
}

afterEach(() => { jest.useRealTimers(); resetDelegationJobs(); clearDelegationTargets(); });

describe('VTID-04602 voice ack default', () => {
  test('AC-1 the default is 6 s', () => {
    expect(SPECIALIST_VOICE_ACK_DEFAULT_MS).toBe(6_000);
  });
});

describe('VTID-04603 one specialist job per question burst', () => {
  test('AC-2 a second call in the same session while the first runs joins it (one run)', async () => {
    const count = registerCounting(50);
    const [a, b] = await Promise.all([
      delegateToAgent('support', 'Do I have open tickets?', caller, { ackWindowMs: 1_000, reuseWithinMs: SPECIALIST_REUSE_WITHIN_MS }),
      delegateToAgent('support', 'What is the status of my support tickets?', caller, { ackWindowMs: 1_000, reuseWithinMs: SPECIALIST_REUSE_WITHIN_MS }),
    ]);
    expect(count()).toBe(1);
    expect(a.status).toBe('done');
    expect(b).toMatchObject({ status: 'done', reused: true });
    expect((a as { job_id: string }).job_id).toBe((b as { job_id: string }).job_id);
  });

  test('AC-3 a call right after a finished job reuses its result; after the window it runs again', async () => {
    const count = registerCounting(5);
    let now = 1_000_000;
    const clock = () => now;
    const r1 = await delegateToAgent('support', 'q1', caller, { ackWindowMs: 1_000, reuseWithinMs: 15_000, now: clock });
    expect(r1.status).toBe('done');
    now += 5_000;
    const r2 = await delegateToAgent('support', 'q2', caller, { ackWindowMs: 1_000, reuseWithinMs: 15_000, now: clock });
    expect(r2).toMatchObject({ status: 'done', reused: true });
    expect(count()).toBe(1);
    now += 20_000;
    const r3 = await delegateToAgent('support', 'q3', caller, { ackWindowMs: 1_000, reuseWithinMs: 15_000, now: clock });
    expect(r3.status).toBe('done');
    expect((r3 as { reused?: boolean }).reused).toBeUndefined();
    expect(count()).toBe(2);
  });

  test('AC-4 never reused across sessions, users or surfaces, or when reuse is off', async () => {
    const count = registerCounting(5);
    await delegateToAgent('support', 'q', caller, { ackWindowMs: 1_000, reuseWithinMs: 15_000 });
    await delegateToAgent('support', 'q', { ...caller, session_id: 's-2' }, { ackWindowMs: 1_000, reuseWithinMs: 15_000 });
    await delegateToAgent('support', 'q', { ...caller, user_id: 'u-2' }, { ackWindowMs: 1_000, reuseWithinMs: 15_000 });
    await delegateToAgent('support', 'q', caller, { ackWindowMs: 1_000 });
    expect(count()).toBe(4);
  });
});

describe('VTID-04604 voice calendar writes', () => {
  const now = Date.parse('2026-09-26T10:00:00Z');
  const future = '2026-09-27T09:00:00Z';

  test('AC-5 refused before the member has spoken, even if "confirmed"', () => {
    expect(checkVoiceCalendarWrite({ memberHasSpoken: false, confirmed: true, startTime: future, nowMs: now })).toMatch(/^STATUS: not_created/);
  });

  test('AC-6 refused without confirmed=true', () => {
    for (const c of [undefined, false, 'true', 1]) {
      expect(checkVoiceCalendarWrite({ memberHasSpoken: true, confirmed: c, startTime: future, nowMs: now })).toMatch(/^STATUS: needs_confirmation/);
    }
  });

  test('AC-7 refused for a past date (the live event was dated 2026-04-15) and an invalid date', () => {
    expect(checkVoiceCalendarWrite({ memberHasSpoken: true, confirmed: true, startTime: '2026-04-15T18:00:00Z', nowMs: now })).toMatch(/in the past/);
    expect(checkVoiceCalendarWrite({ memberHasSpoken: true, confirmed: true, startTime: 'tomorrow', nowMs: now })).toMatch(/not a valid date/);
  });

  test('AC-8 allowed when asked, confirmed and in the future (a start within the tolerance too)', () => {
    expect(checkVoiceCalendarWrite({ memberHasSpoken: true, confirmed: true, startTime: future, nowMs: now })).toBeNull();
    const justNow = new Date(now - PAST_START_TOLERANCE_MS + 60_000).toISOString();
    expect(checkVoiceCalendarWrite({ memberHasSpoken: true, confirmed: true, startTime: justNow, nowMs: now })).toBeNull();
  });

  test('AC-9 memberHasSpoken reads stored user turns and live input only', () => {
    expect(memberHasSpoken({ transcriptTurns: [], inputTranscriptBuffer: '' })).toBe(false);
    expect(memberHasSpoken({ transcriptTurns: [{ role: 'assistant', text: 'Hi' }] })).toBe(false);
    expect(memberHasSpoken({ transcriptTurns: [{ role: 'user', text: '  ' }] })).toBe(false);
    expect(memberHasSpoken({ transcriptTurns: [{ role: 'user', text: 'book yoga' }] })).toBe(true);
    expect(memberHasSpoken({ inputTranscriptBuffer: 'book yoga tomorrow' })).toBe(true);
  });

  test('AC-10 orb-live runs the guard before any calendar write, and the tool declares confirmed', () => {
    const fs = require('fs'); const path = require('path');
    const src: string = fs.readFileSync(path.join(__dirname, '../src/routes/orb-live.ts'), 'utf8');
    const i = src.indexOf("case 'create_calendar_event':");
    const guard = src.indexOf('checkVoiceCalendarWrite', i);
    const write = src.indexOf('createCalendarEvent(userId', i);
    expect(guard).toBeGreaterThan(i);
    expect(write).toBeGreaterThan(guard);
    const cat: string = fs.readFileSync(path.join(__dirname, '../src/orb/live/tools/live-tool-catalog.ts'), 'utf8');
    const j = cat.indexOf("name: 'create_calendar_event'");
    expect(cat.slice(j, j + 3000)).toMatch(/confirmed: \{\s*type: 'boolean'/);
  });
});
