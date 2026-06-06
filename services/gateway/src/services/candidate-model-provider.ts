/**
 * Candidate-model provider — BOOTSTRAP-SHADOW-REAL-CANDIDATE (Day-4 G4).
 *
 * The shadow harness (`llm-router-shadow.ts`) takes a caller-supplied
 * `candidate: () => Promise<TOutput>` closure. Until now every call site
 * hardcoded a deterministic SIMULATION of the fine-tuned model (tagged
 * `simulated_models: true`) because the real candidate isn't reachable from the
 * gateway request path. This module turns that hardcoded simulation into a
 * config-driven seam:
 *
 *   - When a Vertex endpoint is configured for the feature
 *     (`CANDIDATE_ENDPOINT__<feature>`), the candidate is the REAL fine-tuned
 *     model served there → provenance `vertex_endpoint`, `simulated_models:false`.
 *   - Otherwise it falls back to an explicit, caller-supplied simulation →
 *     provenance `simulation`, `simulated_models:true`. The fallback is LOGGED,
 *     never silent (CLAUDE.md: "Never allow silent model fallback").
 *
 * The `simulated_models` flag is the load-bearing part: the canary-readiness
 * accuracy gate must refuse to graduate a candidate on simulated evidence, so
 * every emitted comparison has to carry honest provenance. Wiring the real
 * model later is now a deploy + one env var — "only the candidate closure
 * changes", exactly as the shadow harness was designed for.
 */

/** The comparable output of a tool-routing turn (matches the shadow extractKey). */
export interface ToolChoice {
  tool_name: string | null;
}

export interface CandidateProvenance {
  /** Where the candidate decision came from. */
  candidate_source: 'vertex_endpoint' | 'simulation';
  /** True when the candidate is NOT a real model — gate must not graduate on these. */
  simulated_models: boolean;
  /** The resolved endpoint, when real. */
  endpoint?: string;
}

export interface CandidateRunner {
  run: (input: { text: string }) => Promise<ToolChoice>;
  provenance: CandidateProvenance;
}

/** Env var that names the Vertex endpoint for a feature's candidate model. */
export function candidateEnvKey(feature: string): string {
  return `CANDIDATE_ENDPOINT__${feature.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
}

/** Resolve the configured candidate endpoint for a feature, or null. */
export function candidateEndpointFor(
  feature: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const v = env[candidateEnvKey(feature)];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Default predictor: POST the turn text to a Vertex-served fine-tune and read
 * back the chosen tool. The serving contract is intentionally tolerant — it
 * accepts the common Vertex `{ predictions: [...] }` envelope and reads
 * `tool_name` (or `tool_call.name`) off the first prediction, falling back to a
 * bare `{ tool_name }` body. Auth: an optional bearer from
 * `CANDIDATE_ENDPOINT_TOKEN` (on Cloud Run the real wiring swaps this for ADC;
 * the transport stays the same). Injectable `fetchImpl` keeps it unit-testable.
 */
export async function vertexPredictToolName(
  endpoint: string,
  text: string,
  opts: { fetchImpl?: typeof fetch; token?: string; timeoutMs?: number } = {},
): Promise<ToolChoice> {
  const doFetch = opts.fetchImpl ?? fetch;
  const token = opts.token ?? process.env.CANDIDATE_ENDPOINT_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const resp = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ instances: [{ text }] }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`candidate endpoint HTTP ${resp.status}`);
    }
    const body = (await resp.json()) as unknown;
    return { tool_name: extractToolName(body) };
  } finally {
    clearTimeout(timer);
  }
}

/** Tolerant tool-name extraction from a prediction body. */
export function extractToolName(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const first = Array.isArray(b.predictions) ? b.predictions[0] : b;
  if (!first || typeof first !== 'object') return null;
  const p = first as Record<string, unknown>;
  if (typeof p.tool_name === 'string' && p.tool_name.length > 0) return p.tool_name;
  const tc = p.tool_call;
  if (tc && typeof tc === 'object' && typeof (tc as Record<string, unknown>).name === 'string') {
    return (tc as { name: string }).name;
  }
  return null;
}

export interface ResolveOpts {
  env?: NodeJS.ProcessEnv;
  /** Injectable predictor (tests / custom transport). Defaults to vertexPredictToolName. */
  predict?: (endpoint: string, text: string) => Promise<ToolChoice>;
  /** Explicit simulation fallback when no real endpoint is configured. */
  simulation?: (input: { text: string }) => Promise<ToolChoice>;
  /** Called when falling back to simulation — for non-silent logging. */
  onFallback?: (feature: string, reason: string) => void;
}

function defaultOnFallback(feature: string, reason: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[candidate-model-provider] feature='${feature}' candidate=SIMULATION — ${reason}`);
}

/**
 * Resolve the candidate runner for a feature. Real model when an endpoint is
 * configured; otherwise the supplied simulation with honest provenance and a
 * logged (never silent) fallback. Throws when neither is available rather than
 * fabricating a candidate.
 */
export function resolveCandidateRunner(feature: string, opts: ResolveOpts = {}): CandidateRunner {
  const env = opts.env ?? process.env;
  const endpoint = candidateEndpointFor(feature, env);

  if (endpoint) {
    const predict = opts.predict ?? ((ep: string, text: string) => vertexPredictToolName(ep, text));
    return {
      run: (input) => predict(endpoint, input.text),
      provenance: { candidate_source: 'vertex_endpoint', simulated_models: false, endpoint },
    };
  }

  const reason = `no candidate endpoint configured (${candidateEnvKey(feature)} unset)`;
  (opts.onFallback ?? defaultOnFallback)(feature, reason);
  if (!opts.simulation) {
    throw new Error(
      `candidate-model-provider: ${reason} and no simulation fallback supplied for '${feature}'`,
    );
  }
  return {
    run: opts.simulation,
    provenance: { candidate_source: 'simulation', simulated_models: true },
  };
}
