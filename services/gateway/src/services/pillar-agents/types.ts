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
