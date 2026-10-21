/**
 * VTID-03462 — Watcher Phase 3: ranking, budget, rendering, feedback.
 *
 * The budget tests are the important ones. An unbounded reminder block is how
 * prompt sections get skimmed past — once a model learns a section is mostly
 * irrelevant, the ONE reminder that mattered is lost with the rest, and the
 * tokens were still spent. A block that silently truncates is worse again,
 * because the caller believes it saw everything.
 */

const mockLoadLessons = jest.fn();
const mockLoadRules = jest.fn();

jest.mock('../src/services/watcher/lessons-store', () => {
  const actual = jest.requireActual('../src/services/watcher/lessons-store');
  return {
    ...actual,
    loadLessons: (...a: unknown[]) => mockLoadLessons(...a),
    loadRules: (...a: unknown[]) => mockLoadRules(...a),
  };
});

import {
  MAX_REMINDERS,
  MAX_TOKENS,
  buildReminders,
  estimateTokens,
  frequencyScore,
  lessonText,
  recencyScore,
  remindersEnabled,
  renderRemindersBlock,
  scoreRule,
} from '../src/services/watcher/reminder';
import { parseReminderId } from '../src/services/watcher/feedback';
import type { LessonRow, RuleRow } from '../src/services/watcher/lesson-types';

function lesson(o: Partial<LessonRow> = {}): LessonRow {
  return {
    id: 'l1',
    stage: 'execute',
    pattern_type: 'tsc_error',
    pattern_key: 'TS2307:cannot-find-module',
    scope: {},
    lesson: 'Verify the relative-import depth before proposing the change.',
    example_message: null,
    mitigation_note: null,
    frequency: 3,
    confidence: 0.6,
    status: 'active',
    last_seen_at: new Date().toISOString(),
    ...o,
  };
}

function rule(o: Partial<RuleRow> = {}): RuleRow {
  return {
    rule_key: 'r1',
    source_ref: 'CLAUDE.md §16',
    stage: 'execute',
    trigger: {},
    reminder: 'Push to main deploys STAGING only.',
    severity: 'warn',
    enabled: true,
    ...o,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadRules.mockResolvedValue([]);
  mockLoadLessons.mockResolvedValue([]);
  delete process.env.WATCHER_REMINDERS_ENABLED;
});

describe('scoring primitives', () => {
  it('decays recency to zero across the lesson window', () => {
    const now = Date.now();
    expect(recencyScore(new Date(now).toISOString(), now)).toBeCloseTo(1, 2);
    expect(recencyScore(new Date(now - 7 * 86400_000).toISOString(), now)).toBeCloseTo(0.5, 1);
    expect(recencyScore(new Date(now - 30 * 86400_000).toISOString(), now)).toBe(0);
  });

  it('log-scales frequency so one noisy failure cannot monopolise the budget', () => {
    const f5 = frequencyScore(5);
    const f50 = frequencyScore(50);
    expect(f50).toBeGreaterThan(f5);
    // 10x the occurrences must NOT be 10x the weight.
    expect(f50 / f5).toBeLessThan(3);
    expect(frequencyScore(1000)).toBeLessThanOrEqual(1);
  });

  it('ranks a block_candidate rule above a warn rule', () => {
    expect(scoreRule(rule({ severity: 'block_candidate' })))
      .toBeGreaterThan(scoreRule(rule({ severity: 'warn' })));
    expect(scoreRule(rule({ severity: 'warn' })))
      .toBeGreaterThan(scoreRule(rule({ severity: 'info' })));
  });

  it('prefers a human-authored mitigation note over the derived text', () => {
    expect(lessonText(lesson({ mitigation_note: 'Human says: check tsconfig paths.' })))
      .toBe('Human says: check tsconfig paths.');
    expect(lessonText(lesson({ mitigation_note: '   ' }))).toBe(lesson().lesson);
  });
});

describe('buildReminders — ordering', () => {
  it('always puts authored rules ahead of learned lessons', () => {
    // A rule is canon that is true today; a lesson is an inference from past
    // failures. If lessons could outrank rules, a noisy recurring failure
    // would push governance out of the budget entirely.
    mockLoadRules.mockResolvedValue([rule()]);
    mockLoadLessons.mockResolvedValue([lesson({ frequency: 999, confidence: 0.95 })]);
    return buildReminders({ stage: 'execute' }).then((b) => {
      expect(b.reminders[0].kind).toBe('rule');
      expect(b.reminders[1].kind).toBe('lesson');
    });
  });

  it('is deterministic for the same input', async () => {
    mockLoadRules.mockResolvedValue([rule({ rule_key: 'b' }), rule({ rule_key: 'a' })]);
    const a = await buildReminders({ stage: 'execute' });
    const b = await buildReminders({ stage: 'execute' });
    expect(a.reminders.map((r) => r.reminder_id)).toEqual(b.reminders.map((r) => r.reminder_id));
  });

  it('honours a rule trigger instead of firing every rule', async () => {
    mockLoadRules.mockResolvedValue([
      rule({ rule_key: 'migration', trigger: { touches: ['supabase/migrations/**'] } }),
      rule({ rule_key: 'always', trigger: {} }),
    ]);
    const none = await buildReminders({ stage: 'execute', touched_paths: ['README.md'] });
    expect(none.reminders.map((r) => r.reminder_id)).toEqual(['rule:always']);

    const both = await buildReminders({ stage: 'execute', touched_paths: ['supabase/migrations/x.sql'] });
    expect(both.reminders).toHaveLength(2);
  });
});

describe('buildReminders — budget', () => {
  it('caps the item count and REPORTS what was dropped', async () => {
    mockLoadRules.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => rule({ rule_key: `r${i}`, reminder: `short ${i}` })),
    );
    const b = await buildReminders({ stage: 'execute' });
    expect(b.reminders).toHaveLength(MAX_REMINDERS);
    // Silent truncation would let the caller read a partial block as complete.
    expect(b.truncated.dropped).toBe(6);
    expect(b.truncated.reason).toMatch(/6 reminders/);
  });

  it('caps total tokens even when the item count is legal', async () => {
    const huge = 'x'.repeat(MAX_TOKENS * 4);
    mockLoadRules.mockResolvedValue([
      rule({ rule_key: 'a', reminder: huge }),
      rule({ rule_key: 'b', reminder: huge }),
    ]);
    const b = await buildReminders({ stage: 'execute' });
    expect(b.reminders.length).toBeLessThan(2);
    expect(b.tokens_used).toBeLessThanOrEqual(MAX_TOKENS);
    expect(b.truncated.dropped).toBeGreaterThan(0);
    expect(b.truncated.reason).toMatch(/tokens/);
  });

  it('reports zero dropped when everything fits', async () => {
    mockLoadRules.mockResolvedValue([rule()]);
    const b = await buildReminders({ stage: 'execute' });
    expect(b.truncated.dropped).toBe(0);
    expect(b.truncated.reason).toBeUndefined();
  });

  it('returns an empty bundle rather than throwing when the store fails', async () => {
    // These callers sit on the critical path of planning and execution.
    mockLoadRules.mockRejectedValue(new Error('db down'));
    const b = await buildReminders({ stage: 'execute' });
    expect(b.reminders).toEqual([]);
    expect(b.tokens_used).toBe(0);
  });
});

describe('renderRemindersBlock', () => {
  it('renders nothing for an empty bundle', () => {
    expect(renderRemindersBlock({ reminders: [], truncated: { dropped: 0 }, tokens_used: 0 })).toBe('');
  });

  it('cites each reminder source', async () => {
    // A reminder that reads as the model's own opinion is easy to argue past.
    mockLoadRules.mockResolvedValue([rule({ source_ref: 'CLAUDE.md §15' })]);
    const block = renderRemindersBlock(await buildReminders({ stage: 'execute' }));
    expect(block).toContain('CLAUDE.md §15');
  });

  it('marks block_candidate rules as critical', async () => {
    mockLoadRules.mockResolvedValue([rule({ severity: 'block_candidate' })]);
    expect(renderRemindersBlock(await buildReminders({ stage: 'execute' }))).toContain('[critical]');
  });

  it('states in the rendered block when reminders were withheld', async () => {
    mockLoadRules.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => rule({ rule_key: `r${i}` })),
    );
    const block = renderRemindersBlock(await buildReminders({ stage: 'execute' }));
    expect(block).toMatch(/withheld/i);
  });
});

describe('feature gate', () => {
  it('is OFF unless explicitly set to true', () => {
    expect(remindersEnabled()).toBe(false);
    process.env.WATCHER_REMINDERS_ENABLED = 'false';
    expect(remindersEnabled()).toBe(false);
    // Guards against the FEATURE_ORB_FAST_START_ENV trap: a var being present
    // is not the same as the feature being live.
    process.env.WATCHER_REMINDERS_ENABLED = 'staging-only';
    expect(remindersEnabled()).toBe(false);
    process.env.WATCHER_REMINDERS_ENABLED = 'true';
    expect(remindersEnabled()).toBe(true);
  });
});

describe('estimateTokens', () => {
  it('grows with length and never returns zero for non-empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBeGreaterThan(0);
    expect(estimateTokens('x'.repeat(400))).toBeGreaterThan(estimateTokens('x'.repeat(40)));
  });
});

describe('parseReminderId', () => {
  it('splits kind from ref', () => {
    expect(parseReminderId('rule:staging_first.no_exec_deploy_to_prod'))
      .toEqual({ kind: 'rule', ref: 'staging_first.no_exec_deploy_to_prod' });
    // A lesson ref is a uuid, which contains no colon — but rule keys may.
    expect(parseReminderId('lesson:abc-123')).toEqual({ kind: 'lesson', ref: 'abc-123' });
  });

  it('rejects malformed or unknown kinds', () => {
    expect(parseReminderId('nonsense')).toBeNull();
    expect(parseReminderId(':abc')).toBeNull();
    expect(parseReminderId('rule:')).toBeNull();
    expect(parseReminderId('other:abc')).toBeNull();
  });
});
