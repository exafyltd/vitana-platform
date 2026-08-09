/**
 * VCAOP Partner Portal — gateway surface (Commerce Mesh, VTID-03544 / BLK-001).
 *
 * Thin persistence + state-machine surface over the mesh factory tables
 * (partner_tenant, integration_manifest, integration_version, schema_source,
 * schema_mapping, mapping_decision, connector_certification — VTID-03535
 * migration, applied 2026-08-09). The heavy factory logic (OpenAPI ingest,
 * mapping proposal, compiled connectors, real contract tests) lives in
 * services/vcaop and runs on the worker/CI plane — this route deliberately
 * does NOT fork it (ADR-001: one execution engine). What IS mirrored here is
 * the 11-state connection state machine, byte-for-byte from
 * services/vcaop/src/factory/manifest.ts, pinned by a sync test
 * (test/routes/vcaop-portal-transitions-sync.test.ts) the same way the nav
 * catalog is pinned to the vitana-v1 manifest.
 *
 * Roles: portal management is back-office → exafy_admin only. The
 * one-approval activation and revoke additionally emit OASIS events.
 * Sandbox tests here run in `gateway_dev_sandbox` mode: they evaluate the
 * deterministic mapping gate (no sensitive/low-confidence mapping without a
 * human decision) and execute ZERO live partner calls — test_results says so
 * explicitly rather than pretending contract tests ran.
 */
import { Router, Request, Response } from 'express';
import { createHash, randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth-supabase-jwt';

// ---------------------------------------------------------------------------
// Connection state machine — MIRROR of services/vcaop/src/factory/manifest.ts.
// Do not edit here without editing the canonical source; the sync test fails
// on any divergence.
// ---------------------------------------------------------------------------
export const CONNECTION_STATES = [
  'discovered',
  'authorization_required',
  'mapping',
  'testing',
  'approval_required',
  'certified',
  'active',
  'degraded',
  'suspended',
  'revoked',
  'failed',
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const STATE_TRANSITIONS: Record<ConnectionState, ConnectionState[]> = {
  discovered: ['authorization_required', 'mapping', 'failed', 'revoked'],
  authorization_required: ['mapping', 'failed', 'revoked'],
  mapping: ['testing', 'failed', 'revoked'],
  testing: ['approval_required', 'certified', 'failed', 'revoked'],
  approval_required: ['certified', 'mapping', 'failed', 'revoked'],
  certified: ['active', 'revoked'],
  active: ['degraded', 'suspended', 'revoked'],
  degraded: ['active', 'suspended', 'failed', 'revoked'],
  suspended: ['active', 'revoked'],
  revoked: [],
  failed: ['mapping', 'revoked'],
};

export function canTransition(from: string, to: ConnectionState): boolean {
  const legal = STATE_TRANSITIONS[from as ConnectionState];
  return Array.isArray(legal) && legal.includes(to);
}

/** Mapping gate (mirrors certification rule): sensitive or low-confidence
 * AI-decided mappings need a human decision before certification. */
export const LOW_CONFIDENCE_THRESHOLD = 0.75;
export function pendingReviewMappings(
  mappings: Array<{ id: string; sensitive: boolean; confidence: number; decided_by: string }>,
): string[] {
  return mappings
    .filter((m) => m.decided_by !== 'human' && (m.sensitive || m.confidence < LOW_CONFIDENCE_THRESHOLD))
    .map((m) => m.id);
}

/** Minimal, lossless schema-source extraction from an OpenAPI document:
 * component schemas → {name, fields}. No mapping proposal happens here —
 * that is the factory plane's job. */
export function extractSchemaSources(doc: unknown): Array<{ name: string; fields: Array<{ name: string; type: string; required: boolean }> }> {
  const schemas = (doc as any)?.components?.schemas;
  if (!schemas || typeof schemas !== 'object') return [];
  const out: Array<{ name: string; fields: Array<{ name: string; type: string; required: boolean }> }> = [];
  for (const [name, schema] of Object.entries<any>(schemas)) {
    const props = schema?.properties;
    if (!props || typeof props !== 'object') continue;
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    out.push({
      name,
      fields: Object.entries<any>(props).map(([fname, fdef]) => ({
        name: fname,
        type: typeof fdef?.type === 'string' ? fdef.type : 'unknown',
        required: required.includes(fname),
      })),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

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
function isAdmin(req: Request): boolean {
  return Boolean((req as any).identity?.exafy_admin);
}
function userId(req: Request): string {
  return String((req as any).identity?.user_id || '');
}
function tenantId(req: Request): string {
  return String((req as any).identity?.tenant_id || 'platform');
}
function requireAdmin(req: Request, res: Response): boolean {
  if (!isAdmin(req)) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return false;
  }
  return true;
}
async function emitOasisEvent(supabase: any, type: string, status: string, message: string, payload: Record<string, unknown>) {
  try {
    await supabase.from('oasis_events').insert({
      id: randomUUID(), service: 'vcaop', source: 'vcaop-portal', type, topic: type, status, message,
      metadata: payload, created_at: new Date().toISOString(),
    });
  } catch { /* never block the request on the audit write */ }
}

/** Load a manifest row scoped to the caller's tenant; foreign rows read as 404. */
async function getOwnedManifest(supabase: any, req: Request) {
  const { data } = await supabase
    .from('integration_manifest')
    .select('id,partner_tenant_id,connector_id,provider_id,connection_type,risk_level,status,created_at,updated_at, partner_tenant!inner(id,tenant_id,name,jurisdiction)')
    .eq('id', req.params.id)
    .eq('partner_tenant.tenant_id', tenantId(req))
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

async function transitionAndEmitOasisEvent(supabase: any, req: Request, res: Response, to: ConnectionState, eventType: string) {
  const rec = await getOwnedManifest(supabase, req);
  if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
  if (!canTransition(rec.status, to)) {
    return res.status(409).json({ ok: false, error: `illegal transition ${rec.status} -> ${to}` });
  }
  const now = new Date().toISOString();
  await supabase.from('integration_manifest').update({ status: to, updated_at: now }).eq('id', rec.id);
  await emitOasisEvent(supabase, eventType, 'success', `connection ${rec.id}: ${rec.status} -> ${to}`, {
    connection_id: rec.id, from: rec.status, to, actor: userId(req),
  });
  return res.json({ ok: true, data: { id: rec.id, state: to } });
}

// ===== List / create =====
router.get('/connections', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const supabase = db(res); if (!supabase) return;
  const { data, error } = await supabase
    .from('integration_manifest')
    .select('id,connector_id,provider_id,connection_type,risk_level,status,created_at,updated_at, partner_tenant!inner(tenant_id,name,jurisdiction)')
    .eq('partner_tenant.tenant_id', tenantId(req))
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
  if (!requireAdmin(req, res)) return;
  const supabase = db(res); if (!supabase) return;
  const { name, connector_id, provider_id, connection_type, risk_level, jurisdiction, openapi_document } = req.body ?? {};
  if (!name || !connector_id || !provider_id) {
    return res.status(400).json({ ok: false, error: 'name, connector_id and provider_id are required' });
  }
  const tenant = tenantId(req);
  const now = new Date().toISOString();

  // One partner_tenant row per (tenant, business name).
  const { data: existingPartner } = await supabase
    .from('partner_tenant').select('id').eq('tenant_id', tenant).eq('name', name).maybeSingle();
  let partnerId = existingPartner?.id;
  if (!partnerId) {
    partnerId = randomUUID();
    const { error } = await supabase.from('partner_tenant').insert({
      id: partnerId, tenant_id: tenant, name, status: 'discovered', jurisdiction: jurisdiction ?? null,
      created_at: now, updated_at: now,
    });
    if (error) return res.status(500).json({ ok: false, error: error.message });
  }

  // No spec yet → the connection waits on partner authorization (same rule as
  // the vcaop onboarding service).
  const initialState: ConnectionState = openapi_document ? 'mapping' : 'authorization_required';
  const manifestId = randomUUID();
  const { error: mErr } = await supabase.from('integration_manifest').insert({
    id: manifestId, partner_tenant_id: partnerId, connector_id, provider_id,
    connection_type: connection_type ?? 'api', risk_level: risk_level ?? 'medium',
    status: initialState, created_at: now, updated_at: now,
  });
  if (mErr) {
    const dup = /duplicate|unique/i.test(mErr.message);
    return res.status(dup ? 409 : 500).json({ ok: false, error: dup ? 'connection already exists for this partner + connector' : mErr.message });
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

  await emitOasisEvent(supabase, 'vcaop.portal.connection.started', 'success', `connection ${manifestId} started (${initialState})`, {
    connection_id: manifestId, connector_id, provider_id, state: initialState, actor: userId(req),
  });
  res.status(201).json({ ok: true, data: { id: manifestId, name, state: initialState } });
});

// ===== Detail / mapping preview / decisions =====
router.get('/connections/:id', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
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
  if (!requireAdmin(req, res)) return;
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

router.post('/connections/:id/mapping-decisions', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
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
  await emitOasisEvent(supabase, 'vcaop.portal.mapping.decided', 'success', `mapping ${mapping_id}: ${decision}`, {
    connection_id: rec.id, mapping_id, decision, actor: userId(req),
  });
  res.json({ ok: true, data: { mapping_id, decision } });
});

// ===== Sandbox tests (gateway_dev_sandbox mode) =====
router.post('/connections/:id/sandbox-tests', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
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
    // Honest record: the gateway dev sandbox evaluates the deterministic
    // mapping gate only. Real contract tests execute in the VCAOP factory
    // plane (workers/CI) — never claimed here.
    test_results: { mode: 'gateway_dev_sandbox', contract_tests_executed: 0, mapping_gate: pending.length === 0 ? 'pass' : 'pending_review' },
    pending_mappings: pending, reasons: pending.length > 0 ? ['sensitive or low-confidence mappings need a human decision'] : [],
    certified_by: null, created_at: now,
  });
  await supabase.from('integration_version').update({ certification_status: certStatus }).eq('id', version.id);
  const nextState: ConnectionState = certStatus === 'certified' ? 'certified' : 'approval_required';
  await supabase.from('integration_manifest').update({ status: nextState, updated_at: now }).eq('id', rec.id);
  await emitOasisEvent(supabase, 'vcaop.portal.sandbox_tests.completed', 'success', `connection ${rec.id}: ${certStatus}`, {
    connection_id: rec.id, version: version.version, status: certStatus, pending: pending.length, actor: userId(req),
  });
  res.json({ ok: true, data: { state: nextState, certification: certStatus, pending_review: pending } });
});

router.get('/connections/:id/activation-summary', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
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
      certification: cert, can_activate: rec.status === 'certified' && cert?.status === 'certified',
    },
  });
});

// THE one-approval activation — admin only, gated on a certified version.
router.post('/connections/:id/approve-activation', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const supabase = db(res); if (!supabase) return;
  const rec = await getOwnedManifest(supabase, req);
  if (!rec) return res.status(404).json({ ok: false, error: 'connection not found' });
  if (!canTransition(rec.status, 'active')) {
    return res.status(409).json({ ok: false, error: `illegal transition ${rec.status} -> active (certification first)` });
  }
  const version = await latestVersion(supabase, rec.id);
  if (!version || version.certification_status !== 'certified') {
    return res.status(409).json({ ok: false, error: 'latest version is not certified' });
  }
  const now = new Date().toISOString();
  await supabase.from('connector_certification')
    .update({ certified_by: userId(req) })
    .eq('version_id', version.id).eq('status', 'certified').is('certified_by', null);
  await supabase.from('integration_manifest').update({ status: 'active', updated_at: now }).eq('id', rec.id);
  await emitOasisEvent(supabase, 'vcaop.portal.connection.activated', 'success', `connection ${rec.id} activated`, {
    connection_id: rec.id, version: version.version, approved_by: userId(req),
  });
  res.json({ ok: true, data: { id: rec.id, state: 'active' } });
});

// ===== Lifecycle =====
router.post('/connections/:id/pause', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const supabase = db(res); if (!supabase) return;
  await transitionAndEmitOasisEvent(supabase, req, res, 'suspended', 'vcaop.portal.connection.paused');
});
router.post('/connections/:id/resume', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const supabase = db(res); if (!supabase) return;
  await transitionAndEmitOasisEvent(supabase, req, res, 'active', 'vcaop.portal.connection.resumed');
});
router.post('/connections/:id/reauthorize', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const supabase = db(res); if (!supabase) return;
  await transitionAndEmitOasisEvent(supabase, req, res, 'suspended', 'vcaop.portal.connection.reauthorize_requested');
});
// Irreversible for the connection — still admin-only, emits its own event.
router.post('/connections/:id/revoke', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const supabase = db(res); if (!supabase) return;
  await transitionAndEmitOasisEvent(supabase, req, res, 'revoked', 'vcaop.portal.connection.revoked');
});

export default router;
