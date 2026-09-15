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
 * VTID-03848: the pipeline itself lives in services/backoffice/command-orchestrator.ts
 * so the ORB voice tools run the identical path; this file is the HTTP adapter.
 * The bridge (VTID-03840) is the only thing that runs ERPClaw; the orchestrator is
 * the only thing that calls the bridge with a confirmation. `--user-confirmed`
 * never appears anywhere in a request body.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { verifyAuth } from '../lib/tenant-role-auth';
import { resolveAccess } from '../services/backoffice/erp-access-resolver';
import { COMMAND_TYPES, BACKOFFICE_COMMANDS } from '../constants/backoffice-commands';
import { type ErpCapability } from '../constants/erp-capabilities';
import { hasCapability, type EffectiveAccess } from '../services/backoffice/erp-access';
import { DEFAULT_TENANT_POLICY, evaluateApproval, type CommandChannel } from '../services/backoffice/command-policy';
import { getCommandStore } from '../services/backoffice/command-store';
import { submitCommand, decideApproval, publicCommand, mayViewPayload, tenantPolicy, recordPolicyUpdate, type OrchestratorCaller } from '../services/backoffice/command-orchestrator';

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
interface Ctx { auth: Auth; access: EffectiveAccess; tenantId: string; caller: OrchestratorCaller }

export function jwtAal(token: string): string | null {
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
  const caller: OrchestratorCaller = { user_id: auth.user_id, email: auth.email, is_exafy_admin: auth.is_exafy_admin, tenant_id: auth.tenant_id, active_role: auth.active_role, aal: jwtAal(auth.token) };
  return { auth, access, tenantId: auth.tenant_id, caller };
}

// POST /commands -------------------------------------------------------------------
router.post('/commands', async (req: Request, res: Response) => {
  const ctx = await requireCtx(req, res);
  if (!ctx) return;
  const parsed = CommandBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_BODY', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  try {
    const out = await submitCommand(ctx.caller, ctx.access, { ...parsed.data, channel: parsed.data.channel as CommandChannel });
    return res.status(out.http).json(out.body);
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
    const store = getCommandStore();
    const row = await store.getCommand(ctx.tenantId, req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    // VTID-03887: the approver of a queued command may read it (and its payload) even without audit.view.
    const approval = row.approval_id ? await store.getApproval(ctx.tenantId, row.approval_id) : null;
    const viewer = { user_id: ctx.auth.user_id, access: ctx.access };
    if (!mayViewPayload(row, viewer, approval)) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, command: publicCommand(row, false, true) });
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
    const store = getCommandStore();
    const rows = await store.listApprovals(ctx.tenantId, { status, limit });
    // VTID-03887: attach the queued command (with its payload) for every approval the caller may see the
    // payload of — the approver, the requester, audit.view. Others get the approval row without `command`.
    const commands = new Map((await store.getCommandsByIds(ctx.tenantId, rows.map((a) => a.command_id))).map((c) => [c.id, c] as const));
    const viewer = { user_id: ctx.auth.user_id, access: ctx.access };
    return res.json({
      ok: true,
      approvals: rows.map((a) => {
        const cmd = commands.get(a.command_id) ?? null;
        const visible = cmd ? mayViewPayload(cmd, viewer, a) : false;
        return {
          ...a,
          can_decide: evaluateApproval({ user_id: ctx.auth.user_id, active_role: ctx.access.role, is_exafy_admin: ctx.access.is_exafy_admin, capabilities: ctx.access.capabilities, channel: 'web', aal: ctx.caller.aal }, a.requester_id, a.approve_capability as ErpCapability, DEFAULT_TENANT_POLICY).ok,
          command: visible && cmd ? publicCommand(cmd, false, true) : null,
        };
      }),
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
  try {
    const out = await decideApproval(ctx.caller, ctx.access, req.params.id, verdict, parsed.data.note ?? null, channel);
    return res.status(out.http).json(out.body);
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
    await recordPolicyUpdate(ctx.caller, ctx.access, before, parsed.data);
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

export default router;
