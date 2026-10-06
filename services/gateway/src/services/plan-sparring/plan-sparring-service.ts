/**
 * VTID-04868 — Plan Sparring Gate, gateway tier (P1, log mode).
 *
 *   create  → canonical hash → dedup (N7) → session row → partner round 1
 *   rounds  → planner responses + revised plan → same partner, next pass
 *   approve → verified exafy_admin actor recorded (only path that sets it)
 *
 * The store keeps findings verbatim (rounds append-only via
 * plan_sparring_append_round, which checks the expected round number under a
 * row lock — a racing duplicate append surfaces as 409 `round_conflict`).
 * Verdicts: round 1 never converges (≥2 passes, N5); from round 2 on, `converged` when no blocker/major finding is open or
 * disputed, `escalated` when the class's round cap is hit with items open.
 * A partner model failure escalates at once with `model_unavailable` and no
 * other provider is called. Missing code access escalates before any model
 * call with `code_access_unavailable`.
 *
 * Every dependency is injectable so the whole flow is tested without a
 * database, Bedrock or GitHub.
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalPlanHash } from './canonical-hash';
import { PLAN_SPARRING_REPOS, createCodeToolExecutor, planSparringGithubToken } from './github-tools';
import { runPartnerPass, type CallLlm, type ExecuteTool } from './partner';
import * as repo from './plan-sparring-repository';
import {
  ROUND_CAPS,
  type ChangeClass,
  type EscalationReason,
  type Finding,
  type PlannerResponse,
  type SparringRound,
  type SparringSession,
} from './types';
import type { CicdOasisEvent } from '../../types/cicd';

export const PLAN_SPARRING_VTID = 'VTID-04868';
const SHA_RE = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Wall-clock per partner pass. Expedited is time-boxed (10 min total, 2 passes). */
const PASS_DEADLINE_MS: Record<ChangeClass, number> = { light: 10 * 60_000, standard: 15 * 60_000, expedited: 5 * 60_000 };
/** Sessions that never got a real review may be re-run instead of deduplicated. */
const RETRYABLE_REASONS: string[] = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded'];

export interface PlanSparringDeps {
  sb: SupabaseClient;
  callLlm: CallLlm;
  makeToolExecutor: (refs: Record<string, string>) => ExecuteTool;
  hasCodeAccess: () => boolean;
  emit: (event: CicdOasisEvent) => Promise<unknown>;
  now?: () => number;
}

export class SparringError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

/** Production wiring (lazy requires keep tests free of real clients). */
export function defaultDeps(): PlanSparringDeps {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getSupabase } = require('../../lib/supabase');
  const sb = getSupabase() as SupabaseClient | null;
  if (!sb) throw new SparringError(503, 'store_unavailable', 'Supabase is not configured');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { callViaRouter } = require('../llm-router');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { emitOasisEvent } = require('../oasis-event-service');
  return {
    sb,
    callLlm: callViaRouter,
    makeToolExecutor: (refs) => createCodeToolExecutor({ refs }),
    hasCodeAccess: () => Boolean(planSparringGithubToken()),
    emit: emitOasisEvent,
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export interface CreateInput {
  plan_text: string;
  producer: string;
  change_class: ChangeClass;
  base_ref: string;
  repo?: string;
  extra_refs?: Record<string, string>;
  plan_id?: string;
}

export function validateCreateInput(body: unknown): CreateInput {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.plan_text !== 'string' || b.plan_text.length === 0) throw new SparringError(400, 'plan_text_required');
  if (b.plan_text.length > 200_000) throw new SparringError(400, 'plan_text_too_large');
  if (typeof b.producer !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,63}$/i.test(b.producer)) throw new SparringError(400, 'producer_invalid');
  if (!['light', 'standard', 'expedited'].includes(b.change_class as string)) throw new SparringError(400, 'change_class_invalid');
  if (typeof b.base_ref !== 'string' || !SHA_RE.test(b.base_ref)) throw new SparringError(400, 'base_ref_must_be_commit_sha');
  const repoName = b.repo === undefined ? 'exafyltd/vitana-platform' : b.repo;
  if (typeof repoName !== 'string' || !(PLAN_SPARRING_REPOS as readonly string[]).includes(repoName)) throw new SparringError(400, 'repo_invalid');
  let extra: Record<string, string> | undefined;
  if (b.extra_refs !== undefined) {
    if (typeof b.extra_refs !== 'object' || b.extra_refs === null) throw new SparringError(400, 'extra_refs_invalid');
    extra = {};
    for (const [k, v] of Object.entries(b.extra_refs as Record<string, unknown>)) {
      if (!(PLAN_SPARRING_REPOS as readonly string[]).includes(k) || typeof v !== 'string' || !SHA_RE.test(v)) {
        throw new SparringError(400, 'extra_refs_invalid');
      }
      extra[k] = v;
    }
  }
  if (b.plan_id !== undefined && (typeof b.plan_id !== 'string' || !UUID_RE.test(b.plan_id))) throw new SparringError(400, 'plan_id_invalid');
  return {
    plan_text: b.plan_text,
    producer: b.producer,
    change_class: b.change_class as ChangeClass,
    base_ref: b.base_ref,
    repo: repoName,
    extra_refs: extra,
    plan_id: b.plan_id as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Prompts (the partner sees plan + written responses + code — nothing else)
// ---------------------------------------------------------------------------

function round1Prompt(s: { producer: string; change_class: ChangeClass; refs: Record<string, string> }, canonical: string): string {
  return [
    'Round 1. Review this plan adversarially.',
    `Producer: ${s.producer}. Declared change class: ${s.change_class}.`,
    `Code is pinned at: ${Object.entries(s.refs).map(([r, sha]) => `${r}@${sha}`).join(', ')}.`,
    '',
    '<plan>',
    canonical,
    '</plan>',
  ].join('\n');
}

function nextRoundPrompt(
  n: number,
  s: SparringSession,
  previous: SparringRound,
  responses: PlannerResponse[],
  canonical: string,
): string {
  const earlier = s.rounds.slice(0, -1).map((r) => ({
    round: r.round,
    findings: r.review?.findings ?? [],
    acknowledgements: r.review?.acknowledgements ?? [],
    planner_responses: r.planner_responses ?? [],
  }));
  return [
    `Round ${n}. You reviewed earlier versions of this plan. Below: your previous findings (verbatim), the planner's responses, and the revised plan.`,
    `Producer: ${s.producer}. Declared change class: ${s.change_class}.`,
    `Code is pinned at: ${Object.entries(previous.repo_refs).map(([r, sha]) => `${r}@${sha}`).join(', ')}.`,
    '',
    earlier.length > 0 ? `<earlier_rounds>\n${JSON.stringify(earlier, null, 2)}\n</earlier_rounds>` : '',
    `<your_previous_findings round="${previous.round}">\n${JSON.stringify(previous.review?.findings ?? [], null, 2)}\n</your_previous_findings>`,
    `<planner_responses>\n${JSON.stringify(responses, null, 2)}\n</planner_responses>`,
    '',
    '<revised_plan>',
    canonical,
    '</revised_plan>',
    '',
    'Acknowledge or dispute every rejected or deferred finding, re-raise accepted findings the revision did not address, and raise new findings.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const SERIOUS = new Set(['blocker', 'major']);

/**
 * Unresolved = serious findings raised in this pass + serious earlier findings
 * the planner rejected/deferred that the partner disputed OR did not
 * acknowledge at all (silence is not agreement).
 */
export function unresolvedItems(
  previousFindings: Finding[],
  responses: PlannerResponse[],
  current: { findings: Finding[]; acknowledgements: Array<{ finding_id: string; status: string }> },
): { open: string[]; disputed: string[] } {
  const open = current.findings.filter((f) => SERIOUS.has(f.severity)).map((f) => f.id);
  const disputed: string[] = [];
  for (const f of previousFindings) {
    if (!SERIOUS.has(f.severity)) continue;
    const resp = responses.find((r) => r.finding_id === f.id);
    if (!resp || resp.disposition === 'accepted') continue;
    const ack = current.acknowledgements.find((a) => a.finding_id === f.id);
    if (!ack || ack.status === 'disputed') disputed.push(f.id);
  }
  return { open, disputed };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function mustFetch(deps: PlanSparringDeps, id: string): Promise<SparringSession> {
  if (!UUID_RE.test(id)) throw new SparringError(400, 'id_invalid');
  const r = await repo.fetchSession(deps.sb, id);
  if (r.error) throw new SparringError(502, 'store_error', r.error.message);
  if (!r.data) throw new SparringError(404, 'not_found');
  return r.data;
}

async function writeRound(
  deps: PlanSparringDeps,
  session: SparringSession,
  round: SparringRound,
  state: Parameters<typeof repo.updateSessionState>[2],
): Promise<void> {
  // The expected round is this round's number (= current count + 1): the RPC
  // refuses it under a row lock if another request appended first, or if the
  // session is no longer in_progress.
  const a = await repo.appendRound(deps.sb, session.id, round, round.round);
  if (repo.isRoundConflict(a.error)) throw new SparringError(409, 'round_conflict', a.error!.message);
  if (a.error) throw new SparringError(502, 'store_error', `append_round: ${a.error.message}`);
  const u = await repo.updateSessionState(deps.sb, session.id, state);
  if (u.error) throw new SparringError(502, 'store_error', `update: ${u.error.message}`);
}

export async function createSparringSession(
  body: unknown,
  deps: PlanSparringDeps,
): Promise<{ session: SparringSession; deduplicated: boolean }> {
  const input = validateCreateInput(body);
  const plan = canonicalPlanHash(input.plan_text);
  if (!plan.ok) throw new SparringError(400, plan.error);

  const existing = await repo.fetchSessionByPlanHash(deps.sb, input.producer, plan.hash);
  if (existing.error) throw new SparringError(502, 'store_error', existing.error.message);
  if (existing.data) {
    const e = existing.data;
    const retryable =
      !e.human_approved_by && e.verdict === 'escalated' && (e.escalation_reasons ?? []).some((r) => RETRYABLE_REASONS.includes(r));
    if (!retryable) return { session: e, deduplicated: true };
  }

  const ins = await repo.insertSession(deps.sb, {
    plan_id: input.plan_id ?? randomUUID(),
    plan_hash: plan.hash,
    producer: input.producer,
    change_class: input.change_class,
    trust_tier: 'gateway',
    base_ref: input.base_ref,
  });
  if (ins.error || !ins.data) throw new SparringError(502, 'store_error', ins.error?.message ?? 'insert returned no row');
  const session = ins.data;
  const refs: Record<string, string> = { ...(input.extra_refs ?? {}), [input.repo as string]: input.base_ref };
  const now = deps.now ?? Date.now;
  const at = () => new Date(now()).toISOString();

  if (!deps.hasCodeAccess()) {
    await writeRound(
      deps,
      session,
      { round: 1, at: at(), plan_hash: plan.hash, plan_text: plan.canonical, tool_log: [], partner_error: 'code_access_unavailable: PLAN_SPARRING_GITHUB_TOKEN not configured', repo_refs: refs },
      { verdict: 'escalated', escalation_reasons: ['code_access_unavailable'], final_plan_hash: plan.hash },
    );
    return { session: await mustFetch(deps, session.id), deduplicated: false };
  }

  const pass = await runPartnerPass({
    round: 1,
    prompt: round1Prompt({ producer: input.producer, change_class: input.change_class, refs }, plan.canonical),
    callLlm: deps.callLlm,
    executeTool: deps.makeToolExecutor(refs),
    deadlineMs: PASS_DEADLINE_MS[input.change_class],
    now: deps.now,
  });

  if (!pass.ok) {
    await writeRound(
      deps,
      session,
      { round: 1, at: at(), plan_hash: plan.hash, plan_text: plan.canonical, tool_log: pass.toolLog, partner_error: `${pass.reason}: ${pass.error}`, repo_refs: refs },
      { verdict: 'escalated', escalation_reasons: [pass.reason], model_log: pass.modelLog, final_plan_hash: plan.hash },
    );
  } else {
    await writeRound(
      deps,
      session,
      { round: 1, at: at(), plan_hash: plan.hash, plan_text: plan.canonical, review: pass.review, tool_log: pass.toolLog, evidence_floor: pass.evidenceFloor, repo_refs: refs },
      { verdict: 'in_progress', model_log: pass.modelLog },
    );
  }
  return { session: await mustFetch(deps, session.id), deduplicated: false };
}

export function validateRoundInput(body: unknown): { responses: PlannerResponse[]; revised_plan_text: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.responses)) throw new SparringError(400, 'responses_required');
  const responses: PlannerResponse[] = [];
  for (const r of b.responses) {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.finding_id !== 'string' || !['accepted', 'rejected', 'deferred'].includes(o.disposition as string)) {
      throw new SparringError(400, 'response_invalid');
    }
    if (typeof o.rationale !== 'string' || o.rationale.trim().length === 0) throw new SparringError(400, 'response_rationale_required');
    if (o.disposition === 'deferred' && (typeof o.deferred_to !== 'string' || o.deferred_to.trim().length === 0)) {
      throw new SparringError(400, 'deferred_to_required');
    }
    responses.push({
      finding_id: o.finding_id,
      disposition: o.disposition as PlannerResponse['disposition'],
      rationale: o.rationale,
      ...(typeof o.deferred_to === 'string' ? { deferred_to: o.deferred_to } : {}),
    });
  }
  if (typeof b.revised_plan_text !== 'string' || b.revised_plan_text.length === 0) throw new SparringError(400, 'revised_plan_text_required');
  if (b.revised_plan_text.length > 200_000) throw new SparringError(400, 'plan_text_too_large');
  return { responses, revised_plan_text: b.revised_plan_text };
}

export async function submitPlannerRound(id: string, body: unknown, deps: PlanSparringDeps): Promise<SparringSession> {
  const input = validateRoundInput(body);
  const session = await mustFetch(deps, id);
  if (session.human_approved_by) throw new SparringError(409, 'already_approved');
  if (session.verdict !== 'in_progress') throw new SparringError(409, `session_${session.verdict}`);
  const previous = session.rounds[session.rounds.length - 1];
  if (!previous || !previous.review) throw new SparringError(409, 'no_review_to_answer');

  // Every finding of the previous pass gets exactly one answer (step 4).
  const ids = new Set(previous.review.findings.map((f) => f.id));
  const answered = new Set<string>();
  for (const r of input.responses) {
    if (!ids.has(r.finding_id)) throw new SparringError(400, `unknown_finding:${r.finding_id}`);
    if (answered.has(r.finding_id)) throw new SparringError(400, `duplicate_response:${r.finding_id}`);
    answered.add(r.finding_id);
  }
  const missing = [...ids].filter((i) => !answered.has(i));
  if (missing.length > 0) throw new SparringError(400, `unanswered_findings:${missing.join(',')}`);

  const plan = canonicalPlanHash(input.revised_plan_text);
  if (!plan.ok) throw new SparringError(400, plan.error);

  const n = previous.round + 1;
  const cap = ROUND_CAPS[session.change_class];
  const now = deps.now ?? Date.now;
  const at = new Date(now()).toISOString();
  const refs = previous.repo_refs;

  if (!deps.hasCodeAccess()) {
    await writeRound(
      deps,
      session,
      { round: n, at, plan_hash: plan.hash, plan_text: plan.canonical, planner_responses: input.responses, tool_log: [], partner_error: 'code_access_unavailable: PLAN_SPARRING_GITHUB_TOKEN not configured', repo_refs: refs },
      { verdict: 'escalated', escalation_reasons: ['code_access_unavailable'], final_plan_hash: plan.hash },
    );
    return mustFetch(deps, id);
  }

  const pass = await runPartnerPass({
    round: n,
    prompt: nextRoundPrompt(n, session, previous, input.responses, plan.canonical),
    callLlm: deps.callLlm,
    executeTool: deps.makeToolExecutor(refs),
    deadlineMs: PASS_DEADLINE_MS[session.change_class],
    now: deps.now,
  });
  const modelLog = [...(session.model_log ?? []), ...pass.modelLog];

  if (!pass.ok) {
    await writeRound(
      deps,
      session,
      { round: n, at, plan_hash: plan.hash, plan_text: plan.canonical, planner_responses: input.responses, tool_log: pass.toolLog, partner_error: `${pass.reason}: ${pass.error}`, repo_refs: refs },
      { verdict: 'escalated', escalation_reasons: [pass.reason], model_log: modelLog, final_plan_hash: plan.hash },
    );
    return mustFetch(deps, id);
  }

  const { open, disputed } = unresolvedItems(previous.review.findings, input.responses, pass.review);
  let state: Parameters<typeof repo.updateSessionState>[2];
  if (open.length === 0 && disputed.length === 0) {
    state = { verdict: 'converged', escalation_reasons: [], model_log: modelLog, final_plan_hash: plan.hash };
  } else if (n >= cap) {
    const reasons: EscalationReason[] = ['round_cap_reached'];
    if (disputed.length > 0) reasons.push('disputed_items');
    state = { verdict: 'escalated', escalation_reasons: reasons, model_log: modelLog, final_plan_hash: plan.hash };
  } else {
    state = { verdict: 'in_progress', model_log: modelLog };
  }
  await writeRound(
    deps,
    session,
    { round: n, at, plan_hash: plan.hash, plan_text: plan.canonical, planner_responses: input.responses, review: pass.review, tool_log: pass.toolLog, evidence_floor: pass.evidenceFloor, repo_refs: refs },
    state,
  );
  return mustFetch(deps, id);
}

export async function getSparringSession(id: string, deps: PlanSparringDeps): Promise<SparringSession> {
  return mustFetch(deps, id);
}

export interface ApprovalActor {
  user_id: string;
  email?: string | null;
}

/**
 * Record the owner's approval. The actor is the VERIFIED exafy_admin identity
 * from the JWT (the route enforces requireAdminAuth) — never a body field.
 */
export async function approveSparringSession(
  id: string,
  actor: ApprovalActor,
  body: unknown,
  deps: PlanSparringDeps,
): Promise<SparringSession> {
  if (!actor || typeof actor.user_id !== 'string' || !UUID_RE.test(actor.user_id)) throw new SparringError(403, 'verified_actor_required');
  const b = (body ?? {}) as Record<string, unknown>;
  const session = await mustFetch(deps, id);
  if (session.human_approved_by) throw new SparringError(409, 'already_approved');
  if (session.trust_tier !== 'gateway' || session.verdict === 'pending_human_approval') {
    throw new SparringError(409, 'gateway_pass_required');
  }
  if (session.verdict !== 'converged' && session.verdict !== 'escalated') throw new SparringError(409, 'not_ready_for_approval');
  if (!session.final_plan_hash || b.final_plan_hash !== session.final_plan_hash) throw new SparringError(409, 'final_plan_hash_mismatch');
  if (session.verdict === 'escalated' && b.acknowledge_escalation !== true) throw new SparringError(400, 'acknowledge_escalation_required');

  const last = session.rounds[session.rounds.length - 1];
  const evidence: Record<string, unknown> = {
    approved_via: 'gateway:POST /api/v1/plans/spar/:id/approve',
    actor_user_id: actor.user_id,
    actor_email: actor.email ?? null,
    actor_role: 'exafy_admin',
    verdict: session.verdict,
    final_plan_hash: session.final_plan_hash,
    escalation_reasons: session.escalation_reasons ?? [],
    rounds: session.rounds.length,
    last_round_open_findings: (last?.review?.findings ?? []).filter((f) => SERIOUS.has(f.severity)).map((f) => f.id),
    ...(typeof b.note === 'string' ? { note: b.note.slice(0, 2000) } : {}),
  };
  const r = await repo.recordApproval(deps.sb, session.id, {
    human_approved_by: actor.user_id,
    human_approved_at: new Date((deps.now ?? Date.now)()).toISOString(),
    approval_evidence: evidence,
  });
  if (r.error) throw new SparringError(502, 'store_error', r.error.message);
  if (!r.data || r.data.length === 0) throw new SparringError(409, 'already_approved');
  return mustFetch(deps, id);
}

// ---------------------------------------------------------------------------
// OASIS at allocation (F3: rounds are NOT OASIS events — only the binding is)
// ---------------------------------------------------------------------------

/**
 * Emit vtid.plan_sparring.attached | .missing for a freshly allocated VTID.
 * Log mode: informational only, never blocks or fails the allocation.
 */
export async function emitAllocationSparringEvent(
  args: { vtid: string; sparringId: string | null; source: string },
  emit: (event: CicdOasisEvent) => Promise<unknown>,
): Promise<void> {
  const attached = Boolean(args.sparringId);
  try {
    await emit({
      vtid: args.vtid,
      type: attached ? 'vtid.plan_sparring.attached' : 'vtid.plan_sparring.missing',
      source: 'plan-sparring-gate',
      status: attached ? 'info' : 'warning',
      message: attached
        ? `${args.vtid} allocated with sparring record ${args.sparringId}`
        : `${args.vtid} allocated without a sparring record (log mode — not blocked)`,
      payload: { sparring_id: args.sparringId, allocation_source: args.source, mode: 'log', gate_vtid: PLAN_SPARRING_VTID },
      actor_role: 'system',
      surface: 'api',
    });
  } catch (err) {
    console.warn(`[plan-sparring] allocation event emit failed for ${args.vtid}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
