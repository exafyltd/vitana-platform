/**
 * VTID-04499 — the connections step of partner onboarding, mounted at
 * /api/v1/partner-onboarding (docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md §6.2).
 *
 *   GET  /:orgId/connections   the org's shop/API connections, and the mapping
 *                               step reconciled from their states
 *   POST /:orgId/connections   start a connection
 *
 * A connection is the VCAOP one the merchant portal already runs
 * (routes/vcaop-portal-my.ts, VTID-03553): a `partner_tenant` plus an
 * `integration_manifest` in the same state machine
 * (authorization_required | mapping → testing → approval_required → certified
 * → active …), created by the same `insertConnection()`. What changes is the
 * key: the partner_tenant belongs to the partner organization
 * (partner_tenant.partner_organization_id, VTID-04471). Its owner_user_id is the
 * org owner, so the portal's existing per-connection endpoints (mapping
 * preview and decisions, sandbox tests, OAuth, pause/revoke) keep working for
 * the owner; the same routes are also registered org-scoped below
 * (VTID-04527), so every org_admin reaches them under /:orgId/connections/:id.
 *
 * The connector and provider default to the org's website detection
 * (business_details.platform_detection, VTID-04481) when the body names none.
 *
 * The mapping step (§6.1 "mapping confirmed") is `done` once any connection is
 * certified or live, and `in_progress` while one exists. Connection states move
 * through the portal endpoints, which know nothing about the org, so the step is
 * reconciled here on every list and create; the row is only written, and
 * `partner_org.mapping_step_changed` only emitted, when the status moves.
 * Partners with a manual catalogue and no connection confirm mapping another
 * way, which is not built yet.
 *
 * Activation (certified → active) stays the platform's one-approval gate on
 * the admin router, exactly as in the portal.
 */

import { Router, Request, Response, RequestHandler } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import { getCallerId, requireOrgAdmin } from './partner-orgs';
import { loadOrg, respondWithState, type Supa } from './partner-onboarding';
import { insertConnection, registerConnectionRoutes } from './vcaop-portal-my';
import * as vcaopRepo from '../services/vcaop-portal/vcaop-portal-repository';

const router = Router();

const CONNECTION_SELECT =
  'id,connector_id,provider_id,connection_type,risk_level,status,created_at,updated_at, partner_tenant!inner(id,name,jurisdiction,partner_organization_id)';

/** Connection states that count as "mapping confirmed" for the checklist. */
export const MAPPING_CONFIRMED_STATES: readonly string[] = ['certified', 'active', 'degraded'];

/** Lifecycle states in which an org cannot start a new connection. */
const CONNECTIONS_LOCKED_STATES = ['rejected', 'suspended'];

const TOKEN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** The mapping step status for a set of connection states; null when there are none. */
export function mappingStepStatus(states: readonly string[]): 'done' | 'in_progress' | null {
  if (states.length === 0) return null;
  return states.some((s) => MAPPING_CONFIRMED_STATES.includes(s)) ? 'done' : 'in_progress';
}

interface ConnectionRow {
  id: string;
  connector_id: string;
  provider_id: string;
  connection_type: string;
  risk_level: string;
  status: string;
  updated_at: string;
  partner_tenant?: { name?: string; jurisdiction?: string | null } | null;
}

async function listOrgConnections(s: Supa, orgId: string): Promise<{ rows: ConnectionRow[]; error: string | null }> {
  const { data, error } = await s
    .from('integration_manifest')
    .select(CONNECTION_SELECT)
    .eq('partner_tenant.partner_organization_id', orgId)
    .order('updated_at', { ascending: false });
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as unknown as ConnectionRow[], error: null };
}

function publicConnection(m: ConnectionRow) {
  return {
    id: m.id,
    name: m.partner_tenant?.name ?? null,
    connector_id: m.connector_id,
    provider_id: m.provider_id,
    connection_type: m.connection_type,
    risk_level: m.risk_level,
    state: m.status,
    jurisdiction: m.partner_tenant?.jurisdiction ?? null,
    updated_at: m.updated_at,
  };
}

/**
 * Writes the mapping step when its status moves and reports the move, so the
 * caller emits an event only on a real transition. No connections → no row.
 */
async function reconcileMappingStep(
  s: Supa,
  orgId: string,
  rows: ConnectionRow[],
  callerId: string | null,
): Promise<{ error: string | null; changed: boolean; from: string | null; to: string | null }> {
  const to = mappingStepStatus(rows.map((r) => r.status));
  if (!to) return { error: null, changed: false, from: null, to: null };

  const prior = await s
    .from('partner_onboarding_steps')
    .select('status')
    .eq('partner_organization_id', orgId)
    .eq('step_key', 'mapping')
    .maybeSingle();
  if (prior.error) return { error: prior.error.message, changed: false, from: null, to };
  const from = (prior.data as { status?: string } | null)?.status ?? null;
  if (from === to) return { error: null, changed: false, from, to };

  const now = new Date().toISOString();
  const { error } = await s.from('partner_onboarding_steps').upsert(
    {
      partner_organization_id: orgId,
      step_key: 'mapping',
      status: to,
      detail: {
        source: 'connections',
        connections: rows.map((r) => ({ id: r.id, state: r.status })),
        reconciled_at: now,
      },
      updated_by: callerId,
      updated_at: now,
    },
    { onConflict: 'partner_organization_id,step_key' },
  );
  if (error) return { error: error.message, changed: false, from, to };
  return { error: null, changed: true, from, to };
}

function mappingEvent(orgId: string, step: { from: string | null; to: string | null }, connectionCount: number, callerId: string | null) {
  return emitOasisEvent({
    vtid: 'VTID-04499',
    type: 'partner_org.mapping_step_changed',
    source: 'partner-onboarding',
    status: 'success',
    message: `Partner organization ${orgId}: mapping step ${step.from ?? 'todo'} -> ${step.to} (${connectionCount} connections).`,
    payload: { partner_organization_id: orgId, from: step.from, to: step.to, connection_count: connectionCount },
    actor_id: callerId ?? undefined,
  });
}

/**
 * Lists the org's connections and reconciles the mapping step, emitting
 * `partner_org.mapping_step_changed` only on a real move.
 */
export async function refreshMappingStep(
  s: Supa,
  orgId: string,
  callerId: string | null,
): Promise<{ error: string | null; rows: ConnectionRow[]; to: string | null }> {
  const listed = await listOrgConnections(s, orgId);
  if (listed.error) return { error: listed.error, rows: [], to: null };
  const step = await reconcileMappingStep(s, orgId, listed.rows, callerId);
  if (step.error) return { error: step.error, rows: listed.rows, to: step.to };
  if (step.changed) await mappingEvent(orgId, step, listed.rows.length, callerId);
  return { error: null, rows: listed.rows, to: step.to };
}

// ==================== List ====================

router.get('/:orgId/connections', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  // impact-allow-no-oasis: reconciles the mapping step from connection states
  // that move on the portal endpoints; mappingEvent() below emits only when
  // that step's status actually changes.
  const s = getSupabase();
  if (!s) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const callerId = getCallerId(req);
  const { org, error } = await loadOrg(s, req.params.orgId);
  if (error) return res.status(500).json({ ok: false, error });
  if (!org) return res.status(404).json({ ok: false, error: 'ORG_NOT_FOUND' });

  const refreshed = await refreshMappingStep(s, org.id, callerId);
  if (refreshed.error) return res.status(500).json({ ok: false, error: refreshed.error });

  return res.json({ ok: true, connections: refreshed.rows.map(publicConnection), mapping_step: refreshed.to });
});

// ==================== Create ====================

router.post('/:orgId/connections', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {
  const s = getSupabase();
  if (!s) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const callerId = getCallerId(req);
  const orgId = req.params.orgId;

  const { org, error } = await loadOrg(s, orgId);
  if (error) return res.status(500).json({ ok: false, error });
  if (!org) return res.status(404).json({ ok: false, error: 'ORG_NOT_FOUND' });
  if (CONNECTIONS_LOCKED_STATES.includes(org.lifecycle_state)) {
    return res.status(409).json({ ok: false, error: 'CONNECTIONS_LOCKED', lifecycle_state: org.lifecycle_state });
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

  // Default the connector from the org's website detection.
  let connectorId = body.connector_id;
  let providerId = body.provider_id;
  if (connectorId === undefined && providerId === undefined) {
    const { data: row, error: bdErr } = await s
      .from('partner_organizations')
      .select('business_details')
      .eq('id', orgId)
      .maybeSingle();
    if (bdErr) return res.status(500).json({ ok: false, error: bdErr.message });
    const det = ((row as { business_details?: Record<string, any> } | null)?.business_details ?? {}).platform_detection;
    if (det && typeof det === 'object') {
      connectorId = det.connector_id ?? undefined;
      providerId = det.provider_id ?? undefined;
    }
  }
  if (typeof connectorId !== 'string' || !TOKEN.test(connectorId) || typeof providerId !== 'string' || !TOKEN.test(providerId)) {
    return res.status(400).json({
      ok: false,
      error: 'CONNECTOR_REQUIRED',
      message: 'connector_id and provider_id are required (or run POST /detect on a recognised storefront first)',
    });
  }
  for (const key of ['connection_type', 'risk_level'] as const) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || !TOKEN.test(body[key] as string))) {
      return res.status(400).json({ ok: false, error: `${key} must be a short lowercase token` });
    }
  }
  const openapi = body.openapi_document;
  if (openapi !== undefined && (openapi === null || typeof openapi !== 'object' || Array.isArray(openapi))) {
    return res.status(400).json({ ok: false, error: 'openapi_document must be a JSON object' });
  }

  const now = new Date().toISOString();

  // One partner_tenant per org.
  const found = await s
    .from('partner_tenant')
    .select('id')
    .eq('partner_organization_id', orgId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (found.error) return res.status(500).json({ ok: false, error: found.error.message });
  let partnerTenantId = (found.data as { id: string } | null)?.id ?? null;
  if (!partnerTenantId) {
    partnerTenantId = randomUUID();
    const identity = (req as AuthenticatedRequest).identity;
    const { error: ptErr } = await s.from('partner_tenant').insert({
      id: partnerTenantId,
      tenant_id: identity?.tenant_id || 'platform',
      name: org.display_name,
      status: 'discovered',
      jurisdiction: org.country,
      partner_organization_id: orgId,
      // The org owner, so the portal's per-connection endpoints serve them.
      owner_user_id: org.owner_user_id,
      owner_email: callerId === org.owner_user_id ? identity?.email ?? null : null,
      created_at: now,
      updated_at: now,
    });
    if (ptErr) return res.status(500).json({ ok: false, error: ptErr.message });
  }

  const created = await insertConnection(s, {
    partnerTenantId,
    connector_id: connectorId,
    provider_id: providerId,
    connection_type: body.connection_type as string | undefined,
    risk_level: body.risk_level as string | undefined,
    openapi_document: openapi,
    now,
  });
  if (!created.ok) return res.status(created.status).json({ ok: false, error: created.error });

  await emitOasisEvent({
    vtid: 'VTID-04499',
    type: 'partner_org.connection_started',
    source: 'partner-onboarding',
    status: 'success',
    message: `Partner organization ${orgId}: connection ${created.manifestId} started (${connectorId}, ${created.initialState}).`,
    payload: {
      partner_organization_id: orgId,
      connection_id: created.manifestId,
      connector_id: connectorId,
      provider_id: providerId,
      state: created.initialState,
    },
    actor_id: callerId ?? undefined,
  });

  const refreshed = await refreshMappingStep(s, orgId, callerId);
  if (refreshed.error) return res.status(500).json({ ok: false, error: refreshed.error });

  return respondWithState(res, s, orgId, 201, {
    connection: { id: created.manifestId, connector_id: connectorId, provider_id: providerId, state: created.initialState },
  });
});

// ==================== Per connection (VTID-04527) ====================

/**
 * The portal's per-connection routes (detail, mapping preview and decisions,
 * sandbox tests, activation summary, Shopify/SMART-on-FHIR authorize, pause,
 * resume, reauthorize, revoke), registered with an org scope: any org_admin of
 * the org reaches any of the org's connections; another org's connection id is
 * a 404, exactly like a foreign id on the portal. Mapping decisions record the
 * calling admin as `decided_by`. Every state change reconciles the mapping
 * step. Activation stays on the admin router.
 */
const perConnection = Router({ mergeParams: true });
registerConnectionRoutes(perConnection, {
  guards: [requireAuth as RequestHandler, requireOrgAdmin()],
  fetchManifest: (supabase, req) => vcaopRepo.fetchOrgManifest(supabase, req.params.id, req.params.orgId),
  surface: 'partner_onboarding',
  onStateChange: async (supabase, req) => {
    // The connection already moved; a failed reconciliation must not turn
    // that into an error response. The next list or state change retries it.
    try {
      const r = await refreshMappingStep(supabase, req.params.orgId, getCallerId(req));
      if (r.error) console.warn(`[partner-onboarding] mapping step reconcile failed for ${req.params.orgId}: ${r.error}`);
    } catch (err) {
      console.warn(`[partner-onboarding] mapping step reconcile threw for ${req.params.orgId}:`, err);
    }
  },
});
router.use('/:orgId', perConnection);

export default router;
