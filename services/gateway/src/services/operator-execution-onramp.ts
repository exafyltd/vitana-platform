/**
 * VTID-03820: DeepSeek-powered execution on-ramp.
 *
 * Lets an operator (via the Operator Console chat, `autopilot_execute_task`
 * tool) turn an already-approved VTID's plan into a real Dev Autopilot
 * execution — writing code, opening a PR — with THIS invocation's LLM calls
 * forced onto DeepSeek (`deepseek-flash`), without touching the
 * `llm_routing_policy` stage the autonomous self-healing pipeline uses.
 *
 * Deliberately reuses the EXISTING, heavily-guarded machinery rather than
 * building a parallel execution path:
 *   - `approveAutoExecute()` (dev-autopilot-execute.ts) — runs the full
 *     safety gate (kill_switch, allow/deny scope, budget, concurrency,
 *     tests_missing, PR-flood guard) unchanged. This on-ramp does not
 *     re-implement or bypass any of it.
 *   - `EXECUTABLE_RECOMMENDATION_SOURCE_TYPES` — this file adds its own
 *     `operator_onramp` source_type there (a code-reviewed allowlist entry,
 *     per that file's own stated process), rather than reusing an existing
 *     scanner's identity.
 *   - The `find_similar_vtid_tasks`/embedding dedup from VTID-03819 is a
 *     separate concern (task INTAKE) and is not re-run here — this on-ramp
 *     acts on a VTID that already exists and is already approved.
 *
 * The override itself is threaded through metadata.llm_on_ramp_override on
 * the execution row (read by dev-autopilot-execute.ts's
 * extractLlmOnRampOverride()) — never a global routing-policy change, so
 * the self-healing pipeline's own executions (which never set this field)
 * are provably unaffected.
 *
 * Two governance gates specific to THIS on-ramp (neither exists inside the
 * reused machinery, since it was built for scanner-originated findings, not
 * operator-originated ones):
 *   1. `OPERATOR_EXECUTION_ONRAMP_ENABLED` kill switch — defaults OFF. This
 *      is genuinely new capability (an operator causing a real PR via a
 *      chat command); shipping it default-off until observed against real
 *      traffic matches this platform's own standing practice for new
 *      autonomy surfaces (e.g. VTID-03706's full-duplex voice).
 *   2. The target VTID must have `spec_status='approved'` and not be
 *      terminal — "never execute without approval" (this platform's own
 *      standing rule), enforced here explicitly because the Dev Autopilot
 *      pipeline itself has no spec_status gate (that gate normally lives on
 *      the unrelated generic VTID-lifecycle-start route).
 */

import { createHash, randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import type { CicdEventType } from '../types/cicd';
import { approveAutoExecute, getSupabase, supa, type SupaConfig } from './dev-autopilot-execute';
// VTID-04164: per-thread flood guard on the operator execution on-ramp.
import { checkOnRampRateLimit, describeOnRampRateLimit } from './operator-onramp-rate-limit';

const VTID = 'VTID-03820';
const ONRAMP_SOURCE_TYPE = 'operator_onramp';
const DEEPSEEK_MODEL = 'deepseek-flash';

export interface TriggerOperatorExecutionInput {
  /** The already-allocated, already-approved VTID to execute.
   *
   *  VTID-04005: optional ONLY when `OPERATOR_VTID_SELF_ALLOCATE_ENABLED=true`
   *  (default OFF — same default-off posture as the on-ramp kill switch).
   *  When enabled and omitted, the on-ramp mints a VTID through the same
   *  `allocate_global_vtid` RPC the gateway's own /api/v1/vtid/allocate
   *  route calls, sets a real title, and registers it `status=in_progress`
   *  + `spec_status=approved` — the registration CLAUDE.md Part 1 rule 2b /
   *  §4.1 prescribes for work the platform owner instructed in
   *  conversation. The caller has already proven the requester is an
   *  authenticated exafy_admin (executeExecuteTask's VTID-03851 authz runs
   *  first); that instruction is the approval. With the flag off, a missing
   *  VTID is rejected exactly as before. */
  vtid?: string;
  /** VTID-04005: short human title for a self-allocated VTID. Derived from
   *  the plan's first heading/line when omitted. */
  title?: string;
  /** Plan content — what to change and why. Not auto-derived; the caller
   *  (operator or the model composing the tool call) supplies it, same as
   *  a human filling in a plan before clicking Activate. */
  planMarkdown: string;
  /** Files the plan touches, source AND paired test files. The existing
   *  safety gate's tests_missing rule (unchanged) will reject a list
   *  missing test coverage — this on-ramp does not pre-derive or paper
   *  over that check. */
  filesReferenced: string[];
  /** Who asked for this — logged on the execution row and OASIS event. */
  requestedBy: string;
  /** VTID-04007 (W2): open-ended intake. The caller supplies only a
   *  free-text request — no VTID (self-allocated, so
   *  `OPERATOR_VTID_SELF_ALLOCATE_ENABLED` must be on) and no file list.
   *  The execution is pinned to the AGENT executor on the row itself
   *  (`metadata.executor='agent'`, independent of OPERATOR_ONRAMP_EXECUTOR)
   *  because only the agent can discover files; the single-shot path
   *  refuses a plan with no files. Scope, deny globs and the test-coverage
   *  rule are enforced on the agent's real diff after it finishes
   *  (`checkChangedFilesScope`/`hasTestCoverage`, VTID-04006) — the same
   *  globs the safety gate applies to a pre-listed plan, just post-hoc. */
  openEnded?: boolean;
}

export type TriggerOperatorExecutionResult =
  | { ok: true; execution_id: string; finding_id: string; vtid: string; vtid_allocated: boolean }
  | { ok: false; error: string; violations?: unknown[] };

function isOnRampEnabled(): boolean {
  return process.env.OPERATOR_EXECUTION_ONRAMP_ENABLED === 'true';
}

/** VTID-04005: second, independent opt-in for self-allocating VTIDs. */
export function isVtidSelfAllocateEnabled(): boolean {
  return process.env.OPERATOR_VTID_SELF_ALLOCATE_ENABLED === 'true';
}

/** VTID-04005: derive a ledger title from a plan when the caller gave none. */
export function deriveVtidTitleFromPlan(planMarkdown: string, explicit?: string): string {
  const clean = (t: string) => t.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
  const candidate = explicit && explicit.trim().length > 0
    ? explicit
    : (planMarkdown.split('\n').map(clean).find((l) => l.length > 0) || 'Operator-instructed change');
  const title = clean(candidate).slice(0, 140);
  return /^operator/i.test(title) ? title : `Operator: ${title}`;
}

/**
 * VTID-04005: mint a VTID for operator-instructed work and register it the
 * way §4.1 prescribes. Same RPC the gateway's own POST /api/v1/vtid/allocate
 * route calls — no parallel allocator, no fabricated number. Any failure is
 * returned as an error so the caller refuses loudly instead of executing
 * without a governed VTID.
 */
async function allocateAndRegisterVtid(
  s: SupaConfig,
  input: { title: string; summary: string; requestedBy: string; intake?: 'plan' | 'open_ended' },
): Promise<{ ok: true; vtid: string } | { ok: false; error: string }> {
  try {
    const rpc = await fetch(`${s.url}/rest/v1/rpc/allocate_global_vtid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: s.key, Authorization: `Bearer ${s.key}` },
      body: JSON.stringify({ p_source: 'operator-console', p_layer: 'DEV', p_module: 'operator-onramp' }),
    });
    if (!rpc.ok) {
      return { ok: false, error: `vtid_allocation_failed: ${rpc.status} ${(await rpc.text()).slice(0, 200)}` };
    }
    const rows = (await rpc.json()) as Array<{ vtid?: string }>;
    const vtid = rows && rows[0] && typeof rows[0].vtid === 'string' ? rows[0].vtid : null;
    if (!vtid || !/^VTID-\d{4,5}$/.test(vtid)) {
      return { ok: false, error: 'vtid_allocation_failed: allocator returned no VTID' };
    }
    const patch = await supa(s, `/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        title: input.title,
        summary: input.summary.slice(0, 500),
        status: 'in_progress',
        spec_status: 'approved',
        updated_at: new Date().toISOString(),
        metadata: {
          source: 'operator-onramp',
          requested_by: input.requestedBy,
          allocated_by: 'operator-execution-onramp',
          purpose: 'operator-instructed execution (OPERATOR_VTID_SELF_ALLOCATE_ENABLED)',
          ...(input.intake ? { intake: input.intake } : {}),
        },
      }),
    });
    if (!patch.ok) {
      // Allocated but not registered as approved — refuse rather than run
      // an execution the ledger does not show as approved.
      return { ok: false, error: `vtid_registration_failed for ${vtid}: ${patch.error || 'ledger PATCH failed'}` };
    }
    return { ok: true, vtid };
  } catch (err) {
    return { ok: false, error: `vtid_allocation_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * VTID-03877: link the queued execution back onto the VTID's own ledger row
 * so self-healing-reconciler.ts's terminal-outcome sync (originally built
 * only for the self-healing plane, widened by this same VTID to cover any
 * bridged execution) can find it. Without this, an on-ramp-triggered VTID's
 * vtid_ledger.status/is_terminal never updates when the execution finishes —
 * confirmed live: VTID-03862 reverted via the 20-min watchdog but stayed
 * reported as in_progress indefinitely, since nothing ever linked the two
 * rows in the first place.
 *
 * Merges into existing metadata rather than replacing it — a plain PATCH
 * body would clobber whatever else already lives in vtid_ledger.metadata
 * (e.g. the VTID's own `source`/`purpose` set at allocation time).
 * Best-effort: failure here must not fail the on-ramp trigger itself, since
 * the execution is already queued and real work is already in flight.
 */
async function linkExecutionToVtidLedger(s: SupaConfig, vtid: string, executionId: string): Promise<void> {
  try {
    const r = await supa<Array<{ metadata: Record<string, unknown> | null }>>(
      s,
      `/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}&select=metadata&limit=1`
    );
    if (!r.ok || !r.data || r.data.length === 0) return;
    const mergedMetadata = { ...(r.data[0].metadata || {}), autopilot_execution_id: executionId };
    await supa(s, `/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: mergedMetadata }),
    });
  } catch (err) {
    console.warn(`[operator-execution-onramp] linkExecutionToVtidLedger failed for ${vtid}:`, err);
  }
}

/**
 * Split out for testability — real DB call, no side effects beyond the read.
 */
async function loadVtidGovernanceState(
  s: SupaConfig,
  vtid: string
): Promise<{ ok: true; spec_status: string | null; is_terminal: boolean } | { ok: false; error: string }> {
  const r = await supa<Array<{ spec_status: string | null; is_terminal: boolean | null }>>(
    s,
    `/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}&select=spec_status,is_terminal&limit=1`
  );
  if (!r.ok || !r.data || r.data.length === 0) {
    return { ok: false, error: `vtid_ledger row not found for ${vtid}` };
  }
  return { ok: true, spec_status: r.data[0].spec_status, is_terminal: r.data[0].is_terminal === true };
}

export async function triggerOperatorExecution(
  input: TriggerOperatorExecutionInput
): Promise<TriggerOperatorExecutionResult> {
  if (!isOnRampEnabled()) {
    return { ok: false, error: 'operator_execution_onramp_disabled: OPERATOR_EXECUTION_ONRAMP_ENABLED is not "true"' };
  }

  // VTID-04164: flood guard FIRST — before the VTID allocation below, before
  // any DB read, and before approveAutoExecute's safety gate. A runaway
  // tool-calling loop on one Operator Console thread must not get as far as
  // minting a VTID (VTID-04005 self-allocation) or being evaluated as a
  // legitimate execution attempt. Keyed on `requestedBy`
  // (`operator-chat:<threadId>`), which is the thread identity the tool
  // handlers pass down — nothing else on this on-ramp reliably carries it.
  // Refusals are returned as a normal result, never thrown.
  const rate = checkOnRampRateLimit(input.requestedBy);
  if (!rate.allowed) {
    return { ok: false, error: describeOnRampRateLimit(rate) };
  }

  const s = getSupabase();
  if (!s) {
    return { ok: false, error: 'supabase_not_configured' };
  }

  if (!input.planMarkdown || input.planMarkdown.trim().length === 0) {
    return { ok: false, error: 'planMarkdown is required' };
  }
  const openEnded = input.openEnded === true;
  const filesReferenced = Array.isArray(input.filesReferenced) ? input.filesReferenced : [];
  if (!openEnded && filesReferenced.length === 0) {
    return { ok: false, error: 'filesReferenced is required and must be non-empty' };
  }

  // VTID-04005: self-allocate when the caller did not name a VTID and the
  // capability is switched on. The freshly registered row is then re-read
  // through the SAME governance gate below — no shortcut past it.
  let vtidAllocated = false;
  let vtid = (input.vtid || '').trim();
  if (!vtid) {
    if (!isVtidSelfAllocateEnabled()) {
      return { ok: false, error: 'vtid is required (OPERATOR_VTID_SELF_ALLOCATE_ENABLED is not "true", so the on-ramp will not allocate one)' };
    }
    const alloc = await allocateAndRegisterVtid(s, {
      title: deriveVtidTitleFromPlan(input.planMarkdown, input.title),
      summary: input.planMarkdown,
      requestedBy: input.requestedBy,
      intake: openEnded ? 'open_ended' : 'plan',
    });
    if (!alloc.ok) return { ok: false, error: alloc.error };
    vtid = alloc.vtid;
    vtidAllocated = true;
  }

  // Governance gate 1: the target VTID must already be approved. The Dev
  // Autopilot pipeline itself has no spec_status check (see module doc) —
  // this on-ramp is the one place that enforces it for operator-triggered
  // execution.
  const gov = await loadVtidGovernanceState(s, vtid);
  if (!gov.ok) {
    return { ok: false, error: gov.error };
  }
  if (gov.is_terminal) {
    return { ok: false, error: `${vtid} is already terminal — nothing to execute` };
  }
  if (gov.spec_status !== 'approved') {
    return { ok: false, error: `${vtid} spec_status is '${gov.spec_status ?? 'null'}', not 'approved' — cannot execute` };
  }

  const specHash = createHash('sha256').update(input.planMarkdown).digest('hex');
  const title = openEnded ? `Operator open-ended request: ${vtid}` : `Operator on-ramp: ${vtid}`;

  const recBody = {
    title,
    summary: input.planMarkdown.slice(0, 1000),
    domain: 'general',
    risk_level: 'medium',
    impact_score: 5,
    effort_score: 4,
    source_type: ONRAMP_SOURCE_TYPE,
    risk_class: 'medium',
    auto_exec_eligible: false,
    status: 'new',
    activated_vtid: vtid,
    spec_snapshot: {
      scanner: 'operator-onramp',
      vtid: vtid,
      spec_markdown: input.planMarkdown,
      files_referenced: filesReferenced,
      requested_by: input.requestedBy,
      // VTID-04007: read by the agent runner to switch the task prompt to
      // discovery mode ("no files were pre-selected — find them").
      intake: openEnded ? 'open_ended' : 'plan',
    },
    spec_checksum: specHash,
  };

  const recResp = await fetch(`${s.url}/rest/v1/autopilot_recommendations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: s.key,
      Authorization: `Bearer ${s.key}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(recBody),
  });
  if (!recResp.ok) {
    const errText = await recResp.text();
    return { ok: false, error: `autopilot_recommendations insert failed: ${recResp.status} ${errText.slice(0, 300)}` };
  }
  const recRows = (await recResp.json()) as Array<{ id: string }>;
  if (!recRows || recRows.length === 0) {
    return { ok: false, error: 'autopilot_recommendations insert returned no row' };
  }
  const findingId = recRows[0].id;

  const planResp = await fetch(`${s.url}/rest/v1/dev_autopilot_plan_versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: s.key,
      Authorization: `Bearer ${s.key}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      finding_id: findingId,
      version: 1,
      plan_markdown: input.planMarkdown,
      files_referenced: filesReferenced,
    }),
  });
  if (!planResp.ok) {
    const errText = await planResp.text();
    return { ok: false, error: `dev_autopilot_plan_versions insert failed: ${planResp.status} ${errText.slice(0, 300)}` };
  }

  // Governance gate 2 (reused, not reimplemented): approveAutoExecute runs
  // the full existing safety gate. `interactive: true` makes a rejection
  // come back synchronously here — never silently snoozed the way an
  // unattended autoApproveTick call would be.
  //
  // VTID-03839: `requestedBy` is deliberately NOT passed as `approved_by`.
  // It is a label (`operator-chat:<threadId>`), and
  // `dev_autopilot_executions.approved_by` is a uuid column — the first
  // real staging run that cleared the safety gate died on exactly that
  // INSERT (Postgres 22P02). The requester is still recorded on the
  // recommendation (`spec_snapshot.requested_by`), the execution metadata
  // (`triggered_by`, PATCHed below) and the OASIS event — nothing is lost,
  // it just does not go into a uuid column.
  const approval = await approveAutoExecute({ finding_id: findingId, interactive: true });
  if (!approval.ok || !approval.execution) {
    return { ok: false, error: approval.error || 'approval failed', violations: approval.decision?.violations };
  }
  const executionId = approval.execution.id;

  // One PATCH sets the DeepSeek override AND fast-forwards execute_after —
  // deliberately combined so there is no window where a background tick
  // could pick up this execution before the override metadata is attached.
  await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${executionId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      execute_after: new Date().toISOString(),
      metadata: {
        llm_on_ramp: 'deepseek',
        llm_on_ramp_override: { provider: 'deepseek', model: DEEPSEEK_MODEL },
        triggered_by: input.requestedBy,
        source: 'operator-onramp',
        // VTID-04006: OPERATOR_ONRAMP_EXECUTOR=agent routes operator-instructed
        // executions to the agent executor (clone + tool loop + local tsc/jest)
        // without touching how the autonomous self-healing lane executes.
        ...(process.env.OPERATOR_ONRAMP_EXECUTOR === 'agent' ? { executor: 'agent' } : {}),
        // VTID-04007: an open-ended request has no file list, which only the
        // agent executor can work with — pinned on the row so the env default
        // cannot route it to the single-shot path.
        ...(openEnded ? { executor: 'agent', intake: 'open_ended' } : {}),
        // VTID-04029: OPERATOR_PR_APPROVAL_REQUIRED=true makes the agent
        // executor stop after pushing its branch and wait for a human
        // Approve/Reject on the diff before any PR is opened (§4.6).
        ...(process.env.OPERATOR_PR_APPROVAL_REQUIRED === 'true' ? { require_approval: true } : {}),
      },
    }),
  });

  // VTID-03877: link before emitting the event, not after — a crash between
  // the two would still leave the ledger correctly linked, whereas the
  // reverse order could lose the link on a crash right after the event.
  await linkExecutionToVtidLedger(s, vtid, executionId);

  await emitOasisEvent({
    vtid: vtid,
    type: 'operator.execution_onramp.triggered' as CicdEventType,
    source: 'operator-execution-onramp',
    status: 'success',
    message: `Operator on-ramp queued DeepSeek-powered execution ${executionId.slice(0, 8)} for ${vtid}${openEnded ? ' (open-ended request, agent executor)' : ''}`,
    payload: {
      execution_id: executionId,
      finding_id: findingId,
      vtid: vtid,
      intake: openEnded ? 'open_ended' : 'plan',
      vtid_allocated: vtidAllocated,
      requested_by: input.requestedBy,
      provider: 'deepseek',
      model: DEEPSEEK_MODEL,
      correlation_id: randomUUID(),
    },
  }).catch((err: any) => console.warn(`[${VTID}] Failed to log execution_onramp.triggered:`, err.message));

  return { ok: true, execution_id: executionId, finding_id: findingId, vtid, vtid_allocated: vtidAllocated };
}
