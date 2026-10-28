/**
 * VTID-04164: in-process rate limit on the Operator Console execution
 * on-ramp (`autopilot_run_task` / `autopilot_execute_task`).
 *
 * Two halves, both pinned:
 *   1. The pure sliding-window limiter (operator-onramp-rate-limit.ts):
 *      5 calls per threadId per rolling 60s, the 6th refused with a reset
 *      time, and a new call allowed once the window has rolled past.
 *   2. Source wiring + behaviour: triggerOperatorExecution() consults the
 *      limiter BEFORE any VTID allocation, and a refusal comes back as a
 *      normal `{ ok: false, error }` result — never a thrown exception.
 */

jest.mock('../src/services/dev-autopilot-execute', () => {
  const actual = jest.requireActual('../src/services/dev-autopilot-execute');
  return { ...actual, getSupabase: jest.fn(), supa: jest.fn(), approveAutoExecute: jest.fn() };
});
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  ONRAMP_RATE_LIMIT_MAX_CALLS,
  ONRAMP_RATE_LIMIT_WINDOW_MS,
  checkOnRampRateLimit,
  createSlidingWindowLimiter,
  describeOnRampRateLimit,
  resetOnRampRateLimit,
} from '../src/services/operator-onramp-rate-limit';
import { triggerOperatorExecution } from '../src/services/operator-execution-onramp';
import { getSupabase } from '../src/services/dev-autopilot-execute';

const mockedGetSupabase = getSupabase as jest.Mock;
const ONRAMP_SRC = fs.readFileSync(
  path.resolve(__dirname, '../src/services/operator-execution-onramp.ts'),
  'utf8',
);

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as any;
}

describe('VTID-04164 sliding-window limiter (pure)', () => {
  it('is configured to 5 calls per rolling 60s', () => {
    expect(ONRAMP_RATE_LIMIT_MAX_CALLS).toBe(5);
    expect(ONRAMP_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it('allows the first 5 calls in the window and refuses the 6th', () => {
    const limiter = createSlidingWindowLimiter({ limit: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i += 1) {
      const r = limiter.check('thread-a', 1_000 + i);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i + 1);
    }
    const refused = limiter.check('thread-a', 1_005);
    expect(refused.allowed).toBe(false);
    expect(refused.limit).toBe(5);
    expect(refused.window_ms).toBe(60_000);
    // Oldest hit was at 1_000 with a 60s window → 59_995ms left.
    expect(refused.retry_after_ms).toBe(59_995);
  });

  it('names the limit and the reset time in the refusal text', () => {
    const limiter = createSlidingWindowLimiter({ limit: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i += 1) limiter.check('thread-b', 10_000);
    const msg = describeOnRampRateLimit(limiter.check('thread-b', 10_000));
    expect(msg).toMatch(/operator_onramp_rate_limited/);
    expect(msg).toMatch(/limit is 5/);
    expect(msg).toMatch(/per 60s per thread/);
    expect(msg).toMatch(/try again in 60s/);
    expect(msg).toMatch(/autopilot_run_task/);
  });

  it('allows a new call once the window has rolled past', () => {
    const limiter = createSlidingWindowLimiter({ limit: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i += 1) limiter.check('thread-c', 0);
    expect(limiter.check('thread-c', 59_999).allowed).toBe(false);
    // 60_001 is one ms past the oldest hit (0) leaving the window.
    expect(limiter.check('thread-c', 60_001).allowed).toBe(true);
  });

  it('slides per hit, not per fixed bucket: the 6th is refused even spread across the window', () => {
    const limiter = createSlidingWindowLimiter({ limit: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i += 1) limiter.check('thread-d', i * 10_000);
    const refused = limiter.check('thread-d', 45_000);
    expect(refused.allowed).toBe(false);
    // All five hits are still inside the window; the oldest (0) resets at 60s.
    expect(refused.retry_after_ms).toBe(15_000);
  });

  it('refused calls are not counted — the window cannot be pushed forward forever', () => {
    const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 60_000 });
    limiter.check('thread-e', 0);
    limiter.check('thread-e', 0);
    for (let t = 1; t < 60_000; t += 1_000) expect(limiter.check('thread-e', t).allowed).toBe(false);
    expect(limiter.check('thread-e', 60_001).allowed).toBe(true);
  });

  it('keys are independent (one thread cannot throttle another)', () => {
    const limiter = createSlidingWindowLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.check('thread-f', 0).allowed).toBe(true);
    expect(limiter.check('thread-f', 0).allowed).toBe(false);
    expect(limiter.check('thread-g', 0).allowed).toBe(true);
  });

  it('the process-wide counter exposes the same 5/60s behaviour and resets', () => {
    resetOnRampRateLimit();
    for (let i = 0; i < 5; i += 1) expect(checkOnRampRateLimit('thread-h', 0).allowed).toBe(true);
    expect(checkOnRampRateLimit('thread-h', 0).allowed).toBe(false);
    resetOnRampRateLimit();
    expect(checkOnRampRateLimit('thread-h', 0).allowed).toBe(true);
    resetOnRampRateLimit();
  });
});

describe('VTID-04164 on-ramp wiring', () => {
  const ORIGINAL_ENV = process.env;
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, OPERATOR_EXECUTION_ONRAMP_ENABLED: 'true', OPERATOR_VTID_SELF_ALLOCATE_ENABLED: 'true' };
    resetOnRampRateLimit();
    mockedGetSupabase.mockReset().mockReturnValue({ url: 'https://test.supabase.co', key: 'k' });
    fetchMock = jest.fn().mockResolvedValue(jsonRes(500, { error: 'allocator disabled' }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    global.fetch = originalFetch;
    resetOnRampRateLimit();
  });

  it('consults the limiter before the VTID self-allocation path', () => {
    const limiterIdx = ONRAMP_SRC.indexOf('checkOnRampRateLimit(input.requestedBy)');
    // lastIndexOf: the function's own definition appears earlier in the file
    // than the entry point's call site.
    const allocIdx = ONRAMP_SRC.lastIndexOf('allocateAndRegisterVtid(');
    expect(limiterIdx).toBeGreaterThan(-1);
    expect(allocIdx).toBeGreaterThan(-1);
    expect(limiterIdx).toBeLessThan(allocIdx);
    // and before the kill-switch-only path reads config or the safety gate
    expect(limiterIdx).toBeLessThan(ONRAMP_SRC.indexOf("const s = getSupabase();"));
  });

  it('refuses the 6th call within 60s as a normal tool error — no allocation, no throw', async () => {
    const requestedBy = 'operator-chat:thread-rate-limit-1';
    const call = () =>
      triggerOperatorExecution({
        planMarkdown: 'Add a unit test for the limiter.',
        filesReferenced: [],
        openEnded: true,
        requestedBy,
      });

    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await call());

    // Calls 1-5 are refused downstream (allocator mocked down) but NOT by the limiter.
    for (const r of results.slice(0, 5)) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toMatch(/operator_onramp_rate_limited/);
    }
    const sixth = results[5];
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) {
      expect(sixth.error).toMatch(/operator_onramp_rate_limited/);
      expect(sixth.error).toMatch(/limit is 5/);
      expect(sixth.error).toMatch(/try again in \d+s/);
    }

    // The limiter fired BEFORE allocation: exactly 5 allocation attempts were
    // made, and the 6th never reached the allocator RPC.
    const allocCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('allocate_global_vtid'));
    expect(allocCalls).toHaveLength(5);

    // A different thread is unaffected.
    const other = await triggerOperatorExecution({
      planMarkdown: 'Add a unit test for the limiter.',
      filesReferenced: [],
      openEnded: true,
      requestedBy: 'operator-chat:thread-rate-limit-2',
    });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error).not.toMatch(/operator_onramp_rate_limited/);
  });
});
