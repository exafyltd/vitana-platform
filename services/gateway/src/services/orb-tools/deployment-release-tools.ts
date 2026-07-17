/**
 * Developer voice tools — Deployment & Release (Wave 2, plan section C4).
 *
 * Backed by services/gateway/src/routes/operator.ts. Several routes require
 * a real admin JWT (requireAdminAuth: exafy_admin), not just header trust —
 * those handlers forward the caller's own session JWT (identity.user_jwt)
 * as a Bearer token and fail clearly if it isn't present, rather than
 * fabricating credentials. `dev_canary_status`, `dev_staging_status` and
 * `dev_compare_staging_prod` have no dedicated endpoint (per plan-gap
 * analysis) — they compose the existing /revisions and /deployments reads.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { developerGate, clampLimit, relAge, gatewayApiCall } from './developer-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

const DEPLOYABLE_SERVICES = ['gateway', 'gateway-staging', 'community-app', 'community-app-staging'];

function adminAuthHeaders(id: OrbToolIdentity): Record<string, string> | null {
  if (!id.user_jwt) return null;
  return { Authorization: `Bearer ${id.user_jwt}` };
}

const NO_ADMIN_JWT: OrbToolResult = {
  ok: true,
  result: { reason: 'no_admin_session' },
  text: "This action needs a signed-in admin session — I don't have one for this voice session. Please use the Command Hub for this action, or sign in with an admin account first.",
};

// ---------------------------------------------------------------------------
// 43. dev_deploy_service — POST /api/v1/operator/deploy (staging path only;
// production goes through dev_publish_to_prod, per the staging-first cutover)
// ---------------------------------------------------------------------------

export const dev_deploy_service: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const service = String(args.service ?? '').trim();
  if (!service) return { ok: false, error: 'dev_deploy_service requires a service name.' };
  const environment = String(args.environment ?? 'staging');
  if (environment === 'production') {
    return { ok: false, error: 'dev_deploy_service only deploys to staging. Use dev_publish_to_prod for production.' };
  }
  const vtid = String(args.vtid ?? '').trim();
  if (!vtid) return { ok: false, error: 'dev_deploy_service requires a vtid.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, service, environment, vtid },
      text: `About to deploy ${service} to ${environment} for ${vtid}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/operator/deploy', {
    method: 'POST',
    body: { vtid, service, environment, branch: String(args.branch ?? 'main'), source: 'orb-voice' },
  });
  if (!ok || body.ok !== true) {
    return { ok: true, result: { deployed: false, status, detail: body }, text: `Deploy was not started: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { deployed: true, detail: body }, text: `Deploy of ${service} to ${environment} started.` };
};

// ---------------------------------------------------------------------------
// 44. dev_publish_to_prod — POST /api/v1/operator/publish
// Double-confirm + spoken reason (recorded to OASIS — /publish itself has no
// reason field, so the reason is emitted as its own OASIS event alongside
// the call, per the plan-gap finding).
// ---------------------------------------------------------------------------

export const dev_publish_to_prod: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const reason = String(args.reason ?? '').trim();
  if (!reason) return { ok: false, error: 'dev_publish_to_prod requires a spoken reason for this publish.' };
  const mode = args.mode === 'canary' ? 'canary' : 'full';

  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, step: 1, mode, reason },
      text: `You're about to PUBLISH gateway to PRODUCTION (mode: ${mode}) — reason: "${reason}". This is a real production release. Ask the developer to confirm once, then call again with confirm=true.`,
    };
  }
  if (args.confirm_again !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, step: 2, mode, reason },
      text: `Second confirmation required: PUBLISH ${mode} to PRODUCTION for reason "${reason}". Ask the developer to confirm one more time, then call again with confirm=true and confirm_again=true.`,
    };
  }

  const auth = adminAuthHeaders(id);
  if (!auth) return NO_ADMIN_JWT;

  try {
    const { emitOasisEvent } = await import('../oasis-event-service');
    await emitOasisEvent({
      vtid: typeof args.vtid === 'string' ? args.vtid : 'VTID-PUBLISH',
      type: 'production.publish.requested',
      source: 'orb-voice-tools',
      status: 'info',
      message: `Voice-initiated production publish requested: ${reason}`,
      payload: { reason, mode, confirm_short_sha: args.confirm_short_sha ?? null },
      actor_id: id.user_id,
      actor_role: 'admin',
      surface: 'orb',
    }).catch(() => {});
  } catch {
    /* best-effort audit event; publish proceeds regardless */
  }

  const { ok, status, body } = await gatewayApiCall('/api/v1/operator/publish', {
    method: 'POST',
    headers: auth,
    body: { mode, confirm_short_sha: typeof args.confirm_short_sha === 'string' ? args.confirm_short_sha : undefined },
  });
  if (!ok || body.ok !== true) {
    return { ok: true, result: { published: false, status, detail: body }, text: `Publish to production did not go through: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { published: true, detail: body }, text: `Published to production (${mode}). Reason recorded: "${reason}".` };
};

// ---------------------------------------------------------------------------
// 45. dev_list_revisions — GET /api/v1/operator/revisions (requireAdminAuth)
// ---------------------------------------------------------------------------

export const dev_list_revisions: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const service = String(args.service ?? 'gateway');
  if (!DEPLOYABLE_SERVICES.includes(service)) {
    return { ok: false, error: `dev_list_revisions requires service to be one of ${DEPLOYABLE_SERVICES.join(', ')}.` };
  }
  const auth = adminAuthHeaders(id);
  if (!auth) return NO_ADMIN_JWT;
  const limit = clampLimit(args.limit, 5, 20);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/operator/revisions?service=${service}&limit=${limit}`, { headers: auth });
  if (!ok || body.ok !== true) return { ok: false, error: `dev_list_revisions failed (${status}): ${String(body.error ?? 'unknown')}` };
  const revisions = (Array.isArray(body.revisions) ? body.revisions : []) as Array<{ name: string; created_at?: string; is_active?: boolean }>;
  if (revisions.length === 0) return { ok: true, result: { revisions: [] }, text: `No revisions found for ${service}.` };
  const lines = revisions.slice(0, 8).map((r) => `${r.name}${r.is_active ? ' (active)' : ''}`);
  return { ok: true, result: { revisions }, text: `${revisions.length} revisions for ${service}: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 46/55. dev_list_deployments / dev_release_feed — GET /api/v1/operator/deployments
// (identical backing route; kept as two tools per the plan)
// ---------------------------------------------------------------------------

async function fetchDeployments(args: OrbToolArgs): Promise<OrbToolResult> {
  const limit = clampLimit(args.limit, 10, 100);
  const qs = new URLSearchParams({ limit: String(limit) });
  if (typeof args.service === 'string' && args.service) qs.set('service', args.service);
  if (typeof args.environment === 'string' && args.environment) qs.set('environment', args.environment);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/operator/deployments?${qs.toString()}`);
  if (!ok) return { ok: false, error: `deployments read failed (${status}): ${String(body.error ?? 'unknown')}` };
  const rows = (Array.isArray(body.deployments) ? body.deployments : Array.isArray(body.data) ? body.data : []) as Array<{
    service?: string; environment?: string; commit_sha?: string; created_at?: string; is_active?: boolean;
  }>;
  if (rows.length === 0) return { ok: true, result: { deployments: [] }, text: 'No deployments recorded.' };
  const lines = rows.slice(0, 8).map((r) => `${r.service ?? '?'} (${r.environment ?? '?'}) — ${(r.commit_sha ?? '').slice(0, 7)}${r.is_active ? ' active' : ''}, ${relAge(r.created_at)}`);
  return { ok: true, result: { deployments: rows }, text: `${rows.length} deployments: ${lines.join('. ')}` };
}

export const dev_list_deployments: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  return fetchDeployments(args);
};

export const dev_release_feed: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  return fetchDeployments(args);
};

// ---------------------------------------------------------------------------
// 47. dev_deployment_health — GET /api/v1/operator/deployments/health
// ---------------------------------------------------------------------------

export const dev_deployment_health: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/operator/deployments/health');
  if (!ok) return { ok: false, error: `dev_deployment_health failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: `Deployment config health: ${String(body.status ?? 'unknown')}.` };
};

// ---------------------------------------------------------------------------
// 48. dev_promote_canary — POST /api/v1/operator/promote (requireAdminAuth)
// ---------------------------------------------------------------------------

export const dev_promote_canary: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const service = String(args.service ?? 'gateway');
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, service },
      text: `About to promote the canary revision to 100% traffic for ${service}. Confirm, then call again with confirm=true.`,
    };
  }
  const auth = adminAuthHeaders(id);
  if (!auth) return NO_ADMIN_JWT;
  const { ok, status, body } = await gatewayApiCall('/api/v1/operator/promote', { method: 'POST', headers: auth, body: { service } });
  if (!ok || body.ok !== true) return { ok: true, result: { promoted: false, status, detail: body }, text: `Could not promote the canary: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { promoted: true, detail: body }, text: `Canary promoted to 100% for ${service}.` };
};

// ---------------------------------------------------------------------------
// 49. dev_abort_canary — POST /api/v1/operator/abort-canary (requireAdminAuth)
// ---------------------------------------------------------------------------

export const dev_abort_canary: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const service = String(args.service ?? 'gateway');
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, service },
      text: `About to abort the canary for ${service} and restore the stable revision to 100%. Confirm, then call again with confirm=true.`,
    };
  }
  const auth = adminAuthHeaders(id);
  if (!auth) return NO_ADMIN_JWT;
  const { ok, status, body } = await gatewayApiCall('/api/v1/operator/abort-canary', { method: 'POST', headers: auth, body: { service } });
  if (!ok || body.ok !== true) return { ok: true, result: { aborted: false, status, detail: body }, text: `Could not abort the canary: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { aborted: true, detail: body }, text: `Canary aborted for ${service} — stable revision restored.` };
};

// ---------------------------------------------------------------------------
// 50. dev_revert_deploy — POST /api/v1/operator/revert (requireAdminAuth)
// ---------------------------------------------------------------------------

export const dev_revert_deploy: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const service = String(args.service ?? '').trim();
  const targetRevision = String(args.target_revision ?? '').trim();
  if (!service || !targetRevision) return { ok: false, error: 'dev_revert_deploy requires service and target_revision.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, service, target_revision: targetRevision },
      text: `About to revert ${service} to revision ${targetRevision}. Confirm, then call again with confirm=true.`,
    };
  }
  const auth = adminAuthHeaders(id);
  if (!auth) return NO_ADMIN_JWT;
  const { ok, status, body } = await gatewayApiCall('/api/v1/operator/revert', {
    method: 'POST',
    headers: auth,
    body: { service, target_revision: targetRevision, confirm_short_sha: typeof args.confirm_short_sha === 'string' ? args.confirm_short_sha : undefined },
  });
  if (!ok || body.ok !== true) return { ok: true, result: { reverted: false, status, detail: body }, text: `Could not revert ${service}: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { reverted: true, detail: body }, text: `${service} reverted to ${targetRevision}.` };
};

// ---------------------------------------------------------------------------
// 51. dev_revert_both — POST /api/v1/operator/revert-both (requireAdminAuth)
// ---------------------------------------------------------------------------

export const dev_revert_both: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const service = String(args.service ?? '').trim();
  const targetRevision = String(args.target_revision ?? '').trim();
  if (!service || !targetRevision) return { ok: false, error: 'dev_revert_both requires service and target_revision.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, service, target_revision: targetRevision },
      text: `About to revert ${service} AND its paired frontend/backend service to revision ${targetRevision}. Confirm, then call again with confirm=true.`,
    };
  }
  const auth = adminAuthHeaders(id);
  if (!auth) return NO_ADMIN_JWT;
  const { ok, status, body } = await gatewayApiCall('/api/v1/operator/revert-both', {
    method: 'POST',
    headers: auth,
    body: {
      service,
      target_revision: targetRevision,
      target_created_at: typeof args.target_created_at === 'string' ? args.target_created_at : undefined,
    },
  });
  if (!ok || body.ok !== true) return { ok: true, result: { reverted: false, status, detail: body }, text: `Could not revert both services: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { reverted: true, detail: body }, text: `Both ${service} and its paired service reverted to ${targetRevision}.` };
};

// ---------------------------------------------------------------------------
// 52. dev_canary_status — no dedicated endpoint; composed from /revisions
// ---------------------------------------------------------------------------

export const dev_canary_status: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const service = String(args.service ?? 'gateway');
  const auth = adminAuthHeaders(id);
  if (!auth) return NO_ADMIN_JWT;
  const { ok, status, body } = await gatewayApiCall(`/api/v1/operator/revisions?service=${service}&limit=5`, { headers: auth });
  if (!ok || body.ok !== true) return { ok: false, error: `dev_canary_status failed (${status}): ${String(body.error ?? 'unknown')}` };
  const revisions = (Array.isArray(body.revisions) ? body.revisions : []) as Array<{ name: string; percent?: number; is_active?: boolean }>;
  const withTraffic = revisions.filter((r) => typeof r.percent === 'number' && r.percent > 0);
  if (withTraffic.length >= 2) {
    const lines = withTraffic.map((r) => `${r.name}: ${r.percent}%`);
    return { ok: true, result: { canary_active: true, revisions: withTraffic }, text: `Canary is active on ${service}: ${lines.join(', ')}.` };
  }
  return {
    ok: true,
    result: { canary_active: false, revisions },
    text: `No canary split detected on ${service} — one revision is serving 100%. (Traffic-percent detail isn't exposed on every environment; check the Command Hub Deployments tab for exact figures.)`,
  };
};

// ---------------------------------------------------------------------------
// 53. dev_staging_status — no dedicated endpoint; composed
// ---------------------------------------------------------------------------

export const dev_staging_status: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const deployRes = await gatewayApiCall('/api/v1/operator/deployments?service=gateway-staging&environment=staging&limit=1');
  const rows = (Array.isArray(deployRes.body.deployments) ? deployRes.body.deployments : Array.isArray(deployRes.body.data) ? deployRes.body.data : []) as Array<{
    commit_sha?: string; created_at?: string;
  }>;
  const latest = rows[0];
  if (!latest) return { ok: true, result: { found: false }, text: 'No staging deployment history found.' };
  return {
    ok: true,
    result: { latest },
    text: `Staging is on commit ${(latest.commit_sha ?? '').slice(0, 7) || 'unknown'}, deployed ${relAge(latest.created_at)}.`,
  };
};

// ---------------------------------------------------------------------------
// 54. dev_compare_staging_prod — no dedicated endpoint; composed
// ---------------------------------------------------------------------------

export const dev_compare_staging_prod: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const [stagingRes, prodRes] = await Promise.all([
    gatewayApiCall('/api/v1/operator/deployments?service=gateway-staging&limit=1'),
    gatewayApiCall('/api/v1/operator/deployments?service=gateway&limit=1'),
  ]);
  const pick = (r: { body: Record<string, unknown> }) => {
    const rows = (Array.isArray(r.body.deployments) ? r.body.deployments : Array.isArray(r.body.data) ? r.body.data : []) as Array<{ commit_sha?: string; created_at?: string }>;
    return rows[0];
  };
  const staging = pick(stagingRes);
  const prod = pick(prodRes);
  if (!staging || !prod) {
    return { ok: true, result: { staging, prod }, text: 'Could not find deployment history for both staging and production.' };
  }
  const same = staging.commit_sha && prod.commit_sha && staging.commit_sha === prod.commit_sha;
  return {
    ok: true,
    result: { staging, prod, same_commit: Boolean(same) },
    text: same
      ? `Staging and production are on the same commit (${(staging.commit_sha ?? '').slice(0, 7)}).`
      : `Staging is on ${(staging.commit_sha ?? '').slice(0, 7) || 'unknown'} (${relAge(staging.created_at)}); production is on ${(prod.commit_sha ?? '').slice(0, 7) || 'unknown'} (${relAge(prod.created_at)}). They differ.`,
  };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const DEPLOYMENT_RELEASE_TOOL_HANDLERS: Record<string, Handler> = {
  dev_deploy_service,
  dev_publish_to_prod,
  dev_list_revisions,
  dev_list_deployments,
  dev_deployment_health,
  dev_promote_canary,
  dev_abort_canary,
  dev_revert_deploy,
  dev_revert_both,
  dev_canary_status,
  dev_staging_status,
  dev_compare_staging_prod,
  dev_release_feed,
};

export const DEPLOYMENT_RELEASE_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'dev_deploy_service',
    description: 'DEVELOPER ONLY. Deploy a service to staging (never production — use dev_publish_to_prod for that). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        vtid: { type: 'string', description: 'Required.' },
        service: { type: 'string', description: 'Required.' },
        environment: { type: 'string', description: 'staging or dev. Default staging.' },
        branch: { type: 'string', description: 'Default main.' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['vtid', 'service'],
    },
  },
  {
    name: 'dev_publish_to_prod',
    description: 'DEVELOPER ONLY. The PUBLISH button by voice — promotes the tested staging build to production. DOUBLE-CONFIRM: requires a reason, then confirm=true, then confirm_again=true on a third call after re-confirming out loud. Requires a signed-in admin session.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Required — why this publish is happening.' },
        mode: { type: 'string', description: '"full" or "canary". Default full.' },
        vtid: { type: 'string' },
        confirm_short_sha: { type: 'string' },
        confirm: { type: 'boolean', description: 'Set true after the first explicit confirmation.' },
        confirm_again: { type: 'boolean', description: 'Set true after the SECOND explicit confirmation.' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'dev_list_revisions',
    description: 'DEVELOPER ONLY. Cloud Run revisions for a service. Requires an admin session.',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'gateway, gateway-staging, community-app, or community-app-staging.' },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'dev_list_deployments',
    description: 'DEVELOPER ONLY. Deployment history, optionally filtered by service/environment.',
    parameters: {
      type: 'object',
      properties: { service: { type: 'string' }, environment: { type: 'string' }, limit: { type: 'integer' } },
    },
  },
  {
    name: 'dev_deployment_health',
    description: 'DEVELOPER ONLY. Deployment pipeline config health.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_promote_canary',
    description: 'DEVELOPER ONLY. Promote the canary revision to 100% traffic. Requires an admin session. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: { service: { type: 'string', description: 'Default gateway.' }, confirm: { type: 'boolean' } },
    },
  },
  {
    name: 'dev_abort_canary',
    description: 'DEVELOPER ONLY. Abort the canary and restore the stable revision to 100%. Requires an admin session. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: { service: { type: 'string', description: 'Default gateway.' }, confirm: { type: 'boolean' } },
    },
  },
  {
    name: 'dev_revert_deploy',
    description: 'DEVELOPER ONLY. Revert a service to a prior revision. Requires an admin session. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Required.' },
        target_revision: { type: 'string', description: 'Required.' },
        confirm_short_sha: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['service', 'target_revision'],
    },
  },
  {
    name: 'dev_revert_both',
    description: 'DEVELOPER ONLY. Revert a service AND its paired frontend/backend counterpart together. Requires an admin session. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Required.' },
        target_revision: { type: 'string', description: 'Required.' },
        target_created_at: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['service', 'target_revision'],
    },
  },
  {
    name: 'dev_canary_status',
    description: 'DEVELOPER ONLY. Whether a canary traffic split is currently active for a service. Requires an admin session.',
    parameters: { type: 'object', properties: { service: { type: 'string', description: 'Default gateway.' } } },
  },
  {
    name: 'dev_staging_status',
    description: 'DEVELOPER ONLY. What build/commit is currently on staging.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_compare_staging_prod',
    description: 'DEVELOPER ONLY. Whether staging and production are on the same build.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_release_feed',
    description: 'DEVELOPER ONLY. Recent releases across services.',
    parameters: { type: 'object', properties: { service: { type: 'string' }, environment: { type: 'string' }, limit: { type: 'integer' } } },
  },
];
