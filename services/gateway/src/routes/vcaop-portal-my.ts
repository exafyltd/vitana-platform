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
 *
 * Served to the commerce.vitanaland.com frontend (host-routed community-app
 * build); DNS/exposure for that host is deferred the BLK-006 way.
 */
import { Router, Request, Response } from 'express';
import { createHash, randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth-supabase-jwt';
import {
  ConnectionState,
  canTransition,
  extractSchemaSources,
  pendingReviewMappings,
} from './vcaop-portal';

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
async function emitEvent(supabase: any, type: string, status: string, message: string, payload: Record<string, unknown>) {
  try {
    await supabase.from('oasis_events').insert({
      id: randomUUID(), service: 'vcaop', source: 'vcaop-portal-my', type, topic: type, status, message,
      metadata: payload, created_at: new Date().toISOString(),
    });
  } catch { /* never block the request on the audit write */ }
}

/** Load a manifest row the CALLER OWNS (partner_tenant.owner_user_id).
 * Anything else — other merchants' rows, admin-seeded rows with no owner —
 * reads as 404. */
async function getOwnedManifest(supabase: any, req: Request) {
  const { data } = await supabase
    .from('integration_manifest')
    .select('id,partner_tenant_id,connector_id,provider_id,connection_type,risk_level,status,created_at,updated_at, partner_tenant!inner(id,tenant_id,name,jurisdiction,owner_user_id)')
    .eq('id', req.params.id)
    .eq('partner_tenant.owner_user_id', userId(req))
    .maybeSingle();
  return data ?? null;
}

async function latestVersion(supabase: any, manifestId: string) {
  const { data } = await supabase
    .from('integration_version')
    .select('id,version,certification_status,document_hash,created_at')
    .eq('manifest_id', manifestId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function transition(supabase: any, req: Request, res: Response, to: ConnectionState, eventType: string) {
  const rec = await getOwnedManifest(supabase, req);
  if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
  if (!canTransition(rec.status, to)) {
    return res.status(409).json({ ok: false, error: `illegal transition ${rec.status} -> ${to}` });
  }
  const now = new Date().toISOString();
  await supabase.from('integration_manifest').update({ status: to, updated_at: now }).eq('id', rec.id);
  await emitEvent(supabase, eventType, 'success', `connection ${rec.id}: ${rec.status} -> ${to}`, {
    connection_id: rec.id, from: rec.status, to, actor: userId(req), surface: 'merchant_self_service',
  });
  return res.json({ ok: true, data: { id: rec.id, state: to } });
}

// ===== List / create =====
router.get('/connections', async (req: Request, res: Response) => {
  const supabase = db(res); if (!supabase) return;
  const { data, error } = await supabase
    .from('integration_manifest')
    .select('id,connector_id,provider_id,connection_type,risk_level,status,created_at,updated_at, partner_tenant!inner(tenant_id,name,jurisdiction,owner_user_id)')
    .eq('partner_tenant.owner_user_id', userId(req))
    .order('updated_at', { ascending: false });
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
  const { data: existingPartner } = await supabase
    .from('partner_tenant').select('id').eq('owner_user_id', owner).eq('name', name).maybeSingle();
  let partnerId = existingPartner?.id;
  if (!partnerId) {
    partnerId = randomUUID();
    const { error } = await supabase.from('partner_tenant').insert({
      id: partnerId, tenant_id: tenantId(req), name, status: 'discovered', jurisdiction: jurisdiction ?? null,
      owner_user_id: owner, owner_email: userEmail(req),
      created_at: now, updated_at: now,
    });
    if (error) return res.status(500).json({ ok: false, error: error.message });
  }

  const initialState: ConnectionState = openapi_document ? 'mapping' : 'authorization_required';
  const manifestId = randomUUID();
  const { error: mErr } = await supabase.from('integration_manifest').insert({
    id: manifestId, partner_tenant_id: partnerId, connector_id, provider_id,
    connection_type: connection_type ?? 'api', risk_level: risk_level ?? 'medium',
    status: initialState, created_at: now, updated_at: now,
  });
  if (mErr) {
    const dup = /duplicate|unique/i.test(mErr.message);
    return res.status(dup ? 409 : 500).json({ ok: false, error: dup ? 'connection already exists for this business + connector' : mErr.message });
  }

  if (openapi_document) {
    const versionId = randomUUID();
    const docJson = JSON.stringify(openapi_document);
    await supabase.from('integration_version').insert({
      id: versionId, manifest_id: manifestId, version: '0.1.0', document: openapi_document,
      document_hash: createHash('sha256').update(docJson).digest('hex'), certification_status: 'draft', created_at: now,
    });
    const sources = extractSchemaSources(openapi_document);
    for (const s of sources) {
      await supabase.from('schema_source').insert({
        id: randomUUID(), version_id: versionId, name: s.name, fields: s.fields,
        hash: createHash('sha256').update(JSON.stringify(s.fields)).digest('hex'), created_at: now,
      });
    }
  }

  await emitEvent(supabase, 'vcaop.portal.connection.started', 'success', `connection ${manifestId} started (${initialState})`, {
    connection_id: manifestId, connector_id, provider_id, state: initialState, actor: owner, surface: 'merchant_self_service',
  });
  res.status(201).json({ ok: true, data: { id: manifestId, name, state: initialState } });
});

// ===== Detail / mapping preview / decisions =====
router.get('/connections/:id', async (req: Request, res: Response) => {
  const supabase = db(res); if (!supabase) return;
  const rec = await getOwnedManifest(supabase, req);
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

router.get('/connections/:id/mapping-preview', async (req: Request, res: Response) => {
  const supabase = db(res); if (!supabase) return;
  const rec = await getOwnedManifest(supabase, req);
  if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
  const version = await latestVersion(supabase, rec.id);
  if (!version) {
    return res.json({ ok: true, data: { state: rec.status, pipeline_status: 'awaiting_specification', sources: [], mappings: [], pending_review: [] } });
  }
  const [{ data: sources }, { data: mappings }] = await Promise.all([
    supabase.from('schema_source').select('id,name,fields').eq('version_id', version.id),
    supabase.from('schema_mapping')
      .select('id,source_schema,source_field,canonical_entity,canonical_field,transform,confidence,decided_by,sensitive')
      .eq('version_id', version.id),
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
router.post('/connections/:id/mapping-decisions', async (req: Request, res: Response) => {
  const supabase = db(res); if (!supabase) return;
  const rec = await getOwnedManifest(supabase, req);
  if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
  const { mapping_id, decision, reason } = req.body ?? {};
  if (!mapping_id || !['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ ok: false, error: 'mapping_id and decision (approve|reject) required' });
  }
  const version = await latestVersion(supabase, rec.id);
  if (!version) return res.status(409).json({ ok: false, error: 'no integration version to decide on' });
  const { data: mapping } = await supabase
    .from('schema_mapping').select('id,version_id').eq('id', mapping_id).eq('version_id', version.id).maybeSingle();
  if (!mapping) return res.status(404).json({ ok: false, error: 'mapping not found on latest version' });

  const now = new Date().toISOString();
  // decided_by is ALWAYS the authenticated caller — a client-supplied value is ignored.
  await supabase.from('mapping_decision').insert({
    id: randomUUID(), mapping_id, decision, decided_by: userId(req), reason: reason ?? null, created_at: now,
  });
  if (decision === 'approve') {
    await supabase.from('schema_mapping').update({ decided_by: 'human' }).eq('id', mapping_id);
  }
  await emitEvent(supabase, 'vcaop.portal.mapping.decided', 'success', `mapping ${mapping_id}: ${decision}`, {
    connection_id: rec.id, mapping_id, decision, actor: userId(req), surface: 'merchant_self_service',
  });
  res.json({ ok: true, data: { mapping_id, decision } });
});

// ===== Sandbox tests (gateway_dev_sandbox mode — same honest record as admin) =====
router.post('/connections/:id/sandbox-tests', async (req: Request, res: Response) => {
  const supabase = db(res); if (!supabase) return;
  const rec = await getOwnedManifest(supabase, req);
  if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
  if (!canTransition(rec.status, 'testing') && rec.status !== 'testing') {
    return res.status(409).json({ ok: false, error: `cannot run tests from state ${rec.status}` });
  }
  const version = await latestVersion(supabase, rec.id);
  if (!version) return res.status(409).json({ ok: false, error: 'no integration version to test' });

  const { data: mappings } = await supabase
    .from('schema_mapping').select('id,sensitive,confidence,decided_by').eq('version_id', version.id);
  const pending = pendingReviewMappings(mappings || []);
  const certStatus = pending.length > 0 ? 'approval_required' : 'certified';
  const now = new Date().toISOString();

  await supabase.from('connector_certification').insert({
    id: randomUUID(), version_id: version.id, status: certStatus,
    test_results: { mode: 'gateway_dev_sandbox', contract_tests_executed: 0, mapping_gate: pending.length === 0 ? 'pass' : 'pending_review' },
    pending_mappings: pending, reasons: pending.length > 0 ? ['sensitive or low-confidence mappings need a human decision'] : [],
    certified_by: null, created_at: now,
  });
  await supabase.from('integration_version').update({ certification_status: certStatus }).eq('id', version.id);
  const nextState: ConnectionState = certStatus === 'certified' ? 'certified' : 'approval_required';
  await supabase.from('integration_manifest').update({ status: nextState, updated_at: now }).eq('id', rec.id);
  await emitEvent(supabase, 'vcaop.portal.sandbox_tests.completed', 'success', `connection ${rec.id}: ${certStatus}`, {
    connection_id: rec.id, version: version.version, status: certStatus, pending: pending.length, actor: userId(req), surface: 'merchant_self_service',
  });
  res.json({ ok: true, data: { state: nextState, certification: certStatus, pending_review: pending } });
});

router.get('/connections/:id/activation-summary', async (req: Request, res: Response) => {
  const supabase = db(res); if (!supabase) return;
  const rec = await getOwnedManifest(supabase, req);
  if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
  const version = await latestVersion(supabase, rec.id);
  let cert = null;
  if (version) {
    const { data } = await supabase
      .from('connector_certification').select('id,status,test_results,pending_mappings,reasons,created_at')
      .eq('version_id', version.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    cert = data ?? null;
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
router.post('/connections/:id/pause', async (req, res) => {
  const supabase = db(res); if (!supabase) return;
  await transition(supabase, req, res, 'suspended', 'vcaop.portal.connection.paused');
});
router.post('/connections/:id/resume', async (req, res) => {
  const supabase = db(res); if (!supabase) return;
  await transition(supabase, req, res, 'active', 'vcaop.portal.connection.resumed');
});
router.post('/connections/:id/reauthorize', async (req, res) => {
  const supabase = db(res); if (!supabase) return;
  await transition(supabase, req, res, 'suspended', 'vcaop.portal.connection.reauthorize_requested');
});
// Irreversible for the connection — the owner may always sever their own integration.
router.post('/connections/:id/revoke', async (req, res) => {
  const supabase = db(res); if (!supabase) return;
  await transition(supabase, req, res, 'revoked', 'vcaop.portal.connection.revoked');
});

export default router;
