/**
 * Agent test-identity roster (universal agent testing capability).
 *
 * Source of truth for which agents may request a test session. An agent that is not listed,
 * or is not `active`, gets no session. A newly registered agent inherits the capability by
 * being added here with `tier` set; no per-agent credential is hand-provisioned.
 *
 * Reconciliation note: docs/AGENT-REGISTRY.md (VTID-04222) inventories 11 LLM-driven entries
 * (rows 1-10, with row 9 split into 9a/9b). The owner's roster is 13 agents (12 Kiro, 1 Claude).
 * The two missing entries are not identifiable from the repository alone and are listed in
 * `UNRECONCILED_SLOTS` so they cannot be silently assumed. Until they are added here, the
 * broker serves only the entries below.
 */

import type { PersonaKey } from './personas';

export type AgentStatus = 'active' | 'suspended';
export type AgentTier = 'reader' | 'tester' | 'operator';

export interface AgentRosterEntry {
  /** Stable, lower-case machine id. Used as the attribution key on every session and audit row. */
  agent_id: string;
  display_name: string;
  /** Who runs it. `kiro` and `claude` are the two runtimes the roster records. */
  runtime: 'kiro' | 'claude' | 'platform';
  status: AgentStatus;
  /** Ceiling on what the agent may ask for. A persona above the tier is refused. */
  tier: AgentTier;
  /** Personas this agent may use. Empty means none. */
  personas: readonly PersonaKey[];
  /** Source row in docs/AGENT-REGISTRY.md, when there is one. */
  registry_row?: string;
}

const TIER_RANK: Record<AgentTier, number> = { reader: 1, tester: 2, operator: 3 };

/** Highest tier a persona may be issued to. Higher-privilege personas need higher tiers. */
export const PERSONA_MIN_TIER: Record<PersonaKey, AgentTier> = {
  community_member: 'reader',
  community_member_b: 'reader',
  no_permission: 'reader',
  community_admin: 'operator',
};

export const AGENT_ROSTER: readonly AgentRosterEntry[] = [
  { agent_id: 'operator-console-chat', display_name: 'Operator Console chat', runtime: 'platform', status: 'active', tier: 'tester', personas: ['community_member', 'community_member_b', 'no_permission'], registry_row: '1' },
  { agent_id: 'agent-executor', display_name: 'Agent executor', runtime: 'platform', status: 'active', tier: 'tester', personas: ['community_member', 'no_permission'], registry_row: '2' },
  { agent_id: 'single-shot-executor', display_name: 'Single-shot executor', runtime: 'platform', status: 'active', tier: 'tester', personas: ['community_member', 'no_permission'], registry_row: '3' },
  { agent_id: 'planner', display_name: 'Planner', runtime: 'platform', status: 'active', tier: 'reader', personas: ['community_member'], registry_row: '4' },
  { agent_id: 'validator-llm-review', display_name: 'Validator / LLM review', runtime: 'platform', status: 'active', tier: 'reader', personas: ['community_member', 'no_permission'], registry_row: '5' },
  { agent_id: 'operator-planner', display_name: 'Operator planner (spec drafts)', runtime: 'platform', status: 'active', tier: 'reader', personas: ['community_member'], registry_row: '6' },
  { agent_id: 'self-healing-triage', display_name: 'Self-healing triage', runtime: 'platform', status: 'active', tier: 'reader', personas: ['community_member'], registry_row: '7' },
  { agent_id: 'architecture-investigator', display_name: 'Architecture investigator', runtime: 'platform', status: 'active', tier: 'reader', personas: [], registry_row: '8' },
  { agent_id: 'memory-thread-summary', display_name: 'Memory job - thread summary', runtime: 'platform', status: 'active', tier: 'reader', personas: [], registry_row: '9a' },
  { agent_id: 'memory-turn-memory', display_name: 'Memory job - turn memory', runtime: 'platform', status: 'active', tier: 'reader', personas: [], registry_row: '9b' },
  { agent_id: 'cognee-extractor', display_name: 'cognee-extractor', runtime: 'platform', status: 'active', tier: 'reader', personas: [], registry_row: '10' },
];

/** Roster slots the owner's 13-agent count implies but the repository does not identify. */
export const UNRECONCILED_SLOTS = 2;

export function findAgent(agentId: string, roster: readonly AgentRosterEntry[] = AGENT_ROSTER): AgentRosterEntry | undefined {
  return roster.find((a) => a.agent_id === agentId);
}

export function tierAllows(tier: AgentTier, persona: PersonaKey): boolean {
  return TIER_RANK[tier] >= TIER_RANK[PERSONA_MIN_TIER[persona]];
}
