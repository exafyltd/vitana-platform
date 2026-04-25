/**
 * Pillar Agent framework types (Phase F v1).
 *
 * One agent per Vitana pillar. Each implements `computePillarSubscores`
 * and writes to `vitana_pillar_agent_outputs` via the orchestrator.
 * v1 agents mirror the compute RPC's math for their pillar; v2+ replaces
 * each agent's internals with external integrations.
 */

export type PillarKey = 'nutrition' | 'hydration' | 'exercise' | 'sleep' | 'mental';

export interface PillarSubscores {
  /** Max 40 — from vitana_index_baseline_survey.answers. */
  baseline: number;
  /** Max 80 — completed calendar events tagged for this pillar in last 30d. */
  completions: number;
  /** Max 40 — recent health_features_daily rows relevant to this pillar. */
  data: number;
  /** Max 40 — consecutive days with signal for this pillar. */
  streak: number;
}

export interface PillarAgentOutput {
  pillar: PillarKey;
  subscores: PillarSubscores;
  /** Free-form agent-specific payload (signals, narratives, suggested nudges). */
  metadata: Record<string, unknown>;
  /** Agent version ("v1", "v2", …). Written to DB for observability. */
  agent_version: string;
}

/**
 * Structured response a PillarAgent gives to a user-facing question. Voice
 * weaves `text` naturally; `citations` get surfaced as Knowledge Hub
 * deeplinks; `data` is a transparency payload that anything else along the
 * chain (logging, autopilot ranker, future LLM rewrap) can read.
 *
 * v1 implementations build this deterministically from the user's current
 * sub-scores + Book chapter URL — no LLM call. v2+ may swap in an LLM or
 * external-integration narrative without changing the contract.
 */
export interface PillarAnswer {
  pillar: PillarKey;
  text: string;
  citations: string[];
  data: Record<string, unknown>;
  agent_version: string;
}

export interface PillarAgent {
  readonly pillar: PillarKey;
  readonly agentId: string;         // e.g., 'pillar-nutrition-agent'
  readonly displayName: string;
  readonly version: string;

  /**
   * Compute this pillar's sub-scores for the given user/date using whatever
   * data sources the agent has access to. v1 implementations read directly
   * from vitana_index_baseline_survey / calendar_events / health_features_daily.
   */
  computePillarSubscores(userId: string, date: string): Promise<PillarAgentOutput>;

  /**
   * Answer a natural-language question about THIS pillar for THIS user.
   * v1 default implementation in base-agent.ts is deterministic — pulls the
   * user's current pillar score + sub-score breakdown + cites the Book
   * chapter. v2+ may LLM-augment or pull from external integrations.
   *
   * Optional in the contract so existing call sites stay compile-safe; the
   * pillar-agent-router treats absence as "fall back to KB search".
   */
  answerQuestion?(userId: string, question: string): Promise<PillarAnswer>;
}

export interface OrchestratorRunResult {
  ok: boolean;
  user_id: string;
  date: string;
  agents_run: number;
  agents_failed: number;
  per_pillar: Partial<Record<PillarKey, PillarAgentOutput>>;
  errors: Array<{ pillar: PillarKey; message: string }>;
  duration_ms: number;
}
