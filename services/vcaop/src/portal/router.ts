/**
 * Partner Portal REST API (Phase 3) — mounts under /api/v1/vcaop/portal.
 * Same two-layer protection as the core VCAOP API: this router's role
 * middleware + Supabase RLS beneath (IAM-ROLES-0001). Connection management
 * is staff/admin; the one-activation approval and revoke are ADMIN-only
 * (mirrors "human-task approvals are admin-only"). Community is denied.
 */
import { Router, Request, Response } from 'express';
import { AuthResolver, requireRole, withAuth } from '../api/authz';
import { PartnerOnboardingService } from './onboarding-service';
import { presentActivationSummary, presentConnectionList, presentMappingPreview } from './views';

export interface PortalRouterDeps {
  service: PartnerOnboardingService;
  authResolver: AuthResolver;
}

const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ ok: false, error });

export function buildPortalRouter(deps: PortalRouterDeps): Router {
  const router = Router();
  router.use(withAuth(deps.authResolver));

  // List this tenant's connections (staff/admin back office).
  router.get('/connections', requireRole('staff', 'admin'), async (req: Request, res: Response) => {
    const records = await deps.service.listConnections(req.vcaop!.tenantId);
    res.json({ ok: true, data: presentConnectionList(records) });
  });

  // Step 1-2: connect a business system (OpenAPI document in the body for now).
  router.post('/connections', requireRole('staff', 'admin'), async (req: Request, res: Response) => {
    try {
      const { name, connector_id, provider_id, openapi_document, jurisdiction } = req.body ?? {};
      if (!name || !connector_id || !provider_id) {
        return fail(res, 400, 'name, connector_id and provider_id are required');
      }
      const rec = await deps.service.startConnection({
        tenantId: req.vcaop!.tenantId,
        name,
        connectorId: connector_id,
        providerId: provider_id,
        openApiDocument: openapi_document,
        jurisdiction,
      });
      res.status(201).json({ ok: true, data: presentConnectionList([rec])[0] });
    } catch (err) {
      fail(res, 400, err instanceof Error ? err.message : 'start failed');
    }
  });

  router.get('/connections/:id/mapping-preview', requireRole('staff', 'admin'), async (req, res) => {
    const rec = await getOwned(deps, req);
    if (!rec) return fail(res, 404, 'connection not found');
    res.json({ ok: true, data: presentMappingPreview(rec) });
  });

  router.post('/connections/:id/mapping-decisions', requireRole('staff', 'admin'), async (req, res) => {
    try {
      const rec = await getOwned(deps, req);
      if (!rec) return fail(res, 404, 'connection not found');
      const { source_schema, source_field, decision } = req.body ?? {};
      if (!source_schema || !source_field || !['approve', 'reject'].includes(decision)) {
        return fail(res, 400, 'source_schema, source_field and decision (approve|reject) required');
      }
      const updated = await deps.service.submitMappingDecision(rec.id, {
        source_schema,
        source_field,
        decision,
        decided_by: req.vcaop!.userId, // always the authenticated human — never client-supplied
      });
      res.json({ ok: true, data: presentMappingPreview(updated) });
    } catch (err) {
      fail(res, 400, err instanceof Error ? err.message : 'decision failed');
    }
  });

  router.post('/connections/:id/sandbox-tests', requireRole('staff', 'admin'), async (req, res) => {
    try {
      const rec = await getOwned(deps, req);
      if (!rec) return fail(res, 404, 'connection not found');
      const updated = await deps.service.runSandboxTests(rec.id);
      res.json({ ok: true, data: presentActivationSummary(updated) });
    } catch (err) {
      fail(res, 400, err instanceof Error ? err.message : 'sandbox tests failed');
    }
  });

  router.get('/connections/:id/activation-summary', requireRole('staff', 'admin'), async (req, res) => {
    const rec = await getOwned(deps, req);
    if (!rec) return fail(res, 404, 'connection not found');
    res.json({ ok: true, data: presentActivationSummary(rec) });
  });

  // THE one-approval activation — admin only.
  router.post('/connections/:id/approve-activation', requireRole('admin'), async (req, res) => {
    try {
      const rec = await getOwned(deps, req);
      if (!rec) return fail(res, 404, 'connection not found');
      const updated = await deps.service.approveActivation(rec.id, req.vcaop!.userId);
      res.json({ ok: true, data: presentActivationSummary(updated) });
    } catch (err) {
      fail(res, 409, err instanceof Error ? err.message : 'activation refused');
    }
  });

  router.post('/connections/:id/pause', requireRole('staff', 'admin'), action(deps, 'pause'));
  router.post('/connections/:id/resume', requireRole('staff', 'admin'), action(deps, 'resume'));
  router.post('/connections/:id/reauthorize', requireRole('staff', 'admin'), action(deps, 'reauthorize'));
  // Revoke is irreversible for the connection — admin only.
  router.post('/connections/:id/revoke', requireRole('admin'), action(deps, 'revoke'));

  return router;
}

function action(deps: PortalRouterDeps, kind: 'pause' | 'resume' | 'revoke' | 'reauthorize') {
  return async (req: Request, res: Response) => {
    try {
      const rec = await getOwned(deps, req);
      if (!rec) return fail(res, 404, 'connection not found');
      const updated = await deps.service[kind](rec.id, req.vcaop!.userId);
      res.json({ ok: true, data: { id: updated.id, state: updated.state } });
    } catch (err) {
      fail(res, 409, err instanceof Error ? err.message : `${kind} failed`);
    }
  };
}

/** Tenant-ownership check: a connection outside the caller's tenant reads as nonexistent. */
async function getOwned(deps: PortalRouterDeps, req: Request) {
  return deps.service.getConnection(req.vcaop!.tenantId, req.params.id);
}
