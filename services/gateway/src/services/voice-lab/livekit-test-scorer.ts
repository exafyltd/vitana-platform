/**
 * VTID-03025: LiveKit hourly tests — golden-contract scorer.
 *
 * Pure function. Takes the captured `tool_calls` + `reply_text` from a
 * dry-run eval (see livekit-test-eval.ts) and the expected JSONB from
 * the case row, returns `{ status, failure_reasons }`.
 *
 * Scoring rules (matcher schema):
 *
 *   tools             — string[]; ALL must appear in tool_calls (name match).
 *   tools_any         — string[]; AT LEAST ONE must appear.
 *   forbidden_tools   — string[]; NONE may appear.
 *   args_match        — { [tool_name]: { [arg_name]: ArgMatcher } }
 *                       Only checked when the tool actually fired. Argument
 *                       absence does NOT fail the matcher unless explicitly
 *                       required by the matcher (regex/exact/enum imply the
 *                       arg must exist; non_empty also requires existence).
 *   intent: "free_text" — assert ZERO tool calls AND reply_text non-empty.
 *
 * ArgMatcher shapes:
 *   { type: "regex",     pattern: string }
 *   { type: "exact",     value: unknown }       (deep-equality on JSON-coercible values)
 *   { type: "enum",      values: unknown[] }    (membership check)
 *   { type: "non_empty" }                       (string: trimmed non-empty;
 *                                               arrays/objects: length > 0)
 *
 * Failure reasons use a stable `category:detail` shape so a downstream
 * monitor can aggregate by category without parsing free text:
 *
 *   missing_tool:<tool_name>
 *   none_of_required_tools:<name1,name2,...>
 *   forbidden_tool_called:<tool_name>
 *   args_mismatch:<tool_name>.<arg>:<matcher_type>
 *   args_missing:<tool_name>.<arg>:<matcher_type>
 *   unexpected_tool_call:<tool_name>            (intent=free_text)
 *   empty_reply_for_free_text_intent
 *   invalid_expected:<reason>                   (defensive — bad seed)
 *
 * No side effects, no I/O. Easy to unit-test.
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface EvalResult {
  tool_calls: ToolCall[];
  reply_text: string;
}

export type ArgMatcher =
  | { type: 'regex'; pattern: string }
  | { type: 'exact'; value: unknown }
  | { type: 'enum'; values: unknown[] }
  | { type: 'non_empty' };

export interface ExpectedContract {
  tools?: string[];
  tools_any?: string[];
  forbidden_tools?: string[];
  args_match?: Record<string, Record<string, ArgMatcher>>;
  intent?: 'free_text';
}

export interface ScoreOutcome {
  status: 'passed' | 'failed';
  failure_reasons: string[];
}

/**
 * Pure scorer. Returns `passed` only when every constraint in `expected`
 * is satisfied; otherwise `failed` with a list of stable reason codes.
 */
export function scoreResult(
  result: EvalResult,
  expected: ExpectedContract,
): ScoreOutcome {
  const reasons: string[] = [];

  // Defensive: empty expected = vacuously pass. (Catches malformed seed
  // rows so a typo doesn't silently fail every run.)
  if (!expected || typeof expected !== 'object') {
    return { status: 'failed', failure_reasons: ['invalid_expected:not_an_object'] };
  }

  const calledNames = new Set(result.tool_calls.map((c) => c.name));

  // intent: "free_text" — short-circuit. No tools allowed; reply must be present.
  if (expected.intent === 'free_text') {
    for (const call of result.tool_calls) {
      reasons.push(`unexpected_tool_call:${call.name}`);
    }
    if (!result.reply_text || result.reply_text.trim().length === 0) {
      reasons.push('empty_reply_for_free_text_intent');
    }
    return {
      status: reasons.length === 0 ? 'passed' : 'failed',
      failure_reasons: reasons,
    };
  }

  // tools (all required)
  if (Array.isArray(expected.tools)) {
    for (const tool of expected.tools) {
      if (typeof tool !== 'string') {
        reasons.push('invalid_expected:tools_entry_not_string');
        continue;
      }
      if (!calledNames.has(tool)) {
        reasons.push(`missing_tool:${tool}`);
      }
    }
  }

  // tools_any (at least one required)
  if (Array.isArray(expected.tools_any) && expected.tools_any.length > 0) {
    const hit = expected.tools_any.some(
      (t) => typeof t === 'string' && calledNames.has(t),
    );
    if (!hit) {
      reasons.push(`none_of_required_tools:${expected.tools_any.join(',')}`);
    }
  }

  // forbidden_tools
  if (Array.isArray(expected.forbidden_tools)) {
    for (const tool of expected.forbidden_tools) {
      if (typeof tool === 'string' && calledNames.has(tool)) {
        reasons.push(`forbidden_tool_called:${tool}`);
      }
    }
  }

  // args_match — per tool, per arg
  if (expected.args_match && typeof expected.args_match === 'object') {
    for (const [toolName, argSpecs] of Object.entries(expected.args_match)) {
      if (!argSpecs || typeof argSpecs !== 'object') continue;
      const calls = result.tool_calls.filter((c) => c.name === toolName);
      // Skip arg matchers entirely if the tool wasn't called. The
      // `tools` / `tools_any` matchers cover required-ness; args_match
      // only fires when the call exists, so contracts can be permissive
      // about which-tool while still enforcing arg shape if it fires.
      if (calls.length === 0) continue;

      for (const [argName, matcher] of Object.entries(argSpecs)) {
        // Run the matcher against EACH call of this tool. If any call
        // satisfies the matcher, the contract is met for that arg.
        const anyOk = calls.some((call) => matchArg(call.args, argName, matcher).ok);
        if (!anyOk) {
          const firstCall = calls[0];
          const detail = matchArg(firstCall.args, argName, matcher);
          reasons.push(
            `${detail.missing ? 'args_missing' : 'args_mismatch'}:${toolName}.${argName}:${matcher.type}`,
          );
        }
      }
    }
  }

  return {
    status: reasons.length === 0 ? 'passed' : 'failed',
    failure_reasons: reasons,
  };
}

/** Single-arg matcher. Returns `{ ok, missing }` so callers can distinguish
 *  "arg not present" from "arg present but didn't match". */
function matchArg(
  args: Record<string, unknown>,
  argName: string,
  matcher: ArgMatcher,
): { ok: boolean; missing: boolean } {
  const hasOwn = Object.prototype.hasOwnProperty.call(args, argName);
  const value = hasOwn ? args[argName] : undefined;

  // For `non_empty`, missing implies fail-missing.
  if (matcher.type === 'non_empty') {
    if (!hasOwn || value === null || value === undefined) {
      return { ok: false, missing: true };
    }
    if (typeof value === 'string') return { ok: value.trim().length > 0, missing: false };
    if (Array.isArray(value)) return { ok: value.length > 0, missing: false };
    if (typeof value === 'object') return { ok: Object.keys(value as object).length > 0, missing: false };
    return { ok: true, missing: false }; // numbers, booleans → present, count as non-empty
  }

  if (matcher.type === 'regex') {
    if (!hasOwn || typeof value !== 'string') return { ok: false, missing: !hasOwn };
    try {
      const re = compileRegexWithInlineFlags(matcher.pattern);
      return { ok: re.test(value), missing: false };
    } catch {
      return { ok: false, missing: false };
    }
  }

  if (matcher.type === 'exact') {
    if (!hasOwn) return { ok: false, missing: true };
    return { ok: deepEqual(value, matcher.value), missing: false };
  }

  if (matcher.type === 'enum') {
    if (!hasOwn) return { ok: false, missing: true };
    if (!Array.isArray(matcher.values)) return { ok: false, missing: false };
    return { ok: matcher.values.some((v) => deepEqual(v, value)), missing: false };
  }

  // Unknown matcher type — fail closed.
  return { ok: false, missing: false };
}

/**
 * Translate PCRE-style inline flags like `(?i)foo` or `(?ims)foo` into the
 * JS `RegExp(pattern, flags)` form. JS doesn't support inline flag groups
 * natively, but the seed JSONB uses them — strip the prefix and pass the
 * flag letters as the second argument.
 *
 * Supported flag letters: i, m, s, u, y. Unknown letters fall through (JS
 * RegExp throws and the caller catches it; we fail closed).
 */
function compileRegexWithInlineFlags(pattern: string): RegExp {
  const m = pattern.match(/^\(\?([imsuy]+)\)/);
  if (m) {
    return new RegExp(pattern.slice(m[0].length), m[1]);
  }
  return new RegExp(pattern);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}
