/**
 * VTID-03025: golden-contract scorer unit tests.
 *
 * `scoreResult` is the "is this voice session actually working" signal for
 * the hourly LiveKit suite — a misclassification here (scoring a broken
 * session as `passed`, or a healthy one as `failed`) would silently hide
 * real voice regressions from the team. Every case below targets a specific
 * boundary in the matcher schema described in the file header comment.
 */

import { scoreResult, type EvalResult, type ExpectedContract } from '../../../src/services/voice-lab/livekit-test-scorer';

function result(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    tool_calls: [],
    reply_text: '',
    ...overrides,
  };
}

describe('scoreResult — defensive / malformed expected', () => {
  it('fails closed when expected is null', () => {
    const outcome = scoreResult(result(), null as unknown as ExpectedContract);
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_reasons).toEqual(['invalid_expected:not_an_object']);
  });

  it('fails closed when expected is undefined', () => {
    const outcome = scoreResult(result(), undefined as unknown as ExpectedContract);
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_reasons).toEqual(['invalid_expected:not_an_object']);
  });

  it('an empty (but valid) object is a vacuous pass — not the invalid_expected path', () => {
    const outcome = scoreResult(result(), {});
    expect(outcome.status).toBe('passed');
    expect(outcome.failure_reasons).toEqual([]);
  });

  it('flags non-string entries in `tools` without crashing', () => {
    const outcome = scoreResult(
      result({ tool_calls: [{ name: 'real_tool', args: {} }] }),
      { tools: [123 as unknown as string, 'real_tool'] },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_reasons).toContain('invalid_expected:tools_entry_not_string');
  });
});

describe('scoreResult — intent: free_text', () => {
  it('passes when no tools were called and reply_text is non-empty', () => {
    const outcome = scoreResult(
      result({ reply_text: 'Sure, here is the answer.' }),
      { intent: 'free_text' },
    );
    expect(outcome.status).toBe('passed');
    expect(outcome.failure_reasons).toEqual([]);
  });

  it('fails when reply_text is empty', () => {
    const outcome = scoreResult(result({ reply_text: '' }), { intent: 'free_text' });
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_reasons).toEqual(['empty_reply_for_free_text_intent']);
  });

  it('fails when reply_text is whitespace-only (trimmed check)', () => {
    const outcome = scoreResult(result({ reply_text: '   \n\t ' }), { intent: 'free_text' });
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_reasons).toEqual(['empty_reply_for_free_text_intent']);
  });

  it('fails and names every unexpected tool call — a tool firing on a free_text intent is a real regression', () => {
    const outcome = scoreResult(
      result({
        tool_calls: [
          { name: 'navigate_to', args: {} },
          { name: 'search_products', args: {} },
        ],
        reply_text: 'ignored',
      }),
      { intent: 'free_text' },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_reasons).toEqual([
      'unexpected_tool_call:navigate_to',
      'unexpected_tool_call:search_products',
    ]);
  });

  it('combines unexpected-tool and empty-reply failures when both occur', () => {
    const outcome = scoreResult(
      result({ tool_calls: [{ name: 'navigate_to', args: {} }], reply_text: '' }),
      { intent: 'free_text' },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_reasons).toEqual([
      'unexpected_tool_call:navigate_to',
      'empty_reply_for_free_text_intent',
    ]);
  });

  it('short-circuits: other expected fields (tools/forbidden_tools) are ignored under free_text intent', () => {
    // Regression guard: if a seed row accidentally sets both `intent` and
    // `tools`, free_text handling must still own the whole verdict.
    const outcome = scoreResult(
      result({ reply_text: 'ok' }),
      { intent: 'free_text', tools: ['never_checked'] } as ExpectedContract,
    );
    expect(outcome.status).toBe('passed');
  });
});

describe('scoreResult — tools (all required)', () => {
  it('passes when every required tool was called', () => {
    const outcome = scoreResult(
      result({ tool_calls: [{ name: 'a', args: {} }, { name: 'b', args: {} }] }),
      { tools: ['a', 'b'] },
    );
    expect(outcome.status).toBe('passed');
  });

  it('fails with a missing_tool reason for the one tool that did not fire', () => {
    const outcome = scoreResult(
      result({ tool_calls: [{ name: 'a', args: {} }] }),
      { tools: ['a', 'b'] },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_reasons).toEqual(['missing_tool:b']);
  });

  it('reports one missing_tool reason per missing tool', () => {
    const outcome = scoreResult(result(), { tools: ['a', 'b', 'c'] });
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_reasons).toEqual([
      'missing_tool:a',
      'missing_tool:b',
      'missing_tool:c',
    ]);
  });
});

describe('scoreResult — tools_any (at least one required)', () => {
  it('passes when at least one of the alternatives fired', () => {
    const outcome = scoreResult(
      result({ tool_calls: [{ name: 'b', args: {} }] }),
      { tools_any: ['a', 'b', 'c'] },
    );
    expect(outcome.status).toBe('passed');
  });

  it('fails naming all alternatives when none fired', () => {
    const outcome = scoreResult(result(), { tools_any: ['a', 'b'] });
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_reasons).toEqual(['none_of_required_tools:a,b']);
  });

  it('boundary: an empty tools_any array is treated as no constraint, not an impossible one', () => {
    // Pinning documented behavior (`.length > 0` guard) — a misconfigured
    // empty array must not silently fail every case that has it.
    const outcome = scoreResult(result(), { tools_any: [] });
    expect(outcome.status).toBe('passed');
  });
});

describe('scoreResult — forbidden_tools', () => {
  it('passes when no forbidden tool was called', () => {
    const outcome = scoreResult(
      result({ tool_calls: [{ name: 'allowed', args: {} }] }),
      { forbidden_tools: ['dangerous_tool'] },
    );
    expect(outcome.status).toBe('passed');
  });

  it('fails when a forbidden tool fired — this is the misclassification case that matters most', () => {
    const outcome = scoreResult(
      result({ tool_calls: [{ name: 'dangerous_tool', args: {} }] }),
      { forbidden_tools: ['dangerous_tool'] },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_reasons).toEqual(['forbidden_tool_called:dangerous_tool']);
  });

  it('reports every forbidden tool that fired, not just the first', () => {
    const outcome = scoreResult(
      result({ tool_calls: [{ name: 'x', args: {} }, { name: 'y', args: {} }] }),
      { forbidden_tools: ['x', 'y'] },
    );
    expect(outcome.failure_reasons).toEqual([
      'forbidden_tool_called:x',
      'forbidden_tool_called:y',
    ]);
  });
});

describe('scoreResult — args_match', () => {
  it('is skipped entirely when the tool was never called (required-ness is tools/tools_any\'s job)', () => {
    const outcome = scoreResult(
      result({ tool_calls: [] }),
      { args_match: { navigate_to: { route: { type: 'exact', value: '/wallet' } } } },
    );
    expect(outcome.status).toBe('passed');
  });

  describe('regex matcher', () => {
    it('passes when the arg matches the pattern', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: { q: 'hello world' } }] }),
        { args_match: { t: { q: { type: 'regex', pattern: '^hello' } } } },
      );
      expect(outcome.status).toBe('passed');
    });

    it('fails with args_mismatch when the arg does not match', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: { q: 'goodbye' } }] }),
        { args_match: { t: { q: { type: 'regex', pattern: '^hello' } } } },
      );
      expect(outcome.status).toBe('failed');
      expect(outcome.failure_reasons).toEqual(['args_mismatch:t.q:regex']);
    });

    it('fails with args_missing (not args_mismatch) when the arg is absent', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: {} }] }),
        { args_match: { t: { q: { type: 'regex', pattern: '^hello' } } } },
      );
      expect(outcome.failure_reasons).toEqual(['args_missing:t.q:regex']);
    });

    it('supports PCRE-style inline case-insensitive flag (?i)', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: { q: 'HELLO world' } }] }),
        { args_match: { t: { q: { type: 'regex', pattern: '(?i)^hello' } } } },
      );
      expect(outcome.status).toBe('passed');
    });

    it('fails closed (not throw) on a malformed regex pattern', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: { q: 'anything' } }] }),
        { args_match: { t: { q: { type: 'regex', pattern: '(unterminated[' } } } },
      );
      expect(outcome.status).toBe('failed');
      expect(outcome.failure_reasons).toEqual(['args_mismatch:t.q:regex']);
    });
  });

  describe('exact matcher', () => {
    it('passes on deep equality of an object value', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: { filter: { a: 1, b: [1, 2] } } }] }),
        { args_match: { t: { filter: { type: 'exact', value: { a: 1, b: [1, 2] } } } } },
      );
      expect(outcome.status).toBe('passed');
    });

    it('fails when values differ', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: { n: 5 } }] }),
        { args_match: { t: { n: { type: 'exact', value: 6 } } } },
      );
      expect(outcome.failure_reasons).toEqual(['args_mismatch:t.n:exact']);
    });

    it('args_missing when the arg key is absent', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: {} }] }),
        { args_match: { t: { n: { type: 'exact', value: 6 } } } },
      );
      expect(outcome.failure_reasons).toEqual(['args_missing:t.n:exact']);
    });
  });

  describe('enum matcher', () => {
    it('passes when value is a member', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: { unit: 'kg' } }] }),
        { args_match: { t: { unit: { type: 'enum', values: ['kg', 'lb'] } } } },
      );
      expect(outcome.status).toBe('passed');
    });

    it('fails when value is not a member', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: { unit: 'stone' } }] }),
        { args_match: { t: { unit: { type: 'enum', values: ['kg', 'lb'] } } } },
      );
      expect(outcome.failure_reasons).toEqual(['args_mismatch:t.unit:enum']);
    });

    it('args_missing when the arg key is absent', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: {} }] }),
        { args_match: { t: { unit: { type: 'enum', values: ['kg', 'lb'] } } } },
      );
      expect(outcome.failure_reasons).toEqual(['args_missing:t.unit:enum']);
    });
  });

  describe('non_empty matcher', () => {
    it('passes for a non-blank string', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: { note: 'hi' } }] }),
        { args_match: { t: { note: { type: 'non_empty' } } } },
      );
      expect(outcome.status).toBe('passed');
    });

    it('fails for a whitespace-only string', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: { note: '   ' } }] }),
        { args_match: { t: { note: { type: 'non_empty' } } } },
      );
      expect(outcome.failure_reasons).toEqual(['args_mismatch:t.note:non_empty']);
    });

    it('fails for an empty array', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: { items: [] } }] }),
        { args_match: { t: { items: { type: 'non_empty' } } } },
      );
      expect(outcome.failure_reasons).toEqual(['args_mismatch:t.items:non_empty']);
    });

    it('fails for an empty object', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: { meta: {} } }] }),
        { args_match: { t: { meta: { type: 'non_empty' } } } },
      );
      expect(outcome.failure_reasons).toEqual(['args_mismatch:t.meta:non_empty']);
    });

    it('args_missing (not args_mismatch) when the key is entirely absent', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: {} }] }),
        { args_match: { t: { note: { type: 'non_empty' } } } },
      );
      expect(outcome.failure_reasons).toEqual(['args_missing:t.note:non_empty']);
    });

    it('documented boundary: numbers/booleans count as present regardless of value (0 and false pass)', () => {
      const outcome = scoreResult(
        result({ tool_calls: [{ name: 't', args: { count: 0, flag: false } }] }),
        {
          args_match: {
            t: {
              count: { type: 'non_empty' },
              flag: { type: 'non_empty' },
            },
          },
        },
      );
      expect(outcome.status).toBe('passed');
    });
  });

  it('boundary: if ANY call of a repeated tool satisfies the matcher, the contract is met', () => {
    // e.g. the agent calls search_products twice — once with a bad query,
    // once correctly. This must not be scored as a failure.
    const outcome = scoreResult(
      result({
        tool_calls: [
          { name: 'search_products', args: { query: '' } },
          { name: 'search_products', args: { query: 'omega-3' } },
        ],
      }),
      { args_match: { search_products: { query: { type: 'non_empty' } } } },
    );
    expect(outcome.status).toBe('passed');
  });

  it('reports the failure detail from the FIRST call when none of the repeated calls satisfy the matcher', () => {
    const outcome = scoreResult(
      result({
        tool_calls: [
          { name: 'search_products', args: {} },
          { name: 'search_products', args: { query: '  ' } },
        ],
      }),
      { args_match: { search_products: { query: { type: 'non_empty' } } } },
    );
    // First call has no `query` key at all → missing, not mismatch.
    expect(outcome.failure_reasons).toEqual(['args_missing:search_products.query:non_empty']);
  });
});

describe('scoreResult — combined contract (realistic multi-constraint case)', () => {
  it('collects failures from every applicable constraint in a stable, deterministic order', () => {
    const outcome = scoreResult(
      result({
        tool_calls: [
          { name: 'search_products', args: { query: 'omega-3' } },
          { name: 'delete_account', args: {} },
        ],
        reply_text: 'Found some options for you.',
      }),
      {
        tools: ['navigate_to'],
        tools_any: ['add_to_cart', 'save_for_later'],
        forbidden_tools: ['delete_account'],
        args_match: { search_products: { query: { type: 'non_empty' } } },
      },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.failure_reasons).toEqual([
      'missing_tool:navigate_to',
      'none_of_required_tools:add_to_cart,save_for_later',
      'forbidden_tool_called:delete_account',
    ]);
  });

  it('a fully-satisfying transcript passes with zero failure reasons', () => {
    const outcome = scoreResult(
      result({
        tool_calls: [
          { name: 'navigate_to', args: { route: '/products' } },
          { name: 'add_to_cart', args: { sku: 'abc-123' } },
        ],
        reply_text: 'Added to your cart.',
      }),
      {
        tools: ['navigate_to'],
        tools_any: ['add_to_cart', 'save_for_later'],
        forbidden_tools: ['delete_account'],
        args_match: {
          navigate_to: { route: { type: 'regex', pattern: '^/products' } },
        },
      },
    );
    expect(outcome.status).toBe('passed');
    expect(outcome.failure_reasons).toEqual([]);
  });
});
