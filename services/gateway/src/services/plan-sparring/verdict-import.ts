/**
 * Machine-only import of an already-completed sparring verdict.
 *
 * Why it exists: the GitLab cutover plan finished sparring off-platform (three rounds, ESCALATED,
 * F7 resolved, owner Gate 1 approved with conditions). Nothing in the gateway could record that
 * outcome, so no VTID could be allocated. This records it. It never restarts sparring, never
 * creates a partner round, and never writes a human approval.
 *
 * Rules, enforced here and pinned by tests:
 * - Only the one approved plan hash is accepted, as the complete 64-hex value. A prefix is refused.
 * - The record is bound by a digest over its content. A record whose digest does not match is refused.
 * - A `converged` verdict may receive the existing `converged-auto-v1` policy approval. An
 *   `escalated` verdict never does (the table CHECK forbids it); it stays awaiting the owner's
 *   approval, which only the existing admin approve route can record.
 * - Replays are idempotent: the same record returns the existing session; a different record for the
 *   same plan is refused and nothing is overwritten. A partial import is resumed, not duplicated.
 */
import { createHash } from 'crypto';
import * as repo from './plan-sparring-repository';
import { SparringError } from './plan-sparring-service';
import type { ApprovalPolicy, ChangeClass, ModelLogEntry, SparringRound, SparringSession, SparringVerdict } from './types';
import type { SupabaseClient } from '@supabase/supabase-js';

/** The one plan hash this import accepts: the owner-approved GitLab cutover plan, complete value. */
export const IMPORT_PLAN_HASH = 'be4416c29788655f854ae7495a82dbc15c9655342bfc698c0404802e71178551';
export const IMPORT_PRODUCER = 'gitlab-cutover';

const HEX64 = /^[0-9a-f]{64}$/;
const CHANGE_CLASSES: ChangeClass[] = ['light', 'standard', 'expedited'];
const IMPORT_VERDICTS = ['converged', 'escalated'] as const;

export interface VerdictImportInput {
  plan_hash: string;
  producer: string;
  change_class: ChangeClass;
  base_ref: string;
  verdict: (typeof IMPORT_VERDICTS)[number];
  final_plan_hash: string;
  escalation_reasons: string[];
  model_log: ModelLogEntry[];
  rounds: SparringRound[];
  record_sha256: string;
}

export interface ImportDeps {
  sb: SupabaseClient;
  audit: (event: Record<string, unknown>) => void;
}

export interface ImportResult {
  deduplicated: boolean;
  resumed: boolean;
  session: SparringSession;
}

/** Stable JSON: object keys sorted at every level, so the digest does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** Digest over the record's content. The same fields are read back from storage for replay checks. */
export function recordDigest(r: {
  plan_hash: string;
  verdict: string;
  final_plan_hash: string | null;
  escalation_reasons: string[];
  model_log: unknown[];
  rounds: unknown[];
}): string {
  const body = canonicalJson({
    plan_hash: r.plan_hash,
    verdict: r.verdict,
    final_plan_hash: r.final_plan_hash,
    escalation_reasons: r.escalation_reasons,
    model_log: r.model_log,
    rounds: r.rounds,
  });
  return createHash('sha256').update(body).digest('hex');
}

/** Deterministic plan id from the plan hash: the same plan always maps to the same row. */
export function planIdFromHash(planHash: string): string {
  const h = createHash('sha256').update(`plan-sparring-import:${planHash}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function bad(code: string, detail: string): never {
  throw new SparringError(422, code, detail);
}

export function validateVerdictImport(body: unknown): VerdictImportInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('import_body_invalid', 'body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.plan_hash !== 'string' || !HEX64.test(b.plan_hash)) bad('plan_hash_invalid', 'plan_hash must be the complete 64-hex value');
  if (b.plan_hash !== IMPORT_PLAN_HASH) bad('plan_hash_not_approved', 'plan_hash is not the approved plan hash');
  if (b.producer !== IMPORT_PRODUCER) bad('producer_invalid', `producer must be ${IMPORT_PRODUCER}`);
  if (!CHANGE_CLASSES.includes(b.change_class as ChangeClass)) bad('change_class_invalid', 'change_class must be light, standard or expedited');
  if (typeof b.base_ref !== 'string' || b.base_ref.trim() === '') bad('base_ref_required', 'base_ref is required');
  if (!IMPORT_VERDICTS.includes(b.verdict as (typeof IMPORT_VERDICTS)[number])) bad('verdict_invalid', 'verdict must be converged or escalated');
  if (b.final_plan_hash !== IMPORT_PLAN_HASH) bad('final_plan_hash_invalid', 'final_plan_hash must equal the approved plan hash');
  if (!Array.isArray(b.escalation_reasons) || !b.escalation_reasons.every((x) => typeof x === 'string')) {
    bad('escalation_reasons_invalid', 'escalation_reasons must be an array of strings');
  }
  if (b.model_log !== undefined && !Array.isArray(b.model_log)) bad('model_log_invalid', 'model_log must be an array');
  if (!Array.isArray(b.rounds) || b.rounds.length === 0) bad('rounds_required', 'rounds must be a non-empty array');
  (b.rounds as Array<Record<string, unknown>>).forEach((r, i) => {
    if (!r || typeof r !== 'object' || r.round !== i + 1) bad('rounds_out_of_order', `round ${i + 1} must be numbered ${i + 1}`);
    if (typeof r.plan_hash !== 'string' || !HEX64.test(r.plan_hash)) bad('round_plan_hash_invalid', `round ${i + 1} plan_hash must be 64-hex`);
  });
  if (typeof b.record_sha256 !== 'string' || !HEX64.test(b.record_sha256)) bad('record_digest_required', 'record_sha256 is required');
  const input: VerdictImportInput = {
    plan_hash: b.plan_hash,
    producer: IMPORT_PRODUCER,
    change_class: b.change_class as ChangeClass,
    base_ref: b.base_ref,
    verdict: b.verdict as VerdictImportInput['verdict'],
    final_plan_hash: IMPORT_PLAN_HASH,
    escalation_reasons: b.escalation_reasons as string[],
    model_log: (b.model_log ?? []) as ModelLogEntry[],
    rounds: b.rounds as SparringRound[],
    record_sha256: b.record_sha256,
  };
  const computed = recordDigest({ ...input, final_plan_hash: input.final_plan_hash });
  if (computed !== input.record_sha256) bad('record_digest_mismatch', 'record_sha256 does not match the record content');
  return input;
}

function storedRecordDigest(s: SparringSession): string {
  return recordDigest({
    plan_hash: s.plan_hash,
    verdict: s.verdict,
    final_plan_hash: s.final_plan_hash,
    escalation_reasons: s.escalation_reasons,
    model_log: s.model_log,
    rounds: s.rounds,
  });
}

async function mustOk<T>(p: Promise<{ data: T | null; error: { message: string; code?: string } | null }>, what: string): Promise<T | null> {
  const r = await p;
  if (r.error) throw new SparringError(503, 'store_error', `${what}: ${r.error.message}`);
  return r.data;
}

async function appendMissingRounds(deps: ImportDeps, sessionId: string, have: number, rounds: SparringRound[]): Promise<void> {
  for (let i = have; i < rounds.length; i++) {
    const r = await repo.appendRound(deps.sb, sessionId, rounds[i], i);
    if (r.error) {
      if (repo.isRoundConflict(r.error)) continue; // already appended by an earlier attempt: never duplicated
      throw new SparringError(503, 'round_append_failed', r.error.message);
    }
  }
}

export async function importVerdict(body: unknown, deps: ImportDeps): Promise<ImportResult> {
  const input = validateVerdictImport(body);
  const existing = await mustOk(repo.fetchSessionByPlanHash(deps.sb, input.producer, input.plan_hash), 'lookup');
  const incomingDigest = input.record_sha256;

  if (existing) {
    if (existing.verdict === 'in_progress') {
      // A previous import stopped part-way. Finish it; never restart or duplicate.
      await appendMissingRounds(deps, existing.id, existing.rounds.length, input.rounds);
      await mustOk(
        repo.updateSessionState(deps.sb, existing.id, {
          verdict: input.verdict as SparringVerdict,
          final_plan_hash: input.final_plan_hash,
          escalation_reasons: input.escalation_reasons,
          model_log: input.model_log,
        }),
        'state',
      );
      const done = await mustOk(repo.fetchSession(deps.sb, existing.id), 'reload');
      if (!done) throw new SparringError(503, 'store_error', 'session vanished during resume');
      if (storedRecordDigest(done) !== incomingDigest) {
        throw new SparringError(409, 'import_conflict', 'resumed session does not match the import');
      }
      if (input.verdict === 'converged') await policyApprove(deps, done);
      deps.audit({ event: 'plan_sparring.verdict_imported', decision: 'resumed', plan_hash: input.plan_hash, session_id: done.id, record_sha256: incomingDigest, verdict: input.verdict });
      return { deduplicated: false, resumed: true, session: (await mustOk(repo.fetchSession(deps.sb, done.id), 'reload')) as SparringSession };
    }
    if (storedRecordDigest(existing) === incomingDigest) {
      deps.audit({ event: 'plan_sparring.verdict_imported', decision: 'deduplicated', plan_hash: input.plan_hash, session_id: existing.id, record_sha256: incomingDigest, verdict: existing.verdict });
      return { deduplicated: true, resumed: false, session: existing };
    }
    deps.audit({ event: 'plan_sparring.verdict_imported', decision: 'refused_conflict', plan_hash: input.plan_hash, session_id: existing.id, record_sha256: incomingDigest });
    throw new SparringError(409, 'import_conflict', 'a different record already exists for this plan; nothing was overwritten');
  }

  const ins = await repo.insertSession(deps.sb, {
    plan_id: planIdFromHash(input.plan_hash),
    plan_hash: input.plan_hash,
    producer: input.producer,
    change_class: input.change_class,
    trust_tier: 'attested',
    base_ref: input.base_ref,
    ...(input.verdict === 'converged' ? { approval_policy: 'converged-auto-v1' as ApprovalPolicy } : {}),
  });
  if (ins.error || !ins.data) throw new SparringError(503, 'store_error', ins.error?.message ?? 'insert failed');
  const session = ins.data;
  await appendMissingRounds(deps, session.id, 0, input.rounds);
  await mustOk(
    repo.updateSessionState(deps.sb, session.id, {
      verdict: input.verdict as SparringVerdict,
      final_plan_hash: input.final_plan_hash,
      escalation_reasons: input.escalation_reasons,
      model_log: input.model_log,
    }),
    'state',
  );
  const done = await mustOk(repo.fetchSession(deps.sb, session.id), 'reload');
  if (!done) throw new SparringError(503, 'store_error', 'session vanished after insert');
  if (storedRecordDigest(done) !== incomingDigest) {
    throw new SparringError(409, 'import_conflict', 'stored record does not match the import');
  }
  if (input.verdict === 'converged') await policyApprove(deps, done);
  deps.audit({ event: 'plan_sparring.verdict_imported', decision: 'created', plan_hash: input.plan_hash, session_id: done.id, record_sha256: incomingDigest, verdict: input.verdict });
  return { deduplicated: false, resumed: false, session: (await mustOk(repo.fetchSession(deps.sb, done.id), 'reload')) as SparringSession };
}

/** The existing machine path: only a converged, unapproved session with its own policy. */
async function policyApprove(deps: ImportDeps, s: SparringSession): Promise<void> {
  if (s.verdict !== 'converged' || s.approval_policy !== 'converged-auto-v1') return;
  await mustOk(repo.recordPolicyApproval(deps.sb, s.id, { rule: 'converged-auto-v1', at: new Date().toISOString() }), 'policy');
}

