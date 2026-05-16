/**
 * VTID-03025: Unit tests for the LiveKit hourly tests scorer.
 *
 * Pure function — no Supabase, no Vertex, no network. Locks the matcher
 * semantics so the hourly grid behaves predictably even as cases evolve.
 */

import {
  scoreResult,
  type ExpectedContract,
  type EvalResult,
} from '../../src/services/voice-lab/livekit-test-scorer';

function evalOf(
  tool_calls: Array<{ name: string; args?: Record<string, unknown> }>,
  reply_text = '',
): EvalResult {
  return {
    tool_calls: tool_calls.map((c) => ({ name: c.name, args: c.args ?? {} })),
    reply_text,
  };
}

describe('scoreResult — tools (all required)', () => {
  test('passes when every required tool is called', () => {
    const out = scoreResult(
      evalOf([{ name: 'save_diary_entry' }]),
      { tools: ['save_diary_entry'] },
    );
    expect(out.status).toBe('passed');
    expect(out.failure_reasons).toEqual([]);
  });

  test('fails with missing_tool when a required tool is not called', () => {
    const out = scoreResult(
      evalOf([{ name: 'search_memory' }]),
      { tools: ['save_diary_entry'] },
    );
    expect(out.status).toBe('failed');
    expect(out.failure_reasons).toContain('missing_tool:save_diary_entry');
  });

  test('passes when required tool is called among extras', () => {
    const out = scoreResult(
      evalOf([{ name: 'resolve_recipient' }, { name: 'send_chat_message' }]),
      { tools: ['send_chat_message'] },
    );
    expect(out.status).toBe('passed');
  });
});

describe('scoreResult — tools_any (at least one)', () => {
  test('passes when one of the candidates fires', () => {
    const out = scoreResult(
      evalOf([{ name: 'navigate' }]),
      { tools_any: ['navigate', 'navigate_to_screen'] },
    );
    expect(out.status).toBe('passed');
  });

  test('fails when none of the candidates fire', () => {
    const out = scoreResult(
      evalOf([{ name: 'search_web' }]),
      { tools_any: ['navigate', 'navigate_to_screen'] },
    );
    expect(out.status).toBe('failed');
    expect(out.failure_reasons[0]).toMatch(/^none_of_required_tools:/);
  });

  test('empty tools_any array is ignored (no constraint)', () => {
    const out = scoreResult(evalOf([{ name: 'anything' }]), { tools_any: [] });
    expect(out.status).toBe('passed');
  });
});

describe('scoreResult — forbidden_tools', () => {
  test('passes when no forbidden tool is called', () => {
    const out = scoreResult(
      evalOf([{ name: 'save_diary_entry' }]),
      { forbidden_tools: ['set_reminder'] },
    );
    expect(out.status).toBe('passed');
  });

  test('fails when a forbidden tool is called', () => {
    const out = scoreResult(
      evalOf([{ name: 'set_reminder' }, { name: 'save_diary_entry' }]),
      { tools: ['save_diary_entry'], forbidden_tools: ['set_reminder'] },
    );
    expect(out.status).toBe('failed');
    expect(out.failure_reasons).toContain('forbidden_tool_called:set_reminder');
  });
});

describe('scoreResult — args_match: regex', () => {
  test('regex match passes', () => {
    const out = scoreResult(
      evalOf([{ name: 'search_web', args: { query: 'Maria Maksina latest show' } }]),
      {
        tools: ['search_web'],
        args_match: {
          search_web: { query: { type: 'regex', pattern: '(?i)maria' } },
        },
      },
    );
    expect(out.status).toBe('passed');
  });

  test('regex mismatch fails with args_mismatch', () => {
    const out = scoreResult(
      evalOf([{ name: 'search_web', args: { query: 'weather in mallorca' } }]),
      {
        tools: ['search_web'],
        args_match: {
          search_web: { query: { type: 'regex', pattern: '(?i)maria' } },
        },
      },
    );
    expect(out.status).toBe('failed');
    expect(out.failure_reasons).toContain('args_mismatch:search_web.query:regex');
  });

  test('missing arg with regex fails with args_missing', () => {
    const out = scoreResult(
      evalOf([{ name: 'search_web', args: {} }]),
      {
        tools: ['search_web'],
        args_match: {
          search_web: { query: { type: 'regex', pattern: '(?i)maria' } },
        },
      },
    );
    expect(out.status).toBe('failed');
    expect(out.failure_reasons).toContain('args_missing:search_web.query:regex');
  });

  test('invalid regex pattern fails closed', () => {
    const out = scoreResult(
      evalOf([{ name: 'search_web', args: { query: 'maria' } }]),
      {
        tools: ['search_web'],
        args_match: {
          search_web: { query: { type: 'regex', pattern: '([' } },
        },
      },
    );
    expect(out.status).toBe('failed');
  });
});

describe('scoreResult — args_match: non_empty', () => {
  test('non-empty string passes', () => {
    const out = scoreResult(
      evalOf([{ name: 'save_diary_entry', args: { entry: 'coffee + water' } }]),
      {
        tools: ['save_diary_entry'],
        args_match: { save_diary_entry: { entry: { type: 'non_empty' } } },
      },
    );
    expect(out.status).toBe('passed');
  });

  test('empty string fails', () => {
    const out = scoreResult(
      evalOf([{ name: 'save_diary_entry', args: { entry: '   ' } }]),
      {
        tools: ['save_diary_entry'],
        args_match: { save_diary_entry: { entry: { type: 'non_empty' } } },
      },
    );
    expect(out.status).toBe('failed');
  });

  test('absent arg fails as args_missing', () => {
    const out = scoreResult(
      evalOf([{ name: 'save_diary_entry', args: {} }]),
      {
        tools: ['save_diary_entry'],
        args_match: { save_diary_entry: { entry: { type: 'non_empty' } } },
      },
    );
    expect(out.status).toBe('failed');
    expect(out.failure_reasons).toContain('args_missing:save_diary_entry.entry:non_empty');
  });

  test('empty array fails', () => {
    const out = scoreResult(
      evalOf([{ name: 'foo', args: { xs: [] } }]),
      { tools: ['foo'], args_match: { foo: { xs: { type: 'non_empty' } } } },
    );
    expect(out.status).toBe('failed');
  });
});

describe('scoreResult — args_match: exact + enum', () => {
  test('exact match', () => {
    const out = scoreResult(
      evalOf([{ name: 'switch_persona', args: { persona: 'devon' } }]),
      {
        tools: ['switch_persona'],
        args_match: {
          switch_persona: { persona: { type: 'exact', value: 'devon' } },
        },
      },
    );
    expect(out.status).toBe('passed');
  });

  test('exact mismatch', () => {
    const out = scoreResult(
      evalOf([{ name: 'switch_persona', args: { persona: 'sage' } }]),
      {
        tools: ['switch_persona'],
        args_match: {
          switch_persona: { persona: { type: 'exact', value: 'devon' } },
        },
      },
    );
    expect(out.status).toBe('failed');
  });

  test('enum member passes', () => {
    const out = scoreResult(
      evalOf([{ name: 'foo', args: { kind: 'bug' } }]),
      {
        tools: ['foo'],
        args_match: {
          foo: { kind: { type: 'enum', values: ['bug', 'ux_issue'] } },
        },
      },
    );
    expect(out.status).toBe('passed');
  });

  test('enum non-member fails', () => {
    const out = scoreResult(
      evalOf([{ name: 'foo', args: { kind: 'feature_request' } }]),
      {
        tools: ['foo'],
        args_match: {
          foo: { kind: { type: 'enum', values: ['bug', 'ux_issue'] } },
        },
      },
    );
    expect(out.status).toBe('failed');
  });
});

describe('scoreResult — multiple calls of same tool', () => {
  test('any matching call satisfies the matcher', () => {
    const out = scoreResult(
      evalOf([
        { name: 'navigate', args: { route: '/wallet' } },
        { name: 'navigate', args: { route: '/journey' } },
      ]),
      {
        tools_any: ['navigate'],
        args_match: {
          navigate: { route: { type: 'regex', pattern: '/journey' } },
        },
      },
    );
    expect(out.status).toBe('passed');
  });

  test('no matching call → args_mismatch reported once', () => {
    const out = scoreResult(
      evalOf([
        { name: 'navigate', args: { route: '/wallet' } },
        { name: 'navigate', args: { route: '/calendar' } },
      ]),
      {
        tools_any: ['navigate'],
        args_match: {
          navigate: { route: { type: 'regex', pattern: '/journey' } },
        },
      },
    );
    expect(out.status).toBe('failed');
    expect(out.failure_reasons.filter((r) => r.startsWith('args_mismatch:'))).toHaveLength(1);
  });
});

describe('scoreResult — intent: free_text', () => {
  test('zero tools + reply_text passes', () => {
    const out = scoreResult(evalOf([], 'You are in Berlin and it is 15:42.'), {
      intent: 'free_text',
    });
    expect(out.status).toBe('passed');
  });

  test('tool call when intent is free_text fails', () => {
    const out = scoreResult(
      evalOf([{ name: 'search_web' }], 'searching now'),
      { intent: 'free_text' },
    );
    expect(out.status).toBe('failed');
    expect(out.failure_reasons).toContain('unexpected_tool_call:search_web');
  });

  test('empty reply with free_text intent fails', () => {
    const out = scoreResult(evalOf([], '   '), { intent: 'free_text' });
    expect(out.status).toBe('failed');
    expect(out.failure_reasons).toContain('empty_reply_for_free_text_intent');
  });
});

describe('scoreResult — defensive', () => {
  test('non-object expected returns invalid_expected', () => {
    const out = scoreResult(evalOf([]), null as unknown as ExpectedContract);
    expect(out.status).toBe('failed');
    expect(out.failure_reasons[0]).toMatch(/^invalid_expected:/);
  });

  test('empty expected is vacuously passing', () => {
    const out = scoreResult(evalOf([{ name: 'anything' }]), {});
    expect(out.status).toBe('passed');
  });

  test('args_match for an uncalled tool is skipped (no false failure)', () => {
    // The case requires search_web; the model called save_diary_entry. The
    // args_match for save_diary_entry SHOULD NOT fail just because the call
    // doesn't carry the expected arg — the missing_tool failure is the one
    // we want, not a confusing arg_mismatch noise.
    const out = scoreResult(
      evalOf([{ name: 'save_diary_entry', args: {} }]),
      {
        tools: ['search_web'],
        args_match: {
          search_web: { query: { type: 'non_empty' } },
        },
      },
    );
    expect(out.status).toBe('failed');
    expect(out.failure_reasons).toContain('missing_tool:search_web');
    expect(out.failure_reasons.filter((r) => r.startsWith('args_'))).toHaveLength(0);
  });
});
