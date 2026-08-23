/**
 * The compiled-in fallback policy must never route to Google (VTID-03579)
 *
 * `loadPolicy()` returns `LLM_SAFE_DEFAULTS` in two cases: the policy read
 * throws, or the active row is missing. Until this change those defaults named
 * `vertex`/`gemini-3.1-pro-preview` as PRIMARY for 7 of 8 stages — so any
 * Supabase hiccup silently moved the whole platform back onto Google, logging a
 * single console.warn and nothing else.
 *
 * That is not hypothetical. On 2026-08-11 the autopilot planner served real
 * traffic on `vertex/gemini-3.1-pro-preview` with `fallback_used: false` while
 * `llm_routing_policy` v14 said bedrock — during a window when Supabase was
 * returning "remaining connection slots are reserved for roles with the
 * SUPERUSER attribute". The routing table was correct and the platform called
 * Google anyway, because the safety net pointed there.
 *
 * A safety net that fails toward the provider you are deliberately leaving is
 * worse than no safety net, because it is invisible: nothing errors, the calls
 * succeed, and only the bill shows it.
 */

import {
  LLM_SAFE_DEFAULTS,
  type LLMStage,
  type LLMProvider,
} from '../src/constants/llm-defaults';

/** Verified invokable by real InvokeModel against eu-central-1, 2026-08-10. */
const SUBSCRIBED_BEDROCK_MODELS = [
  'eu.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-sonnet-4-6',
  'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
];

const FORBIDDEN_PROVIDERS: LLMProvider[] = [
  'vertex', // Google — the whole point of VTID-03563/03579
  'anthropic', // no credit balance on that account; every call 400s (§2b)
];

const stages = Object.keys(LLM_SAFE_DEFAULTS) as LLMStage[];

describe('LLM_SAFE_DEFAULTS never routes to Google (VTID-03579)', () => {
  it('covers every stage, so no stage can fall through to an undefined config', () => {
    expect(stages.length).toBeGreaterThanOrEqual(8);
  });

  it.each(stages)('stage %s names no forbidden provider', (stage) => {
    const cfg = LLM_SAFE_DEFAULTS[stage];
    // Both slots, not just primary: a Google FALLBACK is the exact shape that
    // hid the original bill — the table reads clean and Google still serves.
    expect(FORBIDDEN_PROVIDERS).not.toContain(cfg.primary_provider);
    expect(FORBIDDEN_PROVIDERS).not.toContain(cfg.fallback_provider);
  });

  it.each(stages)('stage %s names no Gemini model string', (stage) => {
    const cfg = LLM_SAFE_DEFAULTS[stage];
    // Belt and braces on the MODEL too. Provider and model are set
    // independently, so a copy-paste can leave a gemini-* string against a
    // non-google provider — which fails at call time, not at deploy time.
    expect(`${cfg.primary_model} ${cfg.fallback_model}`).not.toMatch(/gemini|palm|bison/i);
  });

  it.each(stages)('stage %s only names Bedrock models the account can invoke', (stage) => {
    const cfg = LLM_SAFE_DEFAULTS[stage];
    for (const [provider, model] of [
      [cfg.primary_provider, cfg.primary_model],
      [cfg.fallback_provider, cfg.fallback_model],
    ] as Array<[LLMProvider, string]>) {
      if (provider !== 'bedrock') continue;
      // Every Haiku and Opus profile returns AccessDeniedException — the ACCOUNT
      // is not subscribed, which no amount of caller IAM fixes. Naming one here
      // would reintroduce the silent-fallback bug one layer down: the primary
      // would fail on every call and the stage would serve 100% fallback
      // forever while this file still read `bedrock`.
      expect(SUBSCRIBED_BEDROCK_MODELS).toContain(model);
    }
  });

  it('keeps vision on a second Bedrock model, not DeepSeek', () => {
    // DeepSeek has no image input at all, so a text-only fallback would fail
    // every frame call rather than degrade to a worse answer.
    expect(LLM_SAFE_DEFAULTS.vision.fallback_provider).toBe('bedrock');
    expect(LLM_SAFE_DEFAULTS.vision.fallback_model).not.toBe(
      LLM_SAFE_DEFAULTS.vision.primary_model,
    );
  });
});
