/**
 * VTID-03848 — the BackOffice command orchestrator as a SERVICE.
 *
 * Extracted from routes/backoffice-commands.ts (VTID-03842) so the ORB voice
 * tools (services/backoffice-voice-tools.ts) and the HTTP route run the very
 * same pipeline: idempotency → policy → exact-match entity resolution →
 * execute on the bridge | queue for a different approver | reject → persist,
 * audit, OASIS event. There is no second path; the route is a thin adapter.
 */
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { getCommandSpec, BACKOFFICE_COMMANDS } from '../../constants/backoffice-commands';
import { ROLE_DEFAULT_CAPABILITIES, type ErpCapability } from '../../constants/erp-capabilities';
import { hasCapability, type EffectiveAccess } from './erp-access';
import { DEFAULT_TENANT_POLICY, evaluateApproval, evaluateCommand, eligibleApproverCount, type CommandChannel, type TenantPolicy } from './command-policy';
import { getErpBridgeClient, type BridgeResult } from './erp-bridge-client';
import { resolveEntities } from './entity-resolution';
import { getCommandStore, type CommandRow, type CommandStore } from './command-store';
import { emitOasisEvent } from '../oasis-event-service';
import { getSupabase } from '../../lib/supabase';
import { recordCustomerEpisode } from '../memory/customer';

const VTID = 'VTID-03842';

/**
 * VTID-04411: an executed CRM/sales command about a customer leaves a
 * customer-scoped memory episode. Fire-and-forget; never affects the result.
 */
function rememberForCustomer(done: CommandRow): void {
  if (done.status !== 'executed') return;
  void (async () => {
    try {
      const sb = getSupabase();
      if (!sb) return;
      const out = await recordCustomerEpisode(sb, done);
      if (out.status === 'write_failed') console.warn(`[backoffice] customer memory write failed for ${done.id}: ${out.error}`);
    } catch (err) {
      console.warn('[backoffice] customer memory write threw:', err instanceof Error ? err.message : err);
    }
  })();
}

export interface OrchestratorCaller {
  user_id: string;
  email: string | null;
  is_exafy_admin: boolean;
  tenant_id: string;
  active_role: string | null;
  /** JWT assurance level (`aal2` = MFA-backed); null when unknown */
  aal: string | null;
}

export interface SubmitCommandInput {
  type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  channel: CommandChannel;
  confirm: boolean;
}

export interface OrchestratorResult {
  http: number;
  body: Record<string, unknown>;
}

export function requestHash(type: string, payload: Record<string, unknown>): string {
  const canon = JSON.stringify({ t: type, p: sortKeys(payload) });
  return createHash('sha256').update(canon).digest('hex');
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as any)[k])]));
  return v;
}

export async function tenantPolicy(store: CommandStore, tenantId: string): Promise<TenantPolicy> {
  try {
    const row = await store.getPolicy(tenantId);
    if (row) return { high_risk_amount_threshold: Number(row.high_risk_amount_threshold), require_mfa_for_high: !!row.require_mfa_for_high };
  } catch (err: any) {
    console.error(`[${VTID}] policy fetch failed, using defaults:`, err.message);
  }
  return DEFAULT_TENANT_POLICY;
}

/** Distinct users in the tenant who could approve: explicit holders ∪ tenant admins whose role defaults include it. */
async function approverPool(store: CommandStore, tenantId: string, capability: ErpCapability): Promise<string[]> {
  const explicit = await store.explicitHolders(tenantId, capability).catch(() => [] as string[]);
  const adminDefaults = ROLE_DEFAULT_CAPABILITIES.admin ?? [];
  const admins = adminDefaults.includes(capability) ? await store.tenantAdmins(tenantId).catch(() => [] as string[]) : [];
  return [...new Set([...explicit, ...admins])];
}

/**
 * The command as the API exposes it. `withPayload` (VTID-03887) adds `payload` +
 * `resolved_payload` — only for callers the route has checked may see them: the
 * requester, an `audit.view` holder, or a holder of the approve capability of a
 * command awaiting approval. The approver must see WHAT they approve
 * (GOLDEN-WORKFLOWS §3.3, maker-checker); nobody else sees a payload.
 */
export function publicCommand(row: CommandRow, replayed = false, withPayload = false) {
  const base = {
    command_id: row.id, type: row.type, action: row.action, tier: row.tier, status: row.status,
    reason: row.reason, approval_id: row.approval_id, receipt: row.receipt, escalations: row.escalations,
    channel: row.channel, requester_id: row.requester_id, created_at: row.created_at, executed_at: row.executed_at, replayed,
  };
  return withPayload ? { ...base, payload: row.payload ?? {}, resolved_payload: row.resolved_payload ?? null } : base;
}

/**
 * VTID-03887 — who may see a command's payload. Requester and `audit.view` see it always;
 * a holder of the approval's approve capability sees it while the command awaits their decision
 * (and after it: the audit trail of what was approved). Returns false for everyone else.
 */
export function mayViewPayload(row: CommandRow, viewer: { user_id: string; access: EffectiveAccess }, approval?: { approve_capability: string } | null): boolean {
  if (row.requester_id === viewer.user_id) return true;
  if (hasCapability(viewer.access, 'audit.view')) return true;
  if (approval && row.approval_id && hasCapability(viewer.access, approval.approve_capability as ErpCapability)) return true;
  return false;
}

async function audit(store: CommandStore, caller: OrchestratorCaller, access: EffectiveAccess, channel: string, event: string, command_id: string | null, approval_id: string | null, details: Record<string, unknown>) {
  try {
    await store.appendAudit({ tenant_id: caller.tenant_id, actor_id: caller.user_id, actor_role: access.role, channel, event, command_id, approval_id, details });
  } catch (err: any) {
    // An audit write failure is loud, never silent (CLAUDE.md NEVER 19) — but it must not hide the command outcome.
    console.error(`[${VTID}] AUDIT WRITE FAILED event=${event} command=${command_id}:`, err.message);
  }
  emitOasisEvent({
    vtid: VTID, type: `backoffice.${event}` as any, source: 'gateway', status: event.endsWith('failed') || event.endsWith('rejected') ? 'warning' : 'info',
    message: `${event} ${command_id ?? approval_id ?? ''}`.trim(), actor_id: caller.user_id, actor_email: caller.email ?? undefined,
    actor_role: 'user', surface: channel === 'voice' ? 'orb' : 'api', payload: { tenant_id: caller.tenant_id, command_id, approval_id, ...details },
  }).catch(() => undefined);
}

function bridgeConfirmation(tier: string, approval?: { id: string; approver: string; requester: string }) {
  if (approval) return { granted: true, approval_id: approval.id, approved_by: approval.approver, requested_by: approval.requester };
  if (tier === 'commit') return { granted: true };
  return { granted: false };
}

async function runOnBridge(row: CommandRow, params: Record<string, unknown>, approval?: { id: string; approver: string; requester: string }): Promise<{ status: 'executed' | 'failed'; receipt: Record<string, unknown>; reason: string | null }> {
  const bridge = getErpBridgeClient();
  if (!bridge) return { status: 'failed', receipt: { error: 'bridge_not_configured' }, reason: 'bridge_not_configured' };
  const res: BridgeResult = await bridge.execute({
    tenant_id: row.tenant_id, action: row.action, params, idempotency_key: row.idempotency_key,
    actor: { user_id: row.requester_id, channel: row.channel }, confirmation: bridgeConfirmation(row.tier, approval),
  });
  if (!res.ok) return { status: 'failed', receipt: { error: res.error, detail: res.detail ?? null, http: res.status }, reason: res.error };
  const receipt = res.receipt as unknown as Record<string, unknown>;
  return res.receipt.status === 'executed' ? { status: 'executed', receipt, reason: null } : { status: 'failed', receipt, reason: 'erp_action_failed' };
}

/**
 * Run one typed command for a caller. Returns the HTTP status the route
 * would answer with plus the JSON body — the voice tool reads the same body.
 */
export async function submitCommand(caller: OrchestratorCaller, access: EffectiveAccess, input: SubmitCommandInput): Promise<OrchestratorResult> {
  const spec = getCommandSpec(input.type);
  if (!spec) return { http: 400, body: { ok: false, error: 'INVALID_BODY', issues: ['type: unknown command type'] } };
  const store = getCommandStore();
  const channel = input.channel;
  const hash = requestHash(spec.type, input.payload);

  // Idempotency: same key + same request → replay; same key + different request → 409.
  const existing = await store.findByIdempotency(caller.tenant_id, input.idempotency_key);
  if (existing) {
    if (existing.request_hash !== hash) return { http: 409, body: { ok: false, error: 'IDEMPOTENCY_CONFLICT', command_id: existing.id } };
    return { http: 200, body: { ok: existing.status === 'executed', command: publicCommand(existing, true) } };
  }

  const policy = await tenantPolicy(store, caller.tenant_id);
  const decision = evaluateCommand(spec, input.payload, {
    user_id: caller.user_id, active_role: access.role, is_exafy_admin: access.is_exafy_admin, capabilities: access.capabilities, channel,
  }, policy, input.confirm);

  const base = {
    id: randomUUID(), tenant_id: caller.tenant_id, requester_id: caller.user_id, channel, type: spec.type, action: spec.action,
    tier: decision.tier, payload: input.payload, resolved_payload: null as Record<string, unknown> | null, idempotency_key: input.idempotency_key,
    request_hash: hash, reason: decision.reason ?? null, approval_id: null as string | null, receipt: null as Record<string, unknown> | null,
    escalations: decision.escalations, executed_at: null as string | null,
  };

  if (decision.outcome === 'reject') {
    const row = await store.insertCommand({ ...base, status: 'rejected' });
    await audit(store, caller, access, channel, 'command.rejected', row.id, null, { type: spec.type, tier: decision.tier, reason: decision.reason, required_capability: decision.required_capability ?? null });
    const http = decision.reason === 'capability_missing' || decision.reason === 'platform_role_read_only' ? 403 : 200;
    return { http, body: { ok: false, command: publicCommand(row), required_capability: decision.required_capability ?? null } };
  }

  // Entity resolution happens before anything is queued or executed, and only through the bridge's Read actions.
  let params = input.payload;
  if (Object.keys(input.payload).some((k) => k.endsWith('_ref'))) {
    const bridge = getErpBridgeClient();
    if (!bridge) return { http: 503, body: { ok: false, error: 'bridge_not_configured' } };
    const resolved = await resolveEntities(bridge, caller.tenant_id, caller.user_id, input.payload);
    if (!resolved.ok) {
      const row = await store.insertCommand({ ...base, status: 'rejected', reason: resolved.reason });
      await audit(store, caller, access, channel, 'command.rejected', row.id, null, { type: spec.type, reason: resolved.reason, field: resolved.field, ref: resolved.ref });
      return { http: 200, body: { ok: false, command: publicCommand(row), entity: { field: resolved.field, ref: resolved.ref, candidates: resolved.candidates ?? [] } } };
    }
    params = resolved.payload;
    base.resolved_payload = resolved.payload;
  }

  if (decision.outcome === 'queue') {
    const approveCap = decision.approve_capability!;
    const pool = await approverPool(store, caller.tenant_id, approveCap);
    const eligible = eligibleApproverCount(pool, caller.user_id);
    const row = await store.insertCommand({ ...base, status: 'awaiting_approval', reason: eligible >= 1 ? 'awaiting_approval' : 'no_eligible_approver' });
    const approval = await store.insertApproval({
      id: randomUUID(), command_id: row.id, tenant_id: caller.tenant_id, requester_id: caller.user_id, approve_capability: approveCap,
      status: 'pending', reason: eligible >= 1 ? null : 'no_eligible_approver', decided_by: null, decided_at: null, decision_note: null,
    });
    await store.updateCommand(row.id, { approval_id: approval.id });
    row.approval_id = approval.id;
    await audit(store, caller, access, channel, 'command.queued', row.id, approval.id, { type: spec.type, tier: decision.tier, approve_capability: approveCap, escalations: decision.escalations, eligible_approvers: eligible });
    return { http: 202, body: { ok: true, command: publicCommand(row), approval: { approval_id: approval.id, approve_capability: approveCap, eligible_approvers: eligible } } };
  }

  // execute (read / draft / confirmed commit)
  const row = await store.insertCommand({ ...base, status: 'failed', reason: 'in_progress' });
  const outcome = await runOnBridge(row, params);
  const done = await store.updateCommand(row.id, { status: outcome.status, receipt: outcome.receipt, reason: outcome.reason, executed_at: outcome.status === 'executed' ? new Date().toISOString() : null });
  rememberForCustomer(done);
  await audit(store, caller, access, channel, outcome.status === 'executed' ? 'command.executed' : 'command.failed', row.id, null, { type: spec.type, tier: decision.tier, escalations: decision.escalations, reason: outcome.reason });
  return { http: outcome.status === 'executed' ? 200 : 502, body: { ok: outcome.status === 'executed', command: publicCommand(done) } };
}

/** Decide a queued High-risk request. Only the web channel may reach this (evaluateApproval enforces it). */
export async function decideApproval(caller: OrchestratorCaller, access: EffectiveAccess, approvalId: string, verdict: 'approved' | 'rejected', note: string | null, channel: CommandChannel): Promise<OrchestratorResult> {
  const store = getCommandStore();
  const approval = await store.getApproval(caller.tenant_id, approvalId);
  if (!approval) return { http: 404, body: { ok: false, error: 'NOT_FOUND' } };
  if (approval.status !== 'pending') return { http: 409, body: { ok: false, error: 'ALREADY_DECIDED', status: approval.status } };
  const policy = await tenantPolicy(store, caller.tenant_id);
  const check = evaluateApproval({ user_id: caller.user_id, active_role: access.role, is_exafy_admin: access.is_exafy_admin, capabilities: access.capabilities, channel, aal: caller.aal }, approval.requester_id, approval.approve_capability as ErpCapability, policy);
  if (!check.ok) {
    await audit(store, caller, access, channel, 'approval.refused', approval.command_id, approval.id, { reason: check.reason, verdict });
    return { http: 403, body: { ok: false, error: check.reason } };
  }
  const command = await store.getCommand(caller.tenant_id, approval.command_id);
  if (!command) return { http: 404, body: { ok: false, error: 'COMMAND_NOT_FOUND' } };
  const now = new Date().toISOString();

  if (verdict === 'rejected') {
    await store.updateApproval(approval.id, { status: 'rejected', decided_by: caller.user_id, decided_at: now, decision_note: note });
    const done = await store.updateCommand(command.id, { status: 'rejected', reason: 'approval_rejected' });
    await audit(store, caller, access, channel, 'approval.rejected', command.id, approval.id, { note, requester_id: approval.requester_id });
    return { http: 200, body: { ok: true, command: publicCommand(done) } };
  }

  await store.updateApproval(approval.id, { status: 'approved', decided_by: caller.user_id, decided_at: now, decision_note: note });
  const outcome = await runOnBridge(command, (command.resolved_payload ?? command.payload) as Record<string, unknown>, { id: approval.id, approver: caller.user_id, requester: approval.requester_id });
  const done = await store.updateCommand(command.id, { status: outcome.status, receipt: outcome.receipt, reason: outcome.reason, executed_at: outcome.status === 'executed' ? now : null });
  rememberForCustomer(done);
  await audit(store, caller, access, channel, 'approval.approved', command.id, approval.id, { note, requester_id: approval.requester_id, outcome: outcome.status, reason: outcome.reason });
  return { http: outcome.status === 'executed' ? 200 : 502, body: { ok: outcome.status === 'executed', command: publicCommand(done) } };
}

/** The commands this caller may request (any-of capability), for the voice/catalog surfaces. */
export function allowedCommandsFor(access: EffectiveAccess) {
  return BACKOFFICE_COMMANDS.filter((c) => access.is_exafy_admin || c.capabilities.some((cap) => access.capabilities.includes(cap as ErpCapability)));
}

/** Policy-updated audit, shared by PUT /policy. */
export async function recordPolicyUpdate(caller: OrchestratorCaller, access: EffectiveAccess, before: TenantPolicy, after: TenantPolicy): Promise<void> {
  await audit(getCommandStore(), caller, access, 'web', 'policy.updated', null, null, { before, after });
}

export { hasCapability };
