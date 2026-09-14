/**
 * VTID-03842: BackOffice command orchestrator — the ONE policy path for every
 * ERP mutation, whether it comes from the web UI, the Operator chat or ORB voice.
 *
 * Mounted at /api/v1/backoffice. Endpoints:
 * - POST /commands                { type, payload, idempotency_key, channel?, confirm? }
 *                                 → { command_id, tier, status: executed|awaiting_approval|rejected|failed, receipt, reason }
 * - GET  /commands                caller's tenant, newest first (audit.view or own rows)
 * - GET  /commands/:id
 * - GET  /approvals?status=       queue (any BackOffice capability holder sees it; only approvers act)
 * - POST /approvals/:id/approve   { note? }   maker-checker, MFA, web only
 * - POST /approvals/:id/reject    { note? }
 * - GET  /audit                   independent audit log (audit.view)
 * - GET  /policy, PUT /policy     { high_risk_amount_threshold, require_mfa_for_high } (approvals.policy)
 *
 * Pipeline for POST /commands (GOLDEN-WORKFLOWS §1.3, §3.3, §4.3):
 *   auth → effective capabilities → typed command → idempotency (replay / 409)
 *   → policy (capability, developer/infra ceiling, §4.3 escalations, channel ceilings, confirmation)
 *   → exact-match entity resolution (never a guess)
 *   → execute on the bridge (Read/Draft/Commit) | queue for a different approver (High-risk) | reject
 *   → persist row + receipt, append audit, emit OASIS event.
 *
 * The bridge (VTID-03840) is the only thing that runs ERPClaw; this route is
 * the only thing that calls the bridge with a confirmation. `--user-confirmed`
 * never appears anywhere in a request body.
 */
import { Router, Request, Response } from 'express';
import { createHash } from 'crypto';
import { z } from 'zod';
import { verifyAuth } from '../lib/tenant-role-auth';
import { resolveAccess } from './backoffice-access';
import { getCommandSpec, COMMAND_TYPES, BACKOFFICE_COMMANDS } from '../constants/backoffice-commands';
import { ROLE_DEFAULT_CAPABILITIES, type ErpCapability } from '../constants/erp-capabilities';
import { hasCapability, type EffectiveAccess } from '../services/backoffice/erp-access';
import { DEFAULT_TENANT_POLICY, evaluateApproval, evaluateCommand, eligibleApproverCount, type CommandChannel, type TenantPolicy } from '../services/backoffice/command-policy';
import { getErpBridgeClient, type BridgeResult } from '../services/backoffice/erp-bridge-client';
import { resolveEntities } from '../services/backoffice/entity-resolution';
import { getCommandStore, type CommandRow, type CommandStore } from '../services/backoffice/command-store';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();
const VTID = 'VTID-03842';

const Channel = z.enum(['web', 'chat', 'voice', 'system']);
const CommandBody = z.object({
  type: z.string().min(3).max(80).refine((t) => COMMAND_TYPES.includes(t), { message: 'unknown command type' }),
  payload: z.record(z.unknown()).default({}),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_.:\-]{8,128}$/),
  channel: Channel.default('web'),
  confirm: z.boolean().default(false),
});
const DecisionBody = z.object({ note: z.string().max(1000).optional() });
const PolicyBody = z.object({
  high_risk_amount_threshold: z.number().min(0).max(1e12),
  require_mfa_for_high: z.boolean(),
});

type Auth = Extract<Awaited<ReturnType<typeof verifyAuth>>, { ok: true }>;
interface Ctx { auth: Auth; access: EffectiveAccess; tenantId: string; aal: string | null }

function jwtAal(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.aal === 'string' ? payload.aal : null;
  } catch { return null; }
}

/** Every route here needs identity + a tenant; capabilities are checked per route. */
async function requireCtx(req: Request, res: Response): Promise<Ctx | null> {
  const auth = await verifyAuth(req);
  if (!auth.ok) { res.status(auth.status).json({ ok: false, error: auth.error }); return null; }
  if (!auth.tenant_id) { res.status(400).json({ ok: false, error: 'NO_TENANT_CONTEXT' }); return null; }
  const access = await resolveAccess(auth);
  return { auth, access, tenantId: auth.tenant_id, aal: jwtAal(auth.token) };
}

function requestHash(type: string, payload: Record<string, unknown>): string {
  const canon = JSON.stringify({ t: type, p: sortKeys(payload) });
  return createHash('sha256').update(canon).digest('hex');
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as any)[k])]));
  return v;
}

async function tenantPolicy(store: CommandStore, tenantId: string): Promise<TenantPolicy> {
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

function publicCommand(row: CommandRow, replayed = false) {
  return {
    command_id: row.id, type: row.type, action: row.action, tier: row.tier, status: row.status,
    reason: row.reason, approval_id: row.approval_id, receipt: row.receipt, escalations: row.escalations,
    channel: row.channel, requester_id: row.requester_id, created_at: row.created_at, executed_at: row.executed_at, replayed,
  };
}

async function audit(store: CommandStore, ctx: { tenantId: string; auth: Auth; access: EffectiveAccess }, channel: string, event: string, command_id: string | null, approval_id: string | null, details: Record<string, unknown>) {
  try {
    await store.appendAudit({ tenant_id: ctx.tenantId, actor_id: ctx.auth.user_id, actor_role: ctx.access.role, channel, event, command_id, approval_id, details });
  } catch (err: any) {
    // An audit write failure is loud, never silent (CLAUDE.md NEVER 19) — but it must not hide the command outcome.
    console.error(`[${VTID}] AUDIT WRITE FAILED event=${event} command=${command_id}:`, err.message);
  }
  emitOasisEvent({
    vtid: VTID, type: `backoffice.${event}` as any, source: 'gateway', status: event.endsWith('failed') || event.endsWith('rejected') ? 'warning' : 'info',
    message: `${event} ${command_id ?? approval_id ?? ''}`.trim(), actor_id: ctx.auth.user_id, actor_email: ctx.auth.email,
    actor_role: 'user', surface: 'api', payload: { tenant_id: ctx.tenantId, command_id, approval_id, ...details },
  }).catch(() => undefined);
}

function bridgeConfirmation(tier: string, approval?: { id: string; approver: string; requester: string }) {
  if (approval) return { granted: true, approval_id: approval.id, approved_by: approval.approver, requested_by: approval.requester };
  if (tier === 'commit') return { granted: true };
  return { granted: false };
}

async function runOnBridge(row: CommandRow, ctx: Ctx, params: Record<string, unknown>, approval?: { id: string; approver: string; requester: string }): Promise<{ status: 'executed' | 'failed'; receipt: Record<string, unknown>; reason: string | null }> {
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

// POST /commands -------------------------------------------------------------------
router.post('/commands', async (req: Request, res: Response) => {
  const ctx = await requireCtx(req, res);
  if (!ctx) return;
  const parsed = CommandBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_BODY', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const body = parsed.data;
  const spec = getCommandSpec(body.type)!;
  const store = getCommandStore();
  const channel = body.channel as CommandChannel;
  const hash = requestHash(spec.type, body.payload);

  try {
    // Idempotency: same key + same request → replay; same key + different request → 409.
    const existing = await store.findByIdempotency(ctx.tenantId, body.idempotency_key);
    if (existing) {
      if (existing.request_hash !== hash) return res.status(409).json({ ok: false, error: 'IDEMPOTENCY_CONFLICT', command_id: existing.id });
      return res.status(200).json({ ok: existing.status === 'executed', command: publicCommand(existing, true) });
    }

    const policy = await tenantPolicy(store, ctx.tenantId);
    const decision = evaluateCommand(spec, body.payload, {
      user_id: ctx.auth.user_id, active_role: ctx.access.role, is_exafy_admin: ctx.access.is_exafy_admin, capabilities: ctx.access.capabilities, channel,
    }, policy, body.confirm);

    const base = {
      id: cryptoId(), tenant_id: ctx.tenantId, requester_id: ctx.auth.user_id, channel, type: spec.type, action: spec.action,
      tier: decision.tier, payload: body.payload, resolved_payload: null as Record<string, unknown> | null, idempotency_key: body.idempotency_key,
      request_hash: hash, reason: decision.reason ?? null, approval_id: null as string | null, receipt: null as Record<string, unknown> | null,
      escalations: decision.escalations, executed_at: null as string | null,
    };

    if (decision.outcome === 'reject') {
      const row = await store.insertCommand({ ...base, status: 'rejected' });
      await audit(store, ctx, channel, 'command.rejected', row.id, null, { type: spec.type, tier: decision.tier, reason: decision.reason, required_capability: decision.required_capability ?? null });
      return res.status(decision.reason === 'capability_missing' || decision.reason === 'platform_role_read_only' ? 403 : 200)
        .json({ ok: false, command: publicCommand(row), required_capability: decision.required_capability ?? null });
    }

    // Entity resolution happens before anything is queued or executed, and only through the bridge's Read actions.
    let params = body.payload;
    if (Object.keys(body.payload).some((k) => k.endsWith('_ref'))) {
      const bridge = getErpBridgeClient();
      if (!bridge) return res.status(503).json({ ok: false, error: 'bridge_not_configured' });
      const resolved = await resolveEntities(bridge, ctx.tenantId, ctx.auth.user_id, body.payload);
      if (!resolved.ok) {
        const row = await store.insertCommand({ ...base, status: 'rejected', reason: resolved.reason });
        await audit(store, ctx, channel, 'command.rejected', row.id, null, { type: spec.type, reason: resolved.reason, field: resolved.field, ref: resolved.ref });
        return res.status(200).json({ ok: false, command: publicCommand(row), entity: { field: resolved.field, ref: resolved.ref, candidates: resolved.candidates ?? [] } });
      }
      params = resolved.payload;
      base.resolved_payload = resolved.payload;
    }

    if (decision.outcome === 'queue') {
      const approveCap = decision.approve_capability!;
      const pool = await approverPool(store, ctx.tenantId, approveCap);
      const eligible = eligibleApproverCount(pool, ctx.auth.user_id);
      const row = await store.insertCommand({ ...base, status: 'awaiting_approval', reason: eligible >= 1 ? 'awaiting_approval' : 'no_eligible_approver' });
      const approval = await store.insertApproval({
        id: cryptoId(), command_id: row.id, tenant_id: ctx.tenantId, requester_id: ctx.auth.user_id, approve_capability: approveCap,
        status: 'pending', reason: eligible >= 1 ? null : 'no_eligible_approver', decided_by: null, decided_at: null, decision_note: null,
      });
      await store.updateCommand(row.id, { approval_id: approval.id });
      row.approval_id = approval.id;
      await audit(store, ctx, channel, 'command.queued', row.id, approval.id, { type: spec.type, tier: decision.tier, approve_capability: approveCap, escalations: decision.escalations, eligible_approvers: eligible });
      return res.status(202).json({ ok: true, command: publicCommand(row), approval: { approval_id: approval.id, approve_capability: approveCap, eligible_approvers: eligible } });
    }

    // execute (read / draft / confirmed commit)
    const row = await store.insertCommand({ ...base, status: 'failed', reason: 'in_progress' });
    const outcome = await runOnBridge(row, ctx, params);
    const done = await store.updateCommand(row.id, { status: outcome.status, receipt: outcome.receipt, reason: outcome.reason, executed_at: outcome.status === 'executed' ? new Date().toISOString() : null });
    await audit(store, ctx, channel, outcome.status === 'executed' ? 'command.executed' : 'command.failed', row.id, null, { type: spec.type, tier: decision.tier, escalations: decision.escalations, reason: outcome.reason });
    return res.status(outcome.status === 'executed' ? 200 : 502).json({ ok: outcome.status === 'executed', command: publicCommand(done) });
  } catch (err: any) {
    console.error(`[${VTID}] POST /commands error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /commands, /commands/:id ----------------------------------------------------------
router.get('/commands', async (req: Request, res: Response) => {
  const ctx = await requireCtx(req, res);
  if (!ctx) return;
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
    const status = typeof req.query.status === 'string' ? (req.query.status as any) : undefined;
    let rows = await getCommandStore().listCommands(ctx.tenantId, { status, limit });
    if (!hasCapability(ctx.access, 'audit.view')) rows = rows.filter((r) => r.requester_id === ctx.auth.user_id);
    return res.json({ ok: true, commands: rows.map((r) => publicCommand(r)) });
  } catch (err: any) {
    console.error(`[${VTID}] GET /commands error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

router.get('/commands/:id', async (req: Request, res: Response) => {
  const ctx = await requireCtx(req, res);
  if (!ctx) return;
  try {
    const row = await getCommandStore().getCommand(ctx.tenantId, req.params.id);
    if (!row || (!hasCapability(ctx.access, 'audit.view') && row.requester_id !== ctx.auth.user_id)) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, command: publicCommand(row) });
  } catch (err: any) {
    console.error(`[${VTID}] GET /commands/:id error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// Approvals -------------------------------------------------------------------------------
router.get('/approvals', async (req: Request, res: Response) => {
  const ctx = await requireCtx(req, res);
  if (!ctx) return;
  if (ctx.access.capabilities.length === 0 && !ctx.access.is_exafy_admin) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
    const status = typeof req.query.status === 'string' ? (req.query.status as any) : 'pending';
    const rows = await getCommandStore().listApprovals(ctx.tenantId, { status, limit });
    return res.json({
      ok: true,
      approvals: rows.map((a) => ({
        ...a,
        can_decide: evaluateApproval({ user_id: ctx.auth.user_id, active_role: ctx.access.role, is_exafy_admin: ctx.access.is_exafy_admin, capabilities: ctx.access.capabilities, channel: 'web', aal: ctx.aal }, a.requester_id, a.approve_capability as ErpCapability, DEFAULT_TENANT_POLICY).ok,
      })),
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /approvals error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

async function decide(req: Request, res: Response, verdict: 'approved' | 'rejected') {
  const ctx = await requireCtx(req, res);
  if (!ctx) return;
  const parsed = DecisionBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_BODY' });
  const channel = (typeof req.body?.channel === 'string' && Channel.safeParse(req.body.channel).success ? req.body.channel : 'web') as CommandChannel;
  const store = getCommandStore();
  try {
    const approval = await store.getApproval(ctx.tenantId, req.params.id);
    if (!approval) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    if (approval.status !== 'pending') return res.status(409).json({ ok: false, error: 'ALREADY_DECIDED', status: approval.status });
    const policy = await tenantPolicy(store, ctx.tenantId);
    const check = evaluateApproval({ user_id: ctx.auth.user_id, active_role: ctx.access.role, is_exafy_admin: ctx.access.is_exafy_admin, capabilities: ctx.access.capabilities, channel, aal: ctx.aal }, approval.requester_id, approval.approve_capability as ErpCapability, policy);
    if (!check.ok) {
      await audit(store, ctx, channel, 'approval.refused', approval.command_id, approval.id, { reason: check.reason, verdict });
      return res.status(403).json({ ok: false, error: check.reason });
    }
    const command = await store.getCommand(ctx.tenantId, approval.command_id);
    if (!command) return res.status(404).json({ ok: false, error: 'COMMAND_NOT_FOUND' });
    const now = new Date().toISOString();

    if (verdict === 'rejected') {
      await store.updateApproval(approval.id, { status: 'rejected', decided_by: ctx.auth.user_id, decided_at: now, decision_note: parsed.data.note ?? null });
      const done = await store.updateCommand(command.id, { status: 'rejected', reason: 'approval_rejected' });
      await audit(store, ctx, channel, 'approval.rejected', command.id, approval.id, { note: parsed.data.note ?? null, requester_id: approval.requester_id });
      return res.json({ ok: true, command: publicCommand(done) });
    }

    await store.updateApproval(approval.id, { status: 'approved', decided_by: ctx.auth.user_id, decided_at: now, decision_note: parsed.data.note ?? null });
    const outcome = await runOnBridge(command, ctx, (command.resolved_payload ?? command.payload) as Record<string, unknown>, { id: approval.id, approver: ctx.auth.user_id, requester: approval.requester_id });
    const done = await store.updateCommand(command.id, { status: outcome.status, receipt: outcome.receipt, reason: outcome.reason, executed_at: outcome.status === 'executed' ? now : null });
    await audit(store, ctx, channel, 'approval.approved', command.id, approval.id, { note: parsed.data.note ?? null, requester_id: approval.requester_id, outcome: outcome.status, reason: outcome.reason });
    return res.status(outcome.status === 'executed' ? 200 : 502).json({ ok: outcome.status === 'executed', command: publicCommand(done) });
  } catch (err: any) {
    console.error(`[${VTID}] approval ${verdict} error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
}
router.post('/approvals/:id/approve', (req, res) => decide(req, res, 'approved'));
router.post('/approvals/:id/reject', (req, res) => decide(req, res, 'rejected'));

// Audit -----------------------------------------------------------------------------------
router.get('/audit', async (req: Request, res: Response) => {
  const ctx = await requireCtx(req, res);
  if (!ctx) return;
  if (!hasCapability(ctx.access, 'audit.view')) return res.status(403).json({ ok: false, error: 'FORBIDDEN', required: 'audit.view' });
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 500);
    const command_id = typeof req.query.command_id === 'string' ? req.query.command_id : undefined;
    const rows = await getCommandStore().listAudit(ctx.tenantId, { limit, command_id });
    return res.json({ ok: true, audit: rows });
  } catch (err: any) {
    console.error(`[${VTID}] GET /audit error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// Policy ----------------------------------------------------------------------------------
router.get('/policy', async (req: Request, res: Response) => {
  const ctx = await requireCtx(req, res);
  if (!ctx) return;
  if (!hasCapability(ctx.access, 'approvals.policy') && !hasCapability(ctx.access, 'audit.view')) return res.status(403).json({ ok: false, error: 'FORBIDDEN', required: 'approvals.policy' });
  const policy = await tenantPolicy(getCommandStore(), ctx.tenantId);
  return res.json({ ok: true, policy, defaults: DEFAULT_TENANT_POLICY });
});

router.put('/policy', async (req: Request, res: Response) => {
  const ctx = await requireCtx(req, res);
  if (!ctx) return;
  if (!hasCapability(ctx.access, 'approvals.policy')) return res.status(403).json({ ok: false, error: 'FORBIDDEN', required: 'approvals.policy' });
  const parsed = PolicyBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_BODY', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  try {
    const store = getCommandStore();
    const before = await tenantPolicy(store, ctx.tenantId);
    const row = await store.upsertPolicy({ tenant_id: ctx.tenantId, ...parsed.data, updated_by: ctx.auth.user_id });
    await audit(store, ctx, 'web', 'policy.updated', null, null, { before, after: parsed.data });
    return res.json({ ok: true, policy: { high_risk_amount_threshold: Number(row.high_risk_amount_threshold), require_mfa_for_high: !!row.require_mfa_for_high } });
  } catch (err: any) {
    console.error(`[${VTID}] PUT /policy error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// Catalog (what a client may send) ------------------------------------------------------------
router.get('/commands-catalog', async (req: Request, res: Response) => {
  const ctx = await requireCtx(req, res);
  if (!ctx) return;
  return res.json({ ok: true, commands: BACKOFFICE_COMMANDS.map((c) => ({ ...c, allowed: c.capabilities.some((cap) => ctx.access.capabilities.includes(cap as ErpCapability)) || ctx.access.is_exafy_admin })) });
});

function cryptoId(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('crypto').randomUUID();
}

export default router;
