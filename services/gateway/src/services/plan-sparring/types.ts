/**
 * VTID-04868 — Plan Sparring Gate: record shapes.
 *
 * Mirrors the contract table `public.plan_sparring_sessions` (built in the
 * parallel DB migration). `rounds` is append-only and written only through
 * `plan_sparring_append_round(p_session uuid, p_round jsonb)`.
 */

export type ChangeClass = 'light' | 'standard' | 'expedited';
export type TrustTier = 'gateway' | 'attested';
export type SparringVerdict = 'in_progress' | 'converged' | 'escalated' | 'pending_human_approval';
export type FindingSeverity = 'blocker' | 'major' | 'minor';
export type Disposition = 'accepted' | 'rejected' | 'deferred';
export type AckStatus = 'acknowledged' | 'disputed';

export type EscalationReason =
  | 'model_unavailable'
  | 'code_access_unavailable'
  | 'evidence_floor_not_met'
  | 'partner_output_invalid'
  | 'round_cap_reached'
  | 'disputed_items'
  | 'deadline_exceeded';

/** Round caps per class (REVISION 3, N5: every class gets ≥2 passes). */
export const ROUND_CAPS: Record<ChangeClass, number> = { light: 2, standard: 3, expedited: 2 };

/** A file excerpt the partner actually read via read_file this session. */
export interface EvidenceRef {
  repo: string;
  path: string;
  start_line?: number;
  end_line?: number;
  /** Short verbatim quote from the read result. */
  quote?: string;
}

/** Stored VERBATIM as the partner submitted it (store never edits findings). */
export interface Finding {
  id: string;
  severity: FindingSeverity;
  claim: string;
  evidence: EvidenceRef[];
  suggestion: string;
}

/** A premise of the plan the partner checked against the code. */
export interface PremiseCheck {
  premise: string;
  holds: boolean;
  evidence: EvidenceRef[];
}

export interface Acknowledgement {
  finding_id: string;
  status: AckStatus;
  note?: string;
}

export interface PlannerResponse {
  finding_id: string;
  disposition: Disposition;
  rationale: string;
  deferred_to?: string;
}

/** What the partner returns through its `submit_review` tool. */
export interface PartnerReview {
  summary: string;
  findings: Finding[];
  premise_checks: PremiseCheck[];
  acknowledgements: Acknowledgement[];
}

export interface ToolLogEntry {
  name: 'read_file' | 'list_dir' | 'search';
  repo?: string;
  path?: string;
  ok: boolean;
  approximate?: boolean;
}

export interface ModelLogEntry {
  round: number;
  provider: string | undefined;
  model: string | undefined;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  ok: boolean;
  error?: string;
}

/** One element of `rounds` (append-only). */
export interface SparringRound {
  round: number;
  at: string;
  plan_hash: string;
  /** Canonical plan text that was reviewed this round. */
  plan_text: string;
  /** Planner responses to the PREVIOUS round's findings (round ≥ 2). */
  planner_responses?: PlannerResponse[];
  /** The partner's review, verbatim. Absent when the partner call failed. */
  review?: PartnerReview;
  tool_log: ToolLogEntry[];
  /** Round-1 evidence floor result (≥3 verified-premise checks citing read_file). */
  evidence_floor?: { required: number; verified: number; met: boolean };
  partner_error?: string;
  repo_refs: Record<string, string>;
}

export interface SparringSession {
  id: string;
  plan_id: string;
  plan_hash: string;
  final_plan_hash: string | null;
  producer: string;
  change_class: ChangeClass;
  trust_tier: TrustTier;
  base_ref: string | null;
  rounds: SparringRound[];
  verdict: SparringVerdict;
  escalation_reasons: string[];
  model_log: ModelLogEntry[];
  human_approved_by: string | null;
  human_approved_at: string | null;
  approval_evidence: Record<string, unknown> | null;
  vtid: string | null;
  created_at?: string;
  updated_at?: string;
}
