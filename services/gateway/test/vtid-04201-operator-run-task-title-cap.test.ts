/**
 * VTID-04201 — the Operator Console's `autopilot_run_task` tool accepts an
 * optional `title` argument used to derive a VTID/PR title. This pins a
 * soft length cap on it (truncate, not refuse — unlike the hard-refusal
 * request-size guard) applied before the value flows into
 * `deriveVtidTitleFromPlan()`/`triggerOperatorExecution()`.
 */

import {
  capOperatorRunTaskTitle,
  OPERATOR_RUN_TASK_TITLE_MAX_CHARS,
} from '../src/services/gemini-operator';

describe('VTID-04201 capOperatorRunTaskTitle', () => {
  it('truncates a title over the cap to exactly the cap length', () => {
    const long = 'x'.repeat(OPERATOR_RUN_TASK_TITLE_MAX_CHARS + 137);
    const result = capOperatorRunTaskTitle(long);
    expect(result).toHaveLength(OPERATOR_RUN_TASK_TITLE_MAX_CHARS);
    expect(result).toBe(long.slice(0, OPERATOR_RUN_TASK_TITLE_MAX_CHARS));
  });

  it('passes a title at exactly the cap through unchanged', () => {
    const exact = 'y'.repeat(OPERATOR_RUN_TASK_TITLE_MAX_CHARS);
    expect(capOperatorRunTaskTitle(exact)).toBe(exact);
  });

  it('passes a title under the cap through unchanged (after trimming)', () => {
    expect(capOperatorRunTaskTitle('  Add a retry to the push dispatcher  ')).toBe(
      'Add a retry to the push dispatcher'
    );
  });

  it('logs once at info level when truncation occurs', () => {
    const spy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const long = 'z'.repeat(OPERATOR_RUN_TASK_TITLE_MAX_CHARS + 50);
    capOperatorRunTaskTitle(long);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatch(/truncated from \d+ to 200 chars/);
    spy.mockRestore();
  });

  it('does NOT log when no truncation occurs', () => {
    const spy = jest.spyOn(console, 'info').mockImplementation(() => {});
    capOperatorRunTaskTitle('a short title');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns undefined for an omitted, empty, or whitespace-only title', () => {
    expect(capOperatorRunTaskTitle(undefined)).toBeUndefined();
    expect(capOperatorRunTaskTitle('')).toBeUndefined();
    expect(capOperatorRunTaskTitle('   ')).toBeUndefined();
  });

  it('returns undefined for a non-string value passed at the type boundary', () => {
    expect(capOperatorRunTaskTitle(42 as unknown as string)).toBeUndefined();
  });
});
