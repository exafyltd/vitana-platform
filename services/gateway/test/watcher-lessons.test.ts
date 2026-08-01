/**
 * VTID-03461 — Watcher Phase 2: distiller + lesson/rule matching.
 *
 * The distiller's job is to make SAME PROBLEM → SAME KEY true. If a pattern
 * key carries anything volatile (a line number, a sha, a duration, a uuid),
 * one recurring failure fragments into dozens of one-off lessons, every one
 * of them sits in singleton quarantine, and nothing is ever injected. The
 * memory would look populated and be useless. That property is what most of
 * this file exercises.
 */

import {
  derivePatternKey,
  deriveLessonText,
  distilBatch,
  distilStep,
  normalizeMessage,
} from '../src/services/watcher/distiller';
import {
  globMatches,
  ruleTriggers,
  scopeMatches,
} from '../src/services/watcher/lessons-store';
import type { WatcherStep } from '../src/services/watcher/types';

function step(overrides: Partial<WatcherStep> & { id?: string } = {}): WatcherStep & { id?: string } {
  return {
    work_unit_kind: 'execution',
    work_unit_id: 'exec-1',
    vtid: 'VTID-01',
    step: 'ci',
    outcome: 'failure',
    actor: 'ci',
    evidence: {},
    source: 'oasis_events',
    source_ref: 'evt-1',
    observed_at: '2026-07-30T10:00:00.000Z',
    ...overrides,
  };
}

describe('normalizeMessage — volatility stripping', () => {
  it('strips uuids, shas, timestamps, line/col, durations and bare numbers', () => {
    const a = normalizeMessage('run 3f2a1b4c-1111-2222-3333-444455556677 at 2026-07-30T10:00:00Z took 1234ms line foo.ts:12:5 attempt 3');
    const b = normalizeMessage('run 99999999-9999-8888-7777-666655554444 at 2026-01-01T00:00:00Z took 42ms line foo.ts:88:1 attempt 9');
    // Two occurrences of the same problem must normalize identically.
    expect(a).toBe(b);
  });

  it('collapses whitespace so formatting differences do not fragment keys', () => {
    expect(normalizeMessage('a   b\n\nc')).toBe('a b c');
  });

  it('leaves stable text alone', () => {
    expect(normalizeMessage('cannot find module')).toBe('cannot find module');
  });
});

describe('derivePatternKey — stability', () => {
  it('extracts the TS code, not the message around it', () => {
    const k1 = derivePatternKey(step({ evidence: { message: "src/a.ts:3:1 - error TS2307: Cannot find module './x'" } }));
    const k2 = derivePatternKey(step({ evidence: { message: "src/zzz.ts:99:7 - error TS2307: Cannot find module './totally-different'" } }));
    expect(k1).toBe('TS2307:cannot-find-module');
    expect(k1).toBe(k2);
  });

  it('separates a type error from a missing module under the same code family', () => {
    const missing = derivePatternKey(step({ evidence: { message: 'error TS2307: Cannot find module' } }));
    const typeErr = derivePatternKey(step({ evidence: { message: 'error TS2345: Argument of type X' } }));
    expect(missing).not.toBe(typeErr);
  });

  it('keys jest failures on the matcher, not the compared values', () => {
    const k1 = derivePatternKey(step({ evidence: { message: 'expect(received).toBe(expected) // 1 vs 2' } }));
    const k2 = derivePatternKey(step({ evidence: { message: 'expect(received).toBe(expected) // 77 vs 91' } }));
    expect(k1).toBe('jest:toBe');
    expect(k1).toBe(k2);
  });

  it.each([
    ['FATAL ERROR: JavaScript heap out of memory', 'node:oom'],
    ['connect ECONNREFUSED 10.0.0.1:5432', 'net:unreachable'],
    ['Error: permission denied for table x', 'auth:denied'],
    ['relation "watcher_steps" does not exist', 'db:missing-relation'],
  ])('recognises %s', (message, expected) => {
    expect(derivePatternKey(step({ evidence: { message } }))).toBe(expected);
  });

  it('truncates an enormous message instead of making it unique', () => {
    const huge = 'weird failure ' + 'x'.repeat(5000);
    const key = derivePatternKey(step({ evidence: { message: huge } }));
    expect(key.length).toBeLessThanOrEqual(140);
  });

  it('is deterministic for identical input', () => {
    const s = step({ evidence: { message: 'error TS2304: Cannot find name foo' } });
    expect(derivePatternKey(s)).toBe(derivePatternKey(s));
  });
});

describe('distilStep', () => {
  it('ignores non-failures', () => {
    // A success tells you what worked once, not what to avoid. Injecting it
    // builds a prompt that argues for cargo-culting.
    expect(distilStep(step({ outcome: 'success' }))).toBeNull();
    expect(distilStep(step({ outcome: 'skipped' }))).toBeNull();
    expect(distilStep(step({ outcome: 'unknown' }))).toBeNull();
  });

  it('maps a CI failure to the ci stage and ci_failure type', () => {
    const d = distilStep(step({ step: 'ci', evidence: { message: 'error TS2307: Cannot find module' } }))!;
    expect(d.stage).toBe('ci');
    expect(d.pattern_type).toBe('ci_failure');
    expect(d.pattern_key).toBe('TS2307:cannot-find-module');
  });

  it('maps a deploy failure to the deploy stage', () => {
    const d = distilStep(step({ step: 'deploying', evidence: { failure_stage: 'deploy' } }))!;
    expect(d.stage).toBe('deploy');
    expect(d.pattern_type).toBe('deploy_failure');
  });

  it('carries scanner/service into scope for retrieval', () => {
    const d = distilStep(step({ evidence: { scanner: 'missing-tests-scanner-v1', service: 'gateway', message: 'x' } }))!;
    expect(d.scope).toEqual({ scanner: 'missing-tests-scanner-v1', service: 'gateway' });
  });

  it('produces imperative lesson text, not just the signature', () => {
    const d = distilStep(step({ evidence: { message: 'JavaScript heap out of memory' } }))!;
    expect(d.lesson).toMatch(/heap/i);
    expect(d.lesson.length).toBeGreaterThan(20);
  });

  it('links the evidence step id so a lesson can be traced back', () => {
    const d = distilStep(step({ id: 'step-42', evidence: { message: 'x' } }))!;
    expect(d.evidence_step_ids).toEqual(['step-42']);
  });
});

describe('distilBatch', () => {
  it('merges same-key failures into one lesson carrying all evidence', () => {
    const out = distilBatch([
      step({ id: 's1', evidence: { message: 'error TS2307: Cannot find module a' } }),
      step({ id: 's2', evidence: { message: 'error TS2307: Cannot find module b' } }),
      step({ id: 's3', evidence: { message: 'expect(received).toBe(x)' } }),
    ]);
    expect(out).toHaveLength(2);
    const ts = out.find((d) => d.pattern_key === 'TS2307:cannot-find-module')!;
    expect(ts.evidence_step_ids.sort()).toEqual(['s1', 's2']);
  });

  it('drops non-failures from the batch', () => {
    expect(distilBatch([step({ outcome: 'success' }), step({ outcome: 'skipped' })])).toEqual([]);
  });
});

describe('scopeMatches', () => {
  it('treats an empty scope as universal', () => {
    expect(scopeMatches({}, {})).toBe(true);
    expect(scopeMatches({}, { scanner: 'anything' })).toBe(true);
  });

  it('matches when the caller supplies the same value', () => {
    expect(scopeMatches({ scanner: 'a' }, { scanner: 'a' })).toBe(true);
  });

  it('does NOT match when the caller omits the scoped key', () => {
    // The worker-runner has no scanner. Treating "unknown" as "matches" is
    // exactly how a scanner-specific lesson leaks into every unrelated prompt.
    expect(scopeMatches({ scanner: 'a' }, {})).toBe(false);
    expect(scopeMatches({ scanner: 'a' }, { service: 'gateway' })).toBe(false);
  });

  it('requires every scoped key to match, not just one', () => {
    expect(scopeMatches({ scanner: 'a', service: 'gateway' }, { scanner: 'a', service: 'other' })).toBe(false);
    expect(scopeMatches({ scanner: 'a', service: 'gateway' }, { scanner: 'a', service: 'gateway' })).toBe(true);
  });
});

describe('globMatches', () => {
  it('matches ** across separators', () => {
    expect(globMatches('supabase/migrations/**', 'supabase/migrations/2026_x.sql')).toBe(true);
    expect(globMatches('services/gateway/**', 'services/gateway/src/routes/a.ts')).toBe(true);
  });

  it('does not let a single * cross a separator', () => {
    expect(globMatches('services/*/package.json', 'services/gateway/package.json')).toBe(true);
    expect(globMatches('services/*/package.json', 'services/a/b/package.json')).toBe(false);
  });

  it('does not match an unrelated path', () => {
    expect(globMatches('supabase/migrations/**', 'services/gateway/src/x.ts')).toBe(false);
  });

  it('treats regex metacharacters in the glob as literals', () => {
    expect(globMatches('a+b/c.ts', 'a+b/c.ts')).toBe(true);
    expect(globMatches('a+b/c.ts', 'aab/cXts')).toBe(false);
  });

  it('contains no control-byte sentinel (keeps the source non-binary)', () => {
    // Regression guard: an earlier version substituted a NUL for `**`, which
    // made the whole file read as binary to grep/diff/review tooling.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../src/services/watcher/lessons-store.ts'),
    ) as Buffer;
    expect(src.includes(0)).toBe(false);
  });
});

describe('ruleTriggers', () => {
  it('fires on an empty trigger', () => {
    expect(ruleTriggers({}, {})).toBe(true);
  });

  it('gates on touched paths', () => {
    const t = { touches: ['supabase/migrations/**'] };
    expect(ruleTriggers(t, { touched_paths: ['supabase/migrations/x.sql'] })).toBe(true);
    expect(ruleTriggers(t, { touched_paths: ['README.md'] })).toBe(false);
    // No paths supplied → a path-scoped rule must not fire.
    expect(ruleTriggers(t, {})).toBe(false);
  });

  it('gates on step, service and actor', () => {
    expect(ruleTriggers({ steps: ['ci'] }, { step: 'ci' })).toBe(true);
    expect(ruleTriggers({ steps: ['ci'] }, { step: 'merged' })).toBe(false);
    expect(ruleTriggers({ services: ['gateway'] }, { service: 'gateway' })).toBe(true);
    expect(ruleTriggers({ actors: ['worker-runner'] }, { actor: 'autopilot' })).toBe(false);
  });

  it('requires ALL supplied conditions, not any', () => {
    const t = { steps: ['ci'], services: ['gateway'] };
    expect(ruleTriggers(t, { step: 'ci', service: 'other' })).toBe(false);
    expect(ruleTriggers(t, { step: 'ci', service: 'gateway' })).toBe(true);
  });
});

describe('deriveLessonText', () => {
  it('gives specific guidance for known signatures', () => {
    expect(deriveLessonText(step(), 'db:missing-relation')).toMatch(/DATABASE_SCHEMA|migration/i);
    expect(deriveLessonText(step(), 'TS2307:cannot-find-module')).toMatch(/import|resolve/i);
    expect(deriveLessonText(step(), 'jest:toBe')).toMatch(/jest|suite/i);
  });

  it('still says something useful for an unrecognised signature', () => {
    const text = deriveLessonText(step({ step: 'verified' }), 'verified:something');
    expect(text).toContain('verified');
    expect(text.length).toBeGreaterThan(20);
  });
});
