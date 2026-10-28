/**
 * Role-based LLM routing (AGNT layer, runbook Sec. 1.1 / IF-THEN 26-28).
 *
 * PLANNER -> Claude, WORKER -> Gemini Flash, VALIDATOR -> Claude. The router only
 * resolves which model a role uses; actual calls are out of scope here (and mock in
 * tests). Provider/model/latency logging happens at call sites (CLAUDE.md rule 19).
 */
export type LlmRole = 'PLANNER' | 'WORKER' | 'VALIDATOR';

export interface ModelRouter {
  route(role: LlmRole): string;
}

export const DEFAULT_MODEL_BY_ROLE: Readonly<Record<LlmRole, string>> = Object.freeze({
  PLANNER: 'claude',
  WORKER: 'gemini-flash',
  VALIDATOR: 'claude',
});

export class DefaultModelRouter implements ModelRouter {
  constructor(private readonly map: Record<LlmRole, string> = { ...DEFAULT_MODEL_BY_ROLE }) {}
  route(role: LlmRole): string {
    const model = this.map[role];
    if (!model) throw new Error(`no model configured for role ${role}`);
    return model;
  }
}
