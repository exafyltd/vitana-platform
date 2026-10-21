// VTID-03109 — renderer entry-point behavior.

import {
  renderSystemInstructionFromContext,
  EMPTY_DECISION_CONTEXT,
  type AssistantDecisionContext,
} from '../../../src/services/decision-contract';

describe('renderSystemInstructionFromContext', () => {
  it('returns the legacy prompt unchanged when the contract is valid', () => {
    const out = renderSystemInstructionFromContext(EMPTY_DECISION_CONTEXT, {
      mode: 'strict',
      legacyRendered: 'LEGACY_PROMPT_BYTES',
    });
    expect(out).toBe('LEGACY_PROMPT_BYTES');
  });

  it('throws in strict mode when the contract is malformed', () => {
    const bad = { schema_version: 99 } as unknown as AssistantDecisionContext;
    expect(() =>
      renderSystemInstructionFromContext(bad, {
        mode: 'strict',
        legacyRendered: 'X',
      }),
    ).toThrow(/schema_version/);
  });

  it('warns and returns in log mode when the contract is malformed', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = { schema_version: 99 } as unknown as AssistantDecisionContext;
    const out = renderSystemInstructionFromContext(bad, {
      mode: 'log',
      legacyRendered: 'FALLBACK',
    });
    expect(out).toBe('FALLBACK');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('mode defaults to strict outside production', () => {
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const bad = { schema_version: 99 } as unknown as AssistantDecisionContext;
      expect(() =>
        renderSystemInstructionFromContext(bad, { legacyRendered: 'X' }),
      ).toThrow();
    } finally {
      process.env.NODE_ENV = prior;
    }
  });

  it('mode defaults to log when NODE_ENV=production', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const bad = { schema_version: 99 } as unknown as AssistantDecisionContext;
      const out = renderSystemInstructionFromContext(bad, { legacyRendered: 'X' });
      expect(out).toBe('X');
      expect(spy).toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = prior;
      spy.mockRestore();
    }
  });
});
