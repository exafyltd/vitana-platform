/**
 * VTID-04183 (console task 19): a turn that ran on a model the pricing table
 * does not know must be reported honestly — `cost_priced: false` and
 * `cost_usd: 0` — never a fabricated or fallback dollar amount.
 *
 * Scope note (read before adding to this file): the pure helpers under test
 * (`summarizeTurnCost`, `turnUsageFields`, `pricingKeyForModel`) live in
 * `src/services/operator-turn-cost.ts` and already have a broad suite in
 * `test/vtid-04031-operator-turn-cost.test.ts` (VTID-04031, which shipped
 * them). That suite ALREADY pins the exact case this task names — a model
 * absent from every pricing key:
 *
 *   - `summarizeTurnCost` over a mixed turn including `{ model: 'mystery' }`
 *     asserts `cost_priced === false` (vtid-04031 line ~103), and
 *   - `turnUsageFields('router', …)` asserts the whole field object is
 *     `{ usage, cost_usd: 0, cost_priced: false }` (vtid-04031 line ~80).
 *
 * Per AC-2 that means this file must cover the *distinct* gap instead: a
 * model id that partially matches a priced key ("claude-sonnet-4-6-experimental",
 * a future/point release) is NOT the priced key, so it must be unpriced too —
 * `pricingKeyForModel` returns the exact key or null, and `MODEL_COSTS[...]`
 * is a plain exact-match lookup with no prefix/alias resolution. That case is
 * currently uncovered, and it is the dangerous one: a "close enough" model id
 * is exactly where a well-meaning normaliser would later start returning a
 * neighbouring model's rate.
 *
 * AC-1 is asserted explicitly here as well (a single unpriced call, and an
 * unpriced call mixed into an otherwise priced turn summing to a real number),
 * so this file stands alone as the named regression test.
 */

import { MODEL_COSTS, estimateCost } from '../src/constants/llm-defaults';
import {
  pricingKeyForModel,
  turnUsageFields,
  summarizeTurnCost,
} from '../src/services/operator-turn-cost';

describe('VTID-04183 console task 19 — unpriced models never get a fabricated cost', () => {
  it('AC-1: a model absent from the pricing table yields cost_priced:false and cost_usd:0', () => {
    // A model id nothing in MODEL_COSTS is keyed by — and not reducible to one
    // by the Bedrock inference-profile normalisation either.
    const model = 'totally-unpriced-model-2099';
    expect(MODEL_COSTS[model]).toBeUndefined();
    expect(pricingKeyForModel(model)).toBeNull();

    const perCall = turnUsageFields(model, { inputTokens: 3_000, outputTokens: 900 });
    expect(perCall.cost_priced).toBe(false);
    expect(perCall.cost_usd).toBe(0);
    expect(perCall.usage).toEqual({ input_tokens: 3_000, output_tokens: 900 });

    const summary = summarizeTurnCost([{ model, usage: { inputTokens: 3_000, outputTokens: 900 } }]);
    expect(summary.cost_priced).toBe(false);
    expect(summary.cost_usd).toBe(0);
    // The tokens are still counted — unpriced is "unknown", not "no usage".
    expect(summary.usage).toEqual({ input_tokens: 3_000, output_tokens: 900 });
    expect(summary.model_calls).toBe(1);
  });

  it('AC-1: an unpriced call in a mixed turn flips cost_priced and contributes 0, never the other call\'s rate', () => {
    const summary = summarizeTurnCost([
      { model: 'deepseek-flash', usage: { inputTokens: 1_000_000, outputTokens: 0 } },
      { model: 'totally-unpriced-model-2099', usage: { inputTokens: 1_000_000, outputTokens: 0 } },
    ]);

    expect(summary.model_calls).toBe(2);
    expect(summary.cost_priced).toBe(false);
    // Exactly the priced call's cost (deepseek-flash input = $0.15/1M); the
    // unpriced call added nothing rather than being priced at a neighbour's rate.
    expect(summary.cost_usd).toBe(estimateCost('deepseek-flash', 1_000_000, 0));
    expect(summary.cost_usd).toBe(MODEL_COSTS['deepseek-flash'].input);
    expect(summary.usage).toEqual({ input_tokens: 2_000_000, output_tokens: 0 });
  });

  it('AC-2: a model id that only partially matches a priced key is unpriced, not silently priced at the near key', () => {
    // Distinct from the "totally unknown model" case above: these ids CONTAIN a
    // priced key as a prefix, which is precisely where a prefix/`startsWith`
    // lookup would hand back a real dollar amount that no one ever paid. The
    // table is an exact-match map, so each of these must stay unpriced.
    const partiallyMatching = [
      'claude-sonnet-4-6-experimental',
      'claude-sonnet-4-6:1',
      'eu.anthropic.claude-sonnet-4-7',
      'gemini-3.1-pro-preview-2026',
    ];

    // Guard the premise: the priced keys these look like they are in the table.
    expect(MODEL_COSTS['claude-sonnet-4-6'].input).toBeGreaterThan(0);
    expect(MODEL_COSTS['gemini-3.1-pro-preview'].input).toBeGreaterThan(0);

    for (const model of partiallyMatching) {
      expect(pricingKeyForModel(model)).toBeNull();
      const f = turnUsageFields(model, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
      expect(f.cost_priced).toBe(false);
      expect(f.cost_usd).toBe(0);
      // If this ever regresses, the failure above would instead read like the
      // near key's rate — e.g. $3 + $15 for claude-sonnet-4-6 — which is the
      // exact "confident, wrong number" outcome this file exists to prevent.
      expect(f.cost_usd).not.toBe(
        estimateCost('claude-sonnet-4-6', 1_000_000, 1_000_000),
      );
    }
  });
});
