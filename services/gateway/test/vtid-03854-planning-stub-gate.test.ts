/**
 * VTID-03854: dev-autopilot-planning.ts's runPlanningSession() used to
 * short-circuit to a deterministic stub plan whenever ANTHROPIC_API_KEY was
 * unset — checked BEFORE even attempting the routed call (worker queue or
 * callRoutedLlm -> callViaRouter('planner', ...)). Per CLAUDE.md §1b,
 * ANTHROPIC_API_KEY is deliberately never populated in AWS Secrets Manager,
 * so that gate was permanently true on the real deployed gateway: every
 * finding whose worker queue was unavailable silently got the generic stub
 * template instead of a real, LLM-authored plan.
 *
 * Fix: the stub is now an explicit, off-by-default opt-in
 * (DEV_AUTOPILOT_PLANNING_STUB_ENABLED), and the real routed call is always
 * attempted otherwise — a genuine call failure still surfaces as a real
 * {ok:false,error}, unchanged from before.
 *
 * runPlanningSession() itself needs a live Supabase connection and isn't
 * unit-testable in isolation (same established scope limit as this module's
 * other Supabase-dependent helpers — see vtid-03820/03821's sibling tests).
 * This is a source-level regression guard plus a runtime test of the new
 * exported flag function.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isPlanningStubEnabled } from '../src/services/dev-autopilot-planning';

const SOURCE: string = fs.readFileSync(
  path.join(__dirname, '../src/services/dev-autopilot-planning.ts'),
  'utf8'
);

describe('isPlanningStubEnabled (VTID-03854)', () => {
  const ORIGINAL = process.env.DEV_AUTOPILOT_PLANNING_STUB_ENABLED;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DEV_AUTOPILOT_PLANNING_STUB_ENABLED;
    else process.env.DEV_AUTOPILOT_PLANNING_STUB_ENABLED = ORIGINAL;
  });

  it('defaults to false when unset', () => {
    delete process.env.DEV_AUTOPILOT_PLANNING_STUB_ENABLED;
    expect(isPlanningStubEnabled()).toBe(false);
  });

  it('is false for values that are not any casing of the word "true"', () => {
    process.env.DEV_AUTOPILOT_PLANNING_STUB_ENABLED = '1';
    expect(isPlanningStubEnabled()).toBe(false);
    process.env.DEV_AUTOPILOT_PLANNING_STUB_ENABLED = 'yes';
    expect(isPlanningStubEnabled()).toBe(false);
    process.env.DEV_AUTOPILOT_PLANNING_STUB_ENABLED = 'false';
    expect(isPlanningStubEnabled()).toBe(false);
    process.env.DEV_AUTOPILOT_PLANNING_STUB_ENABLED = '';
    expect(isPlanningStubEnabled()).toBe(false);
  });

  it('is true only for the exact string "true" (case-insensitive)', () => {
    process.env.DEV_AUTOPILOT_PLANNING_STUB_ENABLED = 'true';
    expect(isPlanningStubEnabled()).toBe(true);
    process.env.DEV_AUTOPILOT_PLANNING_STUB_ENABLED = 'True';
    expect(isPlanningStubEnabled()).toBe(true);
  });
});

describe('runPlanningSession source wiring (VTID-03854, source check)', () => {
  it('never reads ANTHROPIC_API_KEY as a module-level constant', () => {
    expect(SOURCE).not.toMatch(/^const ANTHROPIC_API_KEY/m);
    expect(SOURCE).not.toMatch(/^const ANTHROPIC_BASE/m);
  });

  it('gates the stub plan on isPlanningStubEnabled(), not ANTHROPIC_API_KEY', () => {
    const idx = SOURCE.indexOf('if (isPlanningStubEnabled()) {');
    expect(idx).toBeGreaterThan(-1);
    // The specific old gate must not remain anywhere in the file.
    expect(SOURCE).not.toContain('if (!ANTHROPIC_API_KEY) {');
  });

  it('the isPlanningStubEnabled() gate is followed by a real buildStubPlan return, before any routed call', () => {
    const gateIdx = SOURCE.indexOf('if (isPlanningStubEnabled()) {');
    const stubReturnIdx = SOURCE.indexOf('plan_markdown: buildStubPlan(finding, feedbackNote),', gateIdx);
    const routedCallIdx = SOURCE.indexOf('let call = isWorkerQueueEnabled()');
    expect(stubReturnIdx).toBeGreaterThan(gateIdx);
    expect(routedCallIdx).toBeGreaterThan(stubReturnIdx);
  });

  it('the worker-binary-missing fallback retry no longer requires ANTHROPIC_API_KEY', () => {
    const idx = SOURCE.indexOf('if (!call.ok && isWorkerQueueEnabled() && isWorkerBinaryMissing(call.error)) {');
    expect(idx).toBeGreaterThan(-1);
    expect(SOURCE).not.toContain('isWorkerBinaryMissing(call.error) && ANTHROPIC_API_KEY');
  });

  it('callMessagesApi was renamed to callRoutedLlm (no longer implies a hardcoded Anthropic-direct call)', () => {
    expect(SOURCE).toContain('async function callRoutedLlm(');
    expect(SOURCE).not.toMatch(/function callMessagesApi\(/);
  });

  it('a genuine call failure still returns a real {ok:false,error} — unchanged', () => {
    const idx = SOURCE.indexOf("error: `Plan generation failed after ${elapsed}s: ${call.error || 'unknown error'}`,");
    expect(idx).toBeGreaterThan(-1);
  });
});
