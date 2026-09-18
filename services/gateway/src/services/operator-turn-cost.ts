/**
 * VTID-04031 (operator agent W4g, gap analysis §3.10 / §4.6): the cost and
 * model of an Operator Console turn, made visible.
 *
 * The router already returns `usage` (input/output tokens) and the provider
 * and model that actually served each model call; the operator layer
 * forwarded provider/model in `meta` and dropped the usage on the floor, so
 * the console could never show what a turn cost. These pure helpers fold the
 * one or two model calls of a turn (the planning call and, when tools ran,
 * the final call) into one summary: token totals, an estimated USD cost
 * from the same `MODEL_COSTS` table the router's telemetry uses, and an
 * honest `cost_priced` flag — a model the table does not know is reported
 * as unpriced, never as free.
 *
 * Bedrock inference-profile ids (`eu.anthropic.claude-sonnet-4-6`,
 * `eu.anthropic.claude-opus-4-5-20251101-v1:0`) are normalised to the bare
 * Anthropic model name the table is keyed by; DeepSeek ids are used as-is.
 */

import { estimateCost, MODEL_COSTS } from '../constants/llm-defaults';
import type { LLMUsage } from './llm-router';

export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
}

/** The cost fields carried on a `model.turn` event. */
export interface ModelTurnCost {
  usage?: TurnUsage;
  cost_usd?: number;
  cost_priced?: boolean;
}

export interface TurnCostSummary {
  usage: TurnUsage;
  cost_usd: number;
  /** false when at least one call with usage ran on a model the price table does not know. */
  cost_priced: boolean;
  model_calls: number;
}

/**
 * The key `MODEL_COSTS` is priced under for a router model id: the exact id
 * when present, else a Bedrock inference-profile id reduced to its bare
 * Anthropic model name (region prefix and date/version suffix removed).
 */
export function pricingKeyForModel(model: string | undefined | null): string | null {
  const m = (model || '').trim();
  if (!m) return null;
  if (MODEL_COSTS[m]) return m;
  const bare = m
    .replace(/^(?:eu|us|apac|global|jp|au|ca)\.anthropic\./, '')
    .replace(/^anthropic\./, '')
    .replace(/-\d{8}-v\d+:\d+$/, '')
    .replace(/-v\d+:\d+$/, '');
  return MODEL_COSTS[bare] ? bare : null;
}

export function isModelPriced(model: string | undefined | null): boolean {
  return pricingKeyForModel(model) !== null;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function normaliseUsage(usage: LLMUsage | TurnUsage | null | undefined): TurnUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const inp = 'inputTokens' in usage ? usage.inputTokens : (usage as TurnUsage).input_tokens;
  const out = 'outputTokens' in usage ? usage.outputTokens : (usage as TurnUsage).output_tokens;
  const i = Number.isFinite(inp) ? Math.max(0, Math.round(Number(inp))) : 0;
  const o = Number.isFinite(out) ? Math.max(0, Math.round(Number(out))) : 0;
  if (i === 0 && o === 0) return null;
  return { input_tokens: i, output_tokens: o };
}

/** Cost fields for one model call, for its `model.turn` event. Empty when the call reported no usage. */
export function turnUsageFields(model: string | undefined | null, usage: LLMUsage | TurnUsage | null | undefined): ModelTurnCost {
  const u = normaliseUsage(usage);
  if (!u) return {};
  const key = pricingKeyForModel(model);
  return {
    usage: u,
    cost_usd: key ? round6(estimateCost(key, u.input_tokens, u.output_tokens)) : 0,
    cost_priced: key !== null,
  };
}

/** Fold the model calls of one turn into one summary for the reply `meta`. */
export function summarizeTurnCost(calls: Array<{ model?: string | null; usage?: LLMUsage | TurnUsage | null }>): TurnCostSummary {
  let input = 0;
  let output = 0;
  let cost = 0;
  let priced = true;
  let counted = 0;
  for (const c of calls) {
    const f = turnUsageFields(c.model, c.usage);
    if (!f.usage) continue;
    counted += 1;
    input += f.usage.input_tokens;
    output += f.usage.output_tokens;
    cost += f.cost_usd || 0;
    if (!f.cost_priced) priced = false;
  }
  return {
    usage: { input_tokens: input, output_tokens: output },
    cost_usd: round6(cost),
    cost_priced: counted > 0 ? priced : false,
    model_calls: counted,
  };
}
