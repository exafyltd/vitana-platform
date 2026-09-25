/**
 * VCAOP Merchant Self-Service Portal — `/my` surface (VTID-03553).
 *
 * The user side of the Partner Portal (CLAUDE.md §13c: self-service merchant
 * onboarding — a business owner connects their own storefront to Discover
 * without an engineer hand-writing a migration). Same tables, same mirrored
 * state machine, same factory plane as the admin router (vcaop-portal.ts) —
 * the ONLY differences are scoping and authority:
 *
 *  - Auth: any authenticated user (requireAuth), NOT exafy_admin. Every
 *    query is scoped to partner_tenant.owner_user_id = the caller, so a
 *    merchant sees exactly the businesses they created and nothing else;
 *    foreign rows read as 404, indistinguishable from nonexistent.
 *  - Creation stamps ownership (owner_user_id from the JWT, owner_email from
 *    the JWT email claim — never from the request body).
 *  - THE one-approval activation is deliberately ABSENT here. Certification
 *    approval stays back-office (admin router's /approve-activation); a
 *    merchant can take a connection all the way to `certified` and then
 *    waits for platform approval. Mapping decisions for the merchant's OWN
 *    schema are theirs to make (decided_by = the authenticated caller).
 *  - The per-connection routes live in registerConnectionRoutes() with a
 *    ConnectionScope (VTID-04527): this router registers them with the owner
 *    scope; the partner onboarding engine registers the same routes with an
 *    org-admin scope under /api/v1/partner-onboarding/:orgId.
 *
 * Served to the commerce.vitanaland.com frontend (host-routed community-app
 * build); DNS/exposure for that host is deferred the BLK-006 way.
 *
 * Data access for the mesh factory tables goes through
 * services/vcaop-portal/vcaop-portal-repository.ts (VTID-03702, Aurora
 * migration B1 data-access seam), shared with routes/vcaop-portal.ts — see
 * that repository's header for why one seam serves both routers.
 */
import { Router, Request, Response, RequestHandler } from 'express';
import { createHash, randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth-supabase-jwt';
import {
  ConnectionState,
  canTransition,
  extractSchemaSources,
  pendingReviewMappings,
} from './vcaop-portal';
import * as repo from '../services/vcaop-portal/vcaop-portal-repository';
import { detectPlatform } from '../services/platform-detect';
import { isShopifyOAuthConfigured, isValidShopDomain, signState, buildAuthorizeUrl } from '../services/shopify-oauth';
import {
  isFhirOAuthConfigured,
  isValidFhirBaseUrl,
  discoverSmartConfiguration,
  generateCodeVerifier,
  generateCodeChallenge,
  signState as signFhirState,
  buildAuthorizeUrl as buildFhirAuthorizeUrl,
} from '../services/smart-fhir-oauth';

const DEFAULT_FHIR_SCOPE = 'openid fhirUser patient/*.read';

const router = Router();
router.use(requireAuth as any);

function db(res: Response) {
  const s = getSupabase();
  if (!s) {
    res.status(503).json({ ok: false, error: 'database unavailable' });
    return null;
  }
  return s;
}
function userId(req: Request): string {
  return String((req as any).identity?.user_id || '');
}
function userEmail(req: Request): string | null {
  const e = (req as any).identity?.email;
  return typeof e === 'string' && e.length > 0 ? e : null;
}
function tenantId(req: Request): string {
  return String((req as any).identity?.tenant_id || 'platform');
}
async function emitOasisEvent(supabase: any, type: string, status: string, message: string, payload: Record<string, unknown>) {
  try {
    await repo.insertOasisEvent(supabase, {
      id: randomUUID(), service: 'vcaop', source: 'vcaop-portal-my', type, topic: type, status, message,
      metadata: payload, created_at: new Date().toISOString(),
    });
  } catch { /* never block the request on the audit write */ }
}

async function latestVersion(supabase: any, manifestId: string) {
  return repo.fetchLatestVersion(supabase, manifestId);
}

async function transitionAndEmitOasisEvent(scope: ConnectionScope, supabase: any, req: Request, res: Response, to: ConnectionState, eventType: string) {
  // Only a manifest the scope allows (the portal: the caller's own; anything
  // else — other merchants' rows, admin-seeded rows with no owner — is a 404).
  const rec = await scope.fetchManifest(supabase, req);
  if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
  if (!canTransition(rec.status, to)) {
    return res.status(409).json({ ok: false, error: `illegal transition ${rec.status} -> ${to}` });
  }
  const now = new Date().toISOString();
  await repo.updateManifestStatus(supabase, rec.id, to, now);
  await emitOasisEvent(supabase, eventType, 'success', `connection ${rec.id}: ${rec.status} -> ${to}`, {
    connection_id: rec.id, from: rec.status, to, actor: userId(req), surface: scope.surface,
  });
  await scope.onStateChange?.(supabase, req);
  return res.json({ ok: true, data: { id: rec.id, state: to } });
}

// Storefront platform sniff (VTID-03601, Track 4): merchant pastes a URL,
// we fetch it server-side (SSRF-guarded, see services/platform-detect.ts)
// and suggest connector_id/provider_id instead of requiring manual entry.
// Read-only — never touches partner_tenant/integration_manifest.
router.post('/connections/detect-platform', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: read-only lookup, no state transition to record.
  const { url } = req.body ?? {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'url is required' });
  }
  const result = await detectPlatform(url);
  if (!result.ok) return res.status(422).json(result);
  res.json(result);
});

/**
 * Creates the integration manifest for a partner_tenant and, when an OpenAPI
 * document is supplied, its first version and schema sources. Shared with the
 * partner onboarding engine (VTID-04499), so an org-scoped connection enters
 * exactly the same state machine as a merchant's own.
 */
export async function insertConnection(
  supabase: any,
  input: {
    partnerTenantId: string;
    connector_id: string;
    provider_id: string;
    connection_type?: string;
    risk_level?: string;
    openapi_document?: unknown;
    now: string;
  },
): Promise<{ ok: true; manifestId: string; initialState: ConnectionState } | { ok: false; status: number; error: string }> {
  const { partnerTenantId, connector_id, provider_id, connection_type, risk_level, openapi_document, now } = input;
  const initialState: ConnectionState = openapi_document ? 'mapping' : 'authorization_required';
  const manifestId = randomUUID();
  const { error: mErr } = await repo.insertIntegrationManifest(supabase, {
    id: manifestId, partner_tenant_id: partnerTenantId, connector_id, provider_id,
    connection_type: connection_type ?? 'api', risk_level: risk_level ?? 'medium',
    status: initialState, created_at: now, updated_at: now,
  });
  if (mErr) {
    const dup = /duplicate|unique/i.test(mErr.message);
    return { ok: false, status: dup ? 409 : 500, error: dup ? 'connection already exists for this business + connector' : mErr.message };
  }

  if (openapi_document) {
    const versionId = randomUUID();
    const docJson = JSON.stringify(openapi_document);
    await repo.insertIntegrationVersion(supabase, {
      id: versionId, manifest_id: manifestId, version: '0.1.0', document: openapi_document,
      document_hash: createHash('sha256').update(docJson).digest('hex'), certification_status: 'draft', created_at: now,
    });
    const sources = extractSchemaSources(openapi_document as any);
    for (const s of sources) {
      await repo.insertSchemaSource(supabase, {
        id: randomUUID(), version_id: versionId, name: s.name, fields: s.fields,
        hash: createHash('sha256').update(JSON.stringify(s.fields)).digest('hex'), created_at: now,
      });
    }
  }
  return { ok: true, manifestId, initialState };
}

// ===== List / create =====
router.get('/connections', async (req: Request, res: Response) => {
  const supabase = db(res); if (!supabase) return;
  const { data, error } = await repo.fetchConnectionsForOwner(supabase, userId(req));
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({
    ok: true,
    data: (data || []).map((m: any) => ({
      id: m.id, name: m.partner_tenant?.name, connector_id: m.connector_id, provider_id: m.provider_id,
      connection_type: m.connection_type, risk_level: m.risk_level, state: m.status,
      jurisdiction: m.partner_tenant?.jurisdiction, updated_at: m.updated_at,
    })),
  });
});

router.post('/connections', async (req: Request, res: Response) => {
  const supabase = db(res); if (!supabase) return;
  const { name, connector_id, provider_id, connection_type, risk_level, jurisdiction, openapi_document } = req.body ?? {};
  if (!name || !connector_id || !provider_id) {
    return res.status(400).json({ ok: false, error: 'name, connector_id and provider_id are required' });
  }
  const owner = userId(req);
  const now = new Date().toISOString();

  // One partner_tenant row per (owner, business name) — a merchant's own
  // business, distinct from any admin-seeded partner with the same name.
  // A lookup error must not fall through as "doesn't exist yet" — that
  // would create a duplicate partner_tenant row for the same owner+name.
  const { data: existingPartner, error: existingPartnerErr } = await repo.fetchPartnerTenantByOwnerAndName(supabase, owner, name);
  if (existingPartnerErr) return res.status(500).json({ ok: false, error: existingPartnerErr.message });
  let partnerId = existingPartner?.id;
  if (!partnerId) {
    partnerId = randomUUID();
    const { error } = await repo.insertPartnerTenant(supabase, {
      id: partnerId, tenant_id: tenantId(req), name, status: 'discovered', jurisdiction: jurisdiction ?? null,
      owner_user_id: owner, owner_email: userEmail(req),
      created_at: now, updated_at: now,
    });
    if (error) return res.status(500).json({ ok: false, error: error.message });
  }

  const created = await insertConnection(supabase, {
    partnerTenantId: partnerId, connector_id, provider_id, connection_type, risk_level, openapi_document, now,
  });
  if (!created.ok) return res.status(created.status).json({ ok: false, error: created.error });
  const { manifestId, initialState } = created;

  await emitOasisEvent(supabase, 'vcaop.portal.connection.started', 'success', `connection ${manifestId} started (${initialState})`, {
    connection_id: manifestId, connector_id, provider_id, state: initialState, actor: owner, surface: 'merchant_self_service',
  });
  res.status(201).json({ ok: true, data: { id: manifestId, name, state: initialState } });
});

/**
 * Who may reach a connection, and how the per-connection routes report it.
 * The portal's own scope is the owner (partner_tenant.owner_user_id); the
 * partner onboarding engine registers the same routes with an org-admin
 * scope (VTID-04527), so both surfaces run one implementation.
 */
export interface ConnectionScope {
  /** Middleware run before each per-connection route (e.g. an org-admin check). */
  guards: RequestHandler[];
  /** The manifest for req.params.id if the caller may reach it, else null (→ 404). */
  fetchManifest(supabase: any, req: Request): Promise<any>;
  /** Recorded on every OASIS event as `surface`. */
  surface: string;
  /** Called after a route moved the connection's state. */
  onStateChange?(supabase: any, req: Request): Promise<void>;
}

/** Registers the per-connection routes (/connections/:id/...) on a router. */
export function registerConnectionRoutes(r: Router, scope: ConnectionScope): void {
  // Shopify OAuth (VTID-03603, Track 2): starts the authorization-code-grant
  // flow for a connection already created with connector_id='shopify'.
  // Dormant until SHOPIFY_CLIENT_ID/SECRET/OAUTH_REDIRECT_URI are configured.
  r.post('/connections/:id/shopify/authorize', ...scope.guards, async (req: Request, res: Response) => {
    // impact-allow-no-oasis: builds and returns a URL only — no DB write, no
    // state transition. The real mutation happens in the callback, which
    // already emits vcaop.portal.connection.shopify_authorized.
    const supabase = db(res); if (!supabase) return;
    const rec = await scope.fetchManifest(supabase, req);
    if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
    if (rec.connector_id !== 'shopify') {
      return res.status(400).json({ ok: false, error: 'connection is not a shopify connector' });
    }
    const redirectUri = process.env.SHOPIFY_OAUTH_REDIRECT_URI;
    if (!isShopifyOAuthConfigured() || !redirectUri) {
      return res.status(503).json({ ok: false, error: 'not_configured' });
    }
    const { shop } = req.body ?? {};
    if (!isValidShopDomain(shop)) {
      return res.status(400).json({ ok: false, error: 'shop must be a valid *.myshopify.com domain' });
    }
    const state = signState(rec.id);
    const authorizeUrl = buildAuthorizeUrl(shop, state, redirectUri);
    if (!authorizeUrl) return res.status(503).json({ ok: false, error: 'not_configured' });
    res.json({ ok: true, data: { authorize_url: authorizeUrl } });
  });

  // SMART on FHIR OAuth (VTID-03605, Track 3): starts the SMART App Launch
  // (standalone) flow for a connection already created with
  // connector_id='smart_fhir'. Unlike Shopify, the merchant supplies their own
  // EHR-issued client_id/client_secret per connection — there's no global app
  // credential to fall back on, so those come from the request body, never
  // from env. Dormant until FHIR_OAUTH_STATE_SECRET/FHIR_OAUTH_REDIRECT_URI
  // are configured.
  r.post('/connections/:id/fhir/authorize', ...scope.guards, async (req: Request, res: Response) => {
    // impact-allow-no-oasis: discovers the EHR's endpoints and returns an
    // authorize URL only — no DB write, no state transition. The real
    // mutation happens in the callback, which emits its own OASIS event.
    const supabase = db(res); if (!supabase) return;
    const rec = await scope.fetchManifest(supabase, req);
    if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
    if (rec.connector_id !== 'smart_fhir') {
      return res.status(400).json({ ok: false, error: 'connection is not a smart_fhir connector' });
    }
    const redirectUri = process.env.FHIR_OAUTH_REDIRECT_URI;
    if (!isFhirOAuthConfigured() || !redirectUri) {
      return res.status(503).json({ ok: false, error: 'not_configured' });
    }
    // `scope: oauthScope` — the handler's `scope` is the ConnectionScope parameter.
    const { fhir_base_url, client_id, client_secret, scope: oauthScope } = req.body ?? {};
    if (!isValidFhirBaseUrl(fhir_base_url)) {
      return res.status(400).json({ ok: false, error: 'fhir_base_url must be a valid https URL' });
    }
    if (typeof client_id !== 'string' || client_id.length === 0) {
      return res.status(400).json({ ok: false, error: 'client_id is required' });
    }
    if (client_secret !== undefined && typeof client_secret !== 'string') {
      return res.status(400).json({ ok: false, error: 'client_secret must be a string when provided' });
    }
    if (oauthScope !== undefined && typeof oauthScope !== 'string') {
      return res.status(400).json({ ok: false, error: 'scope must be a string when provided' });
    }

    const discovery = await discoverSmartConfiguration(fhir_base_url);
    if (!discovery.ok || !discovery.config) {
      return res.status(502).json({ ok: false, error: discovery.error ?? 'discovery_failed' });
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = signFhirState({
      manifestId: rec.id,
      fhirBaseUrl: fhir_base_url,
      clientId: client_id,
      clientSecret: client_secret || undefined,
      codeVerifier,
      tokenEndpoint: discovery.config.token_endpoint,
    });
    const authorizeUrl = buildFhirAuthorizeUrl({
      authorizationEndpoint: discovery.config.authorization_endpoint,
      fhirBaseUrl: fhir_base_url,
      clientId: client_id,
      redirectUri,
      scope: oauthScope || DEFAULT_FHIR_SCOPE,
      state,
      codeChallenge,
    });
    if (!authorizeUrl) return res.status(502).json({ ok: false, error: 'invalid_authorization_endpoint' });
    res.json({ ok: true, data: { authorize_url: authorizeUrl } });
  });

  // ===== Detail / mapping preview / decisions =====
  r.get('/connections/:id', ...scope.guards, async (req: Request, res: Response) => {
    const supabase = db(res); if (!supabase) return;
    const rec = await scope.fetchManifest(supabase, req);
    if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
    const version = await latestVersion(supabase, rec.id);
    res.json({
      ok: true,
      data: {
        id: rec.id, name: rec.partner_tenant?.name, connector_id: rec.connector_id, provider_id: rec.provider_id,
        connection_type: rec.connection_type, risk_level: rec.risk_level, state: rec.status,
        jurisdiction: rec.partner_tenant?.jurisdiction, latest_version: version, updated_at: rec.updated_at,
      },
    });
  });

  r.get('/connections/:id/mapping-preview', ...scope.guards, async (req: Request, res: Response) => {
    const supabase = db(res); if (!supabase) return;
    const rec = await scope.fetchManifest(supabase, req);
    if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
    const version = await latestVersion(supabase, rec.id);
    if (!version) {
      return res.json({ ok: true, data: { state: rec.status, pipeline_status: 'awaiting_specification', sources: [], mappings: [], pending_review: [] } });
    }
    const [{ data: sources }, { data: mappings }] = await Promise.all([
      repo.fetchSchemaSourcesForVersion(supabase, version.id),
      repo.fetchSchemaMappingsForVersion(supabase, version.id),
    ]);
    const pending = pendingReviewMappings(mappings || []);
    res.json({
      ok: true,
      data: {
        state: rec.status,
        pipeline_status: (mappings || []).length === 0 ? 'awaiting_factory_run' : 'mapped',
        version: version.version,
        sources: sources || [],
        mappings: mappings || [],
        pending_review: pending,
      },
    });
  });

  // A merchant decides mappings for their OWN business's schema.
  r.post('/connections/:id/mapping-decisions', ...scope.guards, async (req: Request, res: Response) => {
    const supabase = db(res); if (!supabase) return;
    const rec = await scope.fetchManifest(supabase, req);
    if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
    const { mapping_id, decision, reason } = req.body ?? {};
    if (!mapping_id || !['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ ok: false, error: 'mapping_id and decision (approve|reject) required' });
    }
    const version = await latestVersion(supabase, rec.id);
    if (!version) return res.status(409).json({ ok: false, error: 'no integration version to decide on' });
    const mapping = await repo.fetchMappingForDecision(supabase, mapping_id, version.id);
    if (!mapping) return res.status(404).json({ ok: false, error: 'mapping not found on latest version' });

    const now = new Date().toISOString();
    // decided_by is ALWAYS the authenticated caller — a client-supplied value is ignored.
    await repo.insertMappingDecision(supabase, {
      id: randomUUID(), mapping_id, decision, decided_by: userId(req), reason: reason ?? null, created_at: now,
    });
    if (decision === 'approve') {
      await repo.approveMapping(supabase, mapping_id);
    } else {
      // A rejected mapping must never reach certification: remove it from the
      // version's mapping set (the mapping_decision row keeps the audit trail).
      await repo.deleteRejectedMapping(supabase, mapping_id);
    }
    await emitOasisEvent(supabase, 'vcaop.portal.mapping.decided', 'success', `mapping ${mapping_id}: ${decision}`, {
      connection_id: rec.id, mapping_id, decision, actor: userId(req), surface: scope.surface,
    });
    res.json({ ok: true, data: { mapping_id, decision } });
  });

  // ===== Sandbox tests (gateway_dev_sandbox mode — same honest record as admin) =====
  r.post('/connections/:id/sandbox-tests', ...scope.guards, async (req: Request, res: Response) => {
    const supabase = db(res); if (!supabase) return;
    const rec = await scope.fetchManifest(supabase, req);
    if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
    // approval_required is re-runnable so a human mapping decision can clear
    // the gate (canonical service: approval_required -> mapping -> testing).
    const canRun = canTransition(rec.status, 'testing') || rec.status === 'testing' || rec.status === 'approval_required';
    if (!canRun) {
      return res.status(409).json({ ok: false, error: `cannot run tests from state ${rec.status}` });
    }
    const version = await latestVersion(supabase, rec.id);
    if (!version) return res.status(409).json({ ok: false, error: 'no integration version to test' });

    const { data: mappings } = await repo.fetchMappingsForSandboxTest(supabase, version.id);
    if (!mappings || mappings.length === 0) {
      // Zero mappings = the factory has not produced its proposals yet — a
      // pipeline state, never a passed mapping gate.
      return res.status(409).json({ ok: false, error: 'awaiting_factory_run: no mappings exist for this version yet' });
    }
    const pending = pendingReviewMappings(mappings || []);
    const certStatus = pending.length > 0 ? 'approval_required' : 'certified';
    const now = new Date().toISOString();

    await repo.insertConnectorCertification(supabase, {
      id: randomUUID(), version_id: version.id, status: certStatus,
      test_results: { mode: 'gateway_dev_sandbox', contract_tests_executed: 0, mapping_gate: pending.length === 0 ? 'pass' : 'pending_review' },
      pending_mappings: pending, reasons: pending.length > 0 ? ['sensitive or low-confidence mappings need a human decision'] : [],
      certified_by: null, created_at: now,
    });
    await repo.updateVersionCertificationStatus(supabase, version.id, certStatus);
    const nextState: ConnectionState = certStatus === 'certified' ? 'certified' : 'approval_required';
    await repo.updateManifestStatus(supabase, rec.id, nextState, now);
    await emitOasisEvent(supabase, 'vcaop.portal.sandbox_tests.completed', 'success', `connection ${rec.id}: ${certStatus}`, {
      connection_id: rec.id, version: version.version, status: certStatus, pending: pending.length, actor: userId(req), surface: scope.surface,
    });
    await scope.onStateChange?.(supabase, req);
    res.json({ ok: true, data: { state: nextState, certification: certStatus, pending_review: pending } });
  });

  r.get('/connections/:id/activation-summary', ...scope.guards, async (req: Request, res: Response) => {
    const supabase = db(res); if (!supabase) return;
    const rec = await scope.fetchManifest(supabase, req);
    if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
    const version = await latestVersion(supabase, rec.id);
    let cert = null;
    if (version) {
      cert = await repo.fetchLatestCertification(supabase, version.id);
    }
    res.json({
      ok: true,
      data: {
        id: rec.id, state: rec.status, version: version?.version ?? null,
        certification: cert,
        // The merchant surface never activates — it reports whether the
        // connection is WAITING on the platform's one-approval activation.
        awaiting_platform_approval: rec.status === 'certified' && cert?.status === 'certified',
      },
    });
  });

  // NOTE: there is deliberately NO /approve-activation here. Activation is the
  // platform's one-approval gate and lives on the admin router only.

  // ===== Lifecycle (a merchant manages their own connection) =====
  r.post('/connections/:id/pause', ...scope.guards, async (req: Request, res: Response) => {
    const supabase = db(res); if (!supabase) return;
    await transitionAndEmitOasisEvent(scope, supabase, req, res, 'suspended', 'vcaop.portal.connection.paused');
  });
  r.post('/connections/:id/resume', ...scope.guards, async (req: Request, res: Response) => {
    const supabase = db(res); if (!supabase) return;
    await transitionAndEmitOasisEvent(scope, supabase, req, res, 'active', 'vcaop.portal.connection.resumed');
  });
  r.post('/connections/:id/reauthorize', ...scope.guards, async (req: Request, res: Response) => {
    const supabase = db(res); if (!supabase) return;
    await transitionAndEmitOasisEvent(scope, supabase, req, res, 'suspended', 'vcaop.portal.connection.reauthorize_requested');
  });
  // Irreversible for the connection — the owner may always sever their own integration.
  r.post('/connections/:id/revoke', ...scope.guards, async (req: Request, res: Response) => {
    const supabase = db(res); if (!supabase) return;
    await transitionAndEmitOasisEvent(scope, supabase, req, res, 'revoked', 'vcaop.portal.connection.revoked');
  });
}

/** The portal's scope: only the caller's own connections. */
const ownerScope: ConnectionScope = {
  guards: [],
  fetchManifest: (supabase, req) => repo.fetchOwnedManifestByOwner(supabase, req.params.id, userId(req)),
  surface: 'merchant_self_service',
};

registerConnectionRoutes(router, ownerScope);

export default router;
