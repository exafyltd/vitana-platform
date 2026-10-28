/**
 * VTID-04243 — autoApproveTick refuses to re-approve a finding whose prior
 * execution died on the agent turn cap; it snoozes the finding instead of
 * spending up to AUTO_RETRY_CAP more full runs on the same exhaustion.
 */
import * as fs from 'fs';
import * as path from 'path';
import { hasTurnCapFailure, isTurnCapFailure, TURN_CAP_FAILURE_RE } from '../src/services/dev-autopilot-retry-breaker';

describe('VTID-04243 isTurnCapFailure / hasTurnCapFailure', () => {
  it('matches the runner\'s cap error whatever the cap size, and the loop\'s step detail', () => {
    expect(isTurnCapFailure({ error: 'agent hit the 120-turn cap without calling finish' })).toBe(true);
    expect(isTurnCapFailure({ error: 'agent hit the 2-turn cap without calling finish' })).toBe(true);
    expect(isTurnCapFailure({ error: 'max turns reached' })).toBe(true);
    expect(TURN_CAP_FAILURE_RE.test('Agent hit the 60-turn cap')).toBe(true);
  });

  it('does not match other failures, missing metadata or non-string errors', () => {
    expect(isTurnCapFailure({ error: 'agent deadline exceeded after 40 turn(s)' })).toBe(false);
    expect(isTurnCapFailure({ error: 'tsc failed after 3 fix round(s): TS2345' })).toBe(false);
    expect(isTurnCapFailure({ error: 'finding already has an unmerged PR' })).toBe(false);
    expect(isTurnCapFailure({ error: 42 } as unknown as Record<string, unknown>)).toBe(false);
    expect(isTurnCapFailure(null)).toBe(false);
    expect(isTurnCapFailure({})).toBe(false);
  });

  it('hasTurnCapFailure is true when any row in the window died on the cap', () => {
    expect(hasTurnCapFailure([{ metadata: { error: 'tsc failed' } }, { metadata: { error: 'agent hit the 120-turn cap without calling finish' } }])).toBe(true);
    expect(hasTurnCapFailure([{ metadata: { error: 'tsc failed' } }, { metadata: null }])).toBe(false);
    expect(hasTurnCapFailure([])).toBe(false);
    expect(hasTurnCapFailure(null)).toBe(false);
  });
});

describe('VTID-04243 autoApproveTick wiring (source contract)', () => {
  // VTID-04368 moved the breaker into retryBreakerAdmits(), shared by the
  // baseline and impact passes; decideRetryBreaker() checks the turn cap
  // before the retry cap (unit-tested in vtid-04368-retry-storm-outage-gate).
  const src = fs.readFileSync(path.resolve(__dirname, '../src/services/dev-autopilot-execute.ts'), 'utf8');
  const helper = src.slice(src.indexOf('async function retryBreakerAdmits('), src.indexOf('export async function autoApproveTick('));

  it('reads metadata on the terminal-failure rows and decides with the breaker', () => {
    expect(helper).toMatch(/&status=in\.\(failed,reverted,failed_escalated\)`[\s\S]*?&select=id,metadata&limit=\d+`/);
    expect(helper).toContain('decideRetryBreaker(failuresR.data)');
  });

  it('snoozes the finding 7 days, emits an OASIS event, and refuses the approval', () => {
    expect(helper).toMatch(/7 \* 24 \* 3600 \* 1000/);
    expect(helper).toMatch(/status: 'snoozed'/);
    expect(helper).toMatch(/type: 'dev_autopilot\.finding\.snoozed'/);
    expect(helper).toMatch(/'turn_cap_failure'/);
    expect(helper.trimEnd().endsWith('return false;\n}')).toBe(true);
  });
});
