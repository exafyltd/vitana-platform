/**
 * VCAOP REST API router (CTRL-API-0004, runbook Sec. 6).
 *
 * Resource groups: /providers /accounts /jobs /tasks /affiliate-programs /rewards
 * /cart /policies /approvals /audit. Cross-cutting guarantees:
 *  - every endpoint is behind authz (role + ownership), Sec. 5
 *  - every mutating write emits a sanitized OASIS event, Sec. 4.7
 *  - secret/credential references are never serialized back to any role
 *  - account creation honors the single-identity guardrail (Sec. 0.3 #5/6)
 *  - human-gated approvals are admin-only (Sec. 5)
 *
 * The router is framework-only and storage-agnostic (Repository + OasisSink), so
 * it mounts into the existing Gateway Express app with a Prisma-backed repo later.
 */
import express, { Router, Request, Response } from 'express';
import { Repository, Record_, newId } from './repository';
import { OasisSink } from './oasis-sink';
import { AuthResolver, headerAuthResolver, withAuth, requireRole } from './authz';
import { PolicyEngine } from '../guardrails/policy-engine';
import { assertSingleActiveAccount, isActiveStatus, ExistingAccount } from '../guardrails/single-identity';
import { HUMAN_REQUIRED_ACTIONS } from '../guardrails/human-gate';
import { SingleIdentityViolation } from '../guardrails/errors';

export interface VcaopApiDeps {
  repo: Repository;
  oasis: OasisSink;
  policyEngine: PolicyEngine;
  authResolver?: AuthResolver;
  source?: string; // OASIS event source/service name
}

/** Strip internal references / secret-ish keys from any record before returning it. */
function serialize(rec: Record_ | null): Record_ | null {
  if (!rec) return rec;
  const out: Record_ = { id: rec.id };
  for (const [k, v] of Object.entries(rec)) {
    const key = k.toLowerCase();
    if (key.endsWith('_ref')) continue; // vault pointer — never expose
    if (/password|secret|credential|token|apikey|api_key|totp|mfa_seed|recovery/.test(key)) continue;
    out[k] = v;
  }
  return out;
}
const serializeMany = (recs: Record_[]) => recs.map((r) => serialize(r)!);

function ok<T>(res: Response, data: T, status = 200) {
  res.status(status).json({ ok: true, data });
}
function err(res: Response, status: number, error: string, code?: string) {
  res.status(status).json({ ok: false, error, code });
}

export function buildVcaopRouter(deps: VcaopApiDeps): Router {
  const { repo, oasis, policyEngine } = deps;
  const source = deps.source ?? 'vcaop-api';
  const resolver = deps.authResolver ?? headerAuthResolver;
  const router = express.Router();

  router.use(express.json());
  router.use(withAuth(resolver));

  const emit = (type: string, status: 'info' | 'success' | 'warning' | 'error', message: string, payload: Record<string, unknown>) =>
    oasis.emit({ type, source, status, message, payload });

  // ---- /providers (read: staff/admin/developer) -------------------------------
  router.get('/providers', requireRole('staff', 'admin', 'developer'), async (_req, res) => {
    ok(res, serializeMany(await repo.list('provider')));
  });

  // ---- /policies (admin only) — set per-provider policy (Sec. 4.3, Sec. 5) ----
  router.put('/policies/:providerId', requireRole('admin'), async (req: Request, res: Response) => {
    const providerId = String(req.params.providerId);
    const policy = req.body?.policy;
    if (!policy || typeof policy !== 'object') return err(res, 400, 'policy object required', 'BAD_REQUEST');
    const existing = await repo.get('provider', providerId);
    const saved = existing
      ? await repo.update('provider', providerId, { policy })
      : await repo.create('provider', { id: providerId, name: providerId, category: 'unknown', policy });
    policyEngine.setPolicy(providerId, policy);
    await emit('vcaop.policy.updated', 'success', `policy set for ${providerId}`, { providerId });
    ok(res, serialize(saved));
  });

  // ---- /accounts (staff) — single canonical identity per (tenant, provider) ---
  router.get('/accounts', requireRole('staff', 'admin'), async (req, res) => {
    const tenantId = req.vcaop!.tenantId;
    const rows = await repo.list('provider_account', (r) => r.tenant_id === tenantId || req.vcaop!.role === 'admin');
    ok(res, serializeMany(rows));
  });

  router.post('/accounts', requireRole('staff'), async (req, res) => {
    const tenantId = req.vcaop!.tenantId;
    const providerId = req.body?.provider_id;
    if (!providerId) return err(res, 400, 'provider_id required', 'BAD_REQUEST');
    const provider = await repo.get('provider', providerId);
    if (!provider) return err(res, 404, `unknown provider ${providerId}`, 'PROVIDER_NOT_FOUND');
    const policy = (provider.policy ?? {}) as { multi_account_allowed?: boolean };

    const existing = (await repo.list('provider_account', (r) => r.provider_id === providerId)).map(
      (r): ExistingAccount => ({ tenant_id: String(r.tenant_id), provider_id: String(r.provider_id), status: String(r.status) }),
    );
    try {
      assertSingleActiveAccount(tenantId, providerId, existing, policy.multi_account_allowed === true);
    } catch (e) {
      if (e instanceof SingleIdentityViolation) return err(res, 409, e.message, e.code);
      throw e;
    }

    const account = await repo.create('provider_account', {
      id: newId('provider_account'),
      tenant_id: tenantId,
      provider_id: providerId,
      status: 'discovered',
    });
    await emit('vcaop.provider_account.created', 'success', `account created for ${providerId}`, {
      accountId: account.id,
      providerId,
    });
    ok(res, serialize(account), 201);
  });

  // ---- /jobs (staff) ----------------------------------------------------------
  router.get('/jobs', requireRole('staff', 'admin'), async (_req, res) => ok(res, serializeMany(await repo.list('provisioning_job'))));
  router.post('/jobs', requireRole('staff'), async (req, res) => {
    const tenantId = req.vcaop!.tenantId;
    const providerAccountId = req.body?.provider_account_id;
    if (!providerAccountId) return err(res, 400, 'provider_account_id required', 'BAD_REQUEST');
    const job = await repo.create('provisioning_job', {
      id: newId('provisioning_job'),
      tenant_id: tenantId,
      provider_account_id: providerAccountId,
      status: 'queued',
    });
    await emit('vcaop.job.created', 'success', 'provisioning job queued', { jobId: job.id });
    ok(res, serialize(job), 201);
  });

  // ---- /tasks (human_task) — staff create/list, admin sees all ----------------
  router.get('/tasks', requireRole('staff', 'admin'), async (req, res) => {
    const tenantId = req.vcaop!.tenantId;
    const rows = await repo.list('human_task', (r) => req.vcaop!.role === 'admin' || r.tenant_id === tenantId);
    ok(res, serializeMany(rows));
  });
  router.post('/tasks', requireRole('staff'), async (req, res) => {
    const type = req.body?.type;
    if (!HUMAN_REQUIRED_ACTIONS.includes(type)) {
      return err(res, 400, `type must be one of ${HUMAN_REQUIRED_ACTIONS.join('|')}`, 'BAD_REQUEST');
    }
    const task = await repo.create('human_task', {
      id: newId('human_task'),
      tenant_id: req.vcaop!.tenantId,
      type,
      status: 'open',
      assignee: req.body?.assignee ?? null,
    });
    await emit('vcaop.human_task.created', 'info', `human task ${type} opened`, { taskId: task.id, type });
    ok(res, serialize(task), 201);
  });

  // ---- /approvals (admin) — approve a human task / Tier-B (Sec. 5) ------------
  router.post('/approvals/:taskId', requireRole('admin'), async (req, res) => {
    const task = await repo.get('human_task', String(req.params.taskId));
    if (!task) return err(res, 404, 'task not found', 'TASK_NOT_FOUND');
    const decision = req.body?.decision === 'reject' ? 'rejected' : 'approved';
    const updated = await repo.update('human_task', task.id, { status: decision });
    await emit('vcaop.human_task.decided', 'success', `task ${task.id} ${decision}`, { taskId: task.id, decision });
    ok(res, serialize(updated));
  });

  // ---- /affiliate-programs — staff read, admin edit ---------------------------
  router.get('/affiliate-programs', requireRole('staff', 'admin'), async (_req, res) => ok(res, serializeMany(await repo.list('affiliate_program'))));
  router.put('/affiliate-programs/:id', requireRole('admin'), async (req, res) => {
    const id = String(req.params.id);
    const body = req.body ?? {};
    const existing = await repo.get('affiliate_program', id);
    const saved = existing ? await repo.update('affiliate_program', id, body) : await repo.create('affiliate_program', { id, ...body });
    await emit('vcaop.affiliate_program.updated', 'success', `affiliate program ${id} updated`, { id });
    ok(res, serialize(saved));
  });

  // ---- /rewards — community sees OWN only; staff/admin see all (RLS, Sec. 5) --
  router.get('/rewards', requireRole('community', 'staff', 'admin'), async (req, res) => {
    const { role, userId } = req.vcaop!;
    const rows = await repo.list('rewards_ledger', (r) => role === 'community' ? r.user_id === userId : true);
    ok(res, serializeMany(rows));
  });

  // ---- /cart — community own ---------------------------------------------------
  router.get('/cart', requireRole('community', 'staff', 'admin'), async (req, res) => {
    const { role, userId } = req.vcaop!;
    const rows = await repo.list('cart_order', (r) => role === 'community' ? r.user_id === userId : true);
    ok(res, serializeMany(rows));
  });
  router.post('/cart', requireRole('community'), async (req, res) => {
    const cart = await repo.create('cart_order', {
      id: newId('cart_order'),
      user_id: req.vcaop!.userId,
      status: 'open',
    });
    await emit('vcaop.cart.created', 'info', 'cart opened', { cartId: cart.id });
    ok(res, serialize(cart), 201);
  });

  // ---- /audit (staff/admin) — OASIS events ------------------------------------
  router.get('/audit', requireRole('staff', 'admin'), async (_req, res) => {
    // Audit reads from the read-model projection; here we surface persisted audit rows.
    ok(res, serializeMany(await repo.list('audit_event')));
  });

  return router;
}

export { isActiveStatus };
